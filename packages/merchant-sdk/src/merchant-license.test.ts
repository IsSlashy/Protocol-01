/**
 * `verifyMerchantLicense` and friends — verify only what you sold, store nothing.
 *
 * Everything here is offline. The `Connection` stub EVALUATES the memcmp
 * filters it is handed against the accounts it holds, so "the lookup found the
 * vault" is a statement about the filter offsets, not about the stub being
 * generous. Every offset used by the lookup is derived from the Borsh layout in
 * `licenseCommitmentTagOffset` and pinned here against a synthetic vault of the
 * same shape, decoded by the real decoder, and against the numbers measured on
 * devnet on 2026-09-02 (32 live vaults; the 18 with a commitment all at 224,
 * the 2 paused at 232).
 */

import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { blake3 } from '@noble/hashes/blake3.js';
import { Buffer } from 'buffer';

import {
  createEphemeralSession,
  ephemeralAccountId,
  EPHEMERAL_ACCOUNT_DOMAIN,
  findVaultByLicenseKey,
  findVaultsByLicenseKey,
  licenseCommitmentTagOffset,
  licenseLookupFilters,
  LICENSE_COMMITMENT_TAG_OFFSET_PAUSED,
  LICENSE_COMMITMENT_TAG_OFFSET_UNPAUSED,
  LICENSE_LOOKUP_SHAPE_PAUSED,
  LICENSE_LOOKUP_SHAPE_UNPAUSED,
  LICENSE_LOOKUP_SHAPES,
  SUBSCRIPTION_VAULT_TOKEN_MINT_OFFSET,
  verifyMerchantLicense,
  type VaultOptionShape,
} from './merchant-license';
import {
  decodeSubscriptionVault,
  deriveSubscriptionVaultPda,
  SUBSCRIPTION_VAULT_DISCRIMINATOR,
  SUBSCRIPTION_VAULT_RETAILER_OFFSET,
} from './vaults';
import { encodeLicenseKey, licenseCommitment, LICENSE_SECRET_BYTES, verifyLicenseAgainstVault } from './license';
import { verifyAccessToken } from './access-token';
import { ZK_SHIELDED_PROGRAM_ID_DEVNET } from './config';
import type { ServiceScope } from './service-scope';

const PROGRAM = ZK_SHIELDED_PROGRAM_ID_DEVNET;

// ---------------------------------------------------------------------------
// Fixtures: a Borsh-faithful vault of any option shape, padded like Anchor does
// ---------------------------------------------------------------------------

/** Anchor `space` of the current program (`LEN`) — real accounts are this long, zero-padded. */
const VAULT_SPACE = 361;

interface VaultFields {
  subscriberId?: Uint8Array;
  retailer: PublicKey;
  tokenMint: PublicKey;
  totalDeposited?: bigint;
  rate?: bigint;
  intervalSlots?: bigint;
  startSlot?: bigint;
  claimedPeriods?: bigint;
  isActive?: boolean;
  isPaused?: boolean;
  pauseSlot?: bigint;
  totalPausedSlots?: bigint;
  sourcePool?: PublicKey;
  stealth?: Uint8Array;
  license?: Uint8Array | null;
  /** Wallet-keyed legacy shape (`subscriber_pubkey` Some, commitment None). */
  walletKeyed?: boolean;
  padTo?: number;
}

const POOL = new PublicKey(new Uint8Array(32).fill(0x70));

/** Variable-width Borsh, field for field as `subscription_vault.rs` declares them. */
function buildVault(f: VaultFields): Buffer {
  const subId = f.subscriberId ?? new Uint8Array(32).fill(0x11);
  const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
  const i64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(v); return b; };
  const some = (v: Uint8Array) => Buffer.concat([Buffer.from([1]), Buffer.from(v)]);
  const NONE = Buffer.from([0]);

  const parts: Buffer[] = [Buffer.from(SUBSCRIPTION_VAULT_DISCRIMINATOR)];
  parts.push(f.walletKeyed ? some(subId) : NONE); // subscriber_pubkey
  parts.push(f.walletKeyed ? NONE : some(subId)); // subscriber_commitment
  parts.push(f.retailer.toBuffer());
  parts.push(f.tokenMint.toBuffer());
  parts.push(u64(f.totalDeposited ?? 1_000_000_000n));
  parts.push(u64(f.rate ?? 50_000_000n));
  parts.push(u64(f.intervalSlots ?? 216_000n));
  parts.push(i64(f.startSlot ?? 1_000n));
  parts.push(u64(f.claimedPeriods ?? 0n));
  parts.push(Buffer.from([f.isActive === false ? 0 : 1, f.isPaused ? 1 : 0]));
  parts.push(f.pauseSlot !== undefined ? some(i64(f.pauseSlot)) : NONE); // pause_slot
  parts.push(i64(f.totalPausedSlots ?? 0n));
  parts.push(Buffer.alloc(32, 0x44)); // vk_hash_subscriber
  parts.push(f.sourcePool === undefined ? some(POOL.toBytes()) : some(f.sourcePool.toBytes())); // source_pool — Some, as the instruction writes it
  parts.push(Buffer.from([7])); // bump
  parts.push(f.stealth ? some(f.stealth) : NONE); // client_stealth_meta
  parts.push(f.license ? some(f.license) : NONE); // license_commitment

  let body = Buffer.concat(parts);
  const padTo = f.padTo ?? VAULT_SPACE;
  if (body.length < padTo) body = Buffer.concat([body, Buffer.alloc(padTo - body.length)]);
  return body;
}

/** A vault whose `source_pool` is None — the shape the older fixtures in this suite use. */
function buildVaultSourceNone(f: VaultFields): Buffer {
  const withSome = buildVault({ ...f, padTo: 0 });
  // source_pool Some(33) sits right after vk_hash; splice it down to a None tag.
  const shapeBefore: VaultOptionShape = {
    subscriberPubkey: !!f.walletKeyed,
    subscriberCommitment: !f.walletKeyed,
    pauseSlot: f.pauseSlot !== undefined,
    sourcePool: true,
    clientStealthMeta: !!f.stealth,
  };
  const licOff = licenseCommitmentTagOffset(shapeBefore);
  const srcOff = licOff - (f.stealth ? 65 : 1) - 1 - 33; // back over stealth, bump, source_pool
  return Buffer.concat([withSome.subarray(0, srcOff), Buffer.from([0]), withSome.subarray(srcOff + 33)]);
}

interface StubCall { method: string; programId?: string; filters?: unknown; address?: string }

/**
 * A `Connection` that holds accounts and APPLIES memcmp/dataSize filters to
 * them, so a lookup only finds a vault if its filter offsets are right.
 */
function stubConnection(opts: {
  accounts?: Record<string, { data: Buffer; owner: PublicKey }>;
  slot?: number;
  failRpc?: boolean;
}) {
  const calls: StubCall[] = [];
  const accounts = opts.accounts ?? {};
  const conn = {
    async getAccountInfo(pk: PublicKey) {
      calls.push({ method: 'getAccountInfo', address: pk.toBase58() });
      if (opts.failRpc) throw new Error('rpc down');
      const hit = accounts[pk.toBase58()];
      if (!hit) return null;
      return { data: hit.data, owner: hit.owner, lamports: 1, executable: false, rentEpoch: 0 };
    },
    async getSlot() {
      calls.push({ method: 'getSlot' });
      if (opts.failRpc) throw new Error('rpc down');
      return opts.slot ?? 100_000;
    },
    async getProgramAccounts(
      programId: PublicKey,
      cfg: { filters?: Array<{ memcmp?: { offset: number; bytes: string }; dataSize?: number }> },
    ) {
      calls.push({ method: 'getProgramAccounts', programId: programId.toBase58(), filters: cfg.filters });
      if (opts.failRpc) throw new Error('rpc down');
      const out: Array<{ pubkey: PublicKey; account: { data: Buffer; owner: PublicKey; lamports: number; executable: boolean; rentEpoch: number } }> = [];
      for (const [addr, acc] of Object.entries(accounts)) {
        if (!acc.owner.equals(programId)) continue;
        const ok = (cfg.filters ?? []).every((flt) => {
          if (flt.dataSize !== undefined) return acc.data.length === flt.dataSize;
          if (!flt.memcmp) return true;
          const want = Buffer.from(bs58.decode(flt.memcmp.bytes));
          const at = flt.memcmp.offset;
          if (at + want.length > acc.data.length) return false;
          return acc.data.subarray(at, at + want.length).equals(want);
        });
        if (ok) out.push({ pubkey: new PublicKey(addr), account: { data: acc.data, owner: acc.owner, lamports: 1, executable: false, rentEpoch: 0 } });
      }
      return out;
    },
  };
  return { conn: conn as unknown as import('@solana/web3.js').Connection, calls };
}

const MERCHANT = new PublicKey(new Uint8Array(32).fill(0x22));
const OTHER_MERCHANT = new PublicKey(new Uint8Array(32).fill(0x23));
const SOL = PublicKey.default; // native SOL, as the program records it
const USDC = new PublicKey(new Uint8Array(32).fill(0x0c));
const SUBSCRIBER = (() => { const s = new Uint8Array(32); for (let i = 0; i < 32; i++) s[i] = (i * 5 + 1) & 0xff; return s; })();
const ISSUER = Keypair.fromSeed(new Uint8Array(32).fill(0x42));

/** What the merchant sells: 0.05 SOL per 216 000 slots. */
const SERVICE: ServiceScope = { retailer: MERCHANT, tokenMint: SOL, priceAtomic: 50_000_000n, intervalSlots: 216_000n };
const SLUG = 'my-saas-pro';
/** The merchant's dearer tier: same retailer, mint and interval, 3× the price. */
const PREMIUM: ServiceScope = { ...SERVICE, priceAtomic: 150_000_000n };
/** A yearly variant: same price, 12× the interval. */
const YEARLY: ServiceScope = { ...SERVICE, intervalSlots: 216_000n * 12n };

const SECRET = (() => { const s = new Uint8Array(LICENSE_SECRET_BYTES); for (let i = 0; i < s.length; i++) s[i] = (i * 3 + 5) & 0xff; return s; })();
const KEY = encodeLicenseKey(SECRET);
const COMMITMENT = licenseCommitment(SECRET);
const OTHER_SECRET = new Uint8Array(LICENSE_SECRET_BYTES).fill(0xaa);
const OTHER_KEY = encodeLicenseKey(OTHER_SECRET);

/** Period 1 of the 20 the default fixture is funded for — current. */
const CURRENT = 1_000n + 216_000n;
const NOW_UNIX = 1_800_000_000;

/** A genuine, canonical, licensed vault for SERVICE. */
function honestVault(over: Partial<VaultFields> = {}) {
  const fields: VaultFields = { subscriberId: SUBSCRIBER, retailer: MERCHANT, tokenMint: SOL, license: COMMITMENT, ...over };
  const [pda] = deriveSubscriptionVaultPda(fields.retailer, fields.subscriberId!, fields.tokenMint);
  return { pda, data: buildVault(fields), fields };
}

function scene(vaults: Array<{ pda: PublicKey; data: Buffer; owner?: PublicKey }>, slot = Number(CURRENT)) {
  const accounts: Record<string, { data: Buffer; owner: PublicKey }> = {};
  for (const v of vaults) accounts[v.pda.toBase58()] = { data: v.data, owner: v.owner ?? PROGRAM };
  return stubConnection({ accounts, slot });
}

const baseParams = { merchant: MERCHANT, service: SERVICE, serviceSlug: SLUG, key: KEY };

// ===========================================================================
// 1. The memcmp offsets — derived from the layout, pinned against the decoder
// ===========================================================================

describe('licenseCommitmentTagOffset — where license_commitment sits, by shape', () => {
  /** Every shape the lookup uses, plus the two retired shapes live on devnet, with their measured offsets. */
  const CASES: Array<{ name: string; shape: VaultOptionShape; offset: number; build: (lic: Uint8Array) => Buffer }> = [
    {
      name: 'commitment-keyed, source_pool Some, unpaused (what subscribe_private_stark{,_v4} writes) — 18/18 licensed devnet vaults',
      shape: LICENSE_LOOKUP_SHAPE_UNPAUSED,
      offset: 224,
      build: (lic) => buildVault({ retailer: MERCHANT, tokenMint: SOL, license: lic }),
    },
    {
      name: 'the same vault paused — 2/2 paused devnet vaults',
      shape: LICENSE_LOOKUP_SHAPE_PAUSED,
      offset: 232,
      build: (lic) => buildVault({ retailer: MERCHANT, tokenMint: SOL, license: lic, isPaused: true, pauseSlot: 5_000n }),
    },
    {
      name: 'retired: client_stealth_meta Some — 5 devnet vaults, none licensed',
      shape: { ...LICENSE_LOOKUP_SHAPE_UNPAUSED, clientStealthMeta: true },
      offset: 288,
      build: (lic) => buildVault({ retailer: MERCHANT, tokenMint: SOL, license: lic, stealth: new Uint8Array(64).fill(0xab) }),
    },
    {
      name: 'legacy: wallet-keyed, source_pool None — 2 devnet vaults, none licensed',
      shape: { subscriberPubkey: true, subscriberCommitment: false, pauseSlot: false, sourcePool: false, clientStealthMeta: false },
      offset: 192,
      build: (lic) => buildVaultSourceNone({ retailer: MERCHANT, tokenMint: SOL, license: lic, walletKeyed: true }),
    },
  ];

  it.each(CASES)('$name → tag at $offset', ({ shape, offset, build }) => {
    const lic = new Uint8Array(32);
    for (let i = 0; i < 32; i++) lic[i] = (i * 11 + 2) & 0xff;
    const data = build(lic);

    // Derived offset equals the measured one.
    expect(licenseCommitmentTagOffset(shape)).toBe(offset);
    // The real decoder reads the commitment from this body...
    const decoded = decodeSubscriptionVault(data, new PublicKey(new Uint8Array(32).fill(1)));
    expect(Buffer.from(decoded.licenseCommitment!)).toEqual(Buffer.from(lic));
    // ...and the bytes at the derived offset are exactly `1 ‖ commitment`,
    // which is what the memcmp filter matches on.
    expect(data[offset]).toBe(1);
    expect(data.subarray(offset + 1, offset + 33)).toEqual(Buffer.from(lic));
    // A None tag at the same offset is what an unlicensed vault of that shape carries.
    const unlicensed = build(lic);
    unlicensed[offset] = 0;
    expect(decodeSubscriptionVault(unlicensed, new PublicKey(new Uint8Array(32).fill(1))).licenseCommitment).toBeNull();
  });

  it('the exported constants are the derived values, not literals that could drift from them', () => {
    expect(LICENSE_COMMITMENT_TAG_OFFSET_UNPAUSED).toBe(licenseCommitmentTagOffset(LICENSE_LOOKUP_SHAPE_UNPAUSED));
    expect(LICENSE_COMMITMENT_TAG_OFFSET_PAUSED).toBe(licenseCommitmentTagOffset(LICENSE_LOOKUP_SHAPE_PAUSED));
    expect(LICENSE_COMMITMENT_TAG_OFFSET_PAUSED - LICENSE_COMMITMENT_TAG_OFFSET_UNPAUSED).toBe(8); // one Option<i64> value
    expect(LICENSE_LOOKUP_SHAPES).toEqual([LICENSE_LOOKUP_SHAPE_UNPAUSED, LICENSE_LOOKUP_SHAPE_PAUSED]);
  });

  it('retailer and token_mint offsets agree with the decoder on the same body', () => {
    const data = buildVault({ retailer: MERCHANT, tokenMint: USDC });
    expect(new PublicKey(data.subarray(SUBSCRIPTION_VAULT_RETAILER_OFFSET, SUBSCRIPTION_VAULT_RETAILER_OFFSET + 32)).equals(MERCHANT)).toBe(true);
    expect(new PublicKey(data.subarray(SUBSCRIPTION_VAULT_TOKEN_MINT_OFFSET, SUBSCRIPTION_VAULT_TOKEN_MINT_OFFSET + 32)).equals(USDC)).toBe(true);
  });

  it('the recorded real devnet vault (stealth Some, len 328) has its tag where the stealth-Some shape says', () => {
    // Captured live in index.test.ts: private mode, client_stealth_meta SOME,
    // license_commitment NONE. Its tag byte is at 288 and is 0.
    const REAL_VAULT_HEX =
      '605af7ca9d1056be000130eac88f0f49d1ba000000000000000000000000000000000000000000000000175fd5ff7689f023598a33f4db5b7e8a3333ea6305cad8f70af129e693d9d233000000000000000000000000000000000000000000000000000000000000000000e1f5050000000080f0fa020000000080e06200000000008293c21b0000000000000000000000000100000000000000000000a64ead4b3a24448b2bf246de8f1ac62a3e0956bed54b7abd1915fbc9244d703301f7944f20410137dd38d8e9709c97fc0b4fe88db86773bb182c83fc804be398bdfe01b51749ad138f3d0d3432e25ef76bd3fa7e3f128cb6feb9179a6a2e83c7db81c2f2ea6dee638f9bef1fc5afb30bc4d1be34abc8da6aa3661060c069652ffe1c3900000000000000000000000000000000000000000000000000000000000000000000000000000000';
    const real = Buffer.from(REAL_VAULT_HEX, 'hex');
    const v = decodeSubscriptionVault(real, new PublicKey(new Uint8Array(32).fill(1)));
    expect(v.subscriberCommitment).not.toBeNull();
    expect(v.sourcePool).not.toBeNull();
    expect(v.clientStealthMeta).not.toBeNull();
    expect(v.licenseCommitment).toBeNull();
    const off = licenseCommitmentTagOffset({ ...LICENSE_LOOKUP_SHAPE_UNPAUSED, clientStealthMeta: true });
    expect(off).toBe(288);
    expect(real[off]).toBe(0);
    // And the stealth tag is where the layout puts it (288 − 65).
    expect(real[off - 65]).toBe(1);
  });
});

// ===========================================================================
// 2. findVaultByLicenseKey — the vault from the key alone
// ===========================================================================

describe('findVaultByLicenseKey', () => {
  it('finds a live vault with ONE getProgramAccounts carrying the four expected filters', async () => {
    const v = honestVault();
    const { conn, calls } = scene([v]);
    const got = await findVaultByLicenseKey(conn, { merchant: MERCHANT, key: KEY, tokenMint: SOL });
    expect(got).not.toBeNull();
    expect(got!.vaultPda.equals(v.pda)).toBe(true);
    expect(got!.vault.retailer.equals(MERCHANT)).toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('getProgramAccounts');
    expect(calls[0]!.programId).toBe(PROGRAM.toBase58());
    expect(calls[0]!.filters).toEqual([
      { memcmp: { offset: 0, bytes: bs58.encode(SUBSCRIPTION_VAULT_DISCRIMINATOR) } },
      { memcmp: { offset: 42, bytes: MERCHANT.toBase58() } },
      { memcmp: { offset: 74, bytes: SOL.toBase58() } },
      { memcmp: { offset: 224, bytes: bs58.encode(Buffer.concat([Buffer.from([1]), Buffer.from(COMMITMENT)])) } },
    ]);
    expect(calls[0]!.filters).toEqual(
      licenseLookupFilters({ merchant: MERCHANT, commitment: COMMITMENT, tokenMint: SOL, shape: LICENSE_LOOKUP_SHAPE_UNPAUSED }),
    );
  });

  it('finds a PAUSED vault on the second query, at the paused offset — two calls total', async () => {
    const v = honestVault({ isPaused: true, pauseSlot: 5_000n });
    const { conn, calls } = scene([v]);
    const got = await findVaultByLicenseKey(conn, { merchant: MERCHANT, key: KEY });
    expect(got).not.toBeNull();
    expect(got!.vault.isPaused).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(['getProgramAccounts', 'getProgramAccounts']);
    const offsets = calls.map((c) => (c.filters as Array<{ memcmp: { offset: number } }>).at(-1)!.memcmp.offset);
    expect(offsets).toEqual([224, 232]);
  });

  it('omits the mint filter when no tokenMint is given', async () => {
    const v = honestVault();
    const { conn, calls } = scene([v]);
    await findVaultByLicenseKey(conn, { merchant: MERCHANT, key: KEY });
    const offsets = (calls[0]!.filters as Array<{ memcmp: { offset: number } }>).map((f) => f.memcmp.offset);
    expect(offsets).toEqual([0, 42, 224]);
  });

  it('returns null after at most two queries when nothing matches', async () => {
    const v = honestVault();
    const { conn, calls } = scene([v]);
    expect(await findVaultByLicenseKey(conn, { merchant: MERCHANT, key: OTHER_KEY })).toBeNull();
    expect(calls.filter((c) => c.method === 'getProgramAccounts')).toHaveLength(2);
    expect(calls.filter((c) => c.method === 'getAccountInfo')).toHaveLength(0);
  });

  it('does not find a vault naming another merchant, even with the right commitment', async () => {
    const v = honestVault({ retailer: OTHER_MERCHANT });
    const { conn } = scene([v]);
    expect(await findVaultByLicenseKey(conn, { merchant: MERCHANT, key: KEY })).toBeNull();
  });

  it('does not find a vault in another mint when the mint filter is on', async () => {
    const v = honestVault({ tokenMint: USDC });
    const { conn } = scene([v]);
    expect(await findVaultByLicenseKey(conn, { merchant: MERCHANT, key: KEY, tokenMint: SOL })).toBeNull();
    expect((await findVaultByLicenseKey(conn, { merchant: MERCHANT, key: KEY }))?.vault.tokenMint.equals(USDC)).toBe(true);
  });

  it('a None tag never matches: an unlicensed vault whose padding happens to hold the bytes is skipped', async () => {
    const v = honestVault({ license: null });
    // Put the commitment bytes right after the None tag — only the tag byte
    // separates it from a Some.
    v.data.set(COMMITMENT, 225);
    const { conn } = scene([v]);
    expect(await findVaultByLicenseKey(conn, { merchant: MERCHANT, key: KEY })).toBeNull();
  });

  it('findVaultsByLicenseKey returns every match — a decoy copying a public commitment is visible, not hidden', async () => {
    const real = honestVault();
    const decoy = honestVault({ subscriberId: new Uint8Array(32).fill(0x99), rate: 1n });
    const { conn } = scene([real, decoy]);
    const all = await findVaultsByLicenseKey(conn, { merchant: MERCHANT, key: KEY });
    expect(all.map((m) => m.vaultPda.toBase58()).sort()).toEqual([real.pda.toBase58(), decoy.pda.toBase58()].sort());
  });

  it('throws on a malformed key rather than reporting "not found"', async () => {
    const { conn, calls } = scene([]);
    await expect(findVaultByLicenseKey(conn, { merchant: MERCHANT, key: 'P01-' })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('honours a program ID override', async () => {
    const forked = new PublicKey(new Uint8Array(32).fill(0x07));
    const v = honestVault();
    const { conn, calls } = scene([{ ...v, owner: forked }]);
    expect(await findVaultByLicenseKey(conn, { merchant: MERCHANT, key: KEY })).toBeNull();
    expect(await findVaultByLicenseKey(conn, { merchant: MERCHANT, key: KEY, programId: forked })).not.toBeNull();
    expect(calls.at(-1)!.programId).toBe(forked.toBase58());
  });
});

// ===========================================================================
// 3. verifyMerchantLicense — fail closed, every refusal named
// ===========================================================================

describe('verifyMerchantLicense — grants', () => {
  it('grants a genuine subscription from the key alone: 1 getProgramAccounts + 1 getSlot', async () => {
    const v = honestVault();
    const { conn, calls } = scene([v]);
    const r = await verifyMerchantLicense(conn, baseParams);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.vaultPda.equals(v.pda)).toBe(true);
    expect(r.periodsPaidFor).toBe(20n);
    expect(r.periodsElapsed).toBe(1n);
    expect(r.currentUntilSlot).toBe(1_000n + 20n * 216_000n);
    expect(r.currentSlot).toBe(CURRENT);
    expect(r.ambiguousService).toBeUndefined();
    expect(r.ephemeralAccountId).toBe(
      ephemeralAccountId({ merchant: MERCHANT, serviceSlug: SLUG, vaultPda: v.pda, startSlot: 1_000n }),
    );
    expect(calls.map((c) => c.method).sort()).toEqual(['getProgramAccounts', 'getSlot']);
  });

  it('the vault fast path reads ONE account and never scans', async () => {
    const v = honestVault();
    const { conn, calls } = scene([v]);
    const r = await verifyMerchantLicense(conn, { ...baseParams, vault: v.pda, currentSlot: CURRENT });
    expect(r.ok).toBe(true);
    expect(calls).toEqual([{ method: 'getAccountInfo', address: v.pda.toBase58() }]);
  });

  it('narrows the key-only lookup to the service mint by default', async () => {
    const v = honestVault();
    const { conn, calls } = scene([v]);
    await verifyMerchantLicense(conn, { ...baseParams, currentSlot: CURRENT });
    const offsets = (calls[0]!.filters as Array<{ memcmp: { offset: number } }>).map((f) => f.memcmp.offset);
    expect(offsets).toContain(SUBSCRIPTION_VAULT_TOKEN_MINT_OFFSET);
  });

  it('reports an ambiguous scope instead of hiding it', async () => {
    const v = honestVault();
    const { conn } = scene([v]);
    const r = await verifyMerchantLicense(conn, { ...baseParams, otherServices: [{ ...SERVICE }] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ambiguousService).toBe(true);
  });

  it('tolerates the key in any of the accepted spellings', async () => {
    const v = honestVault();
    const { conn } = scene([v]);
    const messy = `  ${KEY.toLowerCase().replace(/-/g, ' ')}  `;
    expect((await verifyMerchantLicense(conn, { ...baseParams, key: messy })).ok).toBe(true);
  });
});

describe('verifyMerchantLicense — D1: the self-minted decoy at rate 1', () => {
  /** A stranger burnt one 0.1 SOL note on a vault naming the merchant at one atomic unit per period, and holds the matching key. */
  const decoySecret = new Uint8Array(LICENSE_SECRET_BYTES).fill(0x5a);
  const decoyKey = encodeLicenseKey(decoySecret);
  const decoy = honestVault({
    subscriberId: new Uint8Array(32).fill(0x99),
    totalDeposited: 100_000_000n,
    rate: 1n,
    intervalSlots: 216_000n, // copied from what the merchant sells
    license: licenseCommitment(decoySecret),
  });

  it('is REFUSED, and the reason is the service mismatch', async () => {
    const { conn } = scene([decoy]);
    const r = await verifyMerchantLicense(conn, { ...baseParams, key: decoyKey });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('service_mismatch');
    expect(r.detail).toMatch(/rate 1 does not match the service price 50000000/);
    expect(r.vaultPda?.equals(decoy.pda)).toBe(true);
  });

  it('…while the old API without a scope still GRANTS it — the difference is the whole point', async () => {
    const { conn } = scene([decoy]);
    const old = await verifyLicenseAgainstVault(conn, decoyKey, decoy.pda, MERCHANT, SLUG);
    expect(old.valid).toBe(true);
  });

  it('cannot be asked without a scope: a JS caller omitting `service` gets a throw, not a weaker answer', async () => {
    const { conn, calls } = scene([decoy]);
    await expect(
      verifyMerchantLicense(conn, { ...baseParams, key: decoyKey, service: undefined as unknown as ServiceScope }),
    ).rejects.toThrow(/`service` is required/);
    expect(calls).toHaveLength(0);
  });

  it('a decoy carrying a REAL subscriber\'s public commitment cannot block that subscriber', async () => {
    // license_commitment is public, so a stranger can put someone else's on a
    // rate-1 vault. Both vaults come back from the lookup; the genuine one wins.
    const real = honestVault();
    const copycat = honestVault({ subscriberId: new Uint8Array(32).fill(0x98), rate: 1n });
    const { conn } = scene([copycat, real]);
    const r = await verifyMerchantLicense(conn, baseParams);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.vaultPda.equals(real.pda)).toBe(true);
  });

  it('and when no candidate passes, the refusal is the one that got furthest, not the decoy\'s', async () => {
    const ended = honestVault({ totalDeposited: 100_000_000n, rate: 50_000_000n }); // 2 periods, we are in period 5
    const copycat = honestVault({ subscriberId: new Uint8Array(32).fill(0x98), rate: 1n });
    const { conn } = scene([copycat, ended], Number(1_000n + 5n * 216_000n));
    const r = await verifyMerchantLicense(conn, baseParams);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('subscription_ended');
      expect(r.vaultPda?.equals(ended.pda)).toBe(true);
    }
  });
});

describe('verifyMerchantLicense — D3: a key sold for one thing does not open another', () => {
  const v = honestVault();

  it('merchant Y cannot verify a key minted for merchant X (key-only: not found)', async () => {
    const { conn } = scene([v]);
    const r = await verifyMerchantLicense(conn, {
      ...baseParams,
      merchant: OTHER_MERCHANT,
      service: { ...SERVICE, retailer: OTHER_MERCHANT },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('vault_not_found');
  });

  it('merchant Y cannot verify it even when handed the vault address (retailer mismatch)', async () => {
    const { conn } = scene([v]);
    const r = await verifyMerchantLicense(conn, {
      ...baseParams,
      merchant: OTHER_MERCHANT,
      service: { ...SERVICE, retailer: OTHER_MERCHANT },
      vault: v.pda,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('retailer_mismatch');
      expect(r.detail).toContain(OTHER_MERCHANT.toBase58());
    }
  });

  it('THE ESCALATION: a basic-tier key is refused by the premium tier (price)', async () => {
    const { conn } = scene([v]);
    const r = await verifyMerchantLicense(conn, { ...baseParams, service: PREMIUM, serviceSlug: 'my-saas-premium' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('service_mismatch');
      expect(r.detail).toMatch(/rate 50000000 does not match the service price 150000000/);
    }
  });

  it('…and by the yearly variant (interval)', async () => {
    const { conn } = scene([v]);
    const r = await verifyMerchantLicense(conn, { ...baseParams, service: YEARLY, serviceSlug: 'my-saas-yearly' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('service_mismatch');
      expect(r.detail).toMatch(/interval 216000 does not match the service interval 2592000/);
    }
  });

  it('a vault in another mint is refused (mint mismatch on the fast path, not found on the key path)', async () => {
    const usdcVault = honestVault({ tokenMint: USDC });
    const { conn } = scene([usdcVault]);
    const fast = await verifyMerchantLicense(conn, { ...baseParams, vault: usdcVault.pda });
    expect(fast.ok).toBe(false);
    if (!fast.ok) expect(fast.reason).toBe('mint_mismatch');
    const keyOnly = await verifyMerchantLicense(conn, baseParams);
    expect(keyOnly.ok).toBe(false);
    if (!keyOnly.ok) expect(keyOnly.reason).toBe('vault_not_found');
  });

  it('a scope whose retailer is not the merchant is a configuration error, thrown before any RPC', async () => {
    const { conn, calls } = scene([v]);
    await expect(
      verifyMerchantLicense(conn, { ...baseParams, service: { ...SERVICE, retailer: OTHER_MERCHANT } }),
    ).rejects.toThrow(/configuration error/);
    expect(calls).toHaveLength(0);
  });
});

describe('verifyMerchantLicense — the account itself', () => {
  it('refuses a vault whose address is not its own seeds\' PDA (fast path)', async () => {
    const v = honestVault();
    const impostor = new PublicKey(new Uint8Array(32).fill(0x5c));
    const { conn } = scene([{ pda: impostor, data: v.data }]);
    const r = await verifyMerchantLicense(conn, { ...baseParams, vault: impostor });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('non_canonical_pda');
      expect(r.detail).toContain(v.pda.toBase58());
    }
    // The older license path accepted this — pinned in self-minted-vault.test.ts.
    expect((await verifyLicenseAgainstVault(conn, KEY, impostor, MERCHANT, SLUG)).valid).toBe(true);
  });

  it('refuses it on the key-only path too — the lookup does not vouch for addresses', async () => {
    const v = honestVault();
    const impostor = new PublicKey(new Uint8Array(32).fill(0x5c));
    const { conn } = scene([{ pda: impostor, data: v.data }]);
    const r = await verifyMerchantLicense(conn, baseParams);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('non_canonical_pda');
  });

  it('refuses a wrong key against the right vault: commitment mismatch', async () => {
    const v = honestVault();
    const { conn } = scene([v]);
    const r = await verifyMerchantLicense(conn, { ...baseParams, key: OTHER_KEY, vault: v.pda });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('commitment_mismatch');
  });

  it('refuses a vault created before license keys existed', async () => {
    const v = honestVault({ license: null });
    const { conn } = scene([v]);
    const r = await verifyMerchantLicense(conn, { ...baseParams, vault: v.pda });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_license_commitment');
  });

  it('refuses an account zk_shielded does not own, whatever its bytes say', async () => {
    const v = honestVault();
    const attackerProgram = new PublicKey(new Uint8Array(32).fill(0xbe));
    const { conn } = scene([{ ...v, owner: attackerProgram }]);
    const r = await verifyMerchantLicense(conn, { ...baseParams, vault: v.pda });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('wrong_owner');
      expect(r.detail).toContain(attackerProgram.toBase58());
    }
  });

  it('refuses an account that is not a vault', async () => {
    const v = honestVault();
    const { conn } = scene([{ pda: v.pda, data: Buffer.alloc(64, 0xaa) }]);
    const r = await verifyMerchantLicense(conn, { ...baseParams, vault: v.pda });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('undecodable');
  });

  it('refuses a missing account', async () => {
    const v = honestVault();
    const { conn } = scene([]);
    const r = await verifyMerchantLicense(conn, { ...baseParams, vault: v.pda });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('vault_not_found');
  });

  it('refuses a malformed key before touching the network', async () => {
    const { conn, calls } = scene([]);
    const r = await verifyMerchantLicense(conn, { ...baseParams, key: 'P01-' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('malformed_key');
    expect(calls).toHaveLength(0);
  });

  it('reports an RPC failure as rpc_error, never as a grant', async () => {
    const { conn } = stubConnection({ failRpc: true });
    const r = await verifyMerchantLicense(conn, baseParams);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('rpc_error');
  });
});

describe('verifyMerchantLicense — entitlement, via subscriptionIsCurrent', () => {
  it('refuses an EXPIRED subscription that still reports isActive true', async () => {
    const v = honestVault({ totalDeposited: 100_000_000n, rate: 50_000_000n }); // 2 periods
    const { conn } = scene([v], Number(1_000n + 5n * 216_000n));
    const r = await verifyMerchantLicense(conn, baseParams);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('subscription_ended');
      expect(r.detail).toMatch(/ran past the 2 period\(s\)/);
      expect(r.vault?.isActive).toBe(true);
    }
  });

  it('refuses a PAUSED subscription, found at the paused offset', async () => {
    const v = honestVault({ isPaused: true, pauseSlot: 5_000n });
    const { conn, calls } = scene([v]);
    const r = await verifyMerchantLicense(conn, baseParams);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('subscription_paused');
    expect(calls.filter((c) => c.method === 'getProgramAccounts')).toHaveLength(2);
  });

  it('refuses an interval-0 vault as never current', async () => {
    const v = honestVault({ intervalSlots: 0n });
    const { conn } = scene([v]);
    // interval 0 fails the service scope first; hand it a scope that agrees so
    // the entitlement gate is the one that refuses.
    const r = await verifyMerchantLicense(conn, { ...baseParams, service: { ...SERVICE, intervalSlots: 0n }, vault: v.pda });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('subscription_not_current');
  });

  it('refuses an inactive vault as never current', async () => {
    const v = honestVault({ isActive: false });
    const { conn } = scene([v]);
    const r = await verifyMerchantLicense(conn, { ...baseParams, vault: v.pda });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('subscription_not_current');
  });

  it('honours a caller-supplied slot and skips getSlot', async () => {
    const v = honestVault();
    const { conn, calls } = scene([v], 0);
    const r = await verifyMerchantLicense(conn, { ...baseParams, currentSlot: CURRENT });
    expect(r.ok).toBe(true);
    expect(calls.filter((c) => c.method === 'getSlot')).toHaveLength(0);
  });
});

// ===========================================================================
// 4. ephemeralAccountId — a pseudonym of the vault, not of the secret
// ===========================================================================

describe('ephemeralAccountId', () => {
  const v = honestVault();
  const base = { merchant: MERCHANT, serviceSlug: SLUG, vaultPda: v.pda, startSlot: 1_000n };

  it('is exactly the documented construction', () => {
    const slot = Buffer.alloc(8); slot.writeBigUInt64LE(1_000n);
    const want = bs58.encode(blake3(Buffer.concat([
      Buffer.from(EPHEMERAL_ACCOUNT_DOMAIN, 'utf8'), MERCHANT.toBuffer(), Buffer.from(SLUG, 'utf8'), v.pda.toBuffer(), slot,
    ])));
    expect(EPHEMERAL_ACCOUNT_DOMAIN).toBe('p01-ephemeral-account-v1');
    expect(ephemeralAccountId(base)).toBe(want);
  });

  it('is base58 of a 32-byte digest (43-44 characters)', () => {
    const id = ephemeralAccountId(base);
    expect(bs58.decode(id)).toHaveLength(32);
    expect(id.length).toBeGreaterThanOrEqual(43);
    expect(id.length).toBeLessThanOrEqual(44);
  });

  it('is stable across repeated verifications of the same subscription', async () => {
    const { conn } = scene([v]);
    const a = await verifyMerchantLicense(conn, baseParams);
    const b = await verifyMerchantLicense(conn, { ...baseParams, vault: v.pda });
    const c = await verifyMerchantLicense(conn, { ...baseParams, currentSlot: CURRENT + 1_000n });
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (a.ok && b.ok && c.ok) {
      expect(b.ephemeralAccountId).toBe(a.ephemeralAccountId);
      expect(c.ephemeralAccountId).toBe(a.ephemeralAccountId);
      expect(a.ephemeralAccountId).toBe(ephemeralAccountId(base));
    }
  });

  it('changes with the subscription generation (startSlot), the vault, the merchant and the service', () => {
    const id = ephemeralAccountId(base);
    expect(ephemeralAccountId({ ...base, startSlot: 9_000n })).not.toBe(id);
    expect(ephemeralAccountId({ ...base, vaultPda: new PublicKey(new Uint8Array(32).fill(0x5c)) })).not.toBe(id);
    expect(ephemeralAccountId({ ...base, merchant: OTHER_MERCHANT })).not.toBe(id);
    expect(ephemeralAccountId({ ...base, serviceSlug: 'my-saas-premium' })).not.toBe(id);
  });

  it('is a function of the vault, not of the secret: two different keys on the same vault give the same id', async () => {
    // The same address and start_slot, once carrying commitment A and once B.
    const withA = honestVault();
    const withB = honestVault({ license: licenseCommitment(OTHER_SECRET) });
    const idA = await verifyMerchantLicense(scene([withA]).conn, { ...baseParams, vault: withA.pda });
    const idB = await verifyMerchantLicense(scene([withB]).conn, { ...baseParams, key: OTHER_KEY, vault: withB.pda });
    expect(idA.ok && idB.ok).toBe(true);
    if (idA.ok && idB.ok) expect(idB.ephemeralAccountId).toBe(idA.ephemeralAccountId);
  });

  it('is not derivable from the key alone: no field of the preimage is the secret or its image', () => {
    const id = ephemeralAccountId(base);
    expect(id).not.toBe(bs58.encode(blake3(SECRET)));
    expect(id).not.toBe(bs58.encode(COMMITMENT));
    expect(id).not.toBe(bs58.encode(blake3(Buffer.from(KEY, 'utf8'))));
  });

  it('encodes start_slot as an unsigned 64-bit LE value', () => {
    // A negative i64 would be wrapped, not thrown, and stays distinct.
    expect(() => ephemeralAccountId({ ...base, startSlot: -1n })).not.toThrow();
    expect(ephemeralAccountId({ ...base, startSlot: -1n })).not.toBe(ephemeralAccountId({ ...base, startSlot: 2n ** 64n - 2n }));
    expect(ephemeralAccountId({ ...base, startSlot: -1n })).toBe(ephemeralAccountId({ ...base, startSlot: 2n ** 64n - 1n }));
  });
});

// ===========================================================================
// 5. createEphemeralSession — a token the merchant never has to store
// ===========================================================================

describe('createEphemeralSession', () => {
  const v = honestVault();
  const sessionParams = { ...baseParams, issuer: ISSUER, ttlSeconds: 3_600, nowUnix: NOW_UNIX };

  it('issues a token that round-trips through verifyAccessToken with the ephemeral id as subject', async () => {
    const { conn } = scene([v]);
    const s = await createEphemeralSession(conn, sessionParams);
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.issuer.equals(ISSUER.publicKey)).toBe(true);

    const r = verifyAccessToken(s.token, ISSUER.publicKey, {
      expectedService: SLUG,
      expectedVault: v.pda,
      subscription: { vault: s.vault, currentSlot: CURRENT },
      nowUnix: NOW_UNIX,
    });
    expect(r.valid).toBe(true);
    expect(r.serviceChecked).toBe(true);
    expect(r.subscriptionChecked).toBe(true);
    expect(r.claims!.sub).toBe(s.ephemeralAccountId);
    expect(r.claims!.svc).toBe(SLUG);
    expect(r.claims!.vault).toBe(v.pda.toBase58());
    expect(r.claims!.vaultStartSlot).toBe('1000');
    expect(r.claims!.exp).toBe(s.expiresAtUnix);
  });

  it('bounds exp by the TTL and by the funded window, whichever is sooner', async () => {
    const { conn } = scene([v]);
    const short = await createEphemeralSession(conn, sessionParams);
    expect(short.ok && short.expiresAtUnix).toBe(NOW_UNIX + 3_600);

    // 19 periods of 216 000 slots remain — far more than an hour, so the TTL wins above.
    // Now a 30-day TTL against a vault with 400 slots (160 s) left: the window wins.
    const nearlyOver = honestVault({ totalDeposited: 100_000_000n, rate: 50_000_000n }); // ends at 1000 + 2×216000
    const slot = 1_000n + 2n * 216_000n - 400n;
    const long = await createEphemeralSession(scene([nearlyOver]).conn, {
      ...sessionParams,
      ttlSeconds: 30 * 86_400,
      currentSlot: slot,
    });
    expect(long.ok && long.expiresAtUnix).toBe(NOW_UNIX + 160);
  });

  it('refuses without issuing when the verification refuses, and the reason propagates', async () => {
    const { conn } = scene([v]);
    const s = await createEphemeralSession(conn, { ...sessionParams, key: OTHER_KEY, vault: v.pda });
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.reason).toBe('commitment_mismatch');
    expect('token' in s).toBe(false);

    const decoy = honestVault({ subscriberId: new Uint8Array(32).fill(0x99), rate: 1n });
    const d = await createEphemeralSession(scene([decoy]).conn, sessionParams);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe('service_mismatch');
  });

  it('refuses rather than mint a token with under a second of window left', async () => {
    const nearlyOver = honestVault({ totalDeposited: 100_000_000n, rate: 50_000_000n });
    const slot = 1_000n + 2n * 216_000n - 1n;
    const s = await createEphemeralSession(scene([nearlyOver]).conn, { ...sessionParams, currentSlot: slot });
    expect(s.ok).toBe(false);
    if (!s.ok) {
      expect(s.reason).toBe('subscription_ended');
      expect(s.detail).toMatch(/no subscription time left/);
    }
  });

  it('a token minted under one subscription generation is refused against the next', async () => {
    const { conn } = scene([v]);
    const s = await createEphemeralSession(conn, sessionParams);
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    // claim_period closed the vault; the subscriber re-subscribed at the same PDA.
    const reborn = honestVault({ startSlot: 9_000n });
    const again = await verifyMerchantLicense(scene([reborn]).conn, { ...baseParams, currentSlot: 9_100n });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.ephemeralAccountId).not.toBe(s.ephemeralAccountId);
    const r = verifyAccessToken(s.token, ISSUER.publicKey, {
      subscription: { vault: again.vault, currentSlot: 9_100n },
      nowUnix: NOW_UNIX,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/different subscription on this vault/);
  });

  it('extra claims decorate the token and cannot redefine it', async () => {
    const { conn } = scene([v]);
    const s = await createEphemeralSession(conn, {
      ...sessionParams,
      extraClaims: { tier: 'pro', exp: NOW_UNIX + 365 * 86_400, sub: 'somebody-else' },
    });
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    const r = verifyAccessToken(s.token, ISSUER.publicKey, { nowUnix: NOW_UNIX });
    expect(r.claims!.tier).toBe('pro');
    expect(r.claims!.exp).toBe(NOW_UNIX + 3_600);
    expect(r.claims!.sub).toBe(s.ephemeralAccountId);
  });
});

// ===========================================================================
// 9. The registry moves, the vault does not: prior terms
// ===========================================================================

describe('verifyMerchantLicense - prior terms after update_service', () => {
  const OLD_PRICE = 40_000_000n;
  const OLD_INTERVAL = 216_000n;
  const sold = honestVault({ rate: OLD_PRICE, intervalSlots: OLD_INTERVAL, startSlot: 1_000n, totalDeposited: OLD_PRICE * 10n });

  it('without the list, a customer sold under the old price is refused for the rest of their window', async () => {
    const { conn } = scene([sold]);
    const r = await verifyMerchantLicense(conn, baseParams);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('service_mismatch');
  });

  it('with the old terms listed, the same customer is granted and the grant says the terms are not current', async () => {
    const { conn } = scene([sold]);
    const r = await verifyMerchantLicense(conn, {
      ...baseParams,
      priorTerms: [{ priceAtomic: OLD_PRICE, intervalSlots: OLD_INTERVAL }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.terms).toEqual({ priceAtomic: OLD_PRICE, intervalSlots: OLD_INTERVAL, current: false });
      expect(r.vaultPda.equals(sold.pda)).toBe(true);
    }
  });

  it('a grant on the current terms says so', async () => {
    const v = honestVault();
    const { conn } = scene([v]);
    const r = await verifyMerchantLicense(conn, {
      ...baseParams,
      priorTerms: [{ priceAtomic: OLD_PRICE, intervalSlots: OLD_INTERVAL }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.terms.current).toBe(true);
  });

  it('a prior term must match BOTH numbers: the old price at a new interval is still refused', async () => {
    const { conn } = scene([sold]);
    const r = await verifyMerchantLicense(conn, {
      ...baseParams,
      priorTerms: [{ priceAtomic: OLD_PRICE, intervalSlots: OLD_INTERVAL * 2n }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('service_mismatch');
      expect(r.detail).toContain('prior term');
    }
  });

  it('a prior term never widens the retailer or the mint: the decoy at rate 1 stays refused', async () => {
    const decoy = honestVault({ rate: 1n, intervalSlots: 216_000n, totalDeposited: 10n });
    const { conn } = scene([decoy]);
    const r = await verifyMerchantLicense(conn, {
      ...baseParams,
      priorTerms: [{ priceAtomic: OLD_PRICE, intervalSlots: OLD_INTERVAL }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('service_mismatch');
  });
});

// ===========================================================================
// 10. The chain has not served the vault yet: retryable refusals
// ===========================================================================

describe('verifyMerchantLicense - a not-found right after purchase is retryable', () => {
  /** A connection that answers the key-only scan empty for the first `emptyScans` calls. */
  function lagging(vaults: Parameters<typeof scene>[0], emptyScans: number) {
    const { conn, calls } = scene(vaults);
    const real = conn.getProgramAccounts.bind(conn);
    let scans = 0;
    (conn as unknown as { getProgramAccounts: unknown }).getProgramAccounts = async (
      programId: PublicKey,
      cfg: unknown,
    ) => {
      scans++;
      if (scans <= emptyScans) {
        calls.push({ method: 'getProgramAccounts', programId: programId.toBase58(), filters: (cfg as { filters?: unknown }).filters as never });
        return [];
      }
      return real(programId, cfg as never);
    };
    return { conn, calls };
  }

  it('by default a not-found is answered at once, and it says it is retryable', async () => {
    const { conn } = scene([]);
    const r = await verifyMerchantLicense(conn, baseParams);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('vault_not_found');
      expect(r.retryable).toBe(true);
      expect(r.attempts).toBe(1);
    }
  });

  it('with retry, the scan is repeated until the vault appears (two shapes per attempt)', async () => {
    const v = honestVault();
    const { conn } = lagging([v], 4); // attempts 1 and 2 see nothing at either shape
    const r = await verifyMerchantLicense(conn, { ...baseParams, retry: { attempts: 5, delayMs: 0 } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.vaultPda.equals(v.pda)).toBe(true);
  });

  it('with retry exhausted, the refusal counts its attempts', async () => {
    const { conn } = scene([]);
    const r = await verifyMerchantLicense(conn, { ...baseParams, retry: { attempts: 3, delayMs: 0 } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('vault_not_found');
      expect(r.retryable).toBe(true);
      expect(r.attempts).toBe(3);
      expect(r.detail).toContain('3 attempts');
    }
  });

  it('a malformed key is never retried', async () => {
    const { conn, calls } = scene([]);
    const r = await verifyMerchantLicense(conn, { ...baseParams, key: 'hello', retry: { attempts: 5, delayMs: 0 } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('malformed_key');
      expect(r.retryable).toBeUndefined();
    }
    expect(calls.length).toBe(0);
  });

  it('a refusal that names a located vault is final, not retryable', async () => {
    const decoy = honestVault({ rate: 1n, totalDeposited: 10n });
    const { conn, calls } = scene([decoy]);
    const r = await verifyMerchantLicense(conn, { ...baseParams, retry: { attempts: 5, delayMs: 0 } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('service_mismatch');
      expect(r.retryable).toBeUndefined();
    }
    expect(calls.filter((c) => c.method === 'getProgramAccounts').length).toBeLessThanOrEqual(2);
  });

  it('an RPC failure is retried, then reported as retryable', async () => {
    const { conn } = stubConnection({ failRpc: true });
    const r = await verifyMerchantLicense(conn, { ...baseParams, retry: { attempts: 2, delayMs: 0 } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('rpc_error');
      expect(r.retryable).toBe(true);
      expect(r.attempts).toBe(2);
    }
  });
});

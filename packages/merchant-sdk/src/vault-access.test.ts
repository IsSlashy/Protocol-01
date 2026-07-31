/**
 * The single-account verification path.
 *
 * Everything here is offline: the `Connection` is a stub that records what was
 * asked for, so the RPC-call counts are assertions rather than commentary.
 */

import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer';

import { fetchVaultByAddress, decodeSubscriptionVault, SUBSCRIPTION_VAULT_RETAILER_OFFSET } from './vaults';
import { verifyLicenseAgainstVault, encodeLicenseKey, licenseCommitment, LICENSE_SECRET_BYTES } from './license';
import { ZK_SHIELDED_PROGRAM_ID_DEVNET } from './config';

const PROGRAM = ZK_SHIELDED_PROGRAM_ID_DEVNET;
const VAULT_DISC = [96, 90, 247, 202, 157, 16, 86, 190];

// ---------------------------------------------------------------------------
// Fixtures: a Borsh-faithful vault body + a Connection stub that counts calls.
// ---------------------------------------------------------------------------

interface VaultFields {
  mode?: 'private' | 'normal';
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
  license?: Uint8Array | null;
}

/** Variable-width Borsh, exactly as the program serializes it. */
function buildVault(f: VaultFields): Buffer {
  const mode = f.mode ?? 'private';
  const subId = f.subscriberId ?? new Uint8Array(32).fill(0x11);
  const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
  const i64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(v); return b; };

  const parts: Buffer[] = [Buffer.from(VAULT_DISC)];
  if (mode === 'normal') {
    parts.push(Buffer.concat([Buffer.from([1]), Buffer.from(subId)])); // Some
    parts.push(Buffer.from([0])); // commitment None — ONE byte
  } else {
    parts.push(Buffer.from([0])); // pubkey None — ONE byte
    parts.push(Buffer.concat([Buffer.from([1]), Buffer.from(subId)])); // Some
  }
  parts.push(f.retailer.toBuffer());
  parts.push(f.tokenMint.toBuffer());
  parts.push(u64(f.totalDeposited ?? 1_000_000_000n));
  parts.push(u64(f.rate ?? 50_000_000n));
  parts.push(u64(f.intervalSlots ?? 216_000n));
  parts.push(i64(f.startSlot ?? 1_000n));
  parts.push(u64(f.claimedPeriods ?? 0n));
  parts.push(Buffer.from([f.isActive === false ? 0 : 1, f.isPaused ? 1 : 0]));
  parts.push(Buffer.from([0])); // pause_slot None
  parts.push(i64(0n)); // total_paused_slots
  parts.push(Buffer.alloc(32, 0x44)); // vk_hash_subscriber
  parts.push(Buffer.from([0])); // source_pool None
  parts.push(Buffer.from([7])); // bump
  parts.push(Buffer.from([0])); // client_stealth_meta None
  if (f.license) parts.push(Buffer.concat([Buffer.from([1]), Buffer.from(f.license)]));
  else parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

interface StubCall { method: string; arg: string }

/** Minimal `Connection` shape used by the functions under test. */
function stubConnection(opts: {
  accounts?: Record<string, { data: Buffer; owner: PublicKey }>;
  slot?: number;
  programAccounts?: { pubkey: PublicKey; data: Buffer }[];
}) {
  const calls: StubCall[] = [];
  const conn = {
    async getAccountInfo(pk: PublicKey) {
      calls.push({ method: 'getAccountInfo', arg: pk.toBase58() });
      const hit = opts.accounts?.[pk.toBase58()];
      if (!hit) return null;
      return { data: hit.data, owner: hit.owner, lamports: 1, executable: false, rentEpoch: 0 };
    },
    async getSlot() {
      calls.push({ method: 'getSlot', arg: '' });
      return opts.slot ?? 100_000;
    },
    async getProgramAccounts(pk: PublicKey) {
      calls.push({ method: 'getProgramAccounts', arg: pk.toBase58() });
      return (opts.programAccounts ?? []).map((a) => ({
        pubkey: a.pubkey,
        account: { data: a.data, owner: pk, lamports: 1, executable: false, rentEpoch: 0 },
      }));
    },
  };
  // The SDK functions take a `Connection`; the stub implements the members they
  // actually reach for. Cast at the single boundary rather than in every call.
  return { conn: conn as unknown as import('@solana/web3.js').Connection, calls };
}

const RETAILER = new PublicKey(new Uint8Array(32).fill(0x22));
const MINT = PublicKey.default; // native SOL, as the program records it
const SUBSCRIBER = (() => { const s = new Uint8Array(32); for (let i = 0; i < 32; i++) s[i] = (i * 5 + 1) & 0xff; return s; })();
const SEED_PREFIX = Buffer.from('subscription_vault', 'utf8');

function canonicalVault(over: Partial<VaultFields> = {}) {
  const fields: VaultFields = {
    mode: 'private', subscriberId: SUBSCRIBER, retailer: RETAILER, tokenMint: MINT, ...over,
  };
  const [pda] = PublicKey.findProgramAddressSync(
    [SEED_PREFIX, fields.retailer.toBuffer(), Buffer.from(fields.subscriberId!), fields.tokenMint.toBuffer()],
    PROGRAM,
  );
  return { pda, data: buildVault(fields), fields };
}

// ---------------------------------------------------------------------------
// fetchVaultByAddress — the owner check
// ---------------------------------------------------------------------------

describe('fetchVaultByAddress', () => {
  it('decodes a vault the zk_shielded program owns, reading one account', async () => {
    const v = canonicalVault();
    const { conn, calls } = stubConnection({
      accounts: { [v.pda.toBase58()]: { data: v.data, owner: PROGRAM } },
    });
    const got = await fetchVaultByAddress(conn, v.pda);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.vault.retailer.equals(RETAILER)).toBe(true);
    expect(calls.filter((c) => c.method === 'getAccountInfo')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'getProgramAccounts')).toHaveLength(0);
  });

  it('FORGERY REJECTED: a perfectly-formed vault body owned by someone else', async () => {
    // The whole point of the owner check. An attacker deploys their own program
    // and creates an account whose bytes they choose: right discriminator, the
    // victim merchant in `retailer`, a license commitment whose preimage they
    // hold. Every field check downstream passes on attacker-chosen data.
    const attackerProgram = new PublicKey(new Uint8Array(32).fill(0xbe));
    const v = canonicalVault();
    const { conn } = stubConnection({
      accounts: { [v.pda.toBase58()]: { data: v.data, owner: attackerProgram } },
    });
    const got = await fetchVaultByAddress(conn, v.pda);
    expect(got.ok).toBe(false);
    if (!got.ok) {
      expect(got.reason).toMatch(/owned by/);
      expect(got.reason).toContain(attackerProgram.toBase58());
      expect(got.reason).toContain(PROGRAM.toBase58());
    }
    // The same bytes decode fine — it is ONLY the owner that rejects them.
    expect(() => decodeSubscriptionVault(v.data, v.pda)).not.toThrow();
  });

  it('a system-owned account with vault-shaped bytes is rejected too', async () => {
    const v = canonicalVault();
    const { conn } = stubConnection({
      accounts: { [v.pda.toBase58()]: { data: v.data, owner: new PublicKey('11111111111111111111111111111111') } },
    });
    expect((await fetchVaultByAddress(conn, v.pda)).ok).toBe(false);
  });

  it('reports a missing account distinctly from a wrongly-owned one', async () => {
    const v = canonicalVault();
    const got = await fetchVaultByAddress(stubConnection({}).conn, v.pda);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe('vault not found');
  });

  it('reports a decode failure rather than throwing', async () => {
    const v = canonicalVault();
    const { conn } = stubConnection({
      accounts: { [v.pda.toBase58()]: { data: Buffer.alloc(64, 0xaa), owner: PROGRAM } },
    });
    const got = await fetchVaultByAddress(conn, v.pda);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toMatch(/decode failed/);
  });

  it('honours a program ID override when deciding who is a legitimate owner', async () => {
    const forked = new PublicKey(new Uint8Array(32).fill(0x07));
    const v = canonicalVault();
    const { conn } = stubConnection({
      accounts: { [v.pda.toBase58()]: { data: v.data, owner: forked } },
    });
    expect((await fetchVaultByAddress(conn, v.pda)).ok).toBe(false);
    expect((await fetchVaultByAddress(conn, v.pda, { programId: forked })).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verifyLicenseAgainstVault — the same owner check, on the license path
// ---------------------------------------------------------------------------

describe('verifyLicenseAgainstVault', () => {
  const secret = (() => { const s = new Uint8Array(LICENSE_SECRET_BYTES); for (let i = 0; i < s.length; i++) s[i] = (i * 3 + 5) & 0xff; return s; })();
  const key = encodeLicenseKey(secret);
  const commitment = licenseCommitment(secret);
  const CURRENT = Number(1_000n + 216_000n); // period 1 of 20 — current

  it('accepts a matching key on a program-owned, current vault, without enumerating', async () => {
    const v = canonicalVault({ license: commitment });
    const { conn, calls } = stubConnection({
      accounts: { [v.pda.toBase58()]: { data: v.data, owner: PROGRAM } },
      slot: CURRENT,
    });
    const res = await verifyLicenseAgainstVault(conn, key, v.pda, RETAILER, 'my-saas-pro');
    expect(res.valid).toBe(true);
    expect(calls.filter((c) => c.method === 'getProgramAccounts')).toHaveLength(0);
    expect(calls.filter((c) => c.method === 'getAccountInfo')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'getSlot')).toHaveLength(1);
  });

  it('FORGERY REJECTED: an attacker-owned account carrying a commitment they chose', async () => {
    // Before the owner check this returned valid:true. The attacker picks the
    // secret, so the key matches; the retailer field names the victim; the
    // subscription is current. Only the owner gives it away.
    const attackerProgram = new PublicKey(new Uint8Array(32).fill(0xbe));
    const v = canonicalVault({ license: commitment });
    const { conn } = stubConnection({
      accounts: { [v.pda.toBase58()]: { data: v.data, owner: attackerProgram } },
      slot: CURRENT,
    });
    const res = await verifyLicenseAgainstVault(conn, key, v.pda, RETAILER, 'my-saas-pro');
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/owned by/);
  });

  it('still rejects a key that does not match the commitment', async () => {
    const v = canonicalVault({ license: commitment });
    const { conn } = stubConnection({
      accounts: { [v.pda.toBase58()]: { data: v.data, owner: PROGRAM } }, slot: CURRENT,
    });
    const wrong = encodeLicenseKey(new Uint8Array(LICENSE_SECRET_BYTES).fill(0xaa));
    const res = await verifyLicenseAgainstVault(conn, wrong, v.pda, RETAILER, 'my-saas-pro');
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/does not match this vault/);
  });

  it('still rejects a vault belonging to another merchant', async () => {
    const v = canonicalVault({ license: commitment });
    const { conn } = stubConnection({
      accounts: { [v.pda.toBase58()]: { data: v.data, owner: PROGRAM } }, slot: CURRENT,
    });
    const res = await verifyLicenseAgainstVault(
      conn, key, v.pda, new PublicKey(new Uint8Array(32).fill(0x23)), 'my-saas-pro',
    );
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/different merchant/);
  });

  it('still rejects an exhausted subscription that reports isActive true', async () => {
    const v = canonicalVault({ license: commitment, totalDeposited: 100_000_000n, rate: 50_000_000n });
    const { conn } = stubConnection({
      accounts: { [v.pda.toBase58()]: { data: v.data, owner: PROGRAM } },
      slot: Number(1_000n + 5n * 216_000n),
    });
    const res = await verifyLicenseAgainstVault(conn, key, v.pda, RETAILER, 'my-saas-pro');
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/run past the 2 period\(s\)/);
    expect(decodeSubscriptionVault(v.data, v.pda).isActive).toBe(true);
  });

  it('honours a program ID override for the owner check', async () => {
    const forked = new PublicKey(new Uint8Array(32).fill(0x07));
    const v = canonicalVault({ license: commitment });
    const { conn } = stubConnection({
      accounts: { [v.pda.toBase58()]: { data: v.data, owner: forked } }, slot: CURRENT,
    });
    expect((await verifyLicenseAgainstVault(conn, key, v.pda, RETAILER, 'x')).valid).toBe(false);
    expect((await verifyLicenseAgainstVault(conn, key, v.pda, RETAILER, 'x', { programId: forked })).valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The claim the docs must NOT make
// ---------------------------------------------------------------------------

describe('enumerability is a property of the chain, not of this SDK', () => {
  it('retailer is readable from raw account bytes at a fixed offset, no SDK needed', () => {
    // If a doc ever says deprecating listVaultsForRetailer "removes subscriber
    // enumeration", this is the counterexample: 32 bytes at a constant offset in
    // a public account. Anyone can memcmp on it from curl.
    const v = canonicalVault();
    expect(
      new PublicKey(
        v.data.subarray(SUBSCRIPTION_VAULT_RETAILER_OFFSET, SUBSCRIPTION_VAULT_RETAILER_OFFSET + 32),
      ).equals(RETAILER),
    ).toBe(true);

    // And the offset is mode-invariant, which is what makes the memcmp work at
    // all — so it holds for private vaults too, not just wallet ones.
    const normal = buildVault({ mode: 'normal', retailer: RETAILER, tokenMint: MINT, subscriberId: SUBSCRIBER });
    expect(
      new PublicKey(
        normal.subarray(SUBSCRIPTION_VAULT_RETAILER_OFFSET, SUBSCRIPTION_VAULT_RETAILER_OFFSET + 32),
      ).equals(RETAILER),
    ).toBe(true);
  });
});

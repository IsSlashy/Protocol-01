/**
 * What a `SubscriptionVault` proves about the person presenting it — and what
 * it does not.
 *
 * Subscribing is permissionless, and the removal of `subscribe_normal` did not
 * change that. `subscribe_private_stark` — the only instruction left that can
 * create a vault — carries `/// CHECK: Any pubkey can be a retailer` on an
 * unsigned `AccountInfo`
 * (`programs/zk_shielded/src/instructions/subscribe_private_stark.rs:81-83`),
 * and its handler takes `rate` and `interval_slots` straight from the
 * instruction data with only `> 0` required of each (`:181-182`). So ANYONE can
 * create a real, program-owned vault at the canonical PDA that names any
 * merchant as `retailer`, at a rate of one atomic unit per period. Nothing
 * about that account is forged: the program wrote it.
 *
 * What removing `subscribe_normal` DID change is the price. `total_deposited`
 * is no longer a caller-chosen `amount`; it is fixed to the source pool's
 * denomination (`:187`, `:390`), so the attacker must burn a real pool note
 * instead of one lamport. It closes nothing: at a rate of 1, `periodsPaidFor`
 * becomes that entire denomination — 100,000,000 periods for the 0.1 SOL pools
 * live on devnet — and `periodsElapsed` never catches up.
 *
 * Every structural check on the single-account path passes on such a vault —
 * owner, discriminator, retailer field, canonical PDA, subscriber ID,
 * `subscriptionIsCurrent`. Only `opts.service` refuses it, because only the
 * registry knows what the merchant actually charges.
 *
 * These tests pin that: the scope is not a multi-product convenience, it is the
 * entire distance between "this account exists" and "this person paid you".
 * Both vault shapes are covered — the wallet-keyed one `subscribe_normal` used
 * to write, which 3 of the 18 live devnet vaults still are, and the
 * commitment-keyed one `subscribe_private_stark` writes today.
 */

import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer';

import {
  deriveSubscriptionVaultPda,
  hasActiveVaultAccessForVault,
  fetchVaultByAddress,
} from './vaults';
import { subscriptionIsCurrent, periodsPaidFor } from './claim';
import { verifyLicenseAgainstVault, encodeLicenseKey, licenseCommitment, LICENSE_SECRET_BYTES } from './license';
import { ZK_SHIELDED_PROGRAM_ID_DEVNET } from './config';
import type { ServiceScope } from './service-scope';

const PROGRAM = ZK_SHIELDED_PROGRAM_ID_DEVNET;
const VAULT_DISC = [96, 90, 247, 202, 157, 16, 86, 190];

/** Normal-mode vault body, variable-width Borsh exactly as the program writes it. */
function buildNormalVault(f: {
  subscriberId: Uint8Array;
  retailer: PublicKey;
  tokenMint: PublicKey;
  totalDeposited: bigint;
  rate: bigint;
  intervalSlots: bigint;
  startSlot: bigint;
  license?: Uint8Array | null;
}): Buffer {
  const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
  const i64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(v); return b; };
  const parts: Buffer[] = [
    Buffer.from(VAULT_DISC),
    Buffer.concat([Buffer.from([1]), Buffer.from(f.subscriberId)]), // subscriber_pubkey Some
    Buffer.from([0]),                                              // subscriber_commitment None
    f.retailer.toBuffer(),
    f.tokenMint.toBuffer(),
    u64(f.totalDeposited),
    u64(f.rate),
    u64(f.intervalSlots),
    i64(f.startSlot),
    u64(0n),                       // claimed_periods
    Buffer.from([1, 0]),           // is_active = true, is_paused = false
    Buffer.from([0]),              // pause_slot None
    i64(0n),                       // total_paused_slots
    Buffer.alloc(32, 0x44),        // vk_hash_subscriber (attacker-chosen too)
    Buffer.from([0]),              // source_pool None
    Buffer.from([7]),              // bump
    Buffer.from([0]),              // client_stealth_meta None
    f.license ? Buffer.concat([Buffer.from([1]), Buffer.from(f.license)]) : Buffer.from([0]),
  ];
  return Buffer.concat(parts);
}

/**
 * Commitment-mode vault body — the shape `subscribe_private_stark` writes
 * (`subscriber_pubkey = None` at `:386`, `subscriber_commitment = Some` at
 * `:387`). Identical to {@link buildNormalVault} except for which of the two
 * subscriber options is populated, which is exactly why the PDA seeds, and
 * therefore every structural check, are the same for both.
 */
function buildPrivateVault(f: Parameters<typeof buildNormalVault>[0]): Buffer {
  const normal = buildNormalVault(f);
  const tail = normal.subarray(8 + 33 + 1); // past disc + Some(pubkey) + None
  return Buffer.concat([
    Buffer.from(VAULT_DISC),
    Buffer.from([0]),                                          // subscriber_pubkey None
    Buffer.concat([Buffer.from([1]), Buffer.from(f.subscriberId)]), // subscriber_commitment Some
    tail,
  ]);
}

function stubConnection(accounts: Record<string, { data: Buffer; owner: PublicKey }>, slot: number) {
  const conn = {
    async getAccountInfo(pk: PublicKey) {
      const hit = accounts[pk.toBase58()];
      if (!hit) return null;
      return { data: hit.data, owner: hit.owner, lamports: 1, executable: false, rentEpoch: 0 };
    },
    async getSlot() { return slot; },
    async getProgramAccounts() { throw new Error('the single-account path must not enumerate'); },
  };
  return conn as unknown as import('@solana/web3.js').Connection;
}

const MERCHANT = new PublicKey(new Uint8Array(32).fill(0x22));
const MINT = PublicKey.default; // native SOL, as the program records it
const ATTACKER = (() => { const s = new Uint8Array(32); for (let i = 0; i < 32; i++) s[i] = (i * 7 + 3) & 0xff; return s; })();

/** What the merchant actually sells: 0.05 SOL every ~1 day of slots. */
const REAL_SERVICE: ServiceScope = {
  retailer: MERCHANT,
  tokenMint: MINT,
  priceAtomic: 50_000_000n,
  intervalSlots: 216_000n,
};

/**
 * One lamport deposited, one lamport per period, a period a thousand years
 * long. `periodsPaidFor` = 1 and `periodsElapsed` = 0, for ever.
 */
const SELF_MINTED = {
  subscriberId: ATTACKER,
  retailer: MERCHANT,
  tokenMint: MINT,
  totalDeposited: 1n,
  rate: 1n,
  intervalSlots: 1_000_000_000_000n,
  startSlot: 1_000n,
};

const NOW = 480_000_000; // a real devnet slot, far past startSlot

describe('a vault the merchant never sold — the legacy wallet-keyed shape', () => {
  const [pda] = deriveSubscriptionVaultPda(MERCHANT, ATTACKER, MINT);
  const data = buildNormalVault(SELF_MINTED);
  const conn = stubConnection({ [pda.toBase58()]: { data, owner: PROGRAM } }, NOW);

  it('passes every structural check the single-account path makes', async () => {
    const fetched = await fetchVaultByAddress(conn, pda);
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    // Owned by the real program, names the real merchant, sits at the address
    // the program derives, and is "current" — because one lamport bought one
    // period and the period never ends.
    expect(fetched.vault.retailer.equals(MERCHANT)).toBe(true);
    expect(periodsPaidFor(fetched.vault)).toBe(1n);
    expect(subscriptionIsCurrent(fetched.vault, BigInt(NOW))).toBe(true);
  });

  it('IS GRANTED ACCESS when no service scope is supplied — for one lamport', async () => {
    // This is not a bug in `hasActiveVaultAccessForVault`; it is the honest
    // strength of every check it can make without knowing the merchant's price.
    // It is recorded here so no future doc can call the scope optional.
    const got = await hasActiveVaultAccessForVault(conn, pda, MERCHANT, ATTACKER);
    expect(got).not.toBeNull();
    expect(got!.totalDeposited).toBe(1n);
  });

  it('is DENIED once the merchant passes what it actually charges', async () => {
    const got = await hasActiveVaultAccessForVault(conn, pda, MERCHANT, ATTACKER, {
      service: REAL_SERVICE,
    });
    expect(got).toBeNull();
  });

  it('a genuine subscriber at the registered price still passes with the same scope', async () => {
    // The scope must not be a blanket refusal — it has to admit real customers.
    const honest = { ...SELF_MINTED, rate: 50_000_000n, intervalSlots: 216_000n, totalDeposited: 500_000_000n };
    const honestConn = stubConnection(
      { [pda.toBase58()]: { data: buildNormalVault(honest), owner: PROGRAM } },
      Number(1_000n + 216_000n),
    );
    const got = await hasActiveVaultAccessForVault(honestConn, pda, MERCHANT, ATTACKER, {
      currentSlot: 1_000n + 216_000n,
      service: REAL_SERVICE,
    });
    expect(got).not.toBeNull();
  });

  it('the license path behaves the same way — the commitment is attacker-chosen', async () => {
    // `license_commitment` is an instruction argument on the surviving
    // instruction too (`subscribe_private_stark.rs:74`, and it was
    // `subscribe_normal.rs:65` before that instruction was removed),
    // so whoever creates the vault picks the preimage. A matching key therefore
    // proves possession of a secret the attacker invented, nothing more.
    const secret = new Uint8Array(LICENSE_SECRET_BYTES).fill(0x5a);
    const withLicense = buildNormalVault({ ...SELF_MINTED, license: licenseCommitment(secret) });
    const c = stubConnection({ [pda.toBase58()]: { data: withLicense, owner: PROGRAM } }, NOW);
    const key = encodeLicenseKey(secret);

    const unscoped = await verifyLicenseAgainstVault(c, key, pda, MERCHANT, 'premium-tier');
    expect(unscoped.valid).toBe(true);

    const scoped = await verifyLicenseAgainstVault(c, key, pda, MERCHANT, 'premium-tier', {
      service: REAL_SERVICE,
    });
    expect(scoped.valid).toBe(false);
    expect(scoped.reason).toMatch(/not scoped to "premium-tier"/);
  });

  it('verifyLicenseAgainstVault does NOT check the canonical PDA, unlike the access path', async () => {
    // Documented here because the README claims the property for both. The
    // license path takes no subscriber ID, so it has no seed set to derive
    // from; the commitment is what binds, and it binds to whoever chose it.
    const secret = new Uint8Array(LICENSE_SECRET_BYTES).fill(0x5a);
    const impostorAddress = new PublicKey(new Uint8Array(32).fill(0x5c));
    const c = stubConnection(
      { [impostorAddress.toBase58()]: { data: buildNormalVault({ ...SELF_MINTED, license: licenseCommitment(secret) }), owner: PROGRAM } },
      NOW,
    );
    const res = await verifyLicenseAgainstVault(c, encodeLicenseKey(secret), impostorAddress, MERCHANT, 'x');
    expect(res.valid).toBe(true); // no PDA gate on this path — asserted, not wished away

    // The access path, given the same off-PDA address, refuses it.
    expect(await hasActiveVaultAccessForVault(c, impostorAddress, MERCHANT, ATTACKER)).toBeNull();
  });
});

/**
 * The same hole, on the only instruction that still exists.
 *
 * `subscribe_private_stark` fixes `total_deposited` to the pool's denomination,
 * so the one-lamport fixture above is no longer constructible. It leaves `rate`
 * free, which is enough: a rate of 1 turns a 0.1 SOL pool note into 100,000,000
 * paid-for periods. These four cases are the same four as above, re-run against
 * a body shaped the way the surviving instruction writes it, so that removing
 * `subscribe_normal` cannot be mistaken for closing this.
 */
describe('a vault the merchant never sold — the shape subscribe_private_stark writes', () => {
  /** One 0.1 SOL pool note, one atomic unit per period, the merchant's own interval. */
  const SELF_MINTED_PRIVATE = {
    subscriberId: ATTACKER,
    retailer: MERCHANT,
    tokenMint: MINT,
    totalDeposited: 100_000_000n, // pool.denomination — the attacker cannot choose it
    rate: 1n,                     // …but it can choose this
    intervalSlots: 216_000n,      // copied from what the merchant sells
    startSlot: 1_000n,
  };

  const [pda] = deriveSubscriptionVaultPda(MERCHANT, ATTACKER, MINT);
  const data = buildPrivateVault(SELF_MINTED_PRIVATE);
  const conn = stubConnection({ [pda.toBase58()]: { data, owner: PROGRAM } }, NOW);

  it('decodes as a commitment-keyed vault, not a wallet-keyed one', async () => {
    const fetched = await fetchVaultByAddress(conn, pda);
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(fetched.vault.subscriberPubkey).toBeNull();
    expect(fetched.vault.subscriberCommitment).not.toBeNull();
    expect(fetched.vault.retailer.equals(MERCHANT)).toBe(true);
  });

  it('is "current" for a hundred million periods, at the merchant own interval', async () => {
    const fetched = await fetchVaultByAddress(conn, pda);
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(periodsPaidFor(fetched.vault)).toBe(100_000_000n);
    expect(subscriptionIsCurrent(fetched.vault, BigInt(NOW))).toBe(true);
    // and still current 400 years of slots later
    expect(subscriptionIsCurrent(fetched.vault, 100_000_000_000n)).toBe(true);
  });

  it('IS GRANTED ACCESS when no service scope is supplied', async () => {
    const got = await hasActiveVaultAccessForVault(conn, pda, MERCHANT, ATTACKER);
    expect(got).not.toBeNull();
    expect(got!.rate).toBe(1n);
  });

  it('REFUSES to answer at all when requireService is set and the scope is absent', async () => {
    // The test above is the whole hole: omitting the scope silently degrades the
    // question, so the caller gets a confident answer to a weaker one than it
    // asked. `requireService` turns that into a refusal instead, and the message
    // says what the weaker question actually answers.
    await expect(
      hasActiveVaultAccessForVault(conn, pda, MERCHANT, ATTACKER, { requireService: true }),
    ).rejects.toThrow(/requireService is set but no service scope was supplied/);
  });

  it('does NOT refuse when requireService is set and the scope IS supplied', async () => {
    // Fail-closed must not become fail-always: with the scope present the check
    // runs normally and denies this vault on its merits, not on a missing option.
    await expect(
      hasActiveVaultAccessForVault(conn, pda, MERCHANT, ATTACKER, {
        requireService: true,
        service: REAL_SERVICE,
      }),
    ).resolves.toBeNull();
  });

  it('reports the skipped scope check for callers that cannot fail closed yet', async () => {
    const seen: Array<{ vault: string; retailer: string }> = [];
    const got = await hasActiveVaultAccessForVault(conn, pda, MERCHANT, ATTACKER, {
      onServiceUnchecked: (i) => seen.push(i),
    });
    expect(got).not.toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.retailer).toBe(MERCHANT.toBase58());
    expect(seen[0]!.vault).toBe(pda.toBase58());
  });

  it('does not fire the hook when the scope WAS checked', async () => {
    const seen: unknown[] = [];
    await hasActiveVaultAccessForVault(conn, pda, MERCHANT, ATTACKER, {
      service: REAL_SERVICE,
      onServiceUnchecked: (i) => seen.push(i),
    });
    expect(seen).toHaveLength(0);
  });

  it('never lets a throwing diagnostic hook break the check', async () => {
    const got = await hasActiveVaultAccessForVault(conn, pda, MERCHANT, ATTACKER, {
      onServiceUnchecked: () => {
        throw new Error('merchant logging blew up');
      },
    });
    expect(got).not.toBeNull();
  });

  it('is DENIED once the merchant passes what it actually charges', async () => {
    // The interval matches REAL_SERVICE exactly; only the price refuses it.
    const got = await hasActiveVaultAccessForVault(conn, pda, MERCHANT, ATTACKER, {
      service: REAL_SERVICE,
    });
    expect(got).toBeNull();
  });

  it('a genuine private subscriber at the registered price still passes with the same scope', async () => {
    const honest = { ...SELF_MINTED_PRIVATE, rate: 50_000_000n, totalDeposited: 500_000_000n };
    const honestConn = stubConnection(
      { [pda.toBase58()]: { data: buildPrivateVault(honest), owner: PROGRAM } },
      Number(1_000n + 216_000n),
    );
    const got = await hasActiveVaultAccessForVault(honestConn, pda, MERCHANT, ATTACKER, {
      currentSlot: 1_000n + 216_000n,
      service: REAL_SERVICE,
    });
    expect(got).not.toBeNull();
  });
});

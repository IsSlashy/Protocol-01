/**
 * What a `SubscriptionVault` proves about the person presenting it — and what
 * it does not.
 *
 * `subscribe_normal` is permissionless. Its accounts struct carries
 * `/// CHECK: Any pubkey can be a retailer` on an unsigned `AccountInfo`
 * (`programs/zk_shielded/src/instructions/subscribe_normal.rs:25-27`), and its
 * handler takes `rate`, `interval_slots` and `amount` straight from the
 * instruction data with only `> 0` required of each (lines 58-70). So ANYONE
 * can create a real, program-owned vault at the canonical PDA that names any
 * merchant as `retailer`, funded with one lamport, at a rate of one lamport,
 * with an interval long enough that `periodsElapsed` never reaches
 * `periodsPaidFor`. Nothing about that account is forged: the program wrote it.
 *
 * Every structural check on the single-account path passes on such a vault —
 * owner, discriminator, retailer field, canonical PDA, subscriber ID,
 * `subscriptionIsCurrent`. Only `opts.service` refuses it, because only the
 * registry knows what the merchant actually charges.
 *
 * These tests pin that: the scope is not a multi-product convenience, it is the
 * entire distance between "this account exists" and "this person paid you".
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

describe('a vault the merchant never sold', () => {
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
    // `license_commitment` is an instruction argument (`subscribe_normal.rs:65`),
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

import { describe, expect, it } from 'vitest';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import {
  buildClaimPeriodInstruction,
  claimableAmount,
  claimablePeriods,
  claimWouldStrandRetailer,
  CLAIM_PERIOD_DISCRIMINATOR,
  fundedPeriodsRemaining,
  periodsElapsed,
  periodsPaidFor,
  subscriptionIsCurrent,
  TOKEN_PROGRAM_ID,
} from './claim';
import { ZK_SHIELDED_PROGRAM_ID } from './vaults';

/**
 * Parity fixture for `SubscriptionVault::claimable_periods`
 * (`programs/zk_shielded/src/state/subscription_vault.rs:133`).
 *
 * Defaults describe a funded, active, unpaused vault: 12 periods paid for at
 * 1_000_000 atomic units each, 100 slots per period, started at slot 1_000.
 */
function vault(over: Partial<Parameters<typeof claimablePeriods>[0]> = {}) {
  return {
    isActive: true,
    isPaused: false,
    startSlot: 1_000n,
    totalPausedSlots: 0n,
    intervalSlots: 100n,
    claimedPeriods: 0n,
    totalDeposited: 12_000_000n,
    rate: 1_000_000n,
    ...over,
  };
}

describe('claimablePeriods — parity with the on-chain accrual', () => {
  it('accrues one period per interval_slots', () => {
    expect(claimablePeriods(vault(), 1_000n)).toBe(0n);
    expect(claimablePeriods(vault(), 1_099n)).toBe(0n);
    expect(claimablePeriods(vault(), 1_100n)).toBe(1n);
    expect(claimablePeriods(vault(), 1_550n)).toBe(5n);
  });

  it('subtracts periods already claimed', () => {
    expect(claimablePeriods(vault({ claimedPeriods: 3n }), 1_550n)).toBe(2n);
    expect(claimablePeriods(vault({ claimedPeriods: 5n }), 1_550n)).toBe(0n);
  });

  it('subtracts paused slots from the elapsed window', () => {
    expect(claimablePeriods(vault({ totalPausedSlots: 250n }), 1_550n)).toBe(3n);
  });

  it('returns 0 before the start slot and on a paused or inactive vault', () => {
    expect(claimablePeriods(vault(), 500n)).toBe(0n);
    expect(claimablePeriods(vault({ isPaused: true }), 1_550n)).toBe(0n);
    expect(claimablePeriods(vault({ isActive: false }), 1_550n)).toBe(0n);
  });

  it('clamps to the funded period count, never the elapsed one', () => {
    // 12 periods funded, 40 periods of time elapsed.
    expect(claimablePeriods(vault(), 5_000n)).toBe(12n);
    expect(claimableAmount(vault(), 5_000n)).toBe(12_000_000n);
  });

  it('refuses to build on a zero interval or a zero rate instead of dividing by zero', () => {
    // Both would panic in the u64 arithmetic on chain; the client must not
    // produce a transaction that is guaranteed to fail.
    expect(claimablePeriods(vault({ intervalSlots: 0n }), 5_000n)).toBe(0n);
    expect(claimablePeriods(vault({ rate: 0n }), 5_000n)).toBe(0n);
  });
});

describe('fundedPeriodsRemaining — the exhaustion signal `isActive` cannot give', () => {
  it('reports the periods a subscriber has still paid for', () => {
    expect(fundedPeriodsRemaining(vault())).toBe(12n);
    expect(fundedPeriodsRemaining(vault({ claimedPeriods: 9n }))).toBe(3n);
  });

  it('reaches zero on an exhausted vault that still reports isActive = true', () => {
    // This is the live defect: `is_active` is written `true` at
    // subscribe_private_stark.rs:395 (and was at subscribe_normal.rs:120 before
    // that instruction was removed) and `false`
    // NOWHERE in the program, so an exhausted subscription is indistinguishable
    // from a current one to any check that reads only that flag. The merchant
    // stops being paid and keeps serving.
    const exhausted = vault({ claimedPeriods: 12n });
    expect(exhausted.isActive).toBe(true);
    expect(fundedPeriodsRemaining(exhausted)).toBe(0n);
    expect(claimablePeriods(exhausted, 5_000n)).toBe(0n);
  });

  it('never underflows when claimed periods outran the funding', () => {
    expect(fundedPeriodsRemaining(vault({ claimedPeriods: 99n }))).toBe(0n);
  });
});

describe('subscriptionIsCurrent — the entitlement gate', () => {
  it('grants while the subscriber is inside a period they paid for', () => {
    // 12 periods funded, 100 slots each, started at 1_000.
    expect(subscriptionIsCurrent(vault(), 1_000n)).toBe(true); // period 0
    expect(subscriptionIsCurrent(vault(), 2_100n)).toBe(true); // period 11, the last paid one
  });

  it('denies the moment the subscription runs past what was paid for', () => {
    expect(subscriptionIsCurrent(vault(), 2_200n)).toBe(false); // period 12, one too far
    expect(subscriptionIsCurrent(vault(), 9_999n)).toBe(false);
  });

  it('ignores whether the retailer bothered to claim', () => {
    // A lazy retailer leaves fundedPeriodsRemaining high forever. Entitlement
    // is time paid for, not money collected, so the two must disagree here.
    const lazy = vault({ claimedPeriods: 0n });
    expect(fundedPeriodsRemaining(lazy)).toBe(12n);
    expect(subscriptionIsCurrent(lazy, 9_999n)).toBe(false);
  });

  it('denies a paused or inactive vault', () => {
    expect(subscriptionIsCurrent(vault({ isPaused: true }), 1_000n)).toBe(false);
    expect(subscriptionIsCurrent(vault({ isActive: false }), 1_000n)).toBe(false);
  });

  it('denies the exact devnet vault that was measured granting access', () => {
    // 6Uob9vKJitUq8MeSTNwWBqCgtSQ2pv8qVYjsznXnZq3L as it stood after the
    // 2026-08-01 claim: 5 periods funded at 100_000, all 5 claimed, interval 10,
    // started at slot 480_303_795. isActive was still true.
    const exhausted = vault({
      totalDeposited: 500_000n, rate: 100_000n, intervalSlots: 10n,
      startSlot: 480_303_795n, claimedPeriods: 5n,
    });
    expect(exhausted.isActive).toBe(true);
    expect(periodsPaidFor(exhausted)).toBe(5n);
    expect(periodsElapsed(exhausted, 480_303_923n)).toBe(12n);
    expect(subscriptionIsCurrent(exhausted, 480_303_923n)).toBe(false);
  });

  it('counts paused slots out of the elapsed window', () => {
    const paused = vault({ totalPausedSlots: 500n });
    expect(subscriptionIsCurrent(paused, 2_600n)).toBe(true); // 2_600-1_000-500 = 1_100 -> period 11
    expect(subscriptionIsCurrent(paused, 2_700n)).toBe(false);
  });
});

describe('claimWouldStrandRetailer — the rent floor', () => {
  const FLOOR = 890_880n;

  it('flags the measured devnet failure: empty retailer, 300k payout', () => {
    expect(claimWouldStrandRetailer(0n, 300_000n, FLOOR)).toBe(true);
  });

  it('passes once the payout alone clears the floor', () => {
    expect(claimWouldStrandRetailer(0n, FLOOR, FLOOR)).toBe(false);
    expect(claimWouldStrandRetailer(0n, 1_000_000n, FLOOR)).toBe(false);
  });

  it('passes once the retailer account already exists above the floor', () => {
    expect(claimWouldStrandRetailer(FLOOR, 300_000n, FLOOR)).toBe(false);
  });

  it('does not flag a zero payout, which moves nothing', () => {
    expect(claimWouldStrandRetailer(0n, 0n, FLOOR)).toBe(false);
  });
});

describe('buildClaimPeriodInstruction', () => {
  const vaultPda = new PublicKey('11111111111111111111111111111112');
  const retailer = new PublicKey('11111111111111111111111111111113');

  it('carries the claim_period discriminator and no arguments', () => {
    const ix = buildClaimPeriodInstruction(vaultPda, retailer);
    expect(ix.data).toEqual(Buffer.from(CLAIM_PERIOD_DISCRIMINATOR));
    expect(ix.data).toHaveLength(8);
  });

  it('orders accounts as ClaimPeriod<\'info> declares them', () => {
    const ix = buildClaimPeriodInstruction(vaultPda, retailer);
    expect(ix.keys).toHaveLength(6);
    expect(ix.keys[0]).toMatchObject({ pubkey: retailer, isSigner: true, isWritable: true });
    expect(ix.keys[1]).toMatchObject({ pubkey: vaultPda, isSigner: false, isWritable: true });
    expect(ix.keys[2].pubkey).toEqual(SystemProgram.programId);
  });

  it('fills the three optional slots with the program ID for a native SOL vault', () => {
    // Anchor 0.32 reads an optional account as `None` when the slot holds the
    // program's own ID.
    const ix = buildClaimPeriodInstruction(vaultPda, retailer);
    for (const i of [3, 4, 5]) {
      expect(ix.keys[i].pubkey).toEqual(ZK_SHIELDED_PROGRAM_ID);
      expect(ix.keys[i].isWritable).toBe(false);
    }
  });

  it('fills them with real token accounts for an SPL vault', () => {
    const vaultToken = new PublicKey('11111111111111111111111111111114');
    const retailerToken = new PublicKey('11111111111111111111111111111115');
    const ix = buildClaimPeriodInstruction(vaultPda, retailer, {
      vaultTokenAccount: vaultToken,
      retailerTokenAccount: retailerToken,
    });
    expect(ix.keys[3].pubkey).toEqual(TOKEN_PROGRAM_ID);
    expect(ix.keys[4]).toMatchObject({ pubkey: vaultToken, isWritable: true });
    expect(ix.keys[5]).toMatchObject({ pubkey: retailerToken, isWritable: true });
  });

  it('refuses a half-specified SPL vault rather than silently building a native claim', () => {
    const t = new PublicKey('11111111111111111111111111111114');
    expect(() => buildClaimPeriodInstruction(vaultPda, retailer, { vaultTokenAccount: t })).toThrow(
      /BOTH vaultTokenAccount and retailerTokenAccount/,
    );
    expect(() =>
      buildClaimPeriodInstruction(vaultPda, retailer, { retailerTokenAccount: t }),
    ).toThrow(/BOTH vaultTokenAccount and retailerTokenAccount/);
  });
});

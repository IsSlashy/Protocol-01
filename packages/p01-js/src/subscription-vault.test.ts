import { describe, it, expect } from 'vitest';
// The canonical implementation, imported by RELATIVE PATH on purpose.
// `packages/merchant-sdk/src/period-math.ts` has no imports of its own, so this
// costs nothing at test time and does NOT make p01-js depend on the merchant
// SDK — the published bundle still contains only the local port below.
import {
  ENTITLEMENT_PARITY_VECTORS,
  claimablePeriods as canonicalClaimable,
  fundedPeriodsRemaining as canonicalFunded,
  subscriptionEndSlot as canonicalEndSlot,
  subscriptionIsCurrent as canonicalIsCurrent,
  type VaultPeriodState,
} from '../../merchant-sdk/src/period-math';
import {
  computeAlreadyPaidToRetailer,
  computeClaimable,
  computeClaimableAmount,
  computeOutstandingToRetailer,
  fundedPeriodsRemaining,
  nextClaimableSlot,
  periodsElapsed,
  periodsPaidFor,
  subscriptionEndSlot,
  subscriptionIsCurrent,
  type VaultInfo,
} from './subscription-vault';

/**
 * p01-js decodes every u64 through `Number(...)`, so a vault whose fields
 * exceed 2^53-1 cannot be represented here at all. Rather than pretend, the
 * parity run skips those vectors and this list names exactly which — if a new
 * unrepresentable vector appears it shows up as a failure of the count check
 * below, not as a silent skip.
 */
const NOT_REPRESENTABLE_AS_DOUBLE = [
  'large values stay exact in bigint (would lose precision as a double)',
];

function isRepresentable(v: VaultPeriodState): boolean {
  return [
    v.startSlot,
    v.totalPausedSlots,
    v.intervalSlots,
    v.claimedPeriods,
    v.totalDeposited,
    v.rate,
  ].every((n) => n <= BigInt(Number.MAX_SAFE_INTEGER));
}

function toVaultInfo(v: VaultPeriodState): VaultInfo {
  return {
    address: 'Vau1t1111111111111111111111111111111111111',
    subscriberPubkey: null,
    subscriberCommitment: null,
    retailer: 'Reta11er111111111111111111111111111111111',
    tokenMint: '11111111111111111111111111111111',
    totalDeposited: Number(v.totalDeposited),
    rate: Number(v.rate),
    intervalSlots: Number(v.intervalSlots),
    startSlot: Number(v.startSlot),
    claimedPeriods: Number(v.claimedPeriods),
    isActive: v.isActive,
    isPaused: v.isPaused,
    pauseSlot: null,
    totalPausedSlots: Number(v.totalPausedSlots),
    sourcePool: null,
    isNormalMode: true,
    isPrivateMode: false,
  };
}

describe('p01-js period math is pinned to packages/merchant-sdk/src/period-math', () => {
  const runnable = ENTITLEMENT_PARITY_VECTORS.filter((v) => isRepresentable(v.vault));

  it('skips exactly the vectors a double cannot hold', () => {
    const skipped = ENTITLEMENT_PARITY_VECTORS.filter((v) => !isRepresentable(v.vault)).map(
      (v) => v.name,
    );
    expect(skipped).toEqual(NOT_REPRESENTABLE_AS_DOUBLE);
  });

  it('runs the whole rest of the shared table', () => {
    expect(runnable.length).toBe(ENTITLEMENT_PARITY_VECTORS.length - 1);
    expect(runnable.length).toBeGreaterThanOrEqual(17);
  });

  for (const v of runnable) {
    it(`matches the canonical answers: ${v.name}`, () => {
      const info = toVaultInfo(v.vault);
      const slot = Number(v.currentSlot);

      // Against the hand-written table…
      expect(subscriptionIsCurrent(info, slot)).toBe(v.isCurrent);
      expect(computeClaimable(info, slot)).toBe(Number(v.claimable));
      expect(fundedPeriodsRemaining(info)).toBe(Number(v.fundedRemaining));

      // …and against the canonical implementation, so the two copies cannot
      // drift even if the table is later extended without updating this file.
      expect(subscriptionIsCurrent(info, slot)).toBe(canonicalIsCurrent(v.vault, v.currentSlot));
      expect(computeClaimable(info, slot)).toBe(Number(canonicalClaimable(v.vault, v.currentSlot)));
      expect(fundedPeriodsRemaining(info)).toBe(Number(canonicalFunded(v.vault)));

      const canonicalEnd = canonicalEndSlot(v.vault);
      expect(subscriptionEndSlot(info)).toBe(canonicalEnd === null ? null : Number(canonicalEnd));
    });
  }
});

describe('the max_funded clamp this port was missing', () => {
  /** 350,000 lamports at 100,000/period buys 3 periods, of 100 slots each. */
  function partiallyFunded(): VaultInfo {
    return toVaultInfo({
      isActive: true,
      isPaused: false,
      startSlot: 1_000n,
      totalPausedSlots: 0n,
      intervalSlots: 100n,
      claimedPeriods: 0n,
      totalDeposited: 350_000n,
      rate: 100_000n,
    });
  }

  it('caps claimable periods at what the deposit actually bought', () => {
    // Five periods of wall clock have gone by; only three were ever funded.
    expect(computeClaimable(partiallyFunded(), 1_500)).toBe(3);
  });

  it('MEASURED CONSEQUENCE: the 50,000-lamport remainder stays owed to the retailer', () => {
    // Before the clamp, computeClaimable returned 5 and total owed came out at
    // 500,000 against a 350,000 deposit. That number used to drive the refund
    // preview; it now drives what the retailer is still owed. Either way it has
    // to be 50,000 and not 0.
    expect(computeOutstandingToRetailer(partiallyFunded())).toBe(350_000);
    const afterThreeClaims = { ...partiallyFunded(), claimedPeriods: 3 };
    expect(computeOutstandingToRetailer(afterThreeClaims)).toBe(50_000);
  });

  it('pays whole funded periods only, and carries the sub-period remainder', () => {
    // 3 whole periods × 100,000 = 300,000 claimable now; the 50,000 that never
    // bought a whole period is NOT refundable — it is swept to the retailer
    // when the vault is closed on the final claim.
    const v = partiallyFunded();
    expect(computeClaimableAmount(v, 9_999)).toBe(300_000);
    const afterFinalClaim = { ...v, claimedPeriods: 3 };
    expect(computeClaimableAmount(afterFinalClaim, 9_999)).toBe(0);
    expect(computeOutstandingToRetailer(afterFinalClaim)).toBe(50_000);
  });

  it('THE FOUNDER INVARIANT: paid + outstanding is total_deposited at every slot', () => {
    // Over the life of the vault the retailer receives exactly total_deposited.
    // No lamport ever returns to the subscriber, so there is no third bucket.
    const v = partiallyFunded();
    for (let claimed = 0; claimed <= 3; claimed++) {
      const at = { ...v, claimedPeriods: claimed };
      expect(computeAlreadyPaidToRetailer(at) + computeOutstandingToRetailer(at))
        .toBe(v.totalDeposited);
    }
  });

  it('pause moves WHEN the retailer is paid, never HOW MUCH', () => {
    const running = partiallyFunded();
    const paused = { ...running, isPaused: true };
    // Different amounts claimable right now…
    expect(computeClaimable(running, 1_500)).toBe(3);
    expect(computeClaimable(paused, 1_500)).toBe(0);
    // …identical amounts owed over the life of the vault.
    expect(computeOutstandingToRetailer(running)).toBe(350_000);
    expect(computeOutstandingToRetailer(paused)).toBe(350_000);
  });

  it('an exhausted vault claims nothing even though isActive is still true', () => {
    const v = toVaultInfo({
      isActive: true,
      isPaused: false,
      startSlot: 1_000n,
      totalPausedSlots: 0n,
      intervalSlots: 100n,
      claimedPeriods: 5n,
      totalDeposited: 500_000n,
      rate: 100_000n,
    });
    expect(v.isActive).toBe(true);
    expect(computeClaimable(v, 9_999)).toBe(0);
    expect(computeClaimableAmount(v, 9_999)).toBe(0);
    expect(subscriptionIsCurrent(v, 9_999)).toBe(false);
  });

  it('nextClaimableSlot stops naming a slot once the funding is gone', () => {
    // The same `isActive` defect one function over: this answered from a flag
    // the program never clears, so an exhausted subscription was told to come
    // back at slot 1,600 — where `claim_period` will return NoClaimablePeriods
    // for ever, because claimable_periods is clamped by max_funded.
    const exhausted = toVaultInfo({
      isActive: true,
      isPaused: false,
      startSlot: 1_000n,
      totalPausedSlots: 0n,
      intervalSlots: 100n,
      claimedPeriods: 5n,
      totalDeposited: 500_000n,
      rate: 100_000n,
    });
    expect(exhausted.isActive).toBe(true);
    expect(fundedPeriodsRemaining(exhausted)).toBe(0);
    expect(computeClaimable(exhausted, 9_999)).toBe(0);
    expect(nextClaimableSlot(exhausted)).toBeNull();
  });

  it('nextClaimableSlot still answers while periods remain funded', () => {
    const live = toVaultInfo({
      isActive: true,
      isPaused: false,
      startSlot: 1_000n,
      totalPausedSlots: 0n,
      intervalSlots: 100n,
      claimedPeriods: 2n,
      totalDeposited: 500_000n,
      rate: 100_000n,
    });
    expect(nextClaimableSlot(live)).toBe(1_300);
  });

  it('nextClaimableSlot refuses a zero interval rather than naming the start slot', () => {
    const broken = toVaultInfo({
      isActive: true,
      isPaused: false,
      startSlot: 1_000n,
      totalPausedSlots: 0n,
      intervalSlots: 0n,
      claimedPeriods: 0n,
      totalDeposited: 500_000n,
      rate: 100_000n,
    });
    expect(nextClaimableSlot(broken)).toBeNull();
  });

  it('intervalSlots 0 no longer yields Infinity claimable periods', () => {
    const v = toVaultInfo({
      isActive: true,
      isPaused: false,
      startSlot: 1_000n,
      totalPausedSlots: 0n,
      intervalSlots: 0n,
      claimedPeriods: 0n,
      totalDeposited: 500_000n,
      rate: 100_000n,
    });
    expect(computeClaimable(v, 2_000)).toBe(0);
    expect(Number.isFinite(computeClaimable(v, 2_000))).toBe(true);
    expect(periodsElapsed(v, 2_000)).toBe(0);
    expect(periodsPaidFor(v)).toBe(5);
    // …and the gate still refuses, rather than reading "period 0 of 5 forever".
    expect(subscriptionIsCurrent(v, 2_000)).toBe(false);
  });
});

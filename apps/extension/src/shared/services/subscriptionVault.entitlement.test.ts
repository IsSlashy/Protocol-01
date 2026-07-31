import { describe, it, expect } from 'vitest';
// The canonical implementation, imported by RELATIVE PATH on purpose.
// `packages/merchant-sdk/src/period-math.ts` imports nothing, so pulling it in
// here costs the test environment nothing and adds no runtime dependency to
// the MV3 bundle — the extension keeps its own copy below.
import {
  ENTITLEMENT_PARITY_VECTORS,
  entitlementStatus as canonicalStatus,
  claimablePeriods as canonicalClaimable,
  fundedPeriodsRemaining as canonicalFunded,
  subscriptionEndSlot as canonicalEndSlot,
  subscriptionIsCurrent as canonicalIsCurrent,
  type VaultPeriodState,
} from '../../../../../packages/merchant-sdk/src/period-math';
import {
  computeClaimable,
  computeClaimableAmount,
  computeRefundable,
  entitlementStatus,
  fundedPeriodsRemaining,
  periodsElapsed,
  periodsPaidFor,
  subscriptionEndSlot,
  subscriptionIsCurrent,
} from './subscriptionVault';
import type { VaultInfo } from './subscriptionVault.types';

/**
 * The extension decodes every u64 through `Number(...)`, so vault fields above
 * 2^53-1 cannot be represented. Named explicitly rather than skipped silently.
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

describe('extension period math is pinned to packages/merchant-sdk/src/period-math', () => {
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

      expect(subscriptionIsCurrent(info, slot)).toBe(v.isCurrent);
      expect(computeClaimable(info, slot)).toBe(Number(v.claimable));
      expect(fundedPeriodsRemaining(info)).toBe(Number(v.fundedRemaining));

      expect(subscriptionIsCurrent(info, slot)).toBe(canonicalIsCurrent(v.vault, v.currentSlot));
      expect(computeClaimable(info, slot)).toBe(Number(canonicalClaimable(v.vault, v.currentSlot)));
      expect(fundedPeriodsRemaining(info)).toBe(Number(canonicalFunded(v.vault)));

      const canonicalEnd = canonicalEndSlot(v.vault);
      expect(subscriptionEndSlot(info)).toBe(canonicalEnd === null ? null : Number(canonicalEnd));

      expect(entitlementStatus(info, slot)).toBe(v.status);
      expect(entitlementStatus(info, slot)).toBe(canonicalStatus(v.vault, v.currentSlot));
    });
  }
});

describe('the popup badge cannot say ACTIVE off a stale slot', () => {
  const v = toVaultInfo({
    isActive: true,
    isPaused: false,
    startSlot: 1_000n,
    totalPausedSlots: 0n,
    intervalSlots: 100n,
    claimedPeriods: 0n,
    totalDeposited: 500_000n,
    rate: 100_000n,
  });

  it('the store initialises and PERSISTS currentSlot at 0', () => {
    // At slot 0 the raw predicate is optimistic; the badge helper is not.
    expect(subscriptionIsCurrent(v, 0)).toBe(true);
    expect(entitlementStatus(v, 0)).toBe('unknown');
  });

  it('a slot from before the vault existed is also unknown', () => {
    expect(entitlementStatus(v, 999)).toBe('unknown');
    expect(entitlementStatus(v, 1_000)).toBe('current');
  });

  it('THE UI BUG: an exhausted vault reads ended where it used to read ACTIVE', () => {
    const exhausted = { ...v, claimedPeriods: 5 };
    expect(exhausted.isActive).toBe(true);
    expect(exhausted.isPaused).toBe(false);
    expect(entitlementStatus(exhausted, 1_500)).toBe('ended');
  });
});

describe('the max_funded clamp the extension was missing', () => {
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
    expect(computeClaimable(partiallyFunded(), 1_500)).toBe(3);
  });

  it('MEASURED CONSEQUENCE: the subscriber gets their 50,000-lamport refund back', () => {
    // Before the clamp: claimable read 5, total owed came out at 500,000
    // against a 350,000 deposit, and the cancel screen offered a 0 refund.
    expect(computeRefundable(partiallyFunded(), 1_500)).toBe(50_000);
  });

  it('pays whole funded periods only', () => {
    const v = partiallyFunded();
    expect(computeClaimableAmount(v, 9_999)).toBe(300_000);
    expect(computeClaimableAmount(v, 9_999) + computeRefundable(v, 9_999)).toBe(v.totalDeposited);
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
    expect(subscriptionIsCurrent(v, 9_999)).toBe(false);
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
    expect(Number.isFinite(computeClaimable(v, 2_000))).toBe(true);
    expect(computeClaimable(v, 2_000)).toBe(0);
    expect(periodsElapsed(v, 2_000)).toBe(0);
    expect(periodsPaidFor(v)).toBe(5);
    expect(subscriptionIsCurrent(v, 2_000)).toBe(false);
  });
});

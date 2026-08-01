import { describe, it, expect } from 'vitest';
// The canonical implementation, imported by RELATIVE PATH on purpose.
// `packages/merchant-sdk/src/period-math.ts` imports nothing, so pulling it in
// here costs the test environment nothing and adds no runtime dependency to
// the React Native bundle — the app keeps its own copy below.
import {
  ENTITLEMENT_PARITY_VECTORS,
  claimablePeriods as canonicalClaimable,
  entitlementStatus as canonicalStatus,
  fundedPeriodsRemaining as canonicalFunded,
  subscriptionEndSlot as canonicalEndSlot,
  subscriptionIsCurrent as canonicalIsCurrent,
  type VaultPeriodState,
} from '../../../../packages/merchant-sdk/src/period-math';
import {
  computeSubscriptionOutlook,
  computeClaimable,
  computeClaimableAmount,
  entitlementStatus,
  fundedPeriodsRemaining,
  periodsElapsed,
  periodsPaidFor,
  subscriptionEndSlot,
  subscriptionIsCurrent,
  type VaultInfo,
} from './index';

function toVaultInfo(v: VaultPeriodState): VaultInfo {
  return {
    address: 'Vau1t1111111111111111111111111111111111111',
    subscriberPubkey: null,
    subscriberCommitment: null,
    retailer: 'Reta11er111111111111111111111111111111111',
    tokenMint: '11111111111111111111111111111111',
    totalDeposited: v.totalDeposited,
    rate: v.rate,
    intervalSlots: v.intervalSlots,
    startSlot: v.startSlot,
    claimedPeriods: v.claimedPeriods,
    isActive: v.isActive,
    isPaused: v.isPaused,
    pauseSlot: null,
    totalPausedSlots: v.totalPausedSlots,
    sourcePool: null,
    isNormalMode: true,
    isPrivateMode: false,
    clientStealthMeta: null,
  };
}

describe('mobile period math is pinned to packages/merchant-sdk/src/period-math', () => {
  // Mobile keeps every vault field as bigint, so unlike the extension and
  // p01-js ports it can run the WHOLE table — including the row a double
  // cannot hold. `computeClaimable` still returns a Number, so only the
  // period COUNT is capped, never the amounts.
  it('runs every vector, with no representability skips', () => {
    expect(ENTITLEMENT_PARITY_VECTORS.length).toBeGreaterThanOrEqual(18);
  });

  for (const v of ENTITLEMENT_PARITY_VECTORS) {
    it(`matches the canonical answers: ${v.name}`, () => {
      const info = toVaultInfo(v.vault);
      const slot = Number(v.currentSlot);

      expect(subscriptionIsCurrent(info, slot)).toBe(v.isCurrent);
      expect(fundedPeriodsRemaining(info)).toBe(v.fundedRemaining);
      expect(entitlementStatus(info, slot)).toBe(v.status);

      expect(subscriptionIsCurrent(info, slot)).toBe(canonicalIsCurrent(v.vault, v.currentSlot));
      expect(fundedPeriodsRemaining(info)).toBe(canonicalFunded(v.vault));
      expect(entitlementStatus(info, slot)).toBe(canonicalStatus(v.vault, v.currentSlot));
      expect(subscriptionEndSlot(info)).toBe(canonicalEndSlot(v.vault));

      // `computeClaimable` narrows to Number on the way out; every vector's
      // claimable count is small enough for that to be lossless.
      const canonical = canonicalClaimable(v.vault, v.currentSlot);
      expect(canonical).toBeLessThanOrEqual(BigInt(Number.MAX_SAFE_INTEGER));
      expect(computeClaimable(info, slot)).toBe(Number(v.claimable));
      expect(computeClaimable(info, slot)).toBe(Number(canonical));
    });
  }
});

describe('the max_funded clamp mobile was missing', () => {
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

  it('MEASURED CONSEQUENCE: the 50,000-lamport remainder stays owed to the retailer', () => {
    // This used to be the cancel sheet's refund quote: 3 whole periods claimable
    // and 50,000 of sub-period dust handed back to the subscriber. Cancellation
    // and refunds are gone, so the same 50,000 is now money the RETAILER is
    // still owed and will receive when claim_period closes the vault.
    const outlook = computeSubscriptionOutlook(partiallyFunded(), 1_500);
    expect(outlook.claimablePeriods).toBe(3n);
    expect(outlook.claimableAmount).toBe(300_000n);
    expect(outlook.alreadyPaidToRetailer).toBe(0n);
    expect(outlook.outstandingToRetailer).toBe(350_000n);

    // …and after the retailer has swept those 3 periods, exactly 50,000 remains.
    const afterThree = { ...partiallyFunded(), claimedPeriods: 3n };
    const settled = computeSubscriptionOutlook(afterThree, 9_999);
    expect(settled.claimableAmount).toBe(0n);
    expect(settled.outstandingToRetailer).toBe(50_000n);
  });

  it('THE FOUNDER INVARIANT: paid + outstanding is total_deposited at every slot', () => {
    // A subscription is a one-way prepaid envelope. Over its life the retailer
    // receives exactly total_deposited and no lamport returns to the subscriber,
    // so there is no third bucket for the split to leak into.
    const base = partiallyFunded();
    for (let claimed = 0n; claimed <= 3n; claimed++) {
      const outlook = computeSubscriptionOutlook(
        { ...base, claimedPeriods: claimed },
        9_999,
      );
      expect(outlook.alreadyPaidToRetailer + outlook.outstandingToRetailer)
        .toBe(base.totalDeposited);
    }
  });

  it('pause moves WHEN the retailer is paid, never HOW MUCH', () => {
    const running = computeSubscriptionOutlook(partiallyFunded(), 1_500);
    const paused = computeSubscriptionOutlook(
      { ...partiallyFunded(), isPaused: true },
      1_500,
    );
    // Claimable right now differs...
    expect(running.claimablePeriods).toBe(3n);
    expect(paused.claimablePeriods).toBe(0n);
    // ...the amount owed over the life of the vault does not.
    expect(running.outstandingToRetailer).toBe(350_000n);
    expect(paused.outstandingToRetailer).toBe(350_000n);
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
    expect(computeClaimableAmount(v, 9_999)).toBe(0n);
    expect(subscriptionIsCurrent(v, 9_999)).toBe(false);
    expect(entitlementStatus(v, 9_999)).toBe('ended');
  });

  it('intervalSlots 0 no longer throws a bigint division by zero', () => {
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
    expect(() => computeClaimable(v, 2_000)).not.toThrow();
    expect(computeClaimable(v, 2_000)).toBe(0);
    expect(periodsElapsed(v, 2_000)).toBe(0n);
    expect(periodsPaidFor(v)).toBe(5n);
    expect(subscriptionIsCurrent(v, 2_000)).toBe(false);
  });
});

describe('the vault screens cannot say Active before the slot poll lands', () => {
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

  it('both screens hold currentSlot null on first render and pass 0', () => {
    // subscription-vaults.tsx and vault-detail.tsx both start at `null` and
    // fetch the slot in an effect, so the first paint happens with no clock.
    // The raw predicate is optimistic there; the badge helper is not.
    expect(subscriptionIsCurrent(v, 0)).toBe(true);
    expect(entitlementStatus(v, 0)).toBe('unknown');
  });

  it('a slot from before the vault existed is also unknown', () => {
    expect(entitlementStatus(v, 999)).toBe('unknown');
    expect(entitlementStatus(v, 1_000)).toBe('current');
  });
});

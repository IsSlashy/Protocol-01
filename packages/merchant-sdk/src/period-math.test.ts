import { describe, it, expect } from 'vitest';
import {
  ENTITLEMENT_PARITY_VECTORS,
  NOMINAL_SLOT_MS,
  claimablePeriods,
  entitlementStatus,
  fundedPeriodsRemaining,
  periodsElapsed,
  periodsPaidFor,
  secondsUntilSubscriptionEnds,
  slotsUntilSubscriptionEnds,
  subscriptionEndSlot,
  subscriptionIsCurrent,
  type VaultPeriodState,
} from './period-math';

function vault(over: Partial<VaultPeriodState> = {}): VaultPeriodState {
  return {
    isActive: true,
    isPaused: false,
    startSlot: 1_000n,
    totalPausedSlots: 0n,
    intervalSlots: 100n,
    claimedPeriods: 0n,
    totalDeposited: 500_000n,
    rate: 100_000n,
    ...over,
  };
}

describe('ENTITLEMENT_PARITY_VECTORS — the table every port is pinned to', () => {
  it('covers the shapes that matter', () => {
    // Guards against a future edit quietly deleting rows: a shrunken table
    // would still "pass" everywhere while checking nothing.
    expect(ENTITLEMENT_PARITY_VECTORS.length).toBeGreaterThanOrEqual(18);
    const names = new Set(ENTITLEMENT_PARITY_VECTORS.map((v) => v.name));
    expect(names.size).toBe(ENTITLEMENT_PARITY_VECTORS.length);
  });

  it('at least one row is an exhausted-but-isActive vault', () => {
    const measured = ENTITLEMENT_PARITY_VECTORS.filter(
      (v) => v.vault.isActive && !v.vault.isPaused && !v.isCurrent,
    );
    expect(measured.length).toBeGreaterThan(0);
  });

  for (const v of ENTITLEMENT_PARITY_VECTORS) {
    it(`canonical implementation matches: ${v.name}`, () => {
      expect(subscriptionIsCurrent(v.vault, v.currentSlot)).toBe(v.isCurrent);
      expect(claimablePeriods(v.vault, v.currentSlot)).toBe(v.claimable);
      expect(fundedPeriodsRemaining(v.vault)).toBe(v.fundedRemaining);
      expect(entitlementStatus(v.vault, v.currentSlot)).toBe(v.status);
    });
  }
});

describe('entitlementStatus — what a screen is allowed to say', () => {
  it('never says current off a slot the app has not fetched yet', () => {
    // Zustand stores in this repo persist `currentSlot` and initialise it to 0.
    expect(subscriptionIsCurrent(vault(), 0n)).toBe(true);
    expect(entitlementStatus(vault(), 0n)).toBe('unknown');
  });

  it('never says current off a slot older than the vault itself', () => {
    expect(entitlementStatus(vault(), 999n)).toBe('unknown');
    expect(entitlementStatus(vault(), 1_000n)).toBe('current');
  });

  it('reports paused and inactive before it looks at the clock', () => {
    expect(entitlementStatus(vault({ isPaused: true }), 0n)).toBe('paused');
    expect(entitlementStatus(vault({ isActive: false }), 0n)).toBe('inactive');
  });

  it('THE UI BUG: the exhausted devnet vault reads ended, not active', () => {
    const exhausted = vault({ claimedPeriods: 5n });
    expect(exhausted.isActive).toBe(true);
    expect(exhausted.isPaused).toBe(false);
    expect(entitlementStatus(exhausted, 1_500n)).toBe('ended');
  });
});

describe('subscriptionEndSlot', () => {
  it('is start + paused + paidFor * interval', () => {
    expect(subscriptionEndSlot(vault())).toBe(1_500n);
  });

  it('moves later by exactly the accumulated pause credit', () => {
    expect(subscriptionEndSlot(vault({ totalPausedSlots: 250n }))).toBe(1_750n);
  });

  it('is null while paused — a paused vault entitles nobody', () => {
    expect(subscriptionEndSlot(vault({ isPaused: true }))).toBeNull();
  });

  it('is null when rate is 0 (nothing was ever paid for)', () => {
    expect(subscriptionEndSlot(vault({ rate: 0n }))).toBeNull();
  });

  it('is null when intervalSlots is 0 (period length undefined)', () => {
    expect(subscriptionEndSlot(vault({ intervalSlots: 0n }))).toBeNull();
  });

  it('is null when the deposit did not cover one whole period', () => {
    expect(subscriptionEndSlot(vault({ totalDeposited: 99_999n }))).toBeNull();
  });

  it('is exactly the first slot at which subscriptionIsCurrent flips to false', () => {
    const v = vault();
    const end = subscriptionEndSlot(v)!;
    expect(subscriptionIsCurrent(v, end - 1n)).toBe(true);
    expect(subscriptionIsCurrent(v, end)).toBe(false);
  });

  it('ignores claimedPeriods — collection does not shorten entitlement', () => {
    expect(subscriptionEndSlot(vault({ claimedPeriods: 5n }))).toBe(
      subscriptionEndSlot(vault({ claimedPeriods: 0n })),
    );
  });
});

describe('slotsUntilSubscriptionEnds / secondsUntilSubscriptionEnds', () => {
  it('counts down to the end slot', () => {
    expect(slotsUntilSubscriptionEnds(vault(), 1_100n)).toBe(400n);
  });

  it('floors at zero once the subscription is over', () => {
    expect(slotsUntilSubscriptionEnds(vault(), 9_999n)).toBe(0n);
  });

  it('is zero while paused, so no deadline can be derived from a paused vault', () => {
    expect(slotsUntilSubscriptionEnds(vault({ isPaused: true }), 1_100n)).toBe(0n);
  });

  it('converts at the nominal slot time and rounds DOWN', () => {
    // 400 slots × 400 ms = 160_000 ms = 160 s
    expect(secondsUntilSubscriptionEnds(vault(), 1_100n)).toBe(160n);
    expect(NOMINAL_SLOT_MS).toBe(400n);
  });

  it('rounds down on a partial second rather than up', () => {
    // 1 slot × 400 ms = 0.4 s -> 0
    expect(secondsUntilSubscriptionEnds(vault(), 1_499n)).toBe(0n);
  });

  it('accepts a measured slot time but refuses a non-positive one', () => {
    expect(secondsUntilSubscriptionEnds(vault(), 1_100n, 500n)).toBe(200n);
    expect(() => secondsUntilSubscriptionEnds(vault(), 1_100n, 0n)).toThrow(/positive/);
  });
});

describe('the fail-closed cases', () => {
  it('intervalSlots 0 is NOT current — it would otherwise entitle forever', () => {
    // periodsElapsed can only report 0 with an undefined period length, and
    // `0 < periodsPaidFor` is true, so an unguarded gate would serve for ever.
    expect(periodsElapsed(vault({ intervalSlots: 0n }), 9_999_999n)).toBe(0n);
    expect(periodsPaidFor(vault({ intervalSlots: 0n }))).toBe(5n);
    expect(subscriptionIsCurrent(vault({ intervalSlots: 0n }), 9_999_999n)).toBe(false);
  });

  it('rate 0 buys zero periods, so nothing is ever current or claimable', () => {
    expect(periodsPaidFor(vault({ rate: 0n }))).toBe(0n);
    expect(subscriptionIsCurrent(vault({ rate: 0n }), 1_050n)).toBe(false);
    expect(claimablePeriods(vault({ rate: 0n }), 5_000n)).toBe(0n);
  });
});

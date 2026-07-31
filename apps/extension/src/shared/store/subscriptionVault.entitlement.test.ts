/**
 * The store selector the popup badge actually reads.
 *
 * `subscriptionVault.entitlement.test.ts` (services) pins the arithmetic.
 * Nothing pinned the wiring: `getEntitlementStatus` could be replaced with
 * `return 'current'` — every subscription rendered ACTIVE, i.e. exactly the bug
 * — and all 122 extension tests stayed green. This file closes that.
 *
 * `SubscriptionVaults.tsx` itself cannot be covered here: `vitest.config.ts`
 * excludes `src/popup/**` because react-router-dom pulls a second React copy
 * and every `render()` throws. The store is the last layer that IS testable,
 * and it is the single place the badge's answer is decided.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useSubscriptionVaultStore } from './subscriptionVault';
import type { VaultInfo } from '../services/subscriptionVault.types';

/** 500,000 lamports at 100,000/period buys 5 periods of 100 slots from 1,000. */
function vault(over: Partial<VaultInfo> = {}): VaultInfo {
  return {
    address: 'Vau1t1111111111111111111111111111111111111',
    subscriberPubkey: null,
    subscriberCommitment: null,
    retailer: 'Reta11er111111111111111111111111111111111',
    tokenMint: '11111111111111111111111111111111',
    totalDeposited: 500_000,
    rate: 100_000,
    intervalSlots: 100,
    startSlot: 1_000,
    claimedPeriods: 0,
    isActive: true,
    isPaused: false,
    pauseSlot: null,
    totalPausedSlots: 0,
    sourcePool: null,
    isNormalMode: true,
    isPrivateMode: false,
    ...over,
  } as VaultInfo;
}

function seed(v: VaultInfo, currentSlot: number) {
  useSubscriptionVaultStore.setState({ vaults: [v], currentSlot });
}

describe('getEntitlementStatus — the badge the popup renders', () => {
  beforeEach(() => {
    useSubscriptionVaultStore.setState({ vaults: [], currentSlot: 0 });
  });

  it('says current inside the funded window', () => {
    seed(vault(), 1_250);
    expect(useSubscriptionVaultStore.getState().getEntitlementStatus(vault().address)).toBe(
      'current',
    );
  });

  it('THE BUG: an exhausted subscription is ended, not ACTIVE', () => {
    // isActive is still true — the program writes it true at subscribe and
    // false nowhere — and this is the state MEASURED on devnet vault
    // 6Uob9vKJitUq8MeSTNwWBqCgtSQ2pv8qVYjsznXnZq3L: claimed_periods 5 of 5
    // funded, residual balance 0, is_active true.
    const v = vault({ claimedPeriods: 5 });
    seed(v, 1_500);
    const state = useSubscriptionVaultStore.getState();
    expect(v.isActive).toBe(true);
    expect(state.getEntitlementStatus(v.address)).toBe('ended');
  });

  it('a subscription whose funded periods have all elapsed is ended even unclaimed', () => {
    // The lazy-retailer shape: money still in the vault, term over.
    seed(vault(), 5_000);
    expect(useSubscriptionVaultStore.getState().getEntitlementStatus(vault().address)).toBe(
      'ended',
    );
  });

  it('THE STALE CLOCK: the store persists currentSlot 0, which must not read as ACTIVE', () => {
    // `partialize` includes currentSlot and it initialises to 0, so a freshly
    // opened popup can hold no clock at all. At slot 0 the raw predicate is
    // optimistic; the selector must not be.
    seed(vault(), 0);
    expect(useSubscriptionVaultStore.getState().getEntitlementStatus(vault().address)).toBe(
      'unknown',
    );
  });

  it('a slot from before the vault existed is also unknown', () => {
    seed(vault(), 999);
    expect(useSubscriptionVaultStore.getState().getEntitlementStatus(vault().address)).toBe(
      'unknown',
    );
  });

  it('reports paused', () => {
    seed(vault({ isPaused: true }), 1_250);
    expect(useSubscriptionVaultStore.getState().getEntitlementStatus(vault().address)).toBe(
      'paused',
    );
  });

  it('reports missing rather than guessing when the vault is not in the store', () => {
    expect(useSubscriptionVaultStore.getState().getEntitlementStatus('nope')).toBe('missing');
  });

  it('the selector reads the store clock, not a constant', () => {
    // A selector hard-wired to one answer passes every test above that happens
    // to expect that answer. Walking one vault across the boundary cannot be
    // satisfied by any constant.
    const v = vault();
    const answers = [1_100, 1_400, 1_499, 1_500, 9_999].map((slot) => {
      seed(v, slot);
      return useSubscriptionVaultStore.getState().getEntitlementStatus(v.address);
    });
    expect(answers).toEqual(['current', 'current', 'current', 'ended', 'ended']);
  });

  it('getNextClaimableSlot goes quiet on the same vault the badge calls ended', () => {
    // The popup renders both, side by side. They must not disagree.
    const v = vault({ claimedPeriods: 5 });
    seed(v, 1_500);
    const state = useSubscriptionVaultStore.getState();
    expect(state.getEntitlementStatus(v.address)).toBe('ended');
    expect(state.getNextClaimableSlot(v.address)).toBeNull();
  });
});

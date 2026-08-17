/**
 * The confirmation that stands between a payout address and the wallet.
 *
 * Run: cd apps/web && pnpm test
 *
 * WHY THIS SUITE EXISTS
 * ─────────────────────
 * A withdrawal pays a per-note derived address so the pool's payee is not the
 * user. One action undoes that completely — moving the payout to the connected
 * wallet — because the withdrawal's recipient is a cleartext instruction
 * argument, so a stranger reads the payout address out of the spend and then
 * reads its next transaction. Three RPC calls, same price as the payer walk
 * this whole effort is about, on the same transaction.
 *
 * The UI used to prefill the wallet in one click. These cases pin the rule that
 * replaced it, because the rule's failure mode is silence: if the gate stops
 * firing, nothing breaks, nothing warns, and the mechanism is simply gone.
 */

import { describe, it, expect } from 'vitest';
import {
  requiresSweepHomeConfirmation,
  SWEEP_HOME_WARNING,
} from '@/lib/pay/sweepDestination';

const WALLET = '7gWpzSZAqUiN6uZ9NkfB1gZ5gYtvUvQyFAUhZTjJ6Trh';
const PAYOUT_A = 'QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB';
const PAYOUT_B = 'SysvarC1ock11111111111111111111111111111111';
const ELSEWHERE = 'SysvarRent111111111111111111111111111111111';

const ask = (over: Partial<Parameters<typeof requiresSweepHomeConfirmation>[0]> = {}) =>
  requiresSweepHomeConfirmation({
    destination: ELSEWHERE,
    ownerKey: WALLET,
    payoutAddress: PAYOUT_A,
    armedFor: null,
    ...over,
  });

describe('sweeping to the connected wallet', () => {
  it('stops the first time', () => {
    expect(ask({ destination: WALLET })).toBe(true);
  });

  it('proceeds once that exact payout has been confirmed', () => {
    // The warning must be answerable. A gate that cannot be passed is a ban,
    // and sweeping home is a legitimate thing to want.
    expect(ask({ destination: WALLET, armedFor: PAYOUT_A })).toBe(false);
  });

  it('does NOT let one confirmation arm a different payout', () => {
    // The case that makes it per-address rather than a boolean: a user with
    // several payouts who accepts the warning once would otherwise send all the
    // others home without ever seeing it again.
    expect(ask({ destination: WALLET, armedFor: PAYOUT_B })).toBe(true);
  });
});

describe('every other destination', () => {
  it('passes without friction', () => {
    // A warning shown for everything is read for nothing. This one is about a
    // single outcome and must fire only for it.
    expect(ask()).toBe(false);
  });

  it('passes even when the payout was previously armed', () => {
    expect(ask({ armedFor: PAYOUT_A })).toBe(false);
  });

  it('does not fire on an empty field', () => {
    // The empty case is handled upstream with its own message; firing the
    // linkage warning here would teach the user to dismiss it.
    expect(ask({ destination: '' })).toBe(false);
  });

  it('does not fire when there is no connected wallet to compare against', () => {
    // Otherwise an empty ownerKey would equal an empty destination and warn
    // about a link that cannot exist.
    expect(ask({ destination: '', ownerKey: '' })).toBe(false);
  });
});

describe('the warning text', () => {
  it('names the mechanism and the cost, not just a risk', () => {
    // The user is about to do something legitimate whose consequence is
    // invisible from the screen. "Are you sure?" would not be an answer.
    expect(SWEEP_HOME_WARNING).toContain('links the withdrawal to your wallet');
    expect(SWEEP_HOME_WARNING).toContain('three RPC calls');
    // And it must say how to proceed, or a determined user hunts for another
    // route to the same place and finds one with no warning attached.
    expect(SWEEP_HOME_WARNING).toContain('Press Sweep again');
  });
});

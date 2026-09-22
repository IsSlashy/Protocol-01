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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  createSweepDestinationMemory,
  requiresSweepHomeConfirmation,
  sweepStop,
  SWEEP_HOME_WARNING,
  SWEEP_REUSE_WARNING,
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

// ─────────────────────────────────────────────────────────────────────────
// Sweep round 1, r1-fix3: the wallet is not the ONLY destination that links.
//
// A payout address is derived per note so that two withdrawals of one person
// do not name each other. Sweeping payout A and payout B to one address D
// publishes spendA -> A -> D and spendB -> B -> D, and any chain reader joins
// the two withdrawals, and both to whoever is behind D. The guard could not see
// it and its words said every destination but the wallet was safe. Measured:
// scratchpad/web-run/logs8/r1-chain/probe4-sweep-destination-reuse.log
// (`stop before payout B -> D : false`).
// ─────────────────────────────────────────────────────────────────────────

const EXCHANGE = 'SysvarStakeHistory1111111111111111111111111';

describe('a second payout going where an earlier one went', () => {
  const stopFor = (
    memory: ReturnType<typeof createSweepDestinationMemory>,
    over: Partial<Parameters<typeof sweepStop>[0]> = {},
  ) =>
    sweepStop({
      destination: EXCHANGE,
      ownerKey: WALLET,
      payoutAddress: PAYOUT_B,
      armedFor: null,
      memory,
      ...over,
    });

  it('stops before payout B goes to the address payout A went to', () => {
    const memory = createSweepDestinationMemory();
    expect(stopFor(memory, { payoutAddress: PAYOUT_A }), 'the first sweep must be free').toBeNull();
    memory.remember(EXCHANGE, PAYOUT_A);

    const stop = stopFor(memory);
    expect(stop?.reason, 'payout B went to payout A’s destination with no stop').toBe('reused');
    expect(stop?.warning).toBe(SWEEP_REUSE_WARNING);
  });

  it('asks once: the same press again goes through', () => {
    // Not a ban. One address for several 1 SOL payouts is the ordinary way to
    // move several SOL, and a gate that cannot be passed gets worked around.
    const memory = createSweepDestinationMemory();
    memory.remember(EXCHANGE, PAYOUT_A);
    const stop = stopFor(memory);
    expect(stop?.armToken ?? '', 'there is nothing to arm').not.toBe('');
    expect(stopFor(memory, { armedFor: stop?.armToken ?? null })).toBeNull();
  });

  it('asks again when the destination changes to ANOTHER reused address', () => {
    const memory = createSweepDestinationMemory();
    memory.remember(EXCHANGE, PAYOUT_A);
    memory.remember(ELSEWHERE, PAYOUT_A);
    const first = stopFor(memory);
    expect(
      stopFor(memory, { destination: ELSEWHERE, armedFor: first?.armToken ?? null })?.reason,
    ).toBe('reused');
  });

  it('a confirmation given for sweeping home does not arm a reused address', () => {
    const memory = createSweepDestinationMemory();
    memory.remember(EXCHANGE, PAYOUT_A);
    const home = stopFor(memory, { destination: WALLET });
    expect(home?.reason).toBe('home');
    expect(stopFor(memory, { armedFor: home?.armToken ?? null })?.reason).toBe('reused');
  });

  it('does not fire for a retry of the SAME payout to the same address', () => {
    // A sweep that failed after being remembered, or a row swept twice, joins
    // nothing: one payout, one destination.
    const memory = createSweepDestinationMemory();
    memory.remember(EXCHANGE, PAYOUT_A);
    expect(stopFor(memory, { payoutAddress: PAYOUT_A })).toBeNull();
  });

  it('does not fire for a fresh destination', () => {
    const memory = createSweepDestinationMemory();
    memory.remember(EXCHANGE, PAYOUT_A);
    expect(stopFor(memory, { destination: ELSEWHERE })).toBeNull();
  });

  it('still stops a sweep home, with the home warning, through the same door', () => {
    const memory = createSweepDestinationMemory();
    const stop = stopFor(memory, { destination: WALLET });
    expect(stop?.reason).toBe('home');
    expect(stop?.warning).toBe(SWEEP_HOME_WARNING);
    // Same arming rule as `requiresSweepHomeConfirmation`: per payout.
    expect(stopFor(memory, { destination: WALLET, armedFor: stop?.armToken ?? null })).toBeNull();
    expect(
      stopFor(memory, {
        destination: WALLET,
        payoutAddress: PAYOUT_A,
        armedFor: stop?.armToken ?? null,
      })?.reason,
    ).toBe('home');
  });

  it('keeps nothing anybody can read back or carry to the disk', () => {
    // 🚨 The destinations of earlier sweeps are exactly the rows that join
    // payouts. Round 1 cleared the field after each sweep for that reason; a
    // memory that could be listed, serialised or persisted would undo it.
    const memory = createSweepDestinationMemory();
    memory.remember(EXCHANGE, PAYOUT_A);
    expect(memory.usedByAnotherPayout(EXCHANGE, PAYOUT_B), 'the memory remembers nothing').toBe(
      true,
    );
    const dumped = JSON.stringify(memory) + Object.keys(memory).join(',');
    expect(dumped).not.toContain(EXCHANGE);
    expect(dumped).not.toContain(PAYOUT_A);
    // Two memories do not share state: a reload starts clean, by construction.
    expect(createSweepDestinationMemory().usedByAnotherPayout(EXCHANGE, PAYOUT_B)).toBe(false);
  });
});

describe('the reuse warning text', () => {
  it('names the mechanism and how to proceed, and no address', () => {
    expect(SWEEP_REUSE_WARNING).toContain('already went to that address');
    expect(SWEEP_REUSE_WARNING).toContain('Press Sweep again');
    // It renders under the payout rows. Naming the earlier payout or the
    // destination there would put the join on screen.
    expect(SWEEP_REUSE_WARNING).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
  });
});

describe('what this file says about which destinations link', () => {
  const source = readFileSync(
    path.resolve(__dirname, '../../lib/pay/sweepDestination.ts'),
    'utf8',
  );

  it('does not call the connected wallet the ONLY destination that links', () => {
    // Any address with a public tie to the wallet (the exchange deposit address
    // it already pays into, a second wallet funded from it) links the
    // withdrawal back just the same, and one address used for two payouts joins
    // them. "Exactly one" told the next reader every other destination is safe.
    expect(source).not.toMatch(/undone by exactly one action/);
    expect(source).not.toMatch(/the\s+\*?\s*single destination that undoes/);
    expect(source).not.toMatch(/proceeds without friction/);
  });
});

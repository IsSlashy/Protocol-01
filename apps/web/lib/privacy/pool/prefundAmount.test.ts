/**
 * The pre-fund jitter, and the one invariant whose failure is expensive.
 *
 * Run: cd apps/web && pnpm test:pool
 *
 * Going OVER the floor costs nothing — the surplus is returned by the sweep in
 * `executeSubscribe`'s `finally`. Going UNDER it does not fail cheaply: the
 * ephemeral has already uploaded ~150 proof chunks by the time the instruction
 * runs out of lamports, and the float is stranded on a key the user has to
 * recover by hand. So the floor is asserted across many draws rather than one,
 * and at the awkward inputs rather than only the typical one.
 */

import { describe, it, expect } from 'vitest';
import { jitterPrefund, PREFUND_STEP_LAMPORTS, PREFUND_MAX_EXTRA_STEPS } from './prefundAmount';

/** The two figures measured on devnet, which are what this file exists to erase. */
const MEASURED_SUBSCRIBE = 1_035_725_040;
const MEASURED_SHIELD = 1_573_486_080;

const DRAWS = 500;

describe('jitterPrefund', () => {
  it('never returns less than the floor, across every awkward input', () => {
    const inputs = [
      MEASURED_SUBSCRIBE,
      MEASURED_SHIELD,
      1, // smaller than one step
      PREFUND_STEP_LAMPORTS, // exactly on a step boundary
      PREFUND_STEP_LAMPORTS + 1, // one lamport over, the classic off-by-one
      PREFUND_STEP_LAMPORTS - 1,
    ];
    for (const input of inputs) {
      for (let i = 0; i < 50; i++) {
        expect(jitterPrefund(input)).toBeGreaterThanOrEqual(input);
      }
    }
  });

  it('lands on a whole step, so the amount looks like one a human would send', () => {
    for (let i = 0; i < DRAWS; i++) {
      expect(jitterPrefund(MEASURED_SUBSCRIBE) % PREFUND_STEP_LAMPORTS).toBe(0);
    }
  });

  it('stays within the advertised ceiling, so a payer who could afford it still can', () => {
    const rounded = Math.ceil(MEASURED_SUBSCRIBE / PREFUND_STEP_LAMPORTS) * PREFUND_STEP_LAMPORTS;
    const max = rounded + PREFUND_MAX_EXTRA_STEPS * PREFUND_STEP_LAMPORTS;
    for (let i = 0; i < DRAWS; i++) {
      expect(jitterPrefund(MEASURED_SUBSCRIBE)).toBeLessThanOrEqual(max);
    }
  });

  it('actually uses its whole range — a jitter that draws one value is not a jitter', () => {
    // The regression this catches is real and silent: a `% 1`, a bound off by
    // one, or a rejection loop that always takes the same branch all leave a
    // function that returns a constant while reading as if it randomises.
    const seen = new Set<number>();
    for (let i = 0; i < DRAWS; i++) seen.add(jitterPrefund(MEASURED_SUBSCRIBE));
    expect(seen.size).toBe(PREFUND_MAX_EXTRA_STEPS + 1);
  });

  it('erases the constant: 500 draws never reproduce the measured devnet amount', () => {
    // The defect, stated as a test. 1_035_725_040 appeared on 4 of 4 measured
    // subscriptions, so one `memcmp` over transfer amounts enumerated them all.
    for (let i = 0; i < DRAWS; i++) {
      expect(jitterPrefund(MEASURED_SUBSCRIBE)).not.toBe(MEASURED_SUBSCRIBE);
      expect(jitterPrefund(MEASURED_SHIELD)).not.toBe(MEASURED_SHIELD);
    }
  });

  it('passes degenerate input through instead of inventing an amount', () => {
    // A caller that has computed nonsense should see its nonsense, not a
    // plausible-looking number that hides the bug one layer deeper.
    expect(jitterPrefund(0)).toBe(0);
    expect(jitterPrefund(-1)).toBe(-1);
    expect(jitterPrefund(Number.NaN)).toBeNaN();
  });
});

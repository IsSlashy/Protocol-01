/**
 * Pins the billing intervals of a ZK-shielded subscription to REAL DURATIONS.
 *
 * Why this file exists: `CreateSubscription.tsx:110` read `const SLOTS_PER_DAY =
 * 7200n` from before 2026-08-20. 7 200 is SLOTS_PER_EPOCH — the on-chain epoch
 * divisor (`programs/zk_shielded/src/state/pool.rs:155`), ~48 minutes — not a
 * day. Every private vault created from that screen carried an interval 30x too
 * short, and NOTHING FAILED, because no test anywhere in this repo asserted an
 * interval against a wall-clock duration; the whole suite only ever compared
 * slot counts to other slot counts.
 *
 * So these assertions are deliberately written in SECONDS, not slots. A future
 * edit that swaps one slot constant for another has to move a number that is
 * visibly "one day" to break them.
 *
 * The four durations are exactly INTERVAL_SECONDS in
 * `@/shared/services/stream.ts:101-106` (86 400 / 604 800 / 2 592 000 /
 * 31 536 000). They are duplicated here rather than imported because that
 * constant is module-private; if it is ever exported, import it instead.
 *
 * The slot duration is the NOMINAL 400 ms of
 * `packages/merchant-sdk/src/period-math.ts:255`. That is the same clock the
 * vault list uses to render an interval (`SubscriptionVaults.tsx:177` shows
 * `interval_slots * 0.4` seconds), so this test measures the number the user is
 * shown.
 */

import { describe, it, expect } from 'vitest';
import {
  SLOTS_PER_DAY,
  intervalToSlots,
} from './CreateSubscription';

/** NOMINAL_SLOT_MS = 400 (packages/merchant-sdk/src/period-math.ts:255). */
const SLOT_SECONDS = 0.4;

function intervalSeconds(interval: Parameters<typeof intervalToSlots>[0]): number {
  return Number(intervalToSlots(interval)) * SLOT_SECONDS;
}

describe('CreateSubscription interval → slots', () => {
  it('bills daily every 24 hours', () => {
    expect(intervalSeconds('daily')).toBe(86_400);
  });

  it('bills weekly every 7 days', () => {
    expect(intervalSeconds('weekly')).toBe(604_800);
  });

  it('bills monthly every 30 days', () => {
    expect(intervalSeconds('monthly')).toBe(2_592_000);
  });

  it('bills yearly every 365 days', () => {
    expect(intervalSeconds('yearly')).toBe(31_536_000);
  });

  it('uses a day divisor, not the epoch divisor', () => {
    // ⛔ The regression guard. 7 200 is SLOTS_PER_EPOCH; reusing it as a day is
    // the exact bug this file was written for. Stated as an inequality on
    // purpose: it names the wrong value so a revert fails by name, not just by
    // arithmetic.
    expect(SLOTS_PER_DAY).not.toBe(7_200n);
    expect(SLOTS_PER_DAY).toBe(216_000n);
    // 86_400_000 ms / 400 ms — the same computation mobile does at
    // apps/mobile/services/solana/streams.ts:645.
    expect(SLOTS_PER_DAY).toBe(BigInt(86_400_000 / 400));
  });

  it('keeps the four intervals whole multiples of a day', () => {
    // Guards the shape as well as the values: a future contributor adding a
    // "quarterly" must keep going through SLOTS_PER_DAY rather than pasting a
    // literal, which is how the 7 200 got in.
    expect(intervalToSlots('daily')).toBe(SLOTS_PER_DAY);
    expect(intervalToSlots('weekly')).toBe(SLOTS_PER_DAY * 7n);
    expect(intervalToSlots('monthly')).toBe(SLOTS_PER_DAY * 30n);
    expect(intervalToSlots('yearly')).toBe(SLOTS_PER_DAY * 365n);
  });
});

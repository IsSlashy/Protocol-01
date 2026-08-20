/**
 * The interval table, pinned to wall-clock seconds rather than to slots.
 *
 * WHY SECONDS AND NOT SLOTS
 * ─────────────────────────
 * Asserting `intervalToSlots('monthly') === SLOTS_PER_DAY * 30n` would have
 * passed against the broken constant too — it only restates the implementation.
 * The defect was that a number of SLOTS was believed to be a number of DAYS, so
 * the only assertion that could have caught it converts back to real time.
 *
 * MEASURED: until 2026-08-20 `SLOTS_PER_DAY` here was 7200, which is
 * SLOTS_PER_EPOCH (~48 min). Every private subscription this screen created
 * carried an interval 30x too short — a "monthly" plan billed daily.
 */
import { describe, it, expect } from 'vitest';

import { SLOTS_PER_DAY, intervalToSlots } from './CreateSubscription';

/** Canonical Solana slot time, and the same 400 ms every other definition in
 *  this repository uses (packages/merchant-sdk/src/period-math.ts:255). */
const SLOT_SECONDS = 0.4;

const seconds = (interval: Parameters<typeof intervalToSlots>[0]): number =>
  Number(intervalToSlots(interval)) * SLOT_SECONDS;

describe('subscription intervals map to real durations', () => {
  it('bills daily plans once a day', () => {
    expect(seconds('daily')).toBe(86_400);
  });

  it('bills weekly plans once a week', () => {
    expect(seconds('weekly')).toBe(604_800);
  });

  it('bills monthly plans once every 30 days', () => {
    expect(seconds('monthly')).toBe(2_592_000);
  });

  it('bills yearly plans once a year', () => {
    expect(seconds('yearly')).toBe(31_536_000);
  });

  /**
   * The regression guard. 7200 is a real constant in this codebase — it is
   * SLOTS_PER_EPOCH and it is CORRECT where it means an epoch
   * (denominatedPool.ts). It is wrong here, and reusing it here is exactly the
   * mistake that shipped. Naming the wrong value makes a revert fail loudly
   * instead of silently restoring 30x-fast billing.
   */
  it('does not confuse an epoch for a day', () => {
    expect(SLOTS_PER_DAY).not.toBe(7_200n);
    expect(SLOTS_PER_DAY).toBe(216_000n);
  });

  /**
   * The live registry service, read off devnet on 2026-08-20, carries
   * 6,480,000 slots for its 30-day period. The extension must agree with the
   * chain, not with itself.
   */
  it('agrees with the interval the live registry service actually carries', () => {
    expect(intervalToSlots('monthly')).toBe(6_480_000n);
  });
});

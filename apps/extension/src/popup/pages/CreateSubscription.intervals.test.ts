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

import {
  SLOTS_PER_DAY,
  intervalToSlots,
  registryVaultTerms,
  describeIntervalSlots,
} from './CreateSubscription';

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

/**
 * The table above is for a PERSONAL payment, where the user picks a word. A
 * registry arrival has a number, and until 2026-09-02 that number was rounded
 * to the nearest word before being written: 100 000 slots became 216 000,
 * 3 024 000 (14 days) became 1 512 000, and the merchant SDK, which requires
 * the vault's interval to EQUAL the registry's, refused every such key as
 * `service_mismatch`. The assertions are on values no bucket can produce.
 */
describe('a registry entry is written verbatim', () => {
  it('keeps a period that is not a day, a week, a month or a year', () => {
    expect(registryVaultTerms({ priceAtomic: 60_000_000, intervalSlots: 100_000 })).toEqual({
      rateAtomic: 60_000_000n,
      intervalSlots: 100_000n,
    });
  });

  it('keeps the seeded 10-minute test loop and a 14-day plan', () => {
    expect(registryVaultTerms({ priceAtomic: 1, intervalSlots: 1_500 }).intervalSlots).toBe(1_500n);
    expect(registryVaultTerms({ priceAtomic: 1, intervalSlots: 3_024_000 }).intervalSlots).toBe(
      3_024_000n,
    );
  });

  it('never passes through the bucket table', () => {
    const buckets = (['daily', 'weekly', 'monthly', 'yearly'] as const).map(intervalToSlots);
    for (const slots of [1_500, 100_000, 3_024_000, 6_048_000, 19_440_000]) {
      const written = registryVaultTerms({ priceAtomic: 1, intervalSlots: slots }).intervalSlots;
      expect(buckets).not.toContain(written);
      expect(written).toBe(BigInt(slots));
    }
  });

  it('reads the period as the number it is, not the nearest word', () => {
    expect(describeIntervalSlots(1_500)).toBe('every 10 minutes');
    expect(describeIntervalSlots(100_000)).toBe('every 11.1 hours');
    expect(describeIntervalSlots(3_024_000)).toBe('every 14 days');
    expect(describeIntervalSlots(6_480_000)).toBe('every 30 days');
    expect(describeIntervalSlots(216_000)).toBe('every day');
  });
});

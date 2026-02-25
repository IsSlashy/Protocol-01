/**
 * Unit tests for the Private Subscription SDK module.
 *
 * Tests cover:
 *  1. Valid creation
 *  2. Jitter validation (30% spread rule)
 *  3. Jittered interval payment scheduling
 *  4. Auto-pause after 10 consecutive failures
 *  5. Expiration after maxPeriods
 *  6. addReceipts renewal flow
 *  7. cancel returns unused receipts
 *  8. Serialization / deserialization round-trip
 *  9. Stealth address derivation per period
 * 10. Pause and resume lifecycle
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PrivateSubscription,
  type PrivateSubscriptionConfig,
  type ShieldReceipt,
} from './private-subscription';

// ============ Helpers ============

/** Create a minimal valid config. */
function makeConfig(
  overrides: Partial<PrivateSubscriptionConfig> = {},
): PrivateSubscriptionConfig {
  return {
    token: 'SOL',
    denomination: 0.1,
    merchantAddress: 'MerchantPubKey1111111111111111111111111111111',
    intervalMs: 60_000, // 1 minute for tests
    useStealthAddress: false,
    useRelayer: false,
    autoRenew: false,
    maxPeriods: 0,
    jitter: {
      minIntervalMs: 1_000,
      maxIntervalMs: 10_000,
    },
    ...overrides,
  };
}

/** Create `n` mock ShieldReceipts matching the shielded-pool ShieldReceipt type. */
function makeReceipts(n: number): ShieldReceipt[] {
  return Array.from({ length: n }, (_, i) => ({
    secret: `secret-hex-${i}`,
    nullifierPreimage: `nullifier-preimage-hex-${i}`,
    depositEpoch: 100_000 + i,
    tokenMint: 'So11111111111111111111111111111111111111112',
    commitment: `commitment-hex-${i}`,
    leafIndex: i,
    denomination: 1,
    pool: `pool-pda-base58-${i}`,
  }));
}

/** A mock executePayment that always succeeds. */
function successExecutor(): (
  receipt: ShieldReceipt,
  recipientAddress: string,
  periodIndex: number,
) => Promise<string> {
  return vi.fn(async (_receipt, _addr, index) => `sig-${index}`);
}

/** A mock executePayment that always fails. */
function failureExecutor(): (
  receipt: ShieldReceipt,
  recipientAddress: string,
  periodIndex: number,
) => Promise<string> {
  return vi.fn(async () => {
    throw new Error('payment failed');
  });
}

// ============ Tests ============

describe('PrivateSubscription', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---- Test 1: Creates subscription with valid config ----

  it('creates subscription with valid config', () => {
    const config = makeConfig();
    const receipts = makeReceipts(5);
    const sub = PrivateSubscription.create(config, receipts);
    const info = sub.getInfo();

    expect(info.status).toBe('pending');
    expect(info.config).toEqual(config);
    expect(info.receipts).toHaveLength(5);
    expect(info.spentReceipts).toHaveLength(0);
    expect(info.periodsCompleted).toBe(0);
    expect(info.periodsRemaining).toBe(5);
    expect(info.failedAttempts).toBe(0);
    expect(info.createdAt).toBeGreaterThan(0);
    expect(info.lastPaymentAt).toBeNull();
    expect(info.completedSignatures).toHaveLength(0);
    expect(info.id).toMatch(/^psub_/);
  });

  // ---- Test 2: Rejects config with insufficient jitter ----

  it('rejects config with insufficient jitter', () => {
    // Spread = 100, average = 5050, 30% of 5050 = 1515 — 100 < 1515
    expect(() =>
      PrivateSubscription.create(
        makeConfig({
          jitter: { minIntervalMs: 5_000, maxIntervalMs: 5_100 },
        }),
        makeReceipts(3),
      ),
    ).toThrow('insufficient jitter');
  });

  it('accepts jitter when both values are 0 (jitter disabled)', () => {
    expect(() =>
      PrivateSubscription.create(
        makeConfig({
          jitter: { minIntervalMs: 0, maxIntervalMs: 0 },
        }),
        makeReceipts(1),
      ),
    ).not.toThrow();
  });

  it('rejects negative jitter.minIntervalMs', () => {
    expect(() =>
      PrivateSubscription.create(
        makeConfig({
          jitter: { minIntervalMs: -100, maxIntervalMs: 5_000 },
        }),
        makeReceipts(1),
      ),
    ).toThrow('minIntervalMs must be >= 0');
  });

  it('rejects jitter.maxIntervalMs < jitter.minIntervalMs', () => {
    expect(() =>
      PrivateSubscription.create(
        makeConfig({
          jitter: { minIntervalMs: 5_000, maxIntervalMs: 1_000 },
        }),
        makeReceipts(1),
      ),
    ).toThrow('maxIntervalMs must be >= jitter.minIntervalMs');
  });

  // ---- Test 3: Processes payments at jittered intervals ----

  it('processes payments at jittered intervals', async () => {
    const config = makeConfig({
      intervalMs: 10_000,
      jitter: { minIntervalMs: 1_000, maxIntervalMs: 5_000 },
    });
    const receipts = makeReceipts(3);
    const executor = successExecutor();
    const sub = PrivateSubscription.create(config, receipts);

    sub.start(executor);

    const info1 = sub.getInfo();
    expect(info1.status).toBe('active');

    // The first payment is scheduled at: now + intervalMs + jitter.
    // With intervalMs=10000 and jitter in [1000,5000], the delay is 11000..15000 ms.
    // Advance past the maximum possible delay.
    await vi.advanceTimersByTimeAsync(16_000);

    const info2 = sub.getInfo();
    expect(info2.periodsCompleted).toBe(1);
    expect(info2.completedSignatures).toContain('sig-0');
    expect(executor).toHaveBeenCalledTimes(1);

    // Advance again for second payment
    await vi.advanceTimersByTimeAsync(16_000);

    const info3 = sub.getInfo();
    expect(info3.periodsCompleted).toBe(2);
    expect(info3.completedSignatures).toContain('sig-1');
    expect(executor).toHaveBeenCalledTimes(2);
  });

  // ---- Test 4: Auto-pauses after 10 consecutive failures ----

  it('auto-pauses after 10 consecutive failures', async () => {
    const config = makeConfig({
      intervalMs: 1_000,
      jitter: { minIntervalMs: 0, maxIntervalMs: 0 },
    });
    const receipts = makeReceipts(20);
    const executor = failureExecutor();
    const sub = PrivateSubscription.create(config, receipts);

    sub.start(executor);

    // We need to advance through 10 retry cycles with exponential backoff.
    // Retries: 1s, 2s, 4s, 8s, 16s, 32s, 64s, 128s, 256s + the initial schedule.
    // Total worst case: initial ~1000 + sum of backoffs.
    // Advance 10 minutes to cover all retries.
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
    }

    const info = sub.getInfo();
    expect(info.status).toBe('paused');
    expect(info.failedAttempts).toBe(10);
    // No receipts should have been consumed
    expect(info.receipts).toHaveLength(20);
    expect(info.spentReceipts).toHaveLength(0);
  });

  // ---- Test 5: Expires after maxPeriods reached ----

  it('expires after maxPeriods reached', async () => {
    const config = makeConfig({
      intervalMs: 1_000,
      maxPeriods: 3,
      jitter: { minIntervalMs: 0, maxIntervalMs: 0 },
    });
    const receipts = makeReceipts(5);
    const executor = successExecutor();
    const sub = PrivateSubscription.create(config, receipts);

    sub.start(executor);

    // Process 3 payments
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(2_000);
    }

    const info = sub.getInfo();
    expect(info.status).toBe('expired');
    expect(info.periodsCompleted).toBe(3);
    expect(info.completedSignatures).toHaveLength(3);
    // 2 receipts remain unused
    expect(info.receipts).toHaveLength(2);
    expect(info.spentReceipts).toHaveLength(3);
  });

  // ---- Test 6: Handles addReceipts for renewal ----

  it('handles addReceipts for renewal', async () => {
    const config = makeConfig({
      intervalMs: 5_000,
      autoRenew: true,
      jitter: { minIntervalMs: 0, maxIntervalMs: 0 },
    });
    // Start with 1 receipt — it will be consumed, then sub goes to 'pending'
    const receipts = makeReceipts(1);
    const executor = successExecutor();
    const sub = PrivateSubscription.create(config, receipts);

    sub.start(executor);

    // Process the single receipt (first payment at ~5000ms from creation)
    await vi.advanceTimersByTimeAsync(6_000);

    const info1 = sub.getInfo();
    expect(info1.periodsCompleted).toBe(1);

    // Next payment scheduled at ~5000ms later; when it fires, no receipts -> pending
    await vi.advanceTimersByTimeAsync(6_000);

    const info2 = sub.getInfo();
    expect(info2.status).toBe('pending');

    // Add more receipts — should auto-resume.
    // Since nextPaymentAt is in the past, the next payment fires immediately (delay=0).
    sub.addReceipts(makeReceipts(3));

    const info3 = sub.getInfo();
    expect(info3.status).toBe('active');

    // Let the immediate payment fire
    await vi.advanceTimersByTimeAsync(1);

    const info4 = sub.getInfo();
    expect(info4.periodsCompleted).toBe(2);
    // 2 receipts remain (3 added, 1 consumed immediately)
    expect(info4.receipts).toHaveLength(2);
  });

  // ---- Test 7: Cancel returns unused receipts ----

  it('cancel returns unused receipts', async () => {
    const config = makeConfig({
      intervalMs: 5_000,
      jitter: { minIntervalMs: 0, maxIntervalMs: 0 },
    });
    const receipts = makeReceipts(5);
    const executor = successExecutor();
    const sub = PrivateSubscription.create(config, receipts);

    sub.start(executor);

    // Process 1st payment (fires at ~5000ms)
    await vi.advanceTimersByTimeAsync(6_000);
    expect(sub.getInfo().periodsCompleted).toBe(1);

    // Process 2nd payment (fires at ~5000ms after first)
    await vi.advanceTimersByTimeAsync(6_000);
    expect(sub.getInfo().periodsCompleted).toBe(2);

    const unused = sub.cancel();
    expect(unused).toHaveLength(3);
    expect(unused[0].commitment).toBe('commitment-hex-2');
    expect(unused[1].commitment).toBe('commitment-hex-3');
    expect(unused[2].commitment).toBe('commitment-hex-4');

    const infoAfter = sub.getInfo();
    expect(infoAfter.status).toBe('cancelled');
  });

  // ---- Test 8: Serializes and deserializes correctly ----

  it('serializes and deserializes correctly', async () => {
    const config = makeConfig({
      intervalMs: 5_000,
      maxPeriods: 10,
      jitter: { minIntervalMs: 1_000, maxIntervalMs: 5_000 },
    });
    const receipts = makeReceipts(4);
    const executor = successExecutor();
    const sub = PrivateSubscription.create(config, receipts);

    sub.start(executor);

    // Process 1 payment
    await vi.advanceTimersByTimeAsync(11_000);

    const json = sub.toJSON();
    expect(typeof json).toBe('string');

    // Verify it parses
    const parsed = JSON.parse(json);
    expect(parsed.id).toMatch(/^psub_/);
    expect(parsed.periodsCompleted).toBe(1);

    // Restore
    const restored = PrivateSubscription.fromJSON(json);
    const info = restored.getInfo();

    expect(info.id).toBe(sub.getInfo().id);
    expect(info.periodsCompleted).toBe(1);
    expect(info.receipts).toHaveLength(3);
    expect(info.spentReceipts).toHaveLength(1);
    expect(info.config.denomination).toBe(0.1);
    expect(info.completedSignatures).toContain('sig-0');

    // Verify receipt fields survived the round-trip
    expect(info.receipts[0].denomination).toBe(1);
    expect(info.receipts[0].secret).toMatch(/^secret-hex-/);
    expect(info.spentReceipts[0].denomination).toBe(1);
    expect(info.spentReceipts[0].commitment).toBe('commitment-hex-0');
  });

  // ---- Test 9: Uses different stealth address per period ----

  it('uses different stealth address per period', async () => {
    const config = makeConfig({
      intervalMs: 1_000,
      useStealthAddress: true,
      merchantSpendingPubKey: 'SpendPubKeyABC123',
      merchantViewingPubKey: 'ViewPubKeyDEF456',
      jitter: { minIntervalMs: 0, maxIntervalMs: 0 },
    });
    const receipts = makeReceipts(3);
    const executor = successExecutor();
    const sub = PrivateSubscription.create(config, receipts);

    sub.start(executor);

    // Process 3 payments
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(2_000);

    // Each call should have received a different recipient address
    const calls = (executor as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(3);

    const addr0 = calls[0][1] as string;
    const addr1 = calls[1][1] as string;
    const addr2 = calls[2][1] as string;

    // All should be stealth-tagged addresses
    expect(addr0).toMatch(/^stealth:/);
    expect(addr1).toMatch(/^stealth:/);
    expect(addr2).toMatch(/^stealth:/);

    // Each should include the period index, making them distinct
    expect(addr0).toContain(':0');
    expect(addr1).toContain(':1');
    expect(addr2).toContain(':2');

    // They must all be different
    expect(addr0).not.toBe(addr1);
    expect(addr1).not.toBe(addr2);
    expect(addr0).not.toBe(addr2);
  });

  // ---- Test 10: Pauses and resumes correctly ----

  it('pauses and resumes correctly', async () => {
    const config = makeConfig({
      intervalMs: 5_000,
      jitter: { minIntervalMs: 0, maxIntervalMs: 0 },
    });
    const receipts = makeReceipts(5);
    const executor = successExecutor();
    const sub = PrivateSubscription.create(config, receipts);

    sub.start(executor);

    // Process 1 payment (fires at ~5000ms)
    await vi.advanceTimersByTimeAsync(6_000);

    expect(sub.getInfo().periodsCompleted).toBe(1);

    // Pause immediately (before the next payment at ~5000ms from now)
    sub.pause();
    expect(sub.getInfo().status).toBe('paused');

    // Advance time past when the next payment would have fired
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sub.getInfo().periodsCompleted).toBe(1);
    expect(sub.getInfo().status).toBe('paused');

    // Resume — since nextPaymentAt is in the past, payment fires immediately
    sub.resume();
    expect(sub.getInfo().status).toBe('active');

    // Let the immediate payment fire (delay=0 -> fires in the next microtask)
    await vi.advanceTimersByTimeAsync(1);
    expect(sub.getInfo().periodsCompleted).toBe(2);

    // Verify that pausing again stops further payments
    sub.pause();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sub.getInfo().periodsCompleted).toBe(2);
  });

  // ---- Additional edge case tests ----

  it('throws when starting a cancelled subscription', () => {
    const sub = PrivateSubscription.create(makeConfig(), makeReceipts(1));
    sub.cancel();
    expect(() => sub.start(successExecutor())).toThrow('cannot start a cancelled subscription');
  });

  it('throws when starting an expired subscription', async () => {
    const config = makeConfig({
      intervalMs: 1_000,
      maxPeriods: 1,
      jitter: { minIntervalMs: 0, maxIntervalMs: 0 },
    });
    const sub = PrivateSubscription.create(config, makeReceipts(1));
    sub.start(successExecutor());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sub.getInfo().status).toBe('expired');
    expect(() => sub.start(successExecutor())).toThrow('cannot start a expired subscription');
  });

  it('throws when adding receipts to a cancelled subscription', () => {
    const sub = PrivateSubscription.create(makeConfig(), makeReceipts(1));
    sub.cancel();
    expect(() => sub.addReceipts(makeReceipts(1))).toThrow('cannot add receipts');
  });

  it('requires stealth keys when useStealthAddress is true', () => {
    expect(() =>
      PrivateSubscription.create(
        makeConfig({
          useStealthAddress: true,
          // Missing merchantSpendingPubKey and merchantViewingPubKey
        }),
        makeReceipts(1),
      ),
    ).toThrow('merchantSpendingPubKey and merchantViewingPubKey');
  });

  it('expires when no receipts and autoRenew is false', async () => {
    const config = makeConfig({
      intervalMs: 1_000,
      autoRenew: false,
      jitter: { minIntervalMs: 0, maxIntervalMs: 0 },
    });
    const receipts = makeReceipts(1);
    const executor = successExecutor();
    const sub = PrivateSubscription.create(config, receipts);

    sub.start(executor);

    // Consume the single receipt
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sub.getInfo().periodsCompleted).toBe(1);

    // Next cycle should find no receipts and expire
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sub.getInfo().status).toBe('expired');
  });
});

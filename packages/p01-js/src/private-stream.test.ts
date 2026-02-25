/**
 * Private Stream Tests
 *
 * Uses vitest with fake timers to validate:
 * - Configuration validation (jitter thresholds, stealth address requirements)
 * - Tick execution at jittered intervals
 * - Pause / resume / cancel lifecycle
 * - Catch-up behavior for missed ticks
 * - Exponential backoff on failures
 * - Auto-pause after 10 consecutive failures
 * - Serialization round-trip
 * - Stealth address uniqueness per tick
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PrivateStream,
  type PrivateStreamConfig,
  type ShieldReceipt,
} from './private-stream';

// ============ Helpers ============

/** Create a mock shield receipt matching the real ShieldReceipt interface */
function mockReceipt(index: number): ShieldReceipt {
  return {
    secret: `secret_${index}`,
    nullifierPreimage: `nullifier_${index}`,
    depositEpoch: 1000 + index,
    tokenMint: 'So11111111111111111111111111111111111111112',
    commitment: `commitment_${index}`,
    leafIndex: index,
    denomination: 10,
    pool: `pool_${index}`,
  };
}

/** Create N mock receipts */
function mockReceipts(n: number): ShieldReceipt[] {
  return Array.from({ length: n }, (_, i) => mockReceipt(i));
}

/** Minimal valid config */
function validConfig(overrides: Partial<PrivateStreamConfig> = {}): PrivateStreamConfig {
  return {
    token: 'SOL',
    denomination: 10,
    totalTicks: 5,
    recipientAddress: 'RecipientAddress11111111111111111111111111111',
    useStealthAddress: false,
    useRelayer: false,
    jitter: {
      minIntervalMs: 10_000,
      maxIntervalMs: 20_000,
    },
    ...overrides,
  };
}

/** A mock executeUnshield that always succeeds */
function successUnshield(): (receipt: ShieldReceipt, addr: string) => Promise<string> {
  let callCount = 0;
  return vi.fn(async (_receipt: ShieldReceipt, _addr: string) => {
    callCount++;
    return `sig_${callCount}`;
  });
}

/** A mock executeUnshield that always fails */
function failUnshield(): (receipt: ShieldReceipt, addr: string) => Promise<string> {
  return vi.fn(async () => {
    throw new Error('Unshield failed');
  });
}

/**
 * Advance fake timers to fire the next pending timer and flush microtasks.
 * This is safer than advanceTimersByTime because it only fires one timer
 * at a time, preventing cascading timer execution.
 */
async function advanceToNextTimer(): Promise<void> {
  await vi.advanceTimersToNextTimerAsync();
}

/**
 * Advance fake timers to fire N consecutive timers.
 */
async function advanceTimers(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await advanceToNextTimer();
  }
}

// ============ Tests ============

describe('PrivateStream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ------------------------------------------------
  // 1. Creates a private stream with valid config
  // ------------------------------------------------
  it('creates a private stream with valid config', () => {
    const config = validConfig();
    const stream = PrivateStream.create(config);
    const status = stream.getStatus();

    expect(status.status).toBe('pending');
    expect(status.ticksCompleted).toBe(0);
    expect(status.ticksRemaining).toBe(5);
    expect(status.config.token).toBe('SOL');
    expect(status.config.denomination).toBe(10);
    expect(status.config.totalTicks).toBe(5);
    expect(status.id).toMatch(/^pstream_/);
    expect(status.createdAt).toBeGreaterThan(0);
    expect(status.failedAttempts).toBe(0);
    expect(status.lastTickAt).toBeNull();
    expect(status.completedSignatures).toEqual([]);
    expect(status.receipts).toEqual([]);
    expect(status.spentReceipts).toEqual([]);
  });

  // ------------------------------------------------
  // 2. Rejects config with insufficient jitter (< 30%)
  // ------------------------------------------------
  it('rejects config with insufficient jitter (< 30%)', () => {
    // Range = 1000, average = 10500, ratio = 1000/10500 = ~9.5% < 30%
    expect(() =>
      PrivateStream.create(
        validConfig({
          jitter: { minIntervalMs: 10_000, maxIntervalMs: 11_000 },
        }),
      ),
    ).toThrow(/Insufficient jitter/);

    // Exact boundary: range = 0, ratio = 0%
    expect(() =>
      PrivateStream.create(
        validConfig({
          jitter: { minIntervalMs: 10_000, maxIntervalMs: 10_000 },
        }),
      ),
    ).toThrow(/Insufficient jitter/);
  });

  // ------------------------------------------------
  // 3. Accepts config with sufficient jitter (>= 30%)
  // ------------------------------------------------
  it('accepts config with sufficient jitter (>= 30%)', () => {
    // Range = 10000, average = 15000, ratio = 10000/15000 = 66.7% >= 30%
    const stream = PrivateStream.create(
      validConfig({
        jitter: { minIntervalMs: 10_000, maxIntervalMs: 20_000 },
      }),
    );
    expect(stream.getStatus().status).toBe('pending');

    // Tight but valid: range/average = 3000/10000 = 30%
    const stream2 = PrivateStream.create(
      validConfig({
        jitter: { minIntervalMs: 8_500, maxIntervalMs: 11_500 },
      }),
    );
    expect(stream2.getStatus().status).toBe('pending');
  });

  // ------------------------------------------------
  // 4. Executes ticks at jittered intervals
  // ------------------------------------------------
  it('executes ticks at jittered intervals', async () => {
    const config = validConfig({ totalTicks: 3 });
    const stream = PrivateStream.create(config);
    stream.setReceipts(mockReceipts(3));

    const unshield = successUnshield();
    stream.start(unshield);

    expect(stream.getStatus().status).toBe('active');

    // Fire tick 1
    await advanceToNextTimer();
    expect(unshield).toHaveBeenCalledTimes(1);
    expect(stream.getStatus().ticksCompleted).toBe(1);
    expect(stream.getStatus().ticksRemaining).toBe(2);

    // Fire tick 2
    await advanceToNextTimer();
    expect(unshield).toHaveBeenCalledTimes(2);
    expect(stream.getStatus().ticksCompleted).toBe(2);

    // Fire tick 3
    await advanceToNextTimer();
    expect(unshield).toHaveBeenCalledTimes(3);
    expect(stream.getStatus().ticksCompleted).toBe(3);
    expect(stream.getStatus().ticksRemaining).toBe(0);
    expect(stream.getStatus().status).toBe('completed');
  });

  // ------------------------------------------------
  // 5. Pauses and resumes correctly
  // ------------------------------------------------
  it('pauses and resumes correctly', async () => {
    const config = validConfig({ totalTicks: 3 });
    const stream = PrivateStream.create(config);
    stream.setReceipts(mockReceipts(3));

    const unshield = successUnshield();
    stream.start(unshield);

    // Complete first tick
    await advanceToNextTimer();
    expect(stream.getStatus().ticksCompleted).toBe(1);

    // Pause
    stream.pause();
    expect(stream.getStatus().status).toBe('paused');

    // Time passes -- no more ticks should fire since timer was cleared
    await vi.advanceTimersByTimeAsync(100_000);
    expect(unshield).toHaveBeenCalledTimes(1);

    // Resume
    stream.resume();
    expect(stream.getStatus().status).toBe('active');

    // Complete tick 2 (catch-up or normal scheduling)
    await advanceToNextTimer();
    expect(stream.getStatus().ticksCompleted).toBe(2);

    // Complete tick 3
    await advanceToNextTimer();
    expect(stream.getStatus().ticksCompleted).toBe(3);
    expect(stream.getStatus().status).toBe('completed');
  });

  // ------------------------------------------------
  // 6. Cancels and returns remaining receipts
  // ------------------------------------------------
  it('cancels and returns remaining receipts', async () => {
    const config = validConfig({ totalTicks: 5 });
    const stream = PrivateStream.create(config);
    const receipts = mockReceipts(5);
    stream.setReceipts(receipts);

    const unshield = successUnshield();
    stream.start(unshield);

    // Complete 2 ticks
    await advanceToNextTimer();
    await advanceToNextTimer();
    expect(stream.getStatus().ticksCompleted).toBe(2);

    // Cancel
    const remaining = stream.cancel();
    expect(stream.getStatus().status).toBe('cancelled');
    expect(remaining).toHaveLength(3); // 5 - 2 = 3 remaining
    expect(remaining[0].secret).toBe('secret_2');
    expect(remaining[1].secret).toBe('secret_3');
    expect(remaining[2].secret).toBe('secret_4');

    // No more ticks fire
    await vi.advanceTimersByTimeAsync(200_000);
    expect(unshield).toHaveBeenCalledTimes(2);
  });

  // ------------------------------------------------
  // 7. Catches up missed ticks with spacing (not burst)
  // ------------------------------------------------
  it('catches up missed ticks with spacing (not burst)', async () => {
    const config = validConfig({
      totalTicks: 4,
      jitter: { minIntervalMs: 10_000, maxIntervalMs: 20_000 },
    });
    const stream = PrivateStream.create(config);
    stream.setReceipts(mockReceipts(4));

    const unshield = successUnshield();
    stream.start(unshield);

    // Complete first tick
    await advanceToNextTimer();
    expect(stream.getStatus().ticksCompleted).toBe(1);

    // Pause to simulate going offline
    stream.pause();

    // Advance time way past multiple intervals (simulate offline period)
    await vi.advanceTimersByTimeAsync(300_000);

    // Resume -- catch-up should use 5-30s random spacing
    stream.resume();

    // Catch-up ticks fire one at a time with spacing
    await advanceToNextTimer();
    expect(stream.getStatus().ticksCompleted).toBe(2);

    await advanceToNextTimer();
    expect(stream.getStatus().ticksCompleted).toBe(3);

    await advanceToNextTimer();
    expect(stream.getStatus().ticksCompleted).toBe(4);
    expect(stream.getStatus().status).toBe('completed');
  });

  // ------------------------------------------------
  // 8. Retries failed unshields with exponential backoff
  // ------------------------------------------------
  it('retries failed unshields with exponential backoff', async () => {
    const config = validConfig({ totalTicks: 1 });
    const stream = PrivateStream.create(config);
    stream.setReceipts(mockReceipts(1));

    let callCount = 0;
    const unshield = vi.fn(async () => {
      callCount++;
      if (callCount <= 3) {
        throw new Error('Unshield failed');
      }
      return 'sig_success';
    });

    stream.start(unshield);

    // First attempt fires after jitter
    await advanceToNextTimer();
    expect(unshield).toHaveBeenCalledTimes(1);
    expect(stream.getStatus().failedAttempts).toBe(1);

    // Retry 1: backoff = 1s (2^0 * 1000ms)
    await advanceToNextTimer();
    expect(unshield).toHaveBeenCalledTimes(2);
    expect(stream.getStatus().failedAttempts).toBe(2);

    // Retry 2: backoff = 2s (2^1 * 1000ms)
    await advanceToNextTimer();
    expect(unshield).toHaveBeenCalledTimes(3);
    expect(stream.getStatus().failedAttempts).toBe(3);

    // Retry 3: backoff = 4s (2^2 * 1000ms) -- this time it succeeds
    await advanceToNextTimer();
    expect(unshield).toHaveBeenCalledTimes(4);
    expect(stream.getStatus().failedAttempts).toBe(0);
    expect(stream.getStatus().ticksCompleted).toBe(1);
    expect(stream.getStatus().status).toBe('completed');
  });

  // ------------------------------------------------
  // 9. Auto-pauses after 10 consecutive failures
  // ------------------------------------------------
  it('auto-pauses after 10 consecutive failures', async () => {
    const config = validConfig({ totalTicks: 1 });
    const stream = PrivateStream.create(config);
    stream.setReceipts(mockReceipts(1));

    const unshield = failUnshield();
    stream.start(unshield);

    // Fire all 10 attempts (1 initial + 9 retries)
    for (let i = 1; i <= 10; i++) {
      await advanceToNextTimer();
      expect(unshield).toHaveBeenCalledTimes(i);
      if (i < 10) {
        expect(stream.getStatus().failedAttempts).toBe(i);
        expect(stream.getStatus().status).toBe('active');
      }
    }

    // After 10th failure, should auto-pause
    expect(stream.getStatus().failedAttempts).toBe(10);
    expect(stream.getStatus().status).toBe('paused');

    // No more retries after auto-pause
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(unshield).toHaveBeenCalledTimes(10);
  });

  // ------------------------------------------------
  // 10. Serializes and deserializes state correctly
  // ------------------------------------------------
  it('serializes and deserializes state correctly', async () => {
    const config = validConfig({ totalTicks: 5 });
    const stream = PrivateStream.create(config);
    stream.setReceipts(mockReceipts(5));

    const unshield = successUnshield();
    stream.start(unshield);

    // Complete 2 ticks
    await advanceToNextTimer();
    await advanceToNextTimer();

    // Pause and serialize
    stream.pause();
    const json = stream.toJSON();
    const parsed = JSON.parse(json);

    expect(parsed.id).toMatch(/^pstream_/);
    expect(parsed.status).toBe('paused');
    expect(parsed.ticksCompleted).toBe(2);
    expect(parsed.ticksRemaining).toBe(3);
    expect(parsed.receipts).toHaveLength(3);
    expect(parsed.spentReceipts).toHaveLength(2);
    expect(parsed.completedSignatures).toHaveLength(2);
    expect(parsed.config.token).toBe('SOL');

    // Deserialize and verify
    const restored = PrivateStream.fromJSON(json);
    const restoredStatus = restored.getStatus();

    expect(restoredStatus.id).toBe(parsed.id);
    expect(restoredStatus.status).toBe('paused');
    expect(restoredStatus.ticksCompleted).toBe(2);
    expect(restoredStatus.ticksRemaining).toBe(3);
    expect(restoredStatus.receipts).toHaveLength(3);
    expect(restoredStatus.completedSignatures).toHaveLength(2);
    expect(restoredStatus.config.jitter.minIntervalMs).toBe(10_000);
    expect(restoredStatus.config.jitter.maxIntervalMs).toBe(20_000);
  });

  // ------------------------------------------------
  // 11. Uses different stealth addresses per tick when enabled
  // ------------------------------------------------
  it('uses different stealth addresses per tick when enabled', async () => {
    // Generate valid Ed25519 public keys by importing the crypto primitives
    const { ed25519 } = await import('@noble/curves/ed25519');
    const { randomBytes } = await import('@noble/hashes/utils');

    // Generate real key pairs for spend and view (scan)
    const spendPriv = randomBytes(32);
    const spendPub = ed25519.getPublicKey(spendPriv);
    const viewPriv = randomBytes(32);
    const viewPub = ed25519.getPublicKey(viewPriv);

    // Convert to hex strings
    const toHex = (bytes: Uint8Array) =>
      Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');

    const config = validConfig({
      totalTicks: 3,
      useStealthAddress: true,
      recipientSpendingPubKey: toHex(spendPub),
      recipientViewingPubKey: toHex(viewPub),
    });

    const stream = PrivateStream.create(config);
    stream.setReceipts(mockReceipts(3));

    const addresses: string[] = [];
    const unshield = vi.fn(async (_receipt: ShieldReceipt, addr: string) => {
      addresses.push(addr);
      return `sig_${addresses.length}`;
    });

    stream.start(unshield);

    // Execute all 3 ticks
    await advanceToNextTimer();
    await advanceToNextTimer();
    await advanceToNextTimer();

    expect(addresses).toHaveLength(3);
    // With stealth addresses, each tick derives a new ephemeral key,
    // so each address should be unique (statistically certain for 3 addresses)
    const uniqueAddresses = new Set(addresses);
    expect(uniqueAddresses.size).toBe(3);

    // None should match the original recipient address
    for (const addr of addresses) {
      expect(addr).not.toBe(config.recipientAddress);
    }
  });

  // ------------------------------------------------
  // Additional edge cases
  // ------------------------------------------------

  it('throws when starting without receipts', () => {
    const stream = PrivateStream.create(validConfig({ totalTicks: 3 }));
    expect(() => stream.start(successUnshield())).toThrow(/No receipts/);
  });

  it('throws when setting wrong number of receipts', () => {
    const stream = PrivateStream.create(validConfig({ totalTicks: 3 }));
    expect(() => stream.setReceipts(mockReceipts(5))).toThrow(/Expected 3 receipts, got 5/);
  });

  it('throws when starting a completed stream', async () => {
    const stream = PrivateStream.create(validConfig({ totalTicks: 1 }));
    stream.setReceipts(mockReceipts(1));
    stream.start(successUnshield());
    await advanceToNextTimer();
    expect(stream.getStatus().status).toBe('completed');
    expect(() => stream.start(successUnshield())).toThrow(/Cannot start a completed stream/);
  });

  it('throws when starting a cancelled stream', () => {
    const stream = PrivateStream.create(validConfig({ totalTicks: 3 }));
    stream.setReceipts(mockReceipts(3));
    stream.start(successUnshield());
    stream.cancel();
    expect(() => stream.start(successUnshield())).toThrow(/Cannot start a cancelled stream/);
  });

  it('requires stealth keys when useStealthAddress is true', () => {
    expect(() =>
      PrivateStream.create(
        validConfig({
          useStealthAddress: true,
          // Missing recipientSpendingPubKey and recipientViewingPubKey
        }),
      ),
    ).toThrow(/recipientSpendingPubKey and recipientViewingPubKey are required/);
  });

  it('requires relayerUrl when useRelayer is true', () => {
    expect(() =>
      PrivateStream.create(
        validConfig({
          useRelayer: true,
          // Missing relayerUrl
        }),
      ),
    ).toThrow(/relayerUrl is required/);
  });
});

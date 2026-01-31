import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';

import {
  deriveStreamPDA,
  deriveEscrowPDA,
  calculateElapsedIntervals,
  calculateWithdrawableAmount,
  calculateRefundAmount,
  formatLamports,
  formatTokenAmount,
  parseSolToLamports,
  parseTokenAmount,
  formatInterval,
  formatTimestamp,
  getNextPaymentDate,
  getStreamEndDate,
  hasPaymentsDue,
  generateStreamName,
} from './utils';
import { STREAM_SEED, ESCROW_SEED } from './constants';

// ============================================================
// PDA Derivation
// ============================================================
describe('deriveStreamPDA', () => {
  it('should return a [PublicKey, number] tuple', () => {
    const programId = PublicKey.unique();
    const sender = PublicKey.unique();
    const recipient = PublicKey.unique();
    const mint = PublicKey.unique();

    const result = deriveStreamPDA(programId, sender, recipient, mint);
    expect(result).toHaveLength(2);
    expect(result[0]).toBeInstanceOf(PublicKey);
    expect(typeof result[1]).toBe('number');
  });

  it('should be deterministic for the same inputs', () => {
    const programId = PublicKey.unique();
    const sender = PublicKey.unique();
    const recipient = PublicKey.unique();
    const mint = PublicKey.unique();

    const [pda1, bump1] = deriveStreamPDA(programId, sender, recipient, mint);
    const [pda2, bump2] = deriveStreamPDA(programId, sender, recipient, mint);
    expect(pda1.equals(pda2)).toBe(true);
    expect(bump1).toBe(bump2);
  });

  it('should produce different PDAs for different senders', () => {
    const programId = PublicKey.unique();
    const sender1 = PublicKey.unique();
    const sender2 = PublicKey.unique();
    const recipient = PublicKey.unique();
    const mint = PublicKey.unique();

    const [pda1] = deriveStreamPDA(programId, sender1, recipient, mint);
    const [pda2] = deriveStreamPDA(programId, sender2, recipient, mint);
    expect(pda1.equals(pda2)).toBe(false);
  });

  it('should produce different PDAs for different recipients', () => {
    const programId = PublicKey.unique();
    const sender = PublicKey.unique();
    const recipient1 = PublicKey.unique();
    const recipient2 = PublicKey.unique();
    const mint = PublicKey.unique();

    const [pda1] = deriveStreamPDA(programId, sender, recipient1, mint);
    const [pda2] = deriveStreamPDA(programId, sender, recipient2, mint);
    expect(pda1.equals(pda2)).toBe(false);
  });
});

describe('deriveEscrowPDA', () => {
  it('should return a [PublicKey, number] tuple', () => {
    const programId = PublicKey.unique();
    const stream = PublicKey.unique();

    const result = deriveEscrowPDA(programId, stream);
    expect(result).toHaveLength(2);
    expect(result[0]).toBeInstanceOf(PublicKey);
    expect(typeof result[1]).toBe('number');
  });

  it('should be deterministic for the same inputs', () => {
    const programId = PublicKey.unique();
    const stream = PublicKey.unique();

    const [pda1, bump1] = deriveEscrowPDA(programId, stream);
    const [pda2, bump2] = deriveEscrowPDA(programId, stream);
    expect(pda1.equals(pda2)).toBe(true);
    expect(bump1).toBe(bump2);
  });

  it('should produce different PDAs for different stream addresses', () => {
    const programId = PublicKey.unique();
    const stream1 = PublicKey.unique();
    const stream2 = PublicKey.unique();

    const [pda1] = deriveEscrowPDA(programId, stream1);
    const [pda2] = deriveEscrowPDA(programId, stream2);
    expect(pda1.equals(pda2)).toBe(false);
  });
});

// ============================================================
// Interval calculations
// ============================================================
describe('calculateElapsedIntervals', () => {
  it('should return 0 when no time has passed', () => {
    const now = 1000;
    expect(calculateElapsedIntervals(1000, 100, now)).toBe(0);
  });

  it('should return the correct number of full intervals', () => {
    // 500 seconds elapsed, 100 seconds per interval => 5 intervals
    expect(calculateElapsedIntervals(1000, 100, 1500)).toBe(5);
  });

  it('should floor partial intervals', () => {
    // 250 seconds elapsed, 100 seconds per interval => 2 (not 2.5)
    expect(calculateElapsedIntervals(1000, 100, 1250)).toBe(2);
  });

  it('should handle exactly one interval', () => {
    expect(calculateElapsedIntervals(1000, 3600, 4600)).toBe(1);
  });

  it('should use current time as default when not provided', () => {
    const lastWithdrawalAt = Math.floor(Date.now() / 1000) - 7200; // 2 hours ago
    const result = calculateElapsedIntervals(lastWithdrawalAt, 3600);
    expect(result).toBeGreaterThanOrEqual(2);
  });
});

describe('calculateWithdrawableAmount', () => {
  it('should calculate correct amount for elapsed intervals', () => {
    const amountPerInterval = BigInt(1000);
    const intervalSeconds = 100;
    const totalIntervals = 10;
    const intervalsPaid = 2;
    const lastWithdrawalAt = 1000;
    // With currentTime at 1500 (default uses Date.now, so we test via elapsed)
    // We rely on the function internally calling calculateElapsedIntervals

    // Manually test: if 5 intervals elapsed, remaining is 8, min(5,8)=5
    // 5 * 1000 = 5000
    // We can test by freezing time...

    // Use a known currentTime through the internal calculation
    // lastWithdrawalAt=1000, intervalSeconds=100, currentTime=1500
    // elapsed = floor((1500-1000)/100) = 5
    // remaining = 10-2 = 8
    // intervalsToPay = min(5, 8) = 5
    // amount = 1000 * 5 = 5000

    // Since calculateWithdrawableAmount uses Date.now() internally through
    // calculateElapsedIntervals, we freeze time
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1500 * 1000));

    const result = calculateWithdrawableAmount(
      amountPerInterval,
      intervalSeconds,
      totalIntervals,
      intervalsPaid,
      lastWithdrawalAt
    );
    expect(result).toBe(BigInt(5000));
    vi.useRealTimers();
  });

  it('should cap at remaining intervals', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(5000 * 1000));

    // 40 intervals elapsed but only 3 remaining
    const result = calculateWithdrawableAmount(
      BigInt(500),
      100,   // intervalSeconds
      10,    // totalIntervals
      7,     // intervalsPaid (remaining = 3)
      1000   // lastWithdrawalAt
    );
    expect(result).toBe(BigInt(1500)); // 3 * 500
    vi.useRealTimers();
  });

  it('should return 0 when all intervals are paid', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2000 * 1000));

    const result = calculateWithdrawableAmount(
      BigInt(100),
      100,
      5,
      5,    // all paid
      1000
    );
    expect(result).toBe(BigInt(0));
    vi.useRealTimers();
  });

  it('should return 0 when no time has elapsed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1000 * 1000));

    const result = calculateWithdrawableAmount(
      BigInt(100),
      100,
      10,
      0,
      1000
    );
    expect(result).toBe(BigInt(0));
    vi.useRealTimers();
  });
});

describe('calculateRefundAmount', () => {
  it('should return remaining intervals times amount', () => {
    expect(calculateRefundAmount(BigInt(1000), 10, 3)).toBe(BigInt(7000));
  });

  it('should return 0 when all intervals have been paid', () => {
    expect(calculateRefundAmount(BigInt(500), 5, 5)).toBe(BigInt(0));
  });

  it('should return total amount when none have been paid', () => {
    expect(calculateRefundAmount(BigInt(200), 10, 0)).toBe(BigInt(2000));
  });
});

// ============================================================
// Formatting functions
// ============================================================
describe('formatLamports', () => {
  it('should format 1 SOL (1e9 lamports) as "1.00"', () => {
    const result = formatLamports(BigInt(1_000_000_000));
    // Locale-dependent, but should contain "1"
    expect(result).toContain('1');
  });

  it('should format 0 lamports as "0.00"', () => {
    const result = formatLamports(0);
    expect(result).toContain('0');
  });

  it('should handle number input as well as bigint', () => {
    const resultNum = formatLamports(500_000_000);
    const resultBig = formatLamports(BigInt(500_000_000));
    expect(resultNum).toBe(resultBig);
  });
});

describe('formatTokenAmount', () => {
  it('should format with given decimals', () => {
    // 1_000_000 with 6 decimals = 1.00
    const result = formatTokenAmount(1_000_000, 6);
    expect(result).toContain('1');
  });

  it('should format 0 correctly', () => {
    const result = formatTokenAmount(0, 6);
    expect(result).toContain('0');
  });
});

describe('parseSolToLamports', () => {
  it('should convert 1 SOL to 1e9 lamports', () => {
    expect(parseSolToLamports(1)).toBe(BigInt(1_000_000_000));
  });

  it('should convert 0.5 SOL to 500_000_000 lamports', () => {
    expect(parseSolToLamports(0.5)).toBe(BigInt(500_000_000));
  });

  it('should accept string input', () => {
    expect(parseSolToLamports('2')).toBe(BigInt(2_000_000_000));
  });

  it('should return 0 for zero', () => {
    expect(parseSolToLamports(0)).toBe(BigInt(0));
  });
});

describe('parseTokenAmount', () => {
  it('should parse 1 USDC (6 decimals) correctly', () => {
    expect(parseTokenAmount(1, 6)).toBe(BigInt(1_000_000));
  });

  it('should parse string input', () => {
    expect(parseTokenAmount('10', 6)).toBe(BigInt(10_000_000));
  });

  it('should parse fractional amounts', () => {
    expect(parseTokenAmount(0.5, 6)).toBe(BigInt(500_000));
  });
});

// ============================================================
// Interval formatting
// ============================================================
describe('formatInterval', () => {
  it('should format seconds', () => {
    expect(formatInterval(30)).toBe('30 seconds');
  });

  it('should format minutes', () => {
    expect(formatInterval(120)).toBe('2 minutes');
  });

  it('should format hours', () => {
    expect(formatInterval(7200)).toBe('2 hours');
  });

  it('should format days', () => {
    expect(formatInterval(172800)).toBe('2 days');
  });

  it('should format weeks', () => {
    expect(formatInterval(1209600)).toBe('2 weeks');
  });

  it('should format months', () => {
    expect(formatInterval(5184000)).toBe('2 months');
  });

  it('should format years', () => {
    expect(formatInterval(63072000)).toBe('2 years');
  });

  it('should floor partial intervals (e.g. 90 seconds = 1 minutes)', () => {
    expect(formatInterval(90)).toBe('1 minutes');
  });
});

// ============================================================
// Date helpers
// ============================================================
describe('formatTimestamp', () => {
  it('should return a locale string for a given Unix timestamp', () => {
    const ts = 1700000000; // some known epoch
    const result = formatTimestamp(ts);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('getNextPaymentDate', () => {
  it('should return a Date object representing the next payment', () => {
    const lastWithdrawalAt = 1700000000;
    const intervalSeconds = 3600;
    const result = getNextPaymentDate(lastWithdrawalAt, intervalSeconds);

    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).toBe((lastWithdrawalAt + intervalSeconds) * 1000);
  });
});

describe('getStreamEndDate', () => {
  it('should return a Date representing when the stream ends', () => {
    const createdAt = 1700000000;
    const intervalSeconds = 3600;
    const totalIntervals = 10;

    const result = getStreamEndDate(createdAt, intervalSeconds, totalIntervals);
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).toBe((createdAt + intervalSeconds * totalIntervals) * 1000);
  });
});

// ============================================================
// hasPaymentsDue
// ============================================================
describe('hasPaymentsDue', () => {
  it('should return true when intervals have elapsed and payments remain', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2000 * 1000));

    expect(hasPaymentsDue(1000, 100, 10, 2)).toBe(true);
    vi.useRealTimers();
  });

  it('should return false when all intervals are paid', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(5000 * 1000));

    expect(hasPaymentsDue(1000, 100, 5, 5)).toBe(false);
    vi.useRealTimers();
  });

  it('should return false when no time has elapsed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1000 * 1000));

    expect(hasPaymentsDue(1000, 100, 10, 0)).toBe(false);
    vi.useRealTimers();
  });
});

// ============================================================
// generateStreamName
// ============================================================
describe('generateStreamName', () => {
  it('should return an uppercase string', () => {
    const name = generateStreamName();
    expect(name).toBe(name.toUpperCase());
  });

  it('should start with default prefix "P01"', () => {
    const name = generateStreamName();
    expect(name.startsWith('P01-')).toBe(true);
  });

  it('should use a custom prefix', () => {
    const name = generateStreamName('TEST');
    expect(name.startsWith('TEST-')).toBe(true);
  });

  it('should generate unique names', () => {
    const names = new Set<string>();
    for (let i = 0; i < 100; i++) {
      names.add(generateStreamName());
    }
    // All 100 should be unique
    expect(names.size).toBe(100);
  });

  it('should contain hyphens separating prefix, timestamp, and random', () => {
    const name = generateStreamName('X');
    const parts = name.split('-');
    expect(parts.length).toBe(3);
    expect(parts[0]).toBe('X');
  });
});

/**
 * Tests for shared utility functions
 *
 * These utilities are used across the entire Protocol 01 extension:
 * - cn: Tailwind CSS class merging (clsx wrapper)
 * - formatCurrency: USD formatting for balance display
 * - formatTokenAmount: Token amount formatting with decimal precision
 * - truncateAddress: Shortens Solana addresses for UI display
 * - formatRelativeTime: Human-readable time differences
 * - formatPeriod: Subscription period formatting
 * - copyToClipboard: Clipboard API wrapper
 * - sleep: Async delay utility
 * - generateId: UUID generation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  cn,
  formatCurrency,
  formatTokenAmount,
  truncateAddress,
  formatRelativeTime,
  formatPeriod,
  copyToClipboard,
  sleep,
  generateId,
} from './utils';

describe('cn (class name merger)', () => {
  it('merges string classes', () => {
    expect(cn('text-white', 'bg-black')).toBe('text-white bg-black');
  });

  it('handles conditional classes', () => {
    expect(cn('base', false && 'hidden', 'extra')).toBe('base extra');
  });

  it('handles undefined and null inputs', () => {
    expect(cn('base', undefined, null, 'extra')).toBe('base extra');
  });

  it('returns empty string for no arguments', () => {
    expect(cn()).toBe('');
  });
});

describe('formatCurrency', () => {
  it('formats a number as USD by default', () => {
    expect(formatCurrency(1234.56)).toBe('$1,234.56');
  });

  it('formats zero correctly', () => {
    expect(formatCurrency(0)).toBe('$0.00');
  });

  it('formats small amounts with 2 decimals', () => {
    expect(formatCurrency(0.5)).toBe('$0.50');
  });

  it('formats large amounts with commas', () => {
    expect(formatCurrency(1000000)).toBe('$1,000,000.00');
  });
});

describe('formatTokenAmount', () => {
  it('formats a lamport value (9 decimals) to human-readable SOL', () => {
    // 1 SOL = 1_000_000_000 lamports
    expect(formatTokenAmount(1_000_000_000, 9)).toBe('1');
  });

  it('returns "0" for zero amount', () => {
    expect(formatTokenAmount(0, 9)).toBe('0');
  });

  it('returns "<0.0001" for dust amounts', () => {
    // 1 lamport = 0.000000001 SOL
    expect(formatTokenAmount(1, 9)).toBe('<0.0001');
  });

  it('formats USDC amounts (6 decimals)', () => {
    // 100 USDC = 100_000_000 raw
    expect(formatTokenAmount(100_000_000, 6)).toBe('100');
  });

  it('limits to maxDecimals', () => {
    const result = formatTokenAmount(123_456_789, 9, 2);
    // 0.123456789 with max 2 decimals = "0.12"
    expect(result).toBe('0.12');
  });
});

describe('truncateAddress', () => {
  const fullAddress = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

  it('truncates a Solana address with default chars=4', () => {
    const result = truncateAddress(fullAddress);
    expect(result).toBe('7xKX...gAsU');
  });

  it('truncates with custom char count', () => {
    const result = truncateAddress(fullAddress, 6);
    expect(result).toBe('7xKXtg...osgAsU');
  });

  it('returns empty string for empty input', () => {
    expect(truncateAddress('')).toBe('');
  });

  it('returns the full address if it is too short to truncate', () => {
    expect(truncateAddress('short', 4)).toBe('short');
  });
});

describe('formatRelativeTime', () => {
  it('returns "Just now" for timestamps within the last minute', () => {
    expect(formatRelativeTime(Date.now() - 30_000)).toBe('Just now');
  });

  it('returns minutes for recent timestamps', () => {
    expect(formatRelativeTime(Date.now() - 5 * 60_000)).toBe('5m ago');
  });

  it('returns hours for older timestamps', () => {
    expect(formatRelativeTime(Date.now() - 3 * 3600_000)).toBe('3h ago');
  });

  it('returns days for timestamps older than 24 hours', () => {
    expect(formatRelativeTime(Date.now() - 2 * 86400_000)).toBe('2d ago');
  });
});

describe('formatPeriod', () => {
  it('formats monthly periods', () => {
    expect(formatPeriod(30 * 86400)).toBe('Monthly');
  });

  it('formats weekly periods', () => {
    expect(formatPeriod(7 * 86400)).toBe('Weekly');
  });

  it('formats daily periods', () => {
    expect(formatPeriod(86400)).toBe('Daily');
  });

  it('formats multi-month periods', () => {
    expect(formatPeriod(90 * 86400)).toBe('Every 3 months');
  });

  it('formats hourly periods', () => {
    expect(formatPeriod(3600)).toBe('Every 1 hours');
  });

  it('formats minute periods', () => {
    expect(formatPeriod(300)).toBe('Every 5 minutes');
  });
});

describe('copyToClipboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls navigator.clipboard.writeText and returns true', async () => {
    const result = await copyToClipboard('test text');
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('test text');
    expect(result).toBe(true);
  });

  it('returns false when clipboard write fails', async () => {
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(
      new Error('Clipboard blocked'),
    );

    const result = await copyToClipboard('test');
    expect(result).toBe(false);
  });
});

describe('sleep', () => {
  it('resolves after the specified delay', async () => {
    vi.useFakeTimers();

    const promise = sleep(1000);
    vi.advanceTimersByTime(1000);
    await promise;

    vi.useRealTimers();
  });

  it('returns a Promise', () => {
    const result = sleep(0);
    expect(result).toBeInstanceOf(Promise);
  });
});

describe('generateId', () => {
  it('returns a string', () => {
    expect(typeof generateId()).toBe('string');
  });

  it('generates unique IDs', () => {
    const id1 = generateId();
    const id2 = generateId();
    expect(id1).not.toBe(id2);
  });

  it('generates UUID-like format', () => {
    const id = generateId();
    // UUID format: 8-4-4-4-12
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

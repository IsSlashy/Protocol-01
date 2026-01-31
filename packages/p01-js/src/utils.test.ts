/**
 * Unit tests for Protocol 01 SDK utility functions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveTokenMint,
  getTokenSymbol,
  getTokenDecimals,
  toRawAmount,
  fromRawAmount,
  formatAmount,
  resolveInterval,
  getIntervalName,
  validateAmount,
  validateInterval,
  normalizePrivacyOptions,
  validateMerchantConfig,
  generateId,
  ensureOrderId,
  calculateNextPayment,
  formatDate,
  getTimeUntilPayment,
  isValidUrl,
  isValidWebhookUrl,
  isBrowser,
  isNode,
  sleep,
  withTimeout,
  createDeferred,
} from './utils';
import { TOKENS, TOKENS_DEVNET, INTERVALS } from './constants';
import { Protocol01Error } from './types';

// ============================================================
// Token Utilities
// ============================================================

describe('resolveTokenMint', () => {
  it('should resolve USDC symbol to mainnet mint address', () => {
    expect(resolveTokenMint('USDC')).toBe(TOKENS.USDC);
  });

  it('should resolve SOL symbol to mainnet mint address', () => {
    expect(resolveTokenMint('SOL')).toBe(TOKENS.SOL);
  });

  it('should resolve USDT symbol to mainnet mint address', () => {
    expect(resolveTokenMint('USDT')).toBe(TOKENS.USDT);
  });

  it('should resolve USDC to devnet mint when network is devnet', () => {
    expect(resolveTokenMint('USDC', 'devnet')).toBe(TOKENS_DEVNET.USDC);
  });

  it('should resolve USDT to devnet mint when network is devnet', () => {
    expect(resolveTokenMint('USDT', 'devnet')).toBe(TOKENS_DEVNET.USDT);
  });

  it('should be case-insensitive for token symbols', () => {
    expect(resolveTokenMint('usdc')).toBe(TOKENS.USDC);
    expect(resolveTokenMint('Usdc')).toBe(TOKENS.USDC);
    expect(resolveTokenMint('sol')).toBe(TOKENS.SOL);
  });

  it('should return the input unchanged if it is already a mint address', () => {
    const customMint = 'CustomMintAddress123456789012345678901234567';
    expect(resolveTokenMint(customMint)).toBe(customMint);
  });

  it('should default to mainnet-beta when network is not specified', () => {
    expect(resolveTokenMint('USDC')).toBe(TOKENS.USDC);
  });
});

describe('getTokenSymbol', () => {
  it('should return USDC for the USDC mint address', () => {
    expect(getTokenSymbol(TOKENS.USDC)).toBe('USDC');
  });

  it('should return SOL for the SOL mint address', () => {
    expect(getTokenSymbol(TOKENS.SOL)).toBe('SOL');
  });

  it('should return USDT for the USDT mint address', () => {
    expect(getTokenSymbol(TOKENS.USDT)).toBe('USDT');
  });

  it('should return the mint address itself for unknown tokens', () => {
    const unknownMint = 'UnknownMintAddress1234567890';
    expect(getTokenSymbol(unknownMint)).toBe(unknownMint);
  });

  it('should return USDC for devnet USDC mint', () => {
    expect(getTokenSymbol(TOKENS_DEVNET.USDC)).toBe('USDC');
  });
});

describe('getTokenDecimals', () => {
  it('should return 9 decimals for SOL', () => {
    expect(getTokenDecimals('SOL')).toBe(9);
  });

  it('should return 6 decimals for USDC', () => {
    expect(getTokenDecimals('USDC')).toBe(6);
  });

  it('should return 6 decimals for USDT', () => {
    expect(getTokenDecimals('USDT')).toBe(6);
  });

  it('should return 6 as default for unknown tokens', () => {
    expect(getTokenDecimals('UNKNOWN_TOKEN')).toBe(6);
  });

  it('should return correct decimals for devnet tokens', () => {
    expect(getTokenDecimals('USDC', 'devnet')).toBe(6);
  });
});

describe('toRawAmount', () => {
  it('should convert USDC amount to raw units (6 decimals)', () => {
    expect(toRawAmount(15.99, 'USDC')).toBe(BigInt(15990000));
  });

  it('should convert SOL amount to raw units (9 decimals)', () => {
    expect(toRawAmount(1.5, 'SOL')).toBe(BigInt(1500000000));
  });

  it('should convert whole number amounts', () => {
    expect(toRawAmount(100, 'USDC')).toBe(BigInt(100000000));
  });

  it('should convert very small amounts', () => {
    expect(toRawAmount(0.01, 'USDC')).toBe(BigInt(10000));
  });

  it('should handle zero', () => {
    expect(toRawAmount(0, 'USDC')).toBe(BigInt(0));
  });
});

describe('fromRawAmount', () => {
  it('should convert raw USDC units back to human-readable amount', () => {
    expect(fromRawAmount(BigInt(15990000), 'USDC')).toBe(15.99);
  });

  it('should convert raw SOL units back to human-readable amount', () => {
    expect(fromRawAmount(BigInt(1500000000), 'SOL')).toBe(1.5);
  });

  it('should accept number input in addition to bigint', () => {
    expect(fromRawAmount(15990000, 'USDC')).toBe(15.99);
  });

  it('should handle zero', () => {
    expect(fromRawAmount(BigInt(0), 'USDC')).toBe(0);
  });

  it('should be the inverse of toRawAmount', () => {
    const original = 42.50;
    const raw = toRawAmount(original, 'USDC');
    const back = fromRawAmount(raw, 'USDC');
    expect(back).toBe(original);
  });
});

describe('formatAmount', () => {
  it('should format amount with token symbol suffix by default', () => {
    expect(formatAmount(15.99, 'USDC')).toBe('15.99 USDC');
  });

  it('should format amount with token symbol prefix when specified', () => {
    expect(formatAmount(15.99, 'USDC', { prefix: true })).toBe('USDC 15.99');
  });

  it('should respect custom decimal precision', () => {
    expect(formatAmount(15.999, 'USDC', { decimals: 3 })).toBe('15.999 USDC');
  });

  it('should default to 2 decimal places', () => {
    expect(formatAmount(15.12345, 'USDC')).toBe('15.12 USDC');
  });

  it('should handle whole numbers', () => {
    expect(formatAmount(100, 'SOL')).toBe('100.00 SOL');
  });

  it('should handle zero', () => {
    expect(formatAmount(0, 'USDC')).toBe('0.00 USDC');
  });

  it('should handle zero decimals', () => {
    expect(formatAmount(15.99, 'USDC', { decimals: 0 })).toBe('16 USDC');
  });
});

// ============================================================
// Interval Utilities
// ============================================================

describe('resolveInterval', () => {
  it('should resolve "daily" to 86400 seconds', () => {
    expect(resolveInterval('daily')).toBe(86400);
  });

  it('should resolve "weekly" to 604800 seconds', () => {
    expect(resolveInterval('weekly')).toBe(604800);
  });

  it('should resolve "monthly" to 2592000 seconds', () => {
    expect(resolveInterval('monthly')).toBe(2592000);
  });

  it('should resolve "quarterly" to 7776000 seconds', () => {
    expect(resolveInterval('quarterly')).toBe(7776000);
  });

  it('should resolve "yearly" to 31536000 seconds', () => {
    expect(resolveInterval('yearly')).toBe(31536000);
  });

  it('should resolve "biweekly" to 1209600 seconds', () => {
    expect(resolveInterval('biweekly')).toBe(1209600);
  });

  it('should return the number as-is for custom numeric intervals', () => {
    expect(resolveInterval(7200)).toBe(7200);
  });
});

describe('getIntervalName', () => {
  it('should return "Daily" for 86400 seconds', () => {
    expect(getIntervalName(86400)).toBe('Daily');
  });

  it('should return "Weekly" for 604800 seconds', () => {
    expect(getIntervalName(604800)).toBe('Weekly');
  });

  it('should return "Monthly" for 2592000 seconds', () => {
    expect(getIntervalName(2592000)).toBe('Monthly');
  });

  it('should return "Yearly" for 31536000 seconds', () => {
    expect(getIntervalName(31536000)).toBe('Yearly');
  });

  it('should format custom intervals in years', () => {
    expect(getIntervalName(63072000)).toBe('2 years');
  });

  it('should format custom intervals in months', () => {
    expect(getIntervalName(5184000)).toBe('2 months');
  });

  it('should format single month', () => {
    // 30 days but not exactly matching the INTERVALS.monthly constant
    expect(getIntervalName(2700000)).toBe('1 month');
  });

  it('should format custom intervals in weeks', () => {
    expect(getIntervalName(1814400)).toBe('3 weeks');
  });

  it('should format single week', () => {
    // 7 days but not matching the weekly constant (648000)
    expect(getIntervalName(700000)).toBe('1 week');
  });

  it('should format custom intervals in days', () => {
    expect(getIntervalName(172800)).toBe('2 days');
  });

  it('should format custom intervals in hours', () => {
    expect(getIntervalName(7200)).toBe('2 hours');
  });

  it('should format single hour', () => {
    expect(getIntervalName(3600)).toBe('1 hour');
  });
});

// ============================================================
// Validation Utilities
// ============================================================

describe('validateAmount', () => {
  it('should accept valid amounts', () => {
    expect(() => validateAmount(10)).not.toThrow();
    expect(() => validateAmount(0.01)).not.toThrow();
    expect(() => validateAmount(999999)).not.toThrow();
  });

  it('should throw Protocol01Error for NaN', () => {
    expect(() => validateAmount(NaN)).toThrow(Protocol01Error);
    expect(() => validateAmount(NaN)).toThrow('Amount must be a valid number');
  });

  it('should throw Protocol01Error for zero', () => {
    expect(() => validateAmount(0)).toThrow(Protocol01Error);
    expect(() => validateAmount(0)).toThrow('Amount must be greater than 0');
  });

  it('should throw Protocol01Error for negative amounts', () => {
    expect(() => validateAmount(-5)).toThrow(Protocol01Error);
    expect(() => validateAmount(-5)).toThrow('Amount must be greater than 0');
  });

  it('should throw Protocol01Error for amounts below minimum', () => {
    expect(() => validateAmount(0.001)).toThrow(Protocol01Error);
    expect(() => validateAmount(0.001)).toThrow('Amount must be at least');
  });

  it('should throw Protocol01Error for amounts above maximum', () => {
    expect(() => validateAmount(1000001)).toThrow(Protocol01Error);
    expect(() => validateAmount(1000001)).toThrow('Amount cannot exceed');
  });

  it('should accept the minimum amount exactly', () => {
    expect(() => validateAmount(0.01)).not.toThrow();
  });

  it('should accept the maximum amount exactly', () => {
    expect(() => validateAmount(1000000)).not.toThrow();
  });
});

describe('validateInterval', () => {
  it('should accept standard named intervals', () => {
    expect(() => validateInterval('daily')).not.toThrow();
    expect(() => validateInterval('weekly')).not.toThrow();
    expect(() => validateInterval('monthly')).not.toThrow();
    expect(() => validateInterval('yearly')).not.toThrow();
  });

  it('should accept valid custom intervals (in seconds)', () => {
    expect(() => validateInterval(3600)).not.toThrow();   // 1 hour - minimum
    expect(() => validateInterval(7200)).not.toThrow();   // 2 hours
  });

  it('should throw Protocol01Error for intervals below minimum (1 hour)', () => {
    expect(() => validateInterval(3599)).toThrow(Protocol01Error);
    expect(() => validateInterval(3599)).toThrow('Interval must be at least');
  });

  it('should throw Protocol01Error for intervals above maximum (1 year)', () => {
    expect(() => validateInterval(31536001)).toThrow(Protocol01Error);
    expect(() => validateInterval(31536001)).toThrow('Interval cannot exceed');
  });

  it('should accept the minimum interval exactly', () => {
    expect(() => validateInterval(3600)).not.toThrow();
  });

  it('should accept the maximum interval exactly', () => {
    expect(() => validateInterval(31536000)).not.toThrow();
  });
});

describe('normalizePrivacyOptions', () => {
  it('should return defaults when no options provided', () => {
    expect(normalizePrivacyOptions()).toEqual({
      amountNoise: 0,
      timingNoise: 0,
      useStealthAddress: false,
    });
  });

  it('should return defaults when undefined is provided', () => {
    expect(normalizePrivacyOptions(undefined)).toEqual({
      amountNoise: 0,
      timingNoise: 0,
      useStealthAddress: false,
    });
  });

  it('should pass through valid values', () => {
    expect(normalizePrivacyOptions({
      amountNoise: 5,
      timingNoise: 2,
      useStealthAddress: true,
    })).toEqual({
      amountNoise: 5,
      timingNoise: 2,
      useStealthAddress: true,
    });
  });

  it('should clamp amountNoise to the maximum (25)', () => {
    expect(normalizePrivacyOptions({
      amountNoise: 50,
    })).toEqual({
      amountNoise: 25,
      timingNoise: 0,
      useStealthAddress: false,
    });
  });

  it('should clamp timingNoise to the maximum (24)', () => {
    expect(normalizePrivacyOptions({
      timingNoise: 48,
    })).toEqual({
      amountNoise: 0,
      timingNoise: 24,
      useStealthAddress: false,
    });
  });

  it('should clamp negative values to 0', () => {
    expect(normalizePrivacyOptions({
      amountNoise: -5,
      timingNoise: -10,
    })).toEqual({
      amountNoise: 0,
      timingNoise: 0,
      useStealthAddress: false,
    });
  });

  it('should default useStealthAddress to false when not provided', () => {
    expect(normalizePrivacyOptions({
      amountNoise: 5,
    })).toEqual({
      amountNoise: 5,
      timingNoise: 0,
      useStealthAddress: false,
    });
  });

  it('should default missing noise values to 0', () => {
    expect(normalizePrivacyOptions({
      useStealthAddress: true,
    })).toEqual({
      amountNoise: 0,
      timingNoise: 0,
      useStealthAddress: true,
    });
  });
});

describe('validateMerchantConfig', () => {
  it('should accept valid config', () => {
    expect(() => validateMerchantConfig({
      merchantId: 'test-123',
      merchantName: 'Test Merchant',
    })).not.toThrow();
  });

  it('should throw Protocol01Error when merchantId is missing', () => {
    expect(() => validateMerchantConfig({
      merchantName: 'Test',
    })).toThrow(Protocol01Error);
    expect(() => validateMerchantConfig({
      merchantName: 'Test',
    })).toThrow('merchantId is required');
  });

  it('should throw Protocol01Error when merchantId is empty string', () => {
    expect(() => validateMerchantConfig({
      merchantId: '',
      merchantName: 'Test',
    })).toThrow(Protocol01Error);
  });

  it('should throw Protocol01Error when merchantName is missing', () => {
    expect(() => validateMerchantConfig({
      merchantId: 'test-123',
    })).toThrow(Protocol01Error);
    expect(() => validateMerchantConfig({
      merchantId: 'test-123',
    })).toThrow('merchantName is required');
  });

  it('should throw Protocol01Error when merchantName is empty string', () => {
    expect(() => validateMerchantConfig({
      merchantId: 'test-123',
      merchantName: '',
    })).toThrow(Protocol01Error);
  });

  it('should throw Protocol01Error when merchantId exceeds 64 characters', () => {
    expect(() => validateMerchantConfig({
      merchantId: 'a'.repeat(65),
      merchantName: 'Test',
    })).toThrow(Protocol01Error);
    expect(() => validateMerchantConfig({
      merchantId: 'a'.repeat(65),
      merchantName: 'Test',
    })).toThrow('merchantId cannot exceed 64 characters');
  });

  it('should throw Protocol01Error when merchantName exceeds 128 characters', () => {
    expect(() => validateMerchantConfig({
      merchantId: 'test-123',
      merchantName: 'n'.repeat(129),
    })).toThrow(Protocol01Error);
    expect(() => validateMerchantConfig({
      merchantId: 'test-123',
      merchantName: 'n'.repeat(129),
    })).toThrow('merchantName cannot exceed 128 characters');
  });

  it('should accept merchantId at exactly 64 characters', () => {
    expect(() => validateMerchantConfig({
      merchantId: 'a'.repeat(64),
      merchantName: 'Test',
    })).not.toThrow();
  });

  it('should accept merchantName at exactly 128 characters', () => {
    expect(() => validateMerchantConfig({
      merchantId: 'test-123',
      merchantName: 'n'.repeat(128),
    })).not.toThrow();
  });
});

// ============================================================
// ID Generation
// ============================================================

describe('generateId', () => {
  it('should generate an ID with the default prefix', () => {
    const id = generateId();
    expect(id).toMatch(/^p01_/);
  });

  it('should generate an ID with a custom prefix', () => {
    const id = generateId('order');
    expect(id).toMatch(/^order_/);
  });

  it('should generate unique IDs on successive calls', () => {
    const id1 = generateId();
    const id2 = generateId();
    expect(id1).not.toBe(id2);
  });

  it('should contain alphanumeric characters after prefix', () => {
    const id = generateId();
    const afterPrefix = id.split('_')[1];
    expect(afterPrefix).toBeTruthy();
    expect(afterPrefix!.length).toBeGreaterThan(0);
  });
});

describe('ensureOrderId', () => {
  it('should return the provided orderId when given', () => {
    expect(ensureOrderId('my-order-123')).toBe('my-order-123');
  });

  it('should generate an order ID when none is provided', () => {
    const id = ensureOrderId();
    expect(id).toMatch(/^order_/);
  });

  it('should generate an order ID when undefined is provided', () => {
    const id = ensureOrderId(undefined);
    expect(id).toMatch(/^order_/);
  });
});

// ============================================================
// Time Utilities
// ============================================================

describe('calculateNextPayment', () => {
  it('should add interval seconds to the start date', () => {
    const start = new Date('2025-01-01T00:00:00Z');
    const result = calculateNextPayment(start, INTERVALS.monthly);
    const expected = start.getTime() + INTERVALS.monthly * 1000;
    expect(result).toBe(expected);
  });

  it('should default to now when no start date is provided', () => {
    const before = Date.now();
    const result = calculateNextPayment(undefined, INTERVALS.daily);
    const after = Date.now();
    // Result should be approximately now + 1 day in ms
    expect(result).toBeGreaterThanOrEqual(before + INTERVALS.daily * 1000);
    expect(result).toBeLessThanOrEqual(after + INTERVALS.daily * 1000);
  });

  it('should handle weekly intervals', () => {
    const start = new Date('2025-06-01T12:00:00Z');
    const result = calculateNextPayment(start, INTERVALS.weekly);
    expect(result).toBe(start.getTime() + 604800000);
  });
});

describe('formatDate', () => {
  it('should format a timestamp to a readable date string', () => {
    // Jan 15, 2025 UTC
    const timestamp = new Date('2025-01-15T00:00:00Z').getTime();
    const result = formatDate(timestamp);
    // The exact format depends on locale, but should contain Jan and 15
    expect(result).toContain('Jan');
    expect(result).toContain('15');
    expect(result).toContain('2025');
  });

  it('should accept custom Intl.DateTimeFormat options', () => {
    const timestamp = new Date('2025-06-20T00:00:00Z').getTime();
    const result = formatDate(timestamp, { year: 'numeric', month: 'long' });
    expect(result).toContain('June');
    expect(result).toContain('2025');
  });
});

describe('getTimeUntilPayment', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return "Due now" when payment is in the past', () => {
    const pastTimestamp = Date.now() - 60000;
    expect(getTimeUntilPayment(pastTimestamp)).toBe('Due now');
  });

  it('should return "Due now" when payment is exactly now', () => {
    expect(getTimeUntilPayment(Date.now())).toBe('Due now');
  });

  it('should return days when payment is days away', () => {
    const twoDaysFromNow = Date.now() + 2 * 24 * 60 * 60 * 1000;
    expect(getTimeUntilPayment(twoDaysFromNow)).toBe('2 days');
  });

  it('should return "1 day" for singular', () => {
    const oneDayFromNow = Date.now() + 1 * 24 * 60 * 60 * 1000 + 1000;
    expect(getTimeUntilPayment(oneDayFromNow)).toBe('1 day');
  });

  it('should return hours when payment is hours away', () => {
    const threeHoursFromNow = Date.now() + 3 * 60 * 60 * 1000;
    expect(getTimeUntilPayment(threeHoursFromNow)).toBe('3 hours');
  });

  it('should return "1 hour" for singular', () => {
    const oneHourFromNow = Date.now() + 1 * 60 * 60 * 1000 + 1000;
    expect(getTimeUntilPayment(oneHourFromNow)).toBe('1 hour');
  });

  it('should return minutes when payment is minutes away', () => {
    const thirtyMinFromNow = Date.now() + 30 * 60 * 1000;
    expect(getTimeUntilPayment(thirtyMinFromNow)).toBe('30 minutes');
  });

  it('should return "< 1 minute" for very short durations', () => {
    const soonTimestamp = Date.now() + 30 * 1000; // 30 seconds
    expect(getTimeUntilPayment(soonTimestamp)).toBe('< 1 minute');
  });
});

// ============================================================
// URL Utilities
// ============================================================

describe('isValidUrl', () => {
  it('should return true for valid HTTP URLs', () => {
    expect(isValidUrl('http://example.com')).toBe(true);
  });

  it('should return true for valid HTTPS URLs', () => {
    expect(isValidUrl('https://example.com')).toBe(true);
  });

  it('should return true for URLs with paths', () => {
    expect(isValidUrl('https://example.com/api/webhook')).toBe(true);
  });

  it('should return false for empty strings', () => {
    expect(isValidUrl('')).toBe(false);
  });

  it('should return false for plain text', () => {
    expect(isValidUrl('not a url')).toBe(false);
  });

  it('should return false for incomplete URLs', () => {
    expect(isValidUrl('example.com')).toBe(false);
  });
});

describe('isValidWebhookUrl', () => {
  it('should return true for valid HTTPS URLs', () => {
    expect(isValidWebhookUrl('https://api.example.com/webhook')).toBe(true);
  });

  it('should return false for HTTP URLs (requires HTTPS)', () => {
    expect(isValidWebhookUrl('http://api.example.com/webhook')).toBe(false);
  });

  it('should return false for invalid URLs', () => {
    expect(isValidWebhookUrl('not-a-url')).toBe(false);
  });

  it('should return false for empty strings', () => {
    expect(isValidWebhookUrl('')).toBe(false);
  });
});

// ============================================================
// Environment Detection
// ============================================================

describe('isBrowser', () => {
  it('should return false in Node.js test environment', () => {
    // In a Node test environment, there is no window object
    expect(isBrowser()).toBe(false);
  });
});

describe('isNode', () => {
  it('should return true in Node.js test environment', () => {
    expect(isNode()).toBe(true);
  });
});

// ============================================================
// Async Utilities
// ============================================================

describe('sleep', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should resolve after the specified duration', async () => {
    const promise = sleep(1000);
    vi.advanceTimersByTime(1000);
    await expect(promise).resolves.toBeUndefined();
  });

  it('should not resolve before the specified duration', async () => {
    let resolved = false;
    sleep(1000).then(() => { resolved = true; });

    vi.advanceTimersByTime(500);
    await Promise.resolve(); // flush microtasks
    expect(resolved).toBe(false);

    vi.advanceTimersByTime(500);
    await Promise.resolve();
    expect(resolved).toBe(true);
  });
});

describe('withTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should resolve with the original promise value when it completes in time', async () => {
    const promise = new Promise<string>((resolve) => {
      setTimeout(() => resolve('success'), 100);
    });

    const resultPromise = withTimeout(promise, 5000);
    vi.advanceTimersByTime(100);
    const result = await resultPromise;
    expect(result).toBe('success');
  });

  it('should reject with Protocol01Error on timeout', async () => {
    const promise = new Promise<string>((resolve) => {
      setTimeout(() => resolve('too late'), 10000);
    });

    const resultPromise = withTimeout(promise, 1000, 'Custom timeout message');
    vi.advanceTimersByTime(1000);

    await expect(resultPromise).rejects.toThrow(Protocol01Error);
    await expect(resultPromise).rejects.toThrow('Custom timeout message');
  });

  it('should use default error message when none is provided', async () => {
    const promise = new Promise<string>(() => {
      // Never resolves
    });

    const resultPromise = withTimeout(promise, 500);
    vi.advanceTimersByTime(500);

    await expect(resultPromise).rejects.toThrow('Operation timed out');
  });
});

describe('createDeferred', () => {
  it('should create a deferred promise that can be resolved externally', async () => {
    const deferred = createDeferred<string>();
    deferred.resolve('hello');
    await expect(deferred.promise).resolves.toBe('hello');
  });

  it('should create a deferred promise that can be rejected externally', async () => {
    const deferred = createDeferred<string>();
    deferred.reject(new Error('test error'));
    await expect(deferred.promise).rejects.toThrow('test error');
  });
});

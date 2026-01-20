/**
 * Protocol 01 SDK Utilities
 */

import {
  TOKENS,
  TOKENS_DEVNET,
  TOKEN_DECIMALS,
  TOKEN_SYMBOLS,
  INTERVALS,
  SUBSCRIPTION_LIMITS,
  PRIVACY_LIMITS,
} from './constants';
import type {
  PaymentInterval,
  PrivacyOptions,
  SupportedToken,
  Protocol01ErrorCode,
} from './types';
import { Protocol01Error } from './types';

// ============ Token Utilities ============

/**
 * Resolve token symbol or mint address to mint address
 * @param token - Token symbol (e.g., "USDC") or mint address
 * @param network - Network to use for resolution
 * @returns Token mint address
 */
export function resolveTokenMint(
  token: SupportedToken,
  network: 'devnet' | 'mainnet-beta' = 'mainnet-beta'
): string {
  const upper = token.toUpperCase();
  const tokens = network === 'devnet' ? TOKENS_DEVNET : TOKENS;

  if (upper in tokens) {
    return tokens[upper as keyof typeof tokens];
  }

  // Assume it's already a mint address
  return token;
}

/**
 * Get token symbol from mint address
 * @param mint - Token mint address
 * @returns Token symbol or the mint address if unknown
 */
export function getTokenSymbol(mint: string): string {
  return TOKEN_SYMBOLS[mint] ?? mint;
}

/**
 * Get token decimals
 * @param tokenOrMint - Token symbol or mint address
 * @param network - Network to use
 * @returns Number of decimals (defaults to 6 for unknown tokens)
 */
export function getTokenDecimals(
  tokenOrMint: string,
  network: 'devnet' | 'mainnet-beta' = 'mainnet-beta'
): number {
  const mint = resolveTokenMint(tokenOrMint, network);
  return TOKEN_DECIMALS[mint] ?? 6;
}

/**
 * Convert human-readable amount to raw token units
 * @param amount - Human-readable amount (e.g., 15.99)
 * @param tokenOrMint - Token symbol or mint address
 * @param network - Network to use
 * @returns Raw amount in smallest units
 */
export function toRawAmount(
  amount: number,
  tokenOrMint: string,
  network: 'devnet' | 'mainnet-beta' = 'mainnet-beta'
): bigint {
  const decimals = getTokenDecimals(tokenOrMint, network);
  return BigInt(Math.floor(amount * Math.pow(10, decimals)));
}

/**
 * Convert raw token units to human-readable amount
 * @param rawAmount - Raw amount in smallest units
 * @param tokenOrMint - Token symbol or mint address
 * @param network - Network to use
 * @returns Human-readable amount
 */
export function fromRawAmount(
  rawAmount: bigint | number,
  tokenOrMint: string,
  network: 'devnet' | 'mainnet-beta' = 'mainnet-beta'
): number {
  const decimals = getTokenDecimals(tokenOrMint, network);
  const raw = typeof rawAmount === 'bigint' ? rawAmount : BigInt(rawAmount);
  return Number(raw) / Math.pow(10, decimals);
}

/**
 * Format amount with token symbol
 * @param amount - Amount in human-readable units
 * @param token - Token symbol
 * @param options - Formatting options
 * @returns Formatted string (e.g., "15.99 USDC")
 */
export function formatAmount(
  amount: number,
  token: string,
  options: {
    decimals?: number;
    prefix?: boolean;
  } = {}
): string {
  const { decimals = 2, prefix = false } = options;
  const formatted = amount.toFixed(decimals);
  return prefix ? `${token} ${formatted}` : `${formatted} ${token}`;
}

// ============ Interval Utilities ============

/**
 * Resolve payment interval to seconds
 * @param interval - Interval name or custom seconds
 * @returns Number of seconds
 */
export function resolveInterval(interval: PaymentInterval): number {
  if (typeof interval === 'number') {
    return interval;
  }
  return INTERVALS[interval];
}

/**
 * Get interval display name
 * @param intervalSeconds - Interval in seconds
 * @returns Human-readable interval name
 */
export function getIntervalName(intervalSeconds: number): string {
  // Check for standard intervals
  for (const [name, seconds] of Object.entries(INTERVALS)) {
    if (seconds === intervalSeconds) {
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
  }

  // Format custom intervals
  const days = intervalSeconds / 86400;
  if (days >= 365) {
    const years = Math.floor(days / 365);
    return years === 1 ? '1 year' : `${years} years`;
  }
  if (days >= 30) {
    const months = Math.floor(days / 30);
    return months === 1 ? '1 month' : `${months} months`;
  }
  if (days >= 7) {
    const weeks = Math.floor(days / 7);
    return weeks === 1 ? '1 week' : `${weeks} weeks`;
  }
  if (days >= 1) {
    return days === 1 ? '1 day' : `${Math.floor(days)} days`;
  }

  const hours = intervalSeconds / 3600;
  return hours === 1 ? '1 hour' : `${Math.floor(hours)} hours`;
}

// ============ Validation Utilities ============

/**
 * Validate payment amount
 * @param amount - Amount to validate
 * @throws Protocol01Error if invalid
 */
export function validateAmount(amount: number): void {
  if (typeof amount !== 'number' || isNaN(amount)) {
    throw new Protocol01Error(
      'INVALID_AMOUNT' as Protocol01ErrorCode,
      'Amount must be a valid number'
    );
  }
  if (amount <= 0) {
    throw new Protocol01Error(
      'INVALID_AMOUNT' as Protocol01ErrorCode,
      'Amount must be greater than 0'
    );
  }
  if (amount < SUBSCRIPTION_LIMITS.minAmount) {
    throw new Protocol01Error(
      'INVALID_AMOUNT' as Protocol01ErrorCode,
      `Amount must be at least ${SUBSCRIPTION_LIMITS.minAmount}`
    );
  }
  if (amount > SUBSCRIPTION_LIMITS.maxAmount) {
    throw new Protocol01Error(
      'INVALID_AMOUNT' as Protocol01ErrorCode,
      `Amount cannot exceed ${SUBSCRIPTION_LIMITS.maxAmount}`
    );
  }
}

/**
 * Validate payment interval
 * @param interval - Interval to validate
 * @throws Protocol01Error if invalid
 */
export function validateInterval(interval: PaymentInterval): void {
  const seconds = resolveInterval(interval);

  if (seconds < SUBSCRIPTION_LIMITS.minPeriodSeconds) {
    throw new Protocol01Error(
      'INVALID_INTERVAL' as Protocol01ErrorCode,
      `Interval must be at least ${SUBSCRIPTION_LIMITS.minPeriodSeconds} seconds (1 hour)`
    );
  }
  if (seconds > SUBSCRIPTION_LIMITS.maxPeriodSeconds) {
    throw new Protocol01Error(
      'INVALID_INTERVAL' as Protocol01ErrorCode,
      `Interval cannot exceed ${SUBSCRIPTION_LIMITS.maxPeriodSeconds} seconds (1 year)`
    );
  }
}

/**
 * Validate and normalize privacy options
 * @param options - Privacy options to validate
 * @returns Normalized privacy options
 */
export function normalizePrivacyOptions(
  options?: PrivacyOptions
): PrivacyOptions {
  if (!options) {
    return {
      amountNoise: 0,
      timingNoise: 0,
      useStealthAddress: false,
    };
  }

  return {
    amountNoise: Math.min(
      Math.max(options.amountNoise ?? 0, 0),
      PRIVACY_LIMITS.maxAmountNoise
    ),
    timingNoise: Math.min(
      Math.max(options.timingNoise ?? 0, 0),
      PRIVACY_LIMITS.maxTimingNoise
    ),
    useStealthAddress: options.useStealthAddress ?? false,
  };
}

/**
 * Validate merchant configuration
 * @param config - Config to validate
 * @throws Protocol01Error if invalid
 */
export function validateMerchantConfig(config: {
  merchantId?: string;
  merchantName?: string;
}): void {
  if (!config.merchantId || typeof config.merchantId !== 'string') {
    throw new Protocol01Error(
      'INVALID_CONFIG' as Protocol01ErrorCode,
      'merchantId is required and must be a string'
    );
  }
  if (!config.merchantName || typeof config.merchantName !== 'string') {
    throw new Protocol01Error(
      'INVALID_CONFIG' as Protocol01ErrorCode,
      'merchantName is required and must be a string'
    );
  }
  if (config.merchantId.length > 64) {
    throw new Protocol01Error(
      'INVALID_CONFIG' as Protocol01ErrorCode,
      'merchantId cannot exceed 64 characters'
    );
  }
  if (config.merchantName.length > 128) {
    throw new Protocol01Error(
      'INVALID_CONFIG' as Protocol01ErrorCode,
      'merchantName cannot exceed 128 characters'
    );
  }
}

// ============ ID Generation ============

/**
 * Generate a unique ID
 * @param prefix - Optional prefix for the ID
 * @returns Unique ID string
 */
export function generateId(prefix = 'p01'): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `${prefix}_${timestamp}${random}`;
}

/**
 * Generate a unique order ID if not provided
 * @param orderId - Existing order ID or undefined
 * @returns Order ID
 */
export function ensureOrderId(orderId?: string): string {
  return orderId ?? generateId('order');
}

// ============ Time Utilities ============

/**
 * Calculate next payment timestamp
 * @param startDate - Start date (defaults to now)
 * @param intervalSeconds - Interval in seconds
 * @returns Unix timestamp in milliseconds
 */
export function calculateNextPayment(
  startDate: Date = new Date(),
  intervalSeconds: number
): number {
  return startDate.getTime() + intervalSeconds * 1000;
}

/**
 * Format timestamp to human-readable date
 * @param timestamp - Unix timestamp in milliseconds
 * @param options - Intl.DateTimeFormat options
 * @returns Formatted date string
 */
export function formatDate(
  timestamp: number,
  options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }
): string {
  return new Intl.DateTimeFormat('en-US', options).format(new Date(timestamp));
}

/**
 * Get time until next payment
 * @param nextPaymentAt - Next payment timestamp
 * @returns Human-readable time remaining
 */
export function getTimeUntilPayment(nextPaymentAt: number): string {
  const now = Date.now();
  const diff = nextPaymentAt - now;

  if (diff <= 0) return 'Due now';

  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

  if (days > 0) {
    return days === 1 ? '1 day' : `${days} days`;
  }
  if (hours > 0) {
    return hours === 1 ? '1 hour' : `${hours} hours`;
  }

  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  return minutes <= 1 ? '< 1 minute' : `${minutes} minutes`;
}

// ============ URL Utilities ============

/**
 * Check if a string is a valid URL
 * @param str - String to check
 * @returns true if valid URL
 */
export function isValidUrl(str: string): boolean {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a string is a valid webhook URL
 * @param url - URL to validate
 * @returns true if valid webhook URL
 */
export function isValidWebhookUrl(url: string): boolean {
  if (!isValidUrl(url)) return false;

  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// ============ Browser Utilities ============

/**
 * Check if running in browser environment
 * @returns true if in browser
 */
export function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.document !== 'undefined';
}

/**
 * Check if running in Node.js environment
 * @returns true if in Node.js
 */
export function isNode(): boolean {
  return (
    typeof process !== 'undefined' &&
    process.versions != null &&
    process.versions.node != null
  );
}

/**
 * Sleep for a specified duration
 * @param ms - Milliseconds to sleep
 * @returns Promise that resolves after the duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a promise with timeout
 * @param promise - Promise to wrap
 * @param timeoutMs - Timeout in milliseconds
 * @param errorMessage - Error message on timeout
 * @returns Promise that rejects if timeout exceeded
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage = 'Operation timed out'
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Protocol01Error('TIMEOUT' as Protocol01ErrorCode, errorMessage)
          ),
        timeoutMs
      )
    ),
  ]);
}

// ============ Event Utilities ============

/**
 * Create a deferred promise
 * @returns Object with promise and resolve/reject functions
 */
export function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

/**
 * Create a one-time event listener
 * @param target - Event target
 * @param event - Event name
 * @param timeout - Optional timeout in milliseconds
 * @returns Promise that resolves with the event
 */
export function onceEvent<T extends Event>(
  target: EventTarget,
  event: string,
  timeout?: number
): Promise<T> {
  const { promise, resolve, reject } = createDeferred<T>();

  const handler = (e: Event) => {
    target.removeEventListener(event, handler);
    resolve(e as T);
  };

  target.addEventListener(event, handler);

  if (timeout) {
    setTimeout(() => {
      target.removeEventListener(event, handler);
      reject(
        new Protocol01Error(
          'TIMEOUT' as Protocol01ErrorCode,
          `Timeout waiting for ${event} event`
        )
      );
    }, timeout);
  }

  return promise;
}

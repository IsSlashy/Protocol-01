import { PublicKey, Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import type { Cluster, SpecterError, SpecterErrorCode } from '../types';
import { RPC_ENDPOINTS, STEALTH_ADDRESS_PREFIX, STEALTH_META_ADDRESS_VERSION } from '../constants';
import { toBase58, fromBase58 } from './crypto';

// ============================================================================
// Address Utilities
// ============================================================================

/**
 * Validate a Solana public key
 * @param address - Address string to validate
 */
export function isValidPublicKey(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a stealth meta-address
 * @param address - Stealth meta-address string
 */
export function isValidStealthMetaAddress(address: string): boolean {
  try {
    if (!address.startsWith(STEALTH_ADDRESS_PREFIX)) {
      return false;
    }
    const data = fromBase58(address.slice(STEALTH_ADDRESS_PREFIX.length));
    // Version (1) + spending key (32) + viewing key (32) = 65 bytes
    return data.length === 65 && data[0] === STEALTH_META_ADDRESS_VERSION;
  } catch {
    return false;
  }
}

/**
 * Encode a stealth meta-address from keys
 * @param spendingPubKey - Spending public key (32 bytes)
 * @param viewingPubKey - Viewing public key (32 bytes)
 */
export function encodeStealthMetaAddress(
  spendingPubKey: Uint8Array,
  viewingPubKey: Uint8Array
): string {
  const data = new Uint8Array(65);
  data[0] = STEALTH_META_ADDRESS_VERSION;
  data.set(spendingPubKey, 1);
  data.set(viewingPubKey, 33);
  return STEALTH_ADDRESS_PREFIX + toBase58(data);
}

/**
 * Decode a stealth meta-address to keys
 * @param encoded - Encoded stealth meta-address
 */
export function decodeStealthMetaAddress(encoded: string): {
  spendingPubKey: Uint8Array;
  viewingPubKey: Uint8Array;
} {
  if (!encoded.startsWith(STEALTH_ADDRESS_PREFIX)) {
    throw new Error('Invalid stealth meta-address prefix');
  }

  const data = fromBase58(encoded.slice(STEALTH_ADDRESS_PREFIX.length));
  if (data.length !== 65 || data[0] !== STEALTH_META_ADDRESS_VERSION) {
    throw new Error('Invalid stealth meta-address format');
  }

  return {
    spendingPubKey: data.slice(1, 33),
    viewingPubKey: data.slice(33, 65),
  };
}

/**
 * Shorten an address for display
 * @param address - Full address string
 * @param chars - Number of characters to show on each side
 */
export function shortenAddress(address: string, chars: number = 4): string {
  if (address.length <= chars * 2 + 3) {
    return address;
  }
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

// ============================================================================
// Amount Utilities
// ============================================================================

/**
 * Convert lamports to SOL
 * @param lamports - Amount in lamports
 */
export function lamportsToSol(lamports: bigint | number): number {
  return Number(lamports) / LAMPORTS_PER_SOL;
}

/**
 * Convert SOL to lamports
 * @param sol - Amount in SOL
 */
export function solToLamports(sol: number): bigint {
  return BigInt(Math.round(sol * LAMPORTS_PER_SOL));
}

/**
 * Format lamports as SOL string
 * @param lamports - Amount in lamports
 * @param decimals - Number of decimal places
 */
export function formatSol(lamports: bigint | number, decimals: number = 4): string {
  const sol = lamportsToSol(lamports);
  return sol.toFixed(decimals);
}

/**
 * Format token amount with decimals
 * @param amount - Raw token amount
 * @param decimals - Token decimals
 * @param displayDecimals - Decimals to show
 */
export function formatTokenAmount(
  amount: bigint | number,
  decimals: number,
  displayDecimals: number = 4
): string {
  const divisor = Math.pow(10, decimals);
  const value = Number(amount) / divisor;
  return value.toFixed(displayDecimals);
}

/**
 * Parse a SOL string to lamports
 * @param solString - SOL amount as string
 */
export function parseSol(solString: string): bigint {
  const sol = parseFloat(solString);
  if (isNaN(sol) || sol < 0) {
    throw new Error('Invalid SOL amount');
  }
  return solToLamports(sol);
}

// ============================================================================
// Time Utilities
// ============================================================================

/**
 * Get current Unix timestamp in seconds
 */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Convert days to seconds
 * @param days - Number of days
 */
export function daysToSeconds(days: number): number {
  return days * 24 * 60 * 60;
}

/**
 * Convert seconds to days
 * @param seconds - Number of seconds
 */
export function secondsToDays(seconds: number): number {
  return seconds / (24 * 60 * 60);
}

/**
 * Format duration in human-readable form
 * @param seconds - Duration in seconds
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds} second${seconds !== 1 ? 's' : ''}`;
  }
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
  }
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    return `${hours} hour${hours !== 1 ? 's' : ''}`;
  }
  const days = Math.floor(seconds / 86400);
  return `${days} day${days !== 1 ? 's' : ''}`;
}

/**
 * Format a timestamp as relative time
 * @param timestamp - Unix timestamp in seconds
 */
export function formatRelativeTime(timestamp: number): string {
  const now = nowSeconds();
  const diff = now - timestamp;

  if (diff < 0) {
    return 'in the future';
  }
  if (diff < 60) {
    return 'just now';
  }
  if (diff < 3600) {
    const minutes = Math.floor(diff / 60);
    return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
  }
  if (diff < 86400) {
    const hours = Math.floor(diff / 3600);
    return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
  }
  const days = Math.floor(diff / 86400);
  return `${days} day${days !== 1 ? 's' : ''} ago`;
}

// ============================================================================
// Network Utilities
// ============================================================================

/**
 * Get RPC endpoint for a cluster
 * @param cluster - Network cluster
 */
export function getRpcEndpoint(cluster: Cluster): string {
  return RPC_ENDPOINTS[cluster];
}

/**
 * Create a connection to Solana
 * @param cluster - Network cluster or custom RPC URL
 * @param commitment - Commitment level
 */
export function createConnection(
  cluster: Cluster | string,
  commitment: 'processed' | 'confirmed' | 'finalized' = 'confirmed'
): Connection {
  const endpoint = cluster.startsWith('http')
    ? cluster
    : getRpcEndpoint(cluster as Cluster);
  return new Connection(endpoint, commitment);
}

/**
 * Wait for a specified duration
 * @param ms - Milliseconds to wait
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 * @param fn - Function to retry
 * @param maxRetries - Maximum number of retries
 * @param baseDelay - Base delay in milliseconds
 */
export async function retry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt);
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

// ============================================================================
// Validation Utilities
// ============================================================================

/**
 * Assert a condition and throw if false
 * @param condition - Condition to check
 * @param message - Error message
 */
export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

/**
 * Ensure a value is defined
 * @param value - Value to check
 * @param message - Error message
 */
export function ensureDefined<T>(value: T | undefined | null, message: string): T {
  if (value === undefined || value === null) {
    throw new Error(message);
  }
  return value;
}

/**
 * Check if a value is a valid number
 * @param value - Value to check
 */
export function isValidNumber(value: unknown): value is number {
  return typeof value === 'number' && !isNaN(value) && isFinite(value);
}

/**
 * Check if amount is valid for transfer
 * @param amount - Amount in lamports
 * @param balance - Available balance
 */
export function validateTransferAmount(amount: bigint, balance: bigint): void {
  if (amount <= 0n) {
    throw new Error('Amount must be greater than 0');
  }
  if (amount > balance) {
    throw new Error('Insufficient balance');
  }
}

// ============================================================================
// Array Utilities
// ============================================================================

/**
 * Split an array into chunks
 * @param array - Array to split
 * @param size - Chunk size
 */
export function chunk<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * Remove duplicates from an array
 * @param array - Array with potential duplicates
 * @param key - Key function to determine uniqueness
 */
export function unique<T>(array: T[], key?: (item: T) => string): T[] {
  if (!key) {
    return [...new Set(array)];
  }
  const seen = new Set<string>();
  return array.filter((item) => {
    const k = key(item);
    if (seen.has(k)) {
      return false;
    }
    seen.add(k);
    return true;
  });
}

// ============================================================================
// Object Utilities
// ============================================================================

/**
 * Deep clone an object
 * @param obj - Object to clone
 */
export function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Pick specific keys from an object
 * @param obj - Source object
 * @param keys - Keys to pick
 */
export function pick<T extends object, K extends keyof T>(
  obj: T,
  keys: K[]
): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const key of keys) {
    if (key in obj) {
      result[key] = obj[key];
    }
  }
  return result;
}

/**
 * Omit specific keys from an object
 * @param obj - Source object
 * @param keys - Keys to omit
 */
export function omit<T extends object, K extends keyof T>(
  obj: T,
  keys: K[]
): Omit<T, K> {
  const result = { ...obj };
  for (const key of keys) {
    delete result[key];
  }
  return result as Omit<T, K>;
}

// ============================================================================
// Logging Utilities
// ============================================================================

/**
 * Create a debug logger that only logs when debug is enabled
 * @param namespace - Logger namespace
 * @param enabled - Whether debug is enabled
 */
export function createLogger(namespace: string, enabled: boolean = false) {
  return {
    debug: (...args: unknown[]) => {
      if (enabled) {
        console.debug(`[${namespace}]`, ...args);
      }
    },
    info: (...args: unknown[]) => {
      console.info(`[${namespace}]`, ...args);
    },
    warn: (...args: unknown[]) => {
      console.warn(`[${namespace}]`, ...args);
    },
    error: (...args: unknown[]) => {
      console.error(`[${namespace}]`, ...args);
    },
  };
}

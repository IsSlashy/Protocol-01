/**
 * Cache management utilities for Protocol 01
 * In-memory and persistent caching with TTL support
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { CacheKeys, CacheKey } from './keys';

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

export interface CacheOptions {
  ttl?: number; // Time to live in milliseconds
  persist?: boolean; // Whether to persist to AsyncStorage
}

// In-memory cache store
const memoryCache = new Map<string, CacheEntry<unknown>>();

// Default TTL: 5 minutes
const DEFAULT_TTL = 5 * 60 * 1000;

/**
 * Set cache value (in-memory)
 */
export function setCacheValue<T>(
  key: string,
  data: T,
  options: CacheOptions = {}
): void {
  const { ttl = DEFAULT_TTL } = options;

  const entry: CacheEntry<T> = {
    data,
    timestamp: Date.now(),
    ttl,
  };

  memoryCache.set(key, entry);
}

/**
 * Get cache value (in-memory)
 */
export function getCacheValue<T>(key: string): T | null {
  const entry = memoryCache.get(key) as CacheEntry<T> | undefined;

  if (!entry) {
    return null;
  }

  // Check if expired
  if (isCacheExpired(entry)) {
    memoryCache.delete(key);
    return null;
  }

  return entry.data;
}

/**
 * Delete cache value
 */
export function deleteCacheValue(key: string): void {
  memoryCache.delete(key);
}

/**
 * Clear all in-memory cache
 */
export function clearMemoryCache(): void {
  memoryCache.clear();
}

/**
 * Set cache value with persistence
 */
export async function setPersistentCache<T>(
  key: string,
  data: T,
  ttl: number = DEFAULT_TTL
): Promise<void> {
  const entry: CacheEntry<T> = {
    data,
    timestamp: Date.now(),
    ttl,
  };

  // Save to memory
  memoryCache.set(key, entry);

  // Save to AsyncStorage
  try {
    await AsyncStorage.setItem(key, JSON.stringify(entry));
  } catch (error) {
    console.warn(`Failed to persist cache for key: ${key}`, error);
  }
}

/**
 * Get cache value with persistence fallback
 */
export async function getPersistentCache<T>(key: string): Promise<T | null> {
  // Try memory first
  const memoryValue = getCacheValue<T>(key);
  if (memoryValue !== null) {
    return memoryValue;
  }

  // Try AsyncStorage
  try {
    const stored = await AsyncStorage.getItem(key);
    if (!stored) {
      return null;
    }

    const entry = JSON.parse(stored) as CacheEntry<T>;

    // Check if expired
    if (isCacheExpired(entry)) {
      await AsyncStorage.removeItem(key);
      return null;
    }

    // Restore to memory cache
    memoryCache.set(key, entry);

    return entry.data;
  } catch (error) {
    console.warn(`Failed to retrieve cache for key: ${key}`, error);
    return null;
  }
}

/**
 * Delete persistent cache
 */
export async function deletePersistentCache(key: string): Promise<void> {
  memoryCache.delete(key);
  try {
    await AsyncStorage.removeItem(key);
  } catch (error) {
    console.warn(`Failed to delete cache for key: ${key}`, error);
  }
}

/**
 * Clear all persistent cache
 */
export async function clearPersistentCache(): Promise<void> {
  clearMemoryCache();

  const allCacheKeys = Object.values(CacheKeys).map(c => c.key);

  try {
    await AsyncStorage.multiRemove(allCacheKeys);
  } catch (error) {
    console.warn('Failed to clear persistent cache', error);
  }
}

/**
 * Check if cache entry is expired
 */
export function isCacheExpired<T>(entry: CacheEntry<T>): boolean {
  return Date.now() - entry.timestamp > entry.ttl;
}

/**
 * Get cache entry metadata
 */
export function getCacheMetadata(key: string): {
  exists: boolean;
  timestamp?: number;
  ttl?: number;
  isExpired?: boolean;
  remainingTTL?: number;
} {
  const entry = memoryCache.get(key);

  if (!entry) {
    return { exists: false };
  }

  const isExpired = isCacheExpired(entry);
  const age = Date.now() - entry.timestamp;
  const remainingTTL = Math.max(0, entry.ttl - age);

  return {
    exists: true,
    timestamp: entry.timestamp,
    ttl: entry.ttl,
    isExpired,
    remainingTTL,
  };
}

/**
 * Get or set cache value (cache-aside pattern)
 */
export async function getOrSetCache<T>(
  key: string,
  fetchFn: () => Promise<T>,
  ttl: number = DEFAULT_TTL
): Promise<T> {
  // Try to get from cache first
  const cached = getCacheValue<T>(key);
  if (cached !== null) {
    return cached;
  }

  // Fetch new data
  const data = await fetchFn();

  // Store in cache
  setCacheValue(key, data, { ttl });

  return data;
}

/**
 * Get or set persistent cache
 */
export async function getOrSetPersistentCache<T>(
  key: string,
  fetchFn: () => Promise<T>,
  ttl: number = DEFAULT_TTL
): Promise<T> {
  // Try to get from cache first
  const cached = await getPersistentCache<T>(key);
  if (cached !== null) {
    return cached;
  }

  // Fetch new data
  const data = await fetchFn();

  // Store in cache
  await setPersistentCache(key, data, ttl);

  return data;
}

/**
 * Invalidate cache by pattern
 */
export function invalidateCacheByPattern(pattern: string | RegExp): void {
  const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern;

  for (const key of memoryCache.keys()) {
    if (regex.test(key)) {
      memoryCache.delete(key);
    }
  }
}

/**
 * Invalidate cache by pattern (persistent)
 */
export async function invalidatePersistentCacheByPattern(
  pattern: string | RegExp
): Promise<void> {
  const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern;

  // Clear from memory
  invalidateCacheByPattern(pattern);

  // Clear from AsyncStorage
  try {
    const allKeys = await AsyncStorage.getAllKeys();
    const matchingKeys = allKeys.filter(key => regex.test(key));
    if (matchingKeys.length > 0) {
      await AsyncStorage.multiRemove(matchingKeys);
    }
  } catch (error) {
    console.warn('Failed to invalidate persistent cache by pattern', error);
  }
}

/**
 * Get cache statistics
 */
export function getCacheStats(): {
  size: number;
  keys: string[];
  totalEntries: number;
  expiredEntries: number;
} {
  const keys = Array.from(memoryCache.keys());
  let expiredCount = 0;

  for (const key of keys) {
    const entry = memoryCache.get(key);
    if (entry && isCacheExpired(entry)) {
      expiredCount++;
    }
  }

  return {
    size: memoryCache.size,
    keys,
    totalEntries: keys.length,
    expiredEntries: expiredCount,
  };
}

/**
 * Prune expired entries from memory cache
 */
export function pruneExpiredCache(): number {
  let prunedCount = 0;

  for (const [key, entry] of memoryCache.entries()) {
    if (isCacheExpired(entry)) {
      memoryCache.delete(key);
      prunedCount++;
    }
  }

  return prunedCount;
}

// Predefined cache helpers for common use cases

/**
 * Cache SOL price
 */
export function cacheSolPrice(price: number): void {
  setCacheValue(CacheKeys.SOL_PRICE.key, price, { ttl: CacheKeys.SOL_PRICE.ttl });
}

export function getCachedSolPrice(): number | null {
  return getCacheValue<number>(CacheKeys.SOL_PRICE.key);
}

/**
 * Cache balances
 */
export function cacheBalances(balances: Record<string, number>): void {
  setCacheValue(CacheKeys.BALANCES.key, balances, { ttl: CacheKeys.BALANCES.ttl });
}

export function getCachedBalances(): Record<string, number> | null {
  return getCacheValue<Record<string, number>>(CacheKeys.BALANCES.key);
}

/**
 * Cache token prices
 */
export function cacheTokenPrices(prices: Record<string, number>): void {
  setCacheValue(CacheKeys.TOKEN_PRICES.key, prices, { ttl: CacheKeys.TOKEN_PRICES.ttl });
}

export function getCachedTokenPrices(): Record<string, number> | null {
  return getCacheValue<Record<string, number>>(CacheKeys.TOKEN_PRICES.key);
}

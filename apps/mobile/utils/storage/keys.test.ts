/**
 * Storage Keys Test Suite
 *
 * Validates the centralized key management system that governs
 * all SecureStore and AsyncStorage key names used across the app.
 * Ensures keys are unique, properly namespaced, and type-safe.
 */

import { describe, it, expect } from 'vitest';
import {
  SecureStorageKeys,
  AsyncStorageKeys,
  CacheKeys,
  getAllSecureKeys,
  getAllAsyncKeys,
  getAllCacheKeys,
  createNamespacedKey,
  createAccountKey,
  isSecureStorageKey,
  isCacheKey,
} from './keys';

describe('Storage Keys -- Centralized Key Management', () => {

  // ===================================================================
  // Section 1: Key Namespace Integrity
  // ===================================================================

  describe('Key Namespace Integrity', () => {
    it('should prefix all secure storage keys with p01_', () => {
      Object.values(SecureStorageKeys).forEach(key => {
        expect(key.startsWith('p01_')).toBe(true);
      });
    });

    it('should prefix all async storage keys with p01_', () => {
      Object.values(AsyncStorageKeys).forEach(key => {
        expect(key.startsWith('p01_')).toBe(true);
      });
    });

    it('should prefix all cache keys with cache_', () => {
      Object.values(CacheKeys).forEach(entry => {
        expect(entry.key.startsWith('cache_')).toBe(true);
      });
    });
  });

  // ===================================================================
  // Section 2: Key Uniqueness
  // ===================================================================

  describe('Key Uniqueness', () => {
    it('should have no duplicate secure storage keys', () => {
      const values = Object.values(SecureStorageKeys);
      const unique = new Set(values);
      expect(unique.size).toBe(values.length);
    });

    it('should have no duplicate async storage keys', () => {
      const values = Object.values(AsyncStorageKeys);
      const unique = new Set(values);
      expect(unique.size).toBe(values.length);
    });

    it('should have no overlap between secure and async storage keys', () => {
      const secureKeys = new Set(Object.values(SecureStorageKeys));
      const asyncKeys = Object.values(AsyncStorageKeys);

      asyncKeys.forEach(key => {
        expect(secureKeys.has(key as any)).toBe(false);
      });
    });
  });

  // ===================================================================
  // Section 3: Required Keys Exist
  // ===================================================================

  describe('Required Keys Exist', () => {
    it('should define all wallet-related secure keys', () => {
      expect(SecureStorageKeys.MNEMONIC).toBeDefined();
      expect(SecureStorageKeys.PRIVATE_KEY).toBeDefined();
      expect(SecureStorageKeys.SPENDING_KEY).toBeDefined();
      expect(SecureStorageKeys.VIEWING_KEY).toBeDefined();
      expect(SecureStorageKeys.ENCRYPTION_KEY).toBeDefined();
    });

    it('should define all authentication secure keys', () => {
      expect(SecureStorageKeys.PIN_HASH).toBeDefined();
      expect(SecureStorageKeys.PIN_SALT).toBeDefined();
      expect(SecureStorageKeys.BIOMETRIC_KEY).toBeDefined();
      expect(SecureStorageKeys.AUTH_TOKEN).toBeDefined();
    });

    it('should define all app state async keys', () => {
      expect(AsyncStorageKeys.WALLET_ADDRESS).toBeDefined();
      expect(AsyncStorageKeys.SETTINGS).toBeDefined();
      expect(AsyncStorageKeys.NETWORK).toBeDefined();
      expect(AsyncStorageKeys.ONBOARDING_COMPLETE).toBeDefined();
    });

    it('should define stealth-related async keys', () => {
      expect(AsyncStorageKeys.STEALTH_META_REGISTRY).toBeDefined();
      expect(AsyncStorageKeys.SCANNED_BLOCKS).toBeDefined();
    });
  });

  // ===================================================================
  // Section 4: Cache Keys with TTL
  // ===================================================================

  describe('Cache Keys with TTL', () => {
    it('should define TTL for all cache entries', () => {
      Object.values(CacheKeys).forEach(entry => {
        expect(entry.ttl).toBeGreaterThan(0);
        expect(typeof entry.ttl).toBe('number');
      });
    });

    it('should have reasonable TTLs (less than 24 hours)', () => {
      const maxTTL = 24 * 60 * 60 * 1000; // 24 hours
      Object.values(CacheKeys).forEach(entry => {
        expect(entry.ttl).toBeLessThanOrEqual(maxTTL);
      });
    });

    it('should have short TTL for price data (under 5 minutes)', () => {
      expect(CacheKeys.SOL_PRICE.ttl).toBeLessThanOrEqual(5 * 60 * 1000);
      expect(CacheKeys.TOKEN_PRICES.ttl).toBeLessThanOrEqual(5 * 60 * 1000);
    });
  });

  // ===================================================================
  // Section 5: Key Helper Functions
  // ===================================================================

  describe('Key Helper Functions', () => {
    it('should return all secure storage keys', () => {
      const keys = getAllSecureKeys();
      expect(keys.length).toBeGreaterThan(0);
      expect(keys).toContain(SecureStorageKeys.MNEMONIC);
    });

    it('should return all async storage keys', () => {
      const keys = getAllAsyncKeys();
      expect(keys.length).toBeGreaterThan(0);
      expect(keys).toContain(AsyncStorageKeys.WALLET_ADDRESS);
    });

    it('should return all cache key strings', () => {
      const keys = getAllCacheKeys();
      expect(keys.length).toBeGreaterThan(0);
      expect(keys).toContain(CacheKeys.SOL_PRICE.key);
    });

    it('should create namespaced keys', () => {
      expect(createNamespacedKey('stealth', 'registry')).toBe('p01_stealth_registry');
      expect(createNamespacedKey('token', 'metadata')).toBe('p01_token_metadata');
    });

    it('should create account-specific keys using address prefix', () => {
      const key = createAccountKey('p01_balance', 'AbCdEfGhIjKlMnOpQrSt');
      expect(key).toBe('p01_balance_AbCdEfGh');
    });

    it('should identify secure storage keys', () => {
      expect(isSecureStorageKey(SecureStorageKeys.MNEMONIC)).toBe(true);
      expect(isSecureStorageKey('random_key')).toBe(false);
    });

    it('should identify cache keys', () => {
      expect(isCacheKey(CacheKeys.SOL_PRICE.key)).toBe(true);
      expect(isCacheKey('random_key')).toBe(false);
    });
  });
});

/**
 * Secure Storage Test Suite
 *
 * Validates the secure storage abstraction layer that wraps expo-secure-store
 * for managing sensitive wallet credentials. Ensures mnemonics, private keys,
 * and PIN hashes are stored, retrieved, and deleted correctly.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as SecureStore from '../../test/__mocks__/expo-secure-store';
import {
  secureSet,
  secureGet,
  secureDelete,
  secureSetJSON,
  secureGetJSON,
  secureHas,
  secureGetOrDefault,
  secureClearAll,
  saveMnemonic,
  getMnemonic,
  deleteMnemonic,
  savePrivateKey,
  getPrivateKey,
  deletePrivateKey,
  savePINHash,
  getPINCredentials,
  deletePINCredentials,
  hasWalletCredentials,
  hasPINSetup,
  updateLastUnlock,
  getLastUnlock,
} from './secure';

describe('Secure Storage -- Wallet Credentials Management', () => {

  beforeEach(() => {
    SecureStore.__reset();
    vi.clearAllMocks();
  });

  // ===================================================================
  // Section 1: Basic CRUD Operations
  // ===================================================================

  describe('Basic Secure Storage Operations', () => {
    it('should store and retrieve a string value', async () => {
      await secureSet('test_key', 'test_value');
      const value = await secureGet('test_key');
      expect(value).toBe('test_value');
    });

    it('should return null for non-existent keys', async () => {
      const value = await secureGet('nonexistent');
      expect(value).toBeNull();
    });

    it('should delete a stored value', async () => {
      await secureSet('key_to_delete', 'value');
      await secureDelete('key_to_delete');
      const value = await secureGet('key_to_delete');
      expect(value).toBeNull();
    });

    it('should overwrite existing values', async () => {
      await secureSet('overwrite_key', 'original');
      await secureSet('overwrite_key', 'updated');
      const value = await secureGet('overwrite_key');
      expect(value).toBe('updated');
    });
  });

  // ===================================================================
  // Section 2: JSON Storage
  // ===================================================================

  describe('JSON Object Storage', () => {
    it('should store and retrieve JSON objects', async () => {
      const data = { name: 'Protocol 01', version: 1, features: ['stealth', 'privacy'] };
      await secureSetJSON('json_key', data);
      const retrieved = await secureGetJSON<typeof data>('json_key');
      expect(retrieved).toEqual(data);
    });

    it('should return null for non-existent JSON keys', async () => {
      const value = await secureGetJSON('missing_json');
      expect(value).toBeNull();
    });

    it('should handle nested objects', async () => {
      const nested = { wallet: { address: 'abc', tokens: [{ mint: 'usdc', balance: 100 }] } };
      await secureSetJSON('nested_key', nested);
      const retrieved = await secureGetJSON<typeof nested>('nested_key');
      expect(retrieved).toEqual(nested);
    });
  });

  // ===================================================================
  // Section 3: Key Existence Checks
  // ===================================================================

  describe('Key Existence Checks', () => {
    it('should return true for existing keys', async () => {
      await secureSet('existing_key', 'value');
      expect(await secureHas('existing_key')).toBe(true);
    });

    it('should return false for non-existent keys', async () => {
      expect(await secureHas('missing_key')).toBe(false);
    });

    it('should provide default value when key does not exist', async () => {
      const value = await secureGetOrDefault('missing', 'fallback' as any);
      expect(value).toBe('fallback');
    });

    it('should return stored value over default', async () => {
      await secureSet('real_key', 'real_value');
      const value = await secureGetOrDefault('real_key', 'fallback' as any);
      expect(value).toBe('real_value');
    });
  });

  // ===================================================================
  // Section 4: Mnemonic Management
  // ===================================================================

  describe('Mnemonic Management', () => {
    const TEST_MNEMONIC = 'abandon ability able about above absent absorb abstract absurd abuse access accident';

    it('should save and retrieve a mnemonic', async () => {
      await saveMnemonic(TEST_MNEMONIC);
      const retrieved = await getMnemonic();
      expect(retrieved).toBe(TEST_MNEMONIC);
    });

    it('should delete a stored mnemonic', async () => {
      await saveMnemonic(TEST_MNEMONIC);
      await deleteMnemonic();
      const retrieved = await getMnemonic();
      expect(retrieved).toBeNull();
    });

    it('should return null when no mnemonic is stored', async () => {
      expect(await getMnemonic()).toBeNull();
    });
  });

  // ===================================================================
  // Section 5: Private Key Management
  // ===================================================================

  describe('Private Key Management', () => {
    const TEST_PRIVATE_KEY = 'base58encodedprivatekeydata12345';

    it('should save and retrieve a private key', async () => {
      await savePrivateKey(TEST_PRIVATE_KEY);
      const retrieved = await getPrivateKey();
      expect(retrieved).toBe(TEST_PRIVATE_KEY);
    });

    it('should delete a stored private key', async () => {
      await savePrivateKey(TEST_PRIVATE_KEY);
      await deletePrivateKey();
      expect(await getPrivateKey()).toBeNull();
    });
  });

  // ===================================================================
  // Section 6: PIN Credentials
  // ===================================================================

  describe('PIN Credential Storage', () => {
    it('should save PIN hash and salt together', async () => {
      await savePINHash('hashedpin123', 'salt456');
      const creds = await getPINCredentials();
      expect(creds.hash).toBe('hashedpin123');
      expect(creds.salt).toBe('salt456');
    });

    it('should return null values when no PIN is set', async () => {
      const creds = await getPINCredentials();
      expect(creds.hash).toBeNull();
      expect(creds.salt).toBeNull();
    });

    it('should delete PIN credentials', async () => {
      await savePINHash('hash', 'salt');
      await deletePINCredentials();
      const creds = await getPINCredentials();
      expect(creds.hash).toBeNull();
      expect(creds.salt).toBeNull();
    });

    it('should report PIN setup status correctly', async () => {
      expect(await hasPINSetup()).toBe(false);

      await savePINHash('hash', 'salt');
      expect(await hasPINSetup()).toBe(true);

      await deletePINCredentials();
      expect(await hasPINSetup()).toBe(false);
    });
  });

  // ===================================================================
  // Section 7: Wallet Existence Checks
  // ===================================================================

  describe('Wallet Credential Existence', () => {
    it('should return false when neither mnemonic nor private key exists', async () => {
      expect(await hasWalletCredentials()).toBe(false);
    });

    it('should return true when mnemonic exists', async () => {
      await saveMnemonic('test mnemonic words');
      expect(await hasWalletCredentials()).toBe(true);
    });

    it('should return true when private key exists (even without mnemonic)', async () => {
      await savePrivateKey('private-key-data');
      expect(await hasWalletCredentials()).toBe(true);
    });
  });

  // ===================================================================
  // Section 8: Session Management
  // ===================================================================

  describe('Session and Unlock Tracking', () => {
    it('should store and retrieve the last unlock timestamp', async () => {
      const before = Date.now();
      await updateLastUnlock();
      const timestamp = await getLastUnlock();

      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(Date.now());
    });

    it('should return null when no unlock has been recorded', async () => {
      expect(await getLastUnlock()).toBeNull();
    });
  });

  // ===================================================================
  // Section 9: Clear All Data
  // ===================================================================

  describe('Clear All Secure Storage', () => {
    it('should clear all stored Protocol 01 credentials', async () => {
      await saveMnemonic('test mnemonic');
      await savePrivateKey('test private key');
      await savePINHash('hash', 'salt');

      await secureClearAll();

      expect(await getMnemonic()).toBeNull();
      expect(await getPrivateKey()).toBeNull();
      expect(await hasPINSetup()).toBe(false);
    });
  });
});

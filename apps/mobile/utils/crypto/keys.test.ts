/**
 * Key Derivation Utilities Test Suite
 *
 * Validates the BIP32/BIP44 key derivation pipeline that converts
 * seed phrases into deterministic Solana keypairs. Ensures derivation
 * paths are correctly parsed, child keys are derived consistently,
 * and various key format conversions work as expected.
 */

import { describe, it, expect } from 'vitest';
import { Keypair } from '../../test/__mocks__/@solana/web3.js';
import {
  deriveKeypairFromMnemonic,
  deriveMultipleAccounts,
  getDerivationPath,
  deriveKeypairFromSeed,
  generateRandomKeypair,
  getPublicKeyString,
  secretKeyToBase64,
  base64ToSecretKey,
  keypairFromSecretKey,
  keypairFromBase64,
  deriveChildKey,
  deriveEncryptionKey,
  deriveSigningKeypair,
  isValidDerivationPath,
  parseDerivationPath,
  isHardenedPath,
} from './keys';

// Use a mnemonic composed of valid BIP39 words from our mock wordlist
const TEST_MNEMONIC = 'abandon ability able about above absent absorb abstract absurd abuse access accident';

describe('Key Derivation Utilities -- BIP32/BIP44 for Solana', () => {

  // ===================================================================
  // Section 1: Keypair Derivation from Mnemonic
  // ===================================================================

  describe('Keypair Derivation from Mnemonic', () => {
    it('should derive a keypair from a valid mnemonic', async () => {
      const result = await deriveKeypairFromMnemonic(TEST_MNEMONIC);

      expect(result).toHaveProperty('keypair');
      expect(result).toHaveProperty('publicKey');
      expect(result).toHaveProperty('path');
      expect(typeof result.publicKey).toBe('string');
      expect(result.publicKey.length).toBeGreaterThan(0);
    });

    it('should derive the same keypair from the same mnemonic', async () => {
      const result1 = await deriveKeypairFromMnemonic(TEST_MNEMONIC);
      const result2 = await deriveKeypairFromMnemonic(TEST_MNEMONIC);

      expect(result1.publicKey).toBe(result2.publicKey);
    });

    it('should use the default account index 0', async () => {
      const result = await deriveKeypairFromMnemonic(TEST_MNEMONIC);
      expect(result.path).toBe("m/44'/501'/0'/0'");
    });

    it('should derive different keys for different account indices', async () => {
      const result0 = await deriveKeypairFromMnemonic(TEST_MNEMONIC, 0);
      const result1 = await deriveKeypairFromMnemonic(TEST_MNEMONIC, 1);

      expect(result0.publicKey).not.toBe(result1.publicKey);
      expect(result0.path).not.toBe(result1.path);
    });

    it('should reject an invalid mnemonic', async () => {
      await expect(
        deriveKeypairFromMnemonic('invalid words that are not in wordlist')
      ).rejects.toMatchObject({ code: 'INVALID_MNEMONIC' });
    });
  });

  // ===================================================================
  // Section 2: Multiple Account Derivation
  // ===================================================================

  describe('Multiple Account Derivation', () => {
    it('should derive the requested number of accounts', async () => {
      const accounts = await deriveMultipleAccounts(TEST_MNEMONIC, 3);

      expect(accounts).toHaveLength(3);
      accounts.forEach((account, index) => {
        expect(account.path).toBe(`m/44'/501'/${index}'/0'`);
        expect(account.publicKey).toBeTruthy();
      });
    });

    it('should produce unique public keys for each account', async () => {
      const accounts = await deriveMultipleAccounts(TEST_MNEMONIC, 5);
      const publicKeys = accounts.map(a => a.publicKey);
      const uniqueKeys = new Set(publicKeys);

      expect(uniqueKeys.size).toBe(5);
    });

    it('should default to 5 accounts when no count specified', async () => {
      const accounts = await deriveMultipleAccounts(TEST_MNEMONIC);
      expect(accounts).toHaveLength(5);
    });
  });

  // ===================================================================
  // Section 3: Derivation Path Management
  // ===================================================================

  describe('Derivation Path Management', () => {
    it('should generate standard Solana BIP44 paths', () => {
      expect(getDerivationPath(0)).toBe("m/44'/501'/0'/0'");
      expect(getDerivationPath(1)).toBe("m/44'/501'/1'/0'");
      expect(getDerivationPath(99)).toBe("m/44'/501'/99'/0'");
    });

    it('should validate correct derivation paths', () => {
      expect(isValidDerivationPath("m/44'/501'/0'/0'")).toBe(true);
      expect(isValidDerivationPath("m/0/1/2")).toBe(true);
      expect(isValidDerivationPath("m/44'")).toBe(true);
    });

    it('should reject invalid derivation paths', () => {
      expect(isValidDerivationPath('')).toBe(false);
      expect(isValidDerivationPath('not/a/path')).toBe(false);
      expect(isValidDerivationPath('m')).toBe(false);
      expect(isValidDerivationPath('m/')).toBe(false);
    });

    it('should parse derivation path into index array', () => {
      const indices = parseDerivationPath("m/44'/501'/0'/0'");
      expect(indices).toHaveLength(4);
      // First index should be 44 + hardened offset
      expect(indices[0]).toBe(44 + 0x80000000);
      expect(indices[1]).toBe(501 + 0x80000000);
    });

    it('should throw for invalid path during parsing', () => {
      expect(() => parseDerivationPath('invalid')).toThrow();
    });

    it('should detect hardened paths', () => {
      expect(isHardenedPath("m/44'/501'/0'/0'")).toBe(true);
      expect(isHardenedPath("m/0/1/2")).toBe(false);
    });
  });

  // ===================================================================
  // Section 4: Keypair from Seed
  // ===================================================================

  describe('Keypair from Seed', () => {
    it('should create a keypair from a 32-byte seed', () => {
      const seed = new Uint8Array(32);
      seed.fill(42);
      const keypair = deriveKeypairFromSeed(seed);

      expect(keypair).toBeDefined();
      expect(keypair.publicKey).toBeDefined();
      expect(keypair.secretKey).toBeDefined();
    });

    it('should reject seeds that are not 32 bytes', () => {
      expect(() => deriveKeypairFromSeed(new Uint8Array(16))).toThrow();
      expect(() => deriveKeypairFromSeed(new Uint8Array(64))).toThrow();
    });

    it('should generate a random keypair', () => {
      const kp = generateRandomKeypair();
      expect(kp.publicKey).toBeDefined();
      expect(kp.secretKey.length).toBe(64);
    });
  });

  // ===================================================================
  // Section 5: Key Format Conversions
  // ===================================================================

  describe('Key Format Conversions', () => {
    it('should extract public key string from keypair', () => {
      const kp = Keypair.generate();
      const pubStr = getPublicKeyString(kp);
      expect(typeof pubStr).toBe('string');
      expect(pubStr.length).toBeGreaterThan(0);
    });

    it('should round-trip secret key through base64', () => {
      const kp = Keypair.generate();
      const b64 = secretKeyToBase64(kp.secretKey);
      const restored = base64ToSecretKey(b64);

      expect(restored).toBeInstanceOf(Uint8Array);
      expect(restored.length).toBe(kp.secretKey.length);
    });

    it('should restore a keypair from its secret key', () => {
      const kp = Keypair.generate();
      const restored = keypairFromSecretKey(kp.secretKey);

      expect(restored.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
    });

    it('should restore a keypair from base64 secret', () => {
      const kp = Keypair.generate();
      const b64 = secretKeyToBase64(kp.secretKey);
      const restored = keypairFromBase64(b64);

      expect(restored).toBeDefined();
      expect(restored.secretKey.length).toBe(64);
    });
  });

  // ===================================================================
  // Section 6: Child Key Derivation
  // ===================================================================

  describe('Child Key Derivation', () => {
    it('should derive child keys for different purposes', async () => {
      const parentSeed = new Uint8Array(32);
      parentSeed.fill(1);

      const encKey = await deriveChildKey(parentSeed, 'encryption');
      const sigKey = await deriveChildKey(parentSeed, 'signing');

      expect(encKey).not.toEqual(sigKey);
      expect(encKey).toBeInstanceOf(Uint8Array);
      expect(encKey.length).toBeGreaterThan(0);
    });

    it('should derive deterministic child keys', async () => {
      const parentSeed = new Uint8Array(32);
      parentSeed.fill(7);

      const key1 = await deriveChildKey(parentSeed, 'test');
      const key2 = await deriveChildKey(parentSeed, 'test');

      expect(key1).toEqual(key2);
    });

    it('should derive an encryption key from master key', async () => {
      const masterKey = new Uint8Array(32);
      masterKey.fill(3);

      const encKey = await deriveEncryptionKey(masterKey);
      expect(typeof encKey).toBe('string');
      expect(encKey).toMatch(/^[0-9a-f]+$/);
    });

    it('should derive a signing keypair from master key', async () => {
      const masterKey = new Uint8Array(32);
      masterKey.fill(5);

      const kp = await deriveSigningKeypair(masterKey);
      expect(kp).toBeDefined();
      expect(kp.publicKey).toBeDefined();
    });
  });
});

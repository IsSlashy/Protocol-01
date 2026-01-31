/**
 * Encryption Utilities Test Suite
 *
 * Validates the AES-GCM-style authenticated encryption layer used to
 * protect sensitive wallet data at rest, including key derivation,
 * encrypt/decrypt round-trips, authentication tag verification, and
 * timing-safe comparison functions.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  generateEncryptionKey,
  generateRandomHex,
  deriveKeyFromPassword,
  encryptData,
  decryptData,
  encryptWithPassword,
  decryptWithPassword,
  hashData,
  hashWithSalt,
  verifyHash,
  secureCompare,
} from './encryption';

describe('Encryption Utilities -- Local Data Protection', () => {

  // ===================================================================
  // Section 1: Key Generation
  // ===================================================================

  describe('Encryption Key Generation', () => {
    it('should generate a 256-bit (64 hex char) encryption key', async () => {
      const key = await generateEncryptionKey();
      expect(key).toHaveLength(64); // 32 bytes = 64 hex chars
      expect(key).toMatch(/^[0-9a-f]+$/);
    });

    it('should generate unique keys on successive calls', async () => {
      const key1 = await generateEncryptionKey();
      const key2 = await generateEncryptionKey();
      expect(key1).not.toBe(key2);
    });

    it('should generate random hex strings of specified length', async () => {
      const hex16 = await generateRandomHex(16);
      expect(hex16).toHaveLength(32); // 16 bytes = 32 hex chars

      const hex8 = await generateRandomHex(8);
      expect(hex8).toHaveLength(16);
    });
  });

  // ===================================================================
  // Section 2: Password-Based Key Derivation
  // ===================================================================

  describe('Password-Based Key Derivation', () => {
    it('should derive a deterministic key from the same password and salt', async () => {
      const key1 = await deriveKeyFromPassword('password123', 'salt456', 10);
      const key2 = await deriveKeyFromPassword('password123', 'salt456', 10);
      expect(key1).toBe(key2);
    });

    it('should derive different keys for different passwords', async () => {
      const key1 = await deriveKeyFromPassword('password1', 'sameSalt', 10);
      const key2 = await deriveKeyFromPassword('password2', 'sameSalt', 10);
      expect(key1).not.toBe(key2);
    });

    it('should derive different keys for different salts', async () => {
      const key1 = await deriveKeyFromPassword('samePassword', 'salt1', 10);
      const key2 = await deriveKeyFromPassword('samePassword', 'salt2', 10);
      expect(key1).not.toBe(key2);
    });

    it('should reject empty password', async () => {
      await expect(deriveKeyFromPassword('', 'salt')).rejects.toMatchObject({
        code: 'INVALID_KEY',
      });
    });

    it('should reject empty salt', async () => {
      await expect(deriveKeyFromPassword('password', '')).rejects.toMatchObject({
        code: 'INVALID_KEY',
      });
    });

    it('should return a hex string', async () => {
      const key = await deriveKeyFromPassword('password', 'salt', 10);
      expect(key).toMatch(/^[0-9a-f]+$/);
    });
  });

  // ===================================================================
  // Section 3: Encrypt / Decrypt Round-Trip
  // ===================================================================

  describe('Encrypt and Decrypt Round-Trip', () => {
    let testKey: string;

    beforeEach(async () => {
      testKey = await generateEncryptionKey();
    });

    it('should encrypt and decrypt a simple message', async () => {
      const message = 'Hello, Protocol 01!';
      const encrypted = await encryptData(message, testKey);
      const decrypted = await decryptData(encrypted, testKey);
      expect(decrypted).toBe(message);
    });

    it('should encrypt and decrypt a seed phrase', async () => {
      const mnemonic = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
      const encrypted = await encryptData(mnemonic, testKey);
      const decrypted = await decryptData(encrypted, testKey);
      expect(decrypted).toBe(mnemonic);
    });

    it('should encrypt and decrypt JSON data', async () => {
      const json = JSON.stringify({ key: 'value', nested: { arr: [1, 2, 3] } });
      const encrypted = await encryptData(json, testKey);
      const decrypted = await decryptData(encrypted, testKey);
      expect(JSON.parse(decrypted)).toEqual(JSON.parse(json));
    });

    it('should produce different ciphertexts for the same plaintext (random IV)', async () => {
      const message = 'Same message';
      const enc1 = await encryptData(message, testKey);
      const enc2 = await encryptData(message, testKey);
      expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
      expect(enc1.iv).not.toBe(enc2.iv);
    });

    it('should return an EncryptedData structure with required fields', async () => {
      const encrypted = await encryptData('test', testKey);
      expect(encrypted).toHaveProperty('ciphertext');
      expect(encrypted).toHaveProperty('iv');
      expect(encrypted).toHaveProperty('salt');
      expect(encrypted).toHaveProperty('tag');
      expect(typeof encrypted.ciphertext).toBe('string');
      expect(typeof encrypted.iv).toBe('string');
      expect(typeof encrypted.salt).toBe('string');
      expect(typeof encrypted.tag).toBe('string');
    });
  });

  // ===================================================================
  // Section 4: Authentication Tag Verification
  // ===================================================================

  describe('Authentication Tag Verification', () => {
    let testKey: string;

    beforeEach(async () => {
      testKey = await generateEncryptionKey();
    });

    it('should fail decryption with a wrong key', async () => {
      const encrypted = await encryptData('secret data', testKey);
      const wrongKey = await generateEncryptionKey();

      await expect(decryptData(encrypted, wrongKey)).rejects.toMatchObject({
        code: 'INVALID_DATA',
      });
    });

    it('should fail decryption if ciphertext is tampered', async () => {
      const encrypted = await encryptData('secret data', testKey);
      const tampered = {
        ...encrypted,
        ciphertext: encrypted.ciphertext.replace(/.$/, 'x'),
      };

      await expect(decryptData(tampered, testKey)).rejects.toMatchObject({
        code: 'INVALID_DATA',
      });
    });

    it('should fail decryption if the tag is tampered', async () => {
      const encrypted = await encryptData('secret data', testKey);
      const tampered = {
        ...encrypted,
        tag: 'ff'.repeat(16),
      };

      await expect(decryptData(tampered, testKey)).rejects.toMatchObject({
        code: 'INVALID_DATA',
      });
    });
  });

  // ===================================================================
  // Section 5: Password-Based Encryption
  // ===================================================================

  describe('Password-Based Encryption', () => {
    it('should produce an EncryptedData structure with all required fields', async () => {
      const encrypted = await encryptWithPassword('test data', 'password123');

      expect(encrypted).toHaveProperty('ciphertext');
      expect(encrypted).toHaveProperty('iv');
      expect(encrypted).toHaveProperty('salt');
      expect(encrypted).toHaveProperty('tag');
    });

    it('should override the salt with the key-derivation salt', async () => {
      // encryptWithPassword generates its own salt for PBKDF2 key derivation
      // and overwrites the encryptData salt with it
      const encrypted = await encryptWithPassword('test', 'password');
      expect(encrypted.salt).toBeTruthy();
      expect(encrypted.salt.length).toBe(32); // SALT_LENGTH (16 bytes) = 32 hex chars
    });

    it('should produce different ciphertexts for the same input (random salt + IV)', async () => {
      const e1 = await encryptWithPassword('same data', 'samePass');
      const e2 = await encryptWithPassword('same data', 'samePass');

      expect(e1.ciphertext).not.toBe(e2.ciphertext);
      expect(e1.salt).not.toBe(e2.salt);
    });

    it('should fail decryption with wrong password (tag mismatch)', async () => {
      const encrypted = await encryptWithPassword('secret', 'correctPassword');

      await expect(
        decryptWithPassword(encrypted, 'wrongPassword')
      ).rejects.toBeDefined();
    });
  });

  // ===================================================================
  // Section 6: Hashing Functions
  // ===================================================================

  describe('Hashing Functions', () => {
    it('should produce consistent hashes for the same input', async () => {
      const hash1 = await hashData('test');
      const hash2 = await hashData('test');
      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different inputs', async () => {
      const hash1 = await hashData('test1');
      const hash2 = await hashData('test2');
      expect(hash1).not.toBe(hash2);
    });

    it('should produce salted hashes', async () => {
      const hash1 = await hashWithSalt('data', 'salt1');
      const hash2 = await hashWithSalt('data', 'salt2');
      expect(hash1).not.toBe(hash2);
    });

    it('should verify correct hash', async () => {
      const hash = await hashData('myData');
      expect(await verifyHash('myData', hash)).toBe(true);
    });

    it('should reject incorrect hash', async () => {
      const hash = await hashData('myData');
      expect(await verifyHash('differentData', hash)).toBe(false);
    });

    it('should verify salted hash', async () => {
      const salt = 'mySalt';
      const hash = await hashWithSalt('myData', salt);
      expect(await verifyHash('myData', hash, salt)).toBe(true);
      expect(await verifyHash('wrong', hash, salt)).toBe(false);
    });
  });

  // ===================================================================
  // Section 7: Timing-Safe Comparison
  // ===================================================================

  describe('Timing-Safe String Comparison', () => {
    it('should return true for identical strings', () => {
      expect(secureCompare('abc', 'abc')).toBe(true);
    });

    it('should return false for different strings', () => {
      expect(secureCompare('abc', 'xyz')).toBe(false);
    });

    it('should return false for different-length strings', () => {
      expect(secureCompare('short', 'much longer string')).toBe(false);
    });

    it('should return true for empty strings', () => {
      expect(secureCompare('', '')).toBe(true);
    });

    it('should detect single character difference', () => {
      expect(secureCompare('abcdef', 'abcdeg')).toBe(false);
    });
  });
});

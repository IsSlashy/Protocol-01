/**
 * Address Validation Test Suite
 *
 * Ensures Solana address validation correctly identifies valid Base58
 * public keys, rejects malformed addresses, and provides accurate
 * error diagnostics for the send flow.
 */

import { describe, it, expect } from 'vitest';
import { PublicKey } from '../../test/__mocks__/@solana/web3.js';
import {
  validateSolanaAddress,
  isValidSolanaAddress,
  isValidPublicKeyFormat,
  isValidProgramId,
  isValidMintAddress,
  isSystemProgramAddress,
  normalizeAddress,
  addressesEqual,
  getAddressTypeHint,
  publicKeyToBase58,
  parsePublicKey,
} from './address';

// Generate a deterministic valid-format address for testing
const VALID_ADDRESS = new PublicKey('11111111111111111111111111111111').toBase58();

describe('Address Validation -- Solana Public Key Verification', () => {

  // ===================================================================
  // Section 1: Full Address Validation
  // ===================================================================

  describe('Full Address Validation (validateSolanaAddress)', () => {
    it('should reject empty string', () => {
      const result = validateSolanaAddress('');
      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('EMPTY');
    });

    it('should reject null/undefined', () => {
      expect(validateSolanaAddress(null as any).isValid).toBe(false);
      expect(validateSolanaAddress(undefined as any).isValid).toBe(false);
    });

    it('should reject addresses that are too short', () => {
      const result = validateSolanaAddress('abc123');
      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('INVALID_LENGTH');
    });

    it('should reject addresses with invalid Base58 characters (0, O, I, l)', () => {
      const badAddr = '0OIl' + 'A'.repeat(40);
      const result = validateSolanaAddress(badAddr);
      expect(result.isValid).toBe(false);
      // Should be either INVALID_CHARACTERS or INVALID_PUBKEY
      expect(['INVALID_CHARACTERS', 'INVALID_PUBKEY', 'INVALID_LENGTH']).toContain(result.error?.code);
    });

    it('should accept well-known Solana system program address', () => {
      const result = validateSolanaAddress('11111111111111111111111111111111');
      expect(result.isValid).toBe(true);
      expect(result.normalizedAddress).toBe('11111111111111111111111111111111');
    });

    it('should accept the Token Program address', () => {
      const result = validateSolanaAddress('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
      expect(result.isValid).toBe(true);
    });

    it('should trim whitespace from addresses', () => {
      const result = validateSolanaAddress('  11111111111111111111111111111111  ');
      expect(result.isValid).toBe(true);
    });
  });

  // ===================================================================
  // Section 2: Quick Format Checks
  // ===================================================================

  describe('Quick Format Checks', () => {
    it('isValidSolanaAddress should return boolean', () => {
      expect(isValidSolanaAddress('11111111111111111111111111111111')).toBe(true);
      expect(isValidSolanaAddress('')).toBe(false);
      expect(isValidSolanaAddress(null as any)).toBe(false);
    });

    it('isValidPublicKeyFormat should check Base58 regex only', () => {
      expect(isValidPublicKeyFormat('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')).toBe(true);
      expect(isValidPublicKeyFormat('')).toBe(false);
      expect(isValidPublicKeyFormat(null as any)).toBe(false);
    });

    it('isValidProgramId should delegate to address validation', () => {
      expect(isValidProgramId('11111111111111111111111111111111')).toBe(true);
    });

    it('isValidMintAddress should delegate to address validation', () => {
      expect(isValidMintAddress('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')).toBe(true);
    });
  });

  // ===================================================================
  // Section 3: System Program Detection
  // ===================================================================

  describe('System Program Detection', () => {
    it('should identify the System Program', () => {
      expect(isSystemProgramAddress('11111111111111111111111111111111')).toBe(true);
    });

    it('should identify the Token Program', () => {
      expect(isSystemProgramAddress('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')).toBe(true);
    });

    it('should identify Token-2022 Program', () => {
      expect(isSystemProgramAddress('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')).toBe(true);
    });

    it('should not flag arbitrary addresses as system programs', () => {
      expect(isSystemProgramAddress('SomeRandomAddress1234567890abcdef')).toBe(false);
    });
  });

  // ===================================================================
  // Section 4: Address Normalization and Comparison
  // ===================================================================

  describe('Address Normalization and Comparison', () => {
    it('should normalize by trimming whitespace', () => {
      expect(normalizeAddress('  addr123  ')).toBe('addr123');
    });

    it('should return empty string for null input', () => {
      expect(normalizeAddress(null as any)).toBe('');
      expect(normalizeAddress(undefined as any)).toBe('');
    });

    it('should compare two identical addresses as equal', () => {
      expect(addressesEqual('addr123', 'addr123')).toBe(true);
    });

    it('should detect different addresses as not equal', () => {
      expect(addressesEqual('addr123', 'addr456')).toBe(false);
    });

    it('should return false when either address is empty', () => {
      expect(addressesEqual('', 'addr')).toBe(false);
      expect(addressesEqual('addr', '')).toBe(false);
    });
  });

  // ===================================================================
  // Section 5: Address Type Hints
  // ===================================================================

  describe('Address Type Hints', () => {
    it('should return system_program for known system addresses', () => {
      expect(getAddressTypeHint('11111111111111111111111111111111')).toBe('system_program');
    });

    it('should return invalid for malformed addresses', () => {
      expect(getAddressTypeHint('')).toBe('invalid');
    });
  });

  // ===================================================================
  // Section 6: PublicKey Utility Functions
  // ===================================================================

  describe('PublicKey Utility Functions', () => {
    it('should convert a PublicKey to base58 string', () => {
      const pk = new PublicKey('test');
      expect(typeof publicKeyToBase58(pk as any)).toBe('string');
    });

    it('should pass through string addresses unchanged', () => {
      expect(publicKeyToBase58('myAddress' as any)).toBe('myAddress');
    });

    it('should parse a valid address string to PublicKey', () => {
      const pk = parsePublicKey('11111111111111111111111111111111');
      expect(pk).not.toBeNull();
    });

    it('should return null for invalid address strings', () => {
      const pk = parsePublicKey('');
      expect(pk).toBeNull();
    });
  });
});

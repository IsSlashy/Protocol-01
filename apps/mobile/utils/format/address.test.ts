/**
 * Address Formatting Test Suite
 *
 * Validates the display formatting utilities for Solana public keys
 * including truncation, masking, QR code formatting, and comparison
 * operations used throughout the wallet UI.
 */

import { describe, it, expect } from 'vitest';
import {
  truncateAddress,
  truncateAddressCustom,
  isValidSolanaAddress,
  isValidPublicKey,
  formatAddressWithLabel,
  addressesMatch,
  getAddressChecksum,
  maskAddress,
  formatAddressForQR,
} from './address';

const FULL_ADDRESS = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

describe('Address Formatting -- Display Utilities for Solana Addresses', () => {

  // ===================================================================
  // Section 1: Address Truncation
  // ===================================================================

  describe('Address Truncation', () => {
    it('should truncate with default 4 characters on each side', () => {
      const truncated = truncateAddress(FULL_ADDRESS);
      expect(truncated).toBe(`Toke...Q5DA`);
    });

    it('should truncate with custom character count', () => {
      const truncated = truncateAddress(FULL_ADDRESS, 6);
      expect(truncated.startsWith('Tokenk')).toBe(true);
      expect(truncated.endsWith('3VQ5DA')).toBe(true);
      expect(truncated).toContain('...');
    });

    it('should return full address if shorter than truncation threshold', () => {
      expect(truncateAddress('short')).toBe('short');
    });

    it('should handle empty/null input', () => {
      expect(truncateAddress('')).toBe('');
      expect(truncateAddress(null as any)).toBe('');
      expect(truncateAddress(undefined as any)).toBe('');
    });
  });

  // ===================================================================
  // Section 2: Custom Truncation
  // ===================================================================

  describe('Custom Truncation', () => {
    it('should support asymmetric start/end character counts', () => {
      const result = truncateAddressCustom(FULL_ADDRESS, 6, 3);
      expect(result.startsWith('Tokenk')).toBe(true);
      expect(result.endsWith('5DA')).toBe(true);
    });

    it('should support custom separator', () => {
      const result = truncateAddressCustom(FULL_ADDRESS, 4, 4, '---');
      expect(result).toBe('Toke---Q5DA');
    });

    it('should handle empty input', () => {
      expect(truncateAddressCustom('')).toBe('');
      expect(truncateAddressCustom(null as any)).toBe('');
    });
  });

  // ===================================================================
  // Section 3: Address Format Validation
  // ===================================================================

  describe('Address Format Validation', () => {
    it('should accept valid base58 Solana addresses', () => {
      expect(isValidSolanaAddress(FULL_ADDRESS)).toBe(true);
    });

    it('should reject empty strings', () => {
      expect(isValidSolanaAddress('')).toBe(false);
      expect(isValidSolanaAddress(null as any)).toBe(false);
    });

    it('should reject addresses with invalid characters', () => {
      expect(isValidSolanaAddress('0OIl' + 'A'.repeat(40))).toBe(false);
    });

    it('should validate public key format (32-44 characters)', () => {
      expect(isValidPublicKey(FULL_ADDRESS)).toBe(true);
      expect(isValidPublicKey('short')).toBe(false);
    });
  });

  // ===================================================================
  // Section 4: Labeled Address Display
  // ===================================================================

  describe('Labeled Address Display', () => {
    it('should format address with a label', () => {
      const result = formatAddressWithLabel(FULL_ADDRESS, 'Main Wallet');
      expect(result).toContain('Main Wallet');
      expect(result).toContain('(');
      expect(result).toContain(')');
    });

    it('should format without label as simple truncated address', () => {
      const result = formatAddressWithLabel(FULL_ADDRESS);
      expect(result).not.toContain('(');
      expect(result).toContain('...');
    });

    it('should handle empty address', () => {
      expect(formatAddressWithLabel('')).toBe('');
    });
  });

  // ===================================================================
  // Section 5: Address Comparison
  // ===================================================================

  describe('Address Comparison', () => {
    it('should match identical addresses', () => {
      expect(addressesMatch(FULL_ADDRESS, FULL_ADDRESS)).toBe(true);
    });

    it('should not match different addresses', () => {
      expect(addressesMatch('addr1', 'addr2')).toBe(false);
    });

    it('should return false for empty addresses', () => {
      expect(addressesMatch('', FULL_ADDRESS)).toBe(false);
      expect(addressesMatch(FULL_ADDRESS, '')).toBe(false);
    });
  });

  // ===================================================================
  // Section 6: Address Checksum
  // ===================================================================

  describe('Address Checksum', () => {
    it('should return first 4 and last 4 characters', () => {
      const checksum = getAddressChecksum(FULL_ADDRESS);
      expect(checksum).toBe(FULL_ADDRESS.slice(0, 4) + FULL_ADDRESS.slice(-4));
    });

    it('should return empty string for short addresses', () => {
      expect(getAddressChecksum('abc')).toBe('');
      expect(getAddressChecksum('')).toBe('');
    });
  });

  // ===================================================================
  // Section 7: Address Masking
  // ===================================================================

  describe('Address Masking for Sensitive Display', () => {
    it('should mask the middle of an address', () => {
      const masked = maskAddress(FULL_ADDRESS);
      expect(masked.startsWith(FULL_ADDRESS.slice(0, 2))).toBe(true);
      expect(masked.endsWith(FULL_ADDRESS.slice(-2))).toBe(true);
      expect(masked).toContain('*');
    });

    it('should support custom visible character counts', () => {
      const masked = maskAddress(FULL_ADDRESS, 4, 4);
      expect(masked.startsWith(FULL_ADDRESS.slice(0, 4))).toBe(true);
      expect(masked.endsWith(FULL_ADDRESS.slice(-4))).toBe(true);
    });

    it('should handle empty input', () => {
      expect(maskAddress('')).toBe('');
      expect(maskAddress(null as any)).toBe('');
    });

    it('should return full address if shorter than visible portions', () => {
      expect(maskAddress('ab', 2, 2)).toBe('ab');
    });
  });

  // ===================================================================
  // Section 8: QR Code Formatting
  // ===================================================================

  describe('QR Code Formatting', () => {
    it('should split address into chunks for QR display', () => {
      const formatted = formatAddressForQR(FULL_ADDRESS);
      expect(formatted).toContain('\n');
      const lines = formatted.split('\n');
      expect(lines.length).toBeGreaterThan(1);
    });

    it('should respect custom chunk size', () => {
      const formatted = formatAddressForQR(FULL_ADDRESS, 5);
      const lines = formatted.split('\n');
      lines.forEach((line, i) => {
        if (i < lines.length - 1) {
          expect(line.length).toBe(5);
        }
      });
    });

    it('should handle empty address', () => {
      expect(formatAddressForQR('')).toBe('');
    });
  });
});

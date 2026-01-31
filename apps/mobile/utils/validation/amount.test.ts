/**
 * Amount Validation Test Suite
 *
 * Ensures the SOL and SPL token amount validation logic correctly
 * parses numeric inputs, enforces balance limits, detects edge cases,
 * and converts between SOL and lamports with precision.
 */

import { describe, it, expect } from 'vitest';
import {
  validateSOLAmount,
  validateTokenAmount,
  isValidAmount,
  isValidNumberFormat,
  parseAmount,
  sanitizeAmountInput,
  limitDecimals,
  calculateMaxSendable,
  hasMinimumBalance,
} from './amount';

const LAMPORTS_PER_SOL = 1_000_000_000;

describe('Amount Validation -- SOL and Token Transfer Amounts', () => {

  // ===================================================================
  // Section 1: SOL Amount Validation
  // ===================================================================

  describe('SOL Amount Validation', () => {
    it('should reject empty input', () => {
      const result = validateSOLAmount('');
      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('EMPTY');
    });

    it('should reject null/undefined input', () => {
      expect(validateSOLAmount(null as any).isValid).toBe(false);
      expect(validateSOLAmount(undefined as any).isValid).toBe(false);
    });

    it('should reject non-numeric strings', () => {
      expect(validateSOLAmount('abc').isValid).toBe(false);
      expect(validateSOLAmount('abc').error?.code).toBe('INVALID_FORMAT');
    });

    it('should reject NaN and Infinity', () => {
      expect(validateSOLAmount('NaN').isValid).toBe(false);
      expect(validateSOLAmount('Infinity').isValid).toBe(false);
    });

    it('should reject negative amounts', () => {
      const result = validateSOLAmount('-1.5');
      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('NEGATIVE');
    });

    it('should reject zero by default', () => {
      const result = validateSOLAmount('0');
      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('ZERO');
    });

    it('should allow zero when explicitly permitted', () => {
      const result = validateSOLAmount('0', { allowZero: true });
      expect(result.isValid).toBe(true);
      expect(result.parsedAmount).toBe(0);
    });

    it('should accept valid SOL amounts', () => {
      const result = validateSOLAmount('1.5');
      expect(result.isValid).toBe(true);
      expect(result.parsedAmount).toBe(1.5);
      expect(result.lamports).toBe(1_500_000_000);
    });

    it('should correctly convert to lamports', () => {
      const result = validateSOLAmount('0.000005');
      expect(result.isValid).toBe(true);
      expect(result.lamports).toBe(5000);
    });

    it('should reject amounts below minimum', () => {
      const result = validateSOLAmount('0.001', { minAmount: 0.01 });
      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('TOO_SMALL');
    });

    it('should reject amounts above maximum', () => {
      const result = validateSOLAmount('100', { maxAmount: 50 });
      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('TOO_LARGE');
    });

    it('should reject amounts exceeding total SOL supply', () => {
      const result = validateSOLAmount('600000000');
      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('EXCEEDS_MAX');
    });

    it('should reject amounts exceeding wallet balance', () => {
      const result = validateSOLAmount('10', { balance: 5 * LAMPORTS_PER_SOL });
      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('INSUFFICIENT_BALANCE');
    });

    it('should account for fee reserve when checking balance', () => {
      const balance = 1 * LAMPORTS_PER_SOL;
      const fee = 5000;

      // Amount that would leave less than fee reserve
      const result = validateSOLAmount('1.0', { balance, reserveForFee: fee });
      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('INSUFFICIENT_BALANCE');

      // Amount that leaves room for fee
      const ok = validateSOLAmount('0.5', { balance, reserveForFee: fee });
      expect(ok.isValid).toBe(true);
    });
  });

  // ===================================================================
  // Section 2: SPL Token Amount Validation
  // ===================================================================

  describe('SPL Token Amount Validation', () => {
    it('should validate token amounts with specified decimals', () => {
      const result = validateTokenAmount('100.5', 6);
      expect(result.isValid).toBe(true);
      expect(result.parsedAmount).toBe(100.5);
      expect(result.lamports).toBe(100_500_000); // 100.5 * 10^6
    });

    it('should reject empty token amount', () => {
      expect(validateTokenAmount('', 6).isValid).toBe(false);
    });

    it('should reject negative token amounts', () => {
      expect(validateTokenAmount('-50', 6).isValid).toBe(false);
    });

    it('should check balance for token amounts', () => {
      // Balance is in raw units (100 tokens * 10^6)
      const result = validateTokenAmount('200', 6, { balance: 100_000_000 });
      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('INSUFFICIENT_BALANCE');
    });

    it('should handle high-decimal tokens (e.g., 9 decimals)', () => {
      const result = validateTokenAmount('1.123456789', 9);
      expect(result.isValid).toBe(true);
      expect(result.lamports).toBe(1_123_456_789);
    });
  });

  // ===================================================================
  // Section 3: Quick Validation Helpers
  // ===================================================================

  describe('Quick Validation Helpers', () => {
    it('isValidAmount should return true for positive numbers', () => {
      expect(isValidAmount('1.5')).toBe(true);
      expect(isValidAmount('0.001')).toBe(true);
    });

    it('isValidAmount should return false for zero and negative', () => {
      expect(isValidAmount('0')).toBe(false);
      expect(isValidAmount('-1')).toBe(false);
      expect(isValidAmount('')).toBe(false);
    });

    it('isValidNumberFormat should accept valid number strings', () => {
      expect(isValidNumberFormat('123')).toBe(true);
      expect(isValidNumberFormat('1.5')).toBe(true);
      expect(isValidNumberFormat('.5')).toBe(true);
    });

    it('isValidNumberFormat should reject non-numeric strings', () => {
      expect(isValidNumberFormat('abc')).toBe(false);
      expect(isValidNumberFormat('')).toBe(false);
      expect(isValidNumberFormat(null as any)).toBe(false);
    });
  });

  // ===================================================================
  // Section 4: Amount Parsing
  // ===================================================================

  describe('Amount Parsing', () => {
    it('should parse valid amount strings', () => {
      expect(parseAmount('1.5')).toBe(1.5);
      expect(parseAmount('0')).toBe(0);
      expect(parseAmount('100')).toBe(100);
    });

    it('should return 0 for invalid strings', () => {
      expect(parseAmount('abc')).toBe(0);
      expect(parseAmount('')).toBe(0);
      expect(parseAmount(null as any)).toBe(0);
    });
  });

  // ===================================================================
  // Section 5: Input Sanitization
  // ===================================================================

  describe('Input Sanitization', () => {
    it('should remove non-numeric characters except decimal point', () => {
      expect(sanitizeAmountInput('$1,234.56')).toBe('1234.56');
    });

    it('should allow only one decimal point', () => {
      expect(sanitizeAmountInput('1.2.3')).toBe('1.23');
    });

    it('should return empty string for empty input', () => {
      expect(sanitizeAmountInput('')).toBe('');
    });

    it('should limit decimal places', () => {
      expect(limitDecimals('1.123456789012', 9)).toBe('1.123456789');
      expect(limitDecimals('1.12', 9)).toBe('1.12');
      expect(limitDecimals('100', 9)).toBe('100');
    });
  });

  // ===================================================================
  // Section 6: Balance Calculations
  // ===================================================================

  describe('Balance Calculations', () => {
    it('should calculate max sendable amount (balance minus fee)', () => {
      const balance = 5 * LAMPORTS_PER_SOL;
      const feeReserve = 5000;
      const max = calculateMaxSendable(balance, feeReserve);

      expect(max).toBeCloseTo(5.0 - 5000 / LAMPORTS_PER_SOL, 6);
    });

    it('should not return negative max sendable', () => {
      expect(calculateMaxSendable(1000, 5000)).toBe(0);
    });

    it('should check minimum balance for transaction', () => {
      const balance = 2 * LAMPORTS_PER_SOL;
      expect(hasMinimumBalance(balance, 1 * LAMPORTS_PER_SOL, 5000)).toBe(true);
      expect(hasMinimumBalance(balance, 2 * LAMPORTS_PER_SOL, 5000)).toBe(false);
    });
  });
});

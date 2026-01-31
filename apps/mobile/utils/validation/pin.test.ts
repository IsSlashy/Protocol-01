/**
 * PIN Validation Test Suite
 *
 * Ensures the PIN security layer correctly enforces length constraints,
 * digit-only requirements, weak pattern detection, and strength
 * classification to protect wallet access.
 */

import { describe, it, expect } from 'vitest';
import {
  validatePIN,
  validatePINConfirmation,
  isValidPIN,
  hasOnlyDigits,
  calculatePINStrength,
  getPINStrengthDescription,
  sanitizePINInput,
  maskPIN,
  getPINRequirements,
  meetsPINRequirements,
} from './pin';

describe('PIN Validation -- Wallet Access Security', () => {

  // ===================================================================
  // Section 1: Basic PIN Validation
  // ===================================================================

  describe('Basic PIN Validation', () => {
    it('should reject empty PIN', () => {
      const result = validatePIN('');
      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('EMPTY');
    });

    it('should reject null/undefined PIN', () => {
      expect(validatePIN(null as any).isValid).toBe(false);
      expect(validatePIN(undefined as any).isValid).toBe(false);
    });

    it('should reject PIN shorter than minimum length', () => {
      const result = validatePIN('123');
      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('TOO_SHORT');
    });

    it('should reject PIN longer than maximum length', () => {
      const result = validatePIN('123456789');
      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('TOO_LONG');
    });

    it('should reject PIN containing non-digit characters', () => {
      const result = validatePIN('12a4');
      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('INVALID_CHARACTERS');
    });

    it('should accept a valid 4-digit PIN', () => {
      const result = validatePIN('5927');
      expect(result.isValid).toBe(true);
      expect(result.strength).toBeDefined();
    });

    it('should accept a valid 6-digit PIN', () => {
      const result = validatePIN('592738');
      expect(result.isValid).toBe(true);
    });

    it('should respect custom min/max length options', () => {
      const result = validatePIN('12', { minLength: 2, maxLength: 4 });
      expect(result.isValid).toBe(true);

      const tooLong = validatePIN('12345', { minLength: 2, maxLength: 4 });
      expect(tooLong.isValid).toBe(false);
    });
  });

  // ===================================================================
  // Section 2: Weak Pattern Detection
  // ===================================================================

  describe('Weak Pattern Detection', () => {
    it('should reject all-same-digit PINs (1111, 0000)', () => {
      expect(validatePIN('1111').isValid).toBe(false);
      expect(validatePIN('0000').isValid).toBe(false);
      expect(validatePIN('9999').isValid).toBe(false);
      expect(validatePIN('1111').error?.code).toBe('WEAK_PATTERN');
    });

    it('should reject sequential ascending PINs (1234, 2345)', () => {
      expect(validatePIN('1234').isValid).toBe(false);
      expect(validatePIN('2345').isValid).toBe(false);
      expect(validatePIN('6789').isValid).toBe(false);
    });

    it('should reject sequential descending PINs (4321, 9876)', () => {
      expect(validatePIN('4321').isValid).toBe(false);
      expect(validatePIN('9876').isValid).toBe(false);
    });

    it('should reject commonly used weak PINs', () => {
      const weakPINs = ['1234', '0000', '1111', '1212', '7777', '6969', '1010'];
      weakPINs.forEach(pin => {
        expect(validatePIN(pin).isValid).toBe(false);
      });
    });

    it('should allow weak patterns when explicitly permitted', () => {
      const result = validatePIN('1111', { allowWeakPatterns: true });
      expect(result.isValid).toBe(true);
    });
  });

  // ===================================================================
  // Section 3: PIN Confirmation
  // ===================================================================

  describe('PIN Confirmation Matching', () => {
    it('should pass when PIN and confirmation match', () => {
      const result = validatePINConfirmation('5927', '5927');
      expect(result.isValid).toBe(true);
    });

    it('should fail when PIN and confirmation do not match', () => {
      const result = validatePINConfirmation('5927', '5928');
      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('MISMATCH');
    });

    it('should validate the PIN itself before checking confirmation', () => {
      const result = validatePINConfirmation('12', '12');
      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('TOO_SHORT');
    });
  });

  // ===================================================================
  // Section 4: Strength Classification
  // ===================================================================

  describe('PIN Strength Classification', () => {
    it('should classify short PINs as weak', () => {
      expect(calculatePINStrength('123')).toBe('weak');
    });

    it('should classify common PINs as weak', () => {
      expect(calculatePINStrength('1234')).toBe('weak');
      expect(calculatePINStrength('0000')).toBe('weak');
    });

    it('should classify longer PINs with unique digits as strong', () => {
      expect(calculatePINStrength('592738')).toBe('strong');
    });

    it('should return descriptive metadata for each strength level', () => {
      const weak = getPINStrengthDescription('weak');
      expect(weak.label).toBe('Weak');
      expect(weak.color).toBeTruthy();

      const strong = getPINStrengthDescription('strong');
      expect(strong.label).toBe('Strong');
    });
  });

  // ===================================================================
  // Section 5: Input Utilities
  // ===================================================================

  describe('Input Utilities', () => {
    it('should detect digit-only strings', () => {
      expect(hasOnlyDigits('12345')).toBe(true);
      expect(hasOnlyDigits('')).toBe(true);
      expect(hasOnlyDigits('12a5')).toBe(false);
    });

    it('should sanitize input by removing non-digit characters', () => {
      expect(sanitizePINInput('1a2b3c4')).toBe('1234');
      expect(sanitizePINInput('!@#$')).toBe('');
      expect(sanitizePINInput('5927')).toBe('5927');
    });

    it('should mask PIN for display', () => {
      expect(maskPIN('5927')).toBe('****');
      expect(maskPIN('5927', 2)).toBe('**27');
      expect(maskPIN('')).toBe('');
    });

    it('should provide requirement text list', () => {
      const requirements = getPINRequirements();
      expect(requirements.length).toBeGreaterThan(0);
      expect(requirements.some(r => r.includes('digits'))).toBe(true);
    });

    it('should check individual requirements', () => {
      const reqs = meetsPINRequirements('5927');
      expect(reqs.meetsLength).toBe(true);
      expect(reqs.meetsDigitsOnly).toBe(true);
      expect(reqs.avoidsSequential).toBe(true);
      expect(reqs.avoidsRepeated).toBe(true);
    });
  });

  // ===================================================================
  // Section 6: Quick Validation
  // ===================================================================

  describe('Quick Validation (isValidPIN)', () => {
    it('should return true for valid PINs', () => {
      expect(isValidPIN('5927')).toBe(true);
      expect(isValidPIN('592738')).toBe(true);
    });

    it('should return false for invalid PINs', () => {
      expect(isValidPIN('')).toBe(false);
      expect(isValidPIN('12')).toBe(false);
      expect(isValidPIN(null as any)).toBe(false);
      expect(isValidPIN('abcd')).toBe(false);
    });
  });
});

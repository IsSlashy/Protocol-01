/**
 * Currency Formatting Test Suite
 *
 * Validates the conversion and display formatting for SOL, lamports,
 * USD, and token amounts -- ensuring accurate representation across
 * the wallet UI.
 */

import { describe, it, expect } from 'vitest';
import {
  formatSOL,
  formatUSD,
  solToUSD,
  lamportsToUSD,
  formatLamportsToUSD,
  parseSOLToLamports,
  formatTokenAmount,
  formatCompactUSD,
  formatPercentage,
  formatPriceChange,
} from './currency';

const LAMPORTS_PER_SOL = 1_000_000_000;

describe('Currency Formatting -- Display and Conversion Utilities', () => {

  // ===================================================================
  // Section 1: SOL Formatting
  // ===================================================================

  describe('SOL Formatting (lamports to display)', () => {
    it('should format lamports to SOL with 4 decimal places by default', () => {
      expect(formatSOL(1_500_000_000)).toBe('1.5000');
      expect(formatSOL(5_000_000)).toBe('0.0050');
      expect(formatSOL(0)).toBe('0.0000');
    });

    it('should respect custom decimal places', () => {
      expect(formatSOL(1_500_000_000, 2)).toBe('1.50');
      expect(formatSOL(1_500_000_000, 9)).toBe('1.500000000');
    });

    it('should handle edge cases gracefully', () => {
      expect(formatSOL(-1)).toBe('0.0000');
      expect(formatSOL(NaN)).toBe('0.0000');
      expect(formatSOL(Infinity)).toBe('0.0000');
    });

    it('should format 1 SOL correctly', () => {
      expect(formatSOL(LAMPORTS_PER_SOL)).toBe('1.0000');
    });
  });

  // ===================================================================
  // Section 2: USD Formatting
  // ===================================================================

  describe('USD Formatting', () => {
    it('should format as USD currency string', () => {
      const formatted = formatUSD(100);
      expect(formatted).toContain('$');
      expect(formatted).toContain('100');
    });

    it('should format with two decimal places', () => {
      const formatted = formatUSD(99.999);
      expect(formatted).toContain('$');
    });

    it('should handle zero', () => {
      expect(formatUSD(0)).toBe('$0.00');
    });

    it('should handle non-finite numbers', () => {
      expect(formatUSD(NaN)).toBe('$0.00');
      expect(formatUSD(Infinity)).toBe('$0.00');
    });
  });

  // ===================================================================
  // Section 3: SOL to USD Conversion
  // ===================================================================

  describe('SOL to USD Conversion', () => {
    it('should multiply SOL amount by price', () => {
      expect(solToUSD(1.5, 100)).toBe(150);
      expect(solToUSD(0, 100)).toBe(0);
    });

    it('should handle non-finite inputs', () => {
      expect(solToUSD(NaN, 100)).toBe(0);
      expect(solToUSD(1, NaN)).toBe(0);
    });

    it('should convert lamports to USD', () => {
      const usd = lamportsToUSD(1_500_000_000, 100);
      expect(usd).toBe(150);
    });

    it('should format lamports directly to USD string', () => {
      const result = formatLamportsToUSD(1_500_000_000, 100);
      expect(result).toContain('$');
      expect(result).toContain('150');
    });
  });

  // ===================================================================
  // Section 4: SOL Parsing
  // ===================================================================

  describe('SOL String to Lamports Parsing', () => {
    it('should parse valid SOL string to lamports', () => {
      expect(parseSOLToLamports('1.5')).toBe(1_500_000_000);
      expect(parseSOLToLamports('0.000005')).toBe(5000);
      expect(parseSOLToLamports('0')).toBe(0);
    });

    it('should return 0 for invalid input', () => {
      expect(parseSOLToLamports('abc')).toBe(0);
      expect(parseSOLToLamports('')).toBe(0);
      expect(parseSOLToLamports('-1')).toBe(0);
    });

    it('should floor the lamport value (no fractional lamports)', () => {
      // 0.0000000015 SOL = 1.5 lamports, should floor to 1
      expect(parseSOLToLamports('0.0000000015')).toBe(1);
    });
  });

  // ===================================================================
  // Section 5: Token Amount Formatting
  // ===================================================================

  describe('Token Amount Formatting', () => {
    it('should format raw token amount with decimals', () => {
      expect(formatTokenAmount(1_000_000, 6, 4)).toBe('1.0000');
      expect(formatTokenAmount(1_500_000, 6, 2)).toBe('1.50');
    });

    it('should handle zero and negative amounts', () => {
      expect(formatTokenAmount(0, 6)).toBe('0.0000');
      expect(formatTokenAmount(-1, 6)).toBe('0');
    });

    it('should handle different token decimal configurations', () => {
      // 9 decimals (like SOL)
      expect(formatTokenAmount(1_000_000_000, 9, 4)).toBe('1.0000');
      // 0 decimals (NFT-like)
      expect(formatTokenAmount(5, 0, 0)).toBe('5');
    });
  });

  // ===================================================================
  // Section 6: Compact USD Formatting
  // ===================================================================

  describe('Compact USD Formatting', () => {
    it('should format small amounts normally', () => {
      const result = formatCompactUSD(100);
      expect(result).toContain('$');
      expect(result).toContain('100');
    });

    it('should handle non-finite input', () => {
      expect(formatCompactUSD(NaN)).toBe('$0');
    });
  });

  // ===================================================================
  // Section 7: Percentage Formatting
  // ===================================================================

  describe('Percentage Formatting', () => {
    it('should format percentage with default 2 decimals', () => {
      expect(formatPercentage(12.345)).toBe('12.35%');
      expect(formatPercentage(0)).toBe('0.00%');
    });

    it('should handle non-finite input', () => {
      expect(formatPercentage(NaN)).toBe('0%');
    });

    it('should format price change with sign', () => {
      expect(formatPriceChange(5.5)).toBe('+5.50%');
      expect(formatPriceChange(-3.2)).toBe('-3.20%');
      expect(formatPriceChange(0)).toBe('+0.00%');
    });

    it('should handle non-finite price change', () => {
      expect(formatPriceChange(NaN)).toBe('0.00%');
    });
  });
});

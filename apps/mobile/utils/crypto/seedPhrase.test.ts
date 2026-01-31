/**
 * Seed Phrase Utility Test Suite
 *
 * Validates the BIP39 seed phrase generation, validation, and
 * conversion utilities used during wallet creation and import.
 */

import { describe, it, expect } from 'vitest';
import {
  generateSeedPhrase,
  generateMnemonic,
  validateSeedPhrase,
  isValidWord,
  getWordSuggestions,
  getWordlist,
  getWordIndex,
  normalizeMnemonic,
  splitMnemonic,
  joinMnemonic,
  maskSeedPhrase,
  hasCorrectFormat,
  getWordCountLabel,
  wordCountToEntropyBits,
} from './seedPhrase';

describe('Seed Phrase Utilities -- BIP39 Operations', () => {

  // ===================================================================
  // Section 1: Seed Phrase Generation
  // ===================================================================

  describe('Seed Phrase Generation', () => {
    it('should generate a 12-word seed phrase by default', () => {
      const words = generateSeedPhrase();
      expect(words).toHaveLength(12);
    });

    it('should generate a 24-word seed phrase when requested', () => {
      const words = generateSeedPhrase(24);
      expect(words).toHaveLength(24);
    });

    it('should throw for invalid word counts', () => {
      expect(() => generateSeedPhrase(10 as any)).toThrow();
    });

    it('should generate as a string via generateMnemonic', () => {
      const mnemonic = generateMnemonic();
      expect(typeof mnemonic).toBe('string');
      expect(mnemonic.split(' ')).toHaveLength(12);
    });

    it('should generate unique phrases on successive calls', () => {
      const m1 = generateMnemonic();
      const m2 = generateMnemonic();
      expect(m1).not.toBe(m2);
    });
  });

  // ===================================================================
  // Section 2: Seed Phrase Validation
  // ===================================================================

  describe('Seed Phrase Validation', () => {
    it('should validate a freshly generated seed phrase', () => {
      const mnemonic = generateMnemonic();
      const result = validateSeedPhrase(mnemonic);
      expect(result.isValid).toBe(true);
    });

    it('should reject wrong word count', () => {
      const result = validateSeedPhrase('one two three');
      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('WRONG_WORD_COUNT');
    });

    it('should detect invalid words', () => {
      const words = generateSeedPhrase();
      words[0] = 'xyzinvalidword';
      const result = validateSeedPhrase(words);
      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('INVALID_WORD');
      expect(result.invalidWords).toContain('xyzinvalidword');
    });

    it('should accept both string and array inputs', () => {
      const mnemonic = generateMnemonic();
      const asString = validateSeedPhrase(mnemonic);
      const asArray = validateSeedPhrase(mnemonic.split(' '));
      expect(asString.isValid).toBe(asArray.isValid);
    });
  });

  // ===================================================================
  // Section 3: Word Validation and Suggestions
  // ===================================================================

  describe('Word Validation and Autocomplete', () => {
    it('should validate words in the BIP39 wordlist', () => {
      expect(isValidWord('abandon')).toBe(true);
      expect(isValidWord('zoo')).toBe(true);
    });

    it('should reject words not in the wordlist', () => {
      expect(isValidWord('solana')).toBe(false);
      expect(isValidWord('')).toBe(false);
    });

    it('should provide autocomplete suggestions', () => {
      const suggestions = getWordSuggestions('ab');
      expect(suggestions.length).toBeGreaterThan(0);
      suggestions.forEach(s => expect(s.startsWith('ab')).toBe(true));
    });

    it('should respect suggestion limit', () => {
      const suggestions = getWordSuggestions('a', 3);
      expect(suggestions.length).toBeLessThanOrEqual(3);
    });

    it('should return empty suggestions for empty prefix', () => {
      expect(getWordSuggestions('')).toEqual([]);
    });
  });

  // ===================================================================
  // Section 4: Wordlist Access
  // ===================================================================

  describe('Wordlist Access', () => {
    it('should return a non-empty wordlist', () => {
      const list = getWordlist();
      expect(list.length).toBeGreaterThan(0);
    });

    it('should return a defensive copy', () => {
      const list1 = getWordlist();
      const list2 = getWordlist();
      list1.push('modified');
      expect(list2.length).toBeLessThan(list1.length);
    });

    it('should find word index in the wordlist', () => {
      const idx = getWordIndex('abandon');
      expect(idx).toBe(0);
    });

    it('should return -1 for words not in the list', () => {
      expect(getWordIndex('notinlist')).toBe(-1);
    });
  });

  // ===================================================================
  // Section 5: Mnemonic Normalization
  // ===================================================================

  describe('Mnemonic Normalization', () => {
    it('should normalize casing and whitespace', () => {
      expect(normalizeMnemonic('  ABANDON   Ability  ')).toBe('abandon ability');
    });

    it('should split mnemonic into words', () => {
      const words = splitMnemonic('abandon ability able');
      expect(words).toEqual(['abandon', 'ability', 'able']);
    });

    it('should join words into a mnemonic string', () => {
      const joined = joinMnemonic(['ABANDON', 'Ability']);
      expect(joined).toBe('abandon ability');
    });
  });

  // ===================================================================
  // Section 6: Display and Format Utilities
  // ===================================================================

  describe('Display and Format Utilities', () => {
    it('should mask seed phrase words except specified indices', () => {
      const words = ['abandon', 'ability', 'able', 'about'];
      const masked = maskSeedPhrase(words, [0, 3]);
      expect(masked[0]).toBe('abandon');
      expect(masked[1]).toMatch(/^\*+$/);
      expect(masked[2]).toMatch(/^\*+$/);
      expect(masked[3]).toBe('about');
    });

    it('should check correct format of word arrays', () => {
      expect(hasCorrectFormat(generateSeedPhrase())).toBe(true);
      expect(hasCorrectFormat(['one', 'two'])).toBe(false);
      expect(hasCorrectFormat([] as any)).toBe(false);
    });

    it('should return word count labels', () => {
      expect(getWordCountLabel(12)).toBe('12 words (Standard)');
      expect(getWordCountLabel(24)).toBe('24 words (High Security)');
    });

    it('should return entropy bits from word count', () => {
      expect(wordCountToEntropyBits(12)).toBe(128);
      expect(wordCountToEntropyBits(24)).toBe(256);
    });
  });
});

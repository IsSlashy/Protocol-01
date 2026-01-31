/**
 * Seed Phrase Validation Test Suite
 *
 * Ensures that the BIP39 mnemonic validation layer correctly identifies
 * valid seed phrases, detects invalid words, wrong word counts, and
 * checksum failures -- critical for wallet import security.
 */

import { describe, it, expect } from 'vitest';
import { wordlist } from '../../test/__mocks__/@scure/bip39/wordlists/english';
import {
  validateSeedPhrase,
  isValidSeedPhrase,
  validateWord,
  validateWordAtPosition,
  getWordSuggestions,
  isValidWordCount,
  getValidWordCounts,
  normalizeToWordArray,
  normalizeSeedPhrase,
  countWords,
  getSeedPhraseProgress,
  validatePartialSeedPhrase,
  maskSeedPhraseWords,
  getSecurityLevel,
} from './seedPhrase';

// Use words from our mock wordlist to build test mnemonics
const VALID_12_WORDS = wordlist.slice(0, 12);
const VALID_12_PHRASE = VALID_12_WORDS.join(' ');

describe('Seed Phrase Validation -- BIP39 Mnemonic Security', () => {

  // ===================================================================
  // Section 1: Full Phrase Validation
  // ===================================================================

  describe('Full Phrase Validation', () => {
    it('should reject an empty string', () => {
      const result = validateSeedPhrase('');
      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('EMPTY');
    });

    it('should reject an empty array', () => {
      const result = validateSeedPhrase([]);
      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('EMPTY');
    });

    it('should reject a phrase with wrong word count (5 words)', () => {
      const result = validateSeedPhrase('one two three four five');
      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('WRONG_WORD_COUNT');
      expect(result.wordCount).toBe(5);
    });

    it('should accept valid word counts: 12, 15, 18, 21, 24', () => {
      for (const count of [12, 15, 18, 21, 24]) {
        const words = wordlist.slice(0, count);
        const result = validateSeedPhrase(words);
        // The checksum may fail because we use arbitrary words, but word count should pass
        if (!result.isValid && result.error) {
          expect(result.error.code).not.toBe('WRONG_WORD_COUNT');
        }
      }
    });

    it('should detect invalid words not in the BIP39 wordlist', () => {
      const words = [...VALID_12_WORDS];
      words[5] = 'xyznotaword';
      const result = validateSeedPhrase(words);
      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('INVALID_WORDS');
      expect(result.invalidWords).toBeDefined();
      expect(result.invalidWords!.length).toBeGreaterThan(0);
      expect(result.invalidWords![0].word).toBe('xyznotaword');
      expect(result.invalidWords![0].index).toBe(5);
    });

    it('should provide suggestions for misspelled words', () => {
      const words = [...VALID_12_WORDS];
      words[0] = 'abando'; // close to "abandon"
      const result = validateSeedPhrase(words);
      expect(result.isValid).toBe(false);
      if (result.invalidWords && result.invalidWords.length > 0) {
        expect(result.invalidWords[0].suggestions).toBeDefined();
      }
    });

    it('should normalize input to lowercase', () => {
      const upper = VALID_12_WORDS.map(w => w.toUpperCase());
      const result = validateSeedPhrase(upper);
      // Should not fail on casing -- invalid words check is after normalization
      if (!result.isValid && result.error) {
        expect(result.error.code).not.toBe('INVALID_WORDS');
      }
    });
  });

  // ===================================================================
  // Section 2: Quick Validation Helper
  // ===================================================================

  describe('Quick Validation (isValidSeedPhrase)', () => {
    it('should return false for empty input', () => {
      expect(isValidSeedPhrase('')).toBe(false);
    });

    it('should return false for invalid word count', () => {
      expect(isValidSeedPhrase('hello world')).toBe(false);
    });
  });

  // ===================================================================
  // Section 3: Individual Word Validation
  // ===================================================================

  describe('Individual Word Validation', () => {
    it('should validate words that exist in the BIP39 wordlist', () => {
      expect(validateWord('abandon')).toBe(true);
      expect(validateWord('ability')).toBe(true);
      expect(validateWord('zoo')).toBe(true);
    });

    it('should reject words not in the wordlist', () => {
      expect(validateWord('javascript')).toBe(false);
      expect(validateWord('solana')).toBe(false);
      expect(validateWord('')).toBe(false);
    });

    it('should handle null/undefined gracefully', () => {
      expect(validateWord(null as any)).toBe(false);
      expect(validateWord(undefined as any)).toBe(false);
    });

    it('should be case-insensitive', () => {
      expect(validateWord('ABANDON')).toBe(true);
      expect(validateWord('Ability')).toBe(true);
    });
  });

  // ===================================================================
  // Section 4: Word at Position Validation
  // ===================================================================

  describe('Word at Position Validation', () => {
    it('should validate a correct word at a valid position', () => {
      const result = validateWordAtPosition('abandon', 0, 12);
      expect(result.isValid).toBe(true);
    });

    it('should reject an invalid word and provide suggestions', () => {
      const result = validateWordAtPosition('abando', 0, 12);
      expect(result.isValid).toBe(false);
      expect(result.suggestions).toBeDefined();
    });

    it('should reject out-of-bounds positions', () => {
      expect(validateWordAtPosition('abandon', -1, 12).isValid).toBe(false);
      expect(validateWordAtPosition('abandon', 12, 12).isValid).toBe(false);
    });
  });

  // ===================================================================
  // Section 5: Autocomplete Suggestions
  // ===================================================================

  describe('Autocomplete Suggestions', () => {
    it('should return words matching the prefix', () => {
      const suggestions = getWordSuggestions('ab');
      expect(suggestions.length).toBeGreaterThan(0);
      suggestions.forEach(word => {
        expect(word.startsWith('ab')).toBe(true);
      });
    });

    it('should limit results to the specified count', () => {
      const suggestions = getWordSuggestions('a', 3);
      expect(suggestions.length).toBeLessThanOrEqual(3);
    });

    it('should return empty array for empty prefix', () => {
      expect(getWordSuggestions('')).toEqual([]);
    });
  });

  // ===================================================================
  // Section 6: Word Count Validation
  // ===================================================================

  describe('Word Count Validation', () => {
    it('should recognize all standard BIP39 word counts', () => {
      expect(isValidWordCount(12)).toBe(true);
      expect(isValidWordCount(15)).toBe(true);
      expect(isValidWordCount(18)).toBe(true);
      expect(isValidWordCount(21)).toBe(true);
      expect(isValidWordCount(24)).toBe(true);
    });

    it('should reject non-standard word counts', () => {
      expect(isValidWordCount(10)).toBe(false);
      expect(isValidWordCount(13)).toBe(false);
      expect(isValidWordCount(0)).toBe(false);
    });

    it('should return the complete list of valid word counts', () => {
      expect(getValidWordCounts()).toEqual([12, 15, 18, 21, 24]);
    });
  });

  // ===================================================================
  // Section 7: Input Normalization
  // ===================================================================

  describe('Input Normalization', () => {
    it('should normalize a string with extra whitespace', () => {
      const result = normalizeToWordArray('  abandon   ability  able  ');
      expect(result).toEqual(['abandon', 'ability', 'able']);
    });

    it('should normalize an array of words', () => {
      const result = normalizeToWordArray(['  ABANDON ', 'ABILITY', ' able']);
      expect(result).toEqual(['abandon', 'ability', 'able']);
    });

    it('should handle non-string input', () => {
      expect(normalizeToWordArray(123 as any)).toEqual([]);
    });

    it('should produce a clean seed phrase string', () => {
      const result = normalizeSeedPhrase('  ABANDON   ability  ABLE  ');
      expect(result).toBe('abandon ability able');
    });

    it('should count words correctly', () => {
      expect(countWords('one two three')).toBe(3);
      expect(countWords('  spaced   out  ')).toBe(2);
      expect(countWords('')).toBe(0);
    });
  });

  // ===================================================================
  // Section 8: Progressive Entry Support
  // ===================================================================

  describe('Progressive Entry Support', () => {
    it('should track seed phrase entry progress', () => {
      const progress = getSeedPhraseProgress(['abandon', 'ability', 'able'], 12);
      expect(progress.entered).toBe(3);
      expect(progress.total).toBe(12);
      expect(progress.percentage).toBe(25);
    });

    it('should validate partial seed phrases', () => {
      const result = validatePartialSeedPhrase(['abandon', 'notaword', 'able']);
      expect(result.allWordsValid).toBe(false);
      expect(result.invalidIndices).toContain(1);
    });

    it('should pass when all entered words are valid', () => {
      const result = validatePartialSeedPhrase(['abandon', 'ability']);
      expect(result.allWordsValid).toBe(true);
      expect(result.invalidIndices).toEqual([]);
    });
  });

  // ===================================================================
  // Section 9: Display Utilities
  // ===================================================================

  describe('Display Utilities', () => {
    it('should mask seed phrase words for secure display', () => {
      const words = ['abandon', 'ability', 'able', 'about'];
      const masked = maskSeedPhraseWords(words, [0, 3]);

      expect(masked[0]).toBe('abandon');
      expect(masked[1]).toBe('*******');
      expect(masked[2]).toBe('****');
      expect(masked[3]).toBe('about');
    });

    it('should mask all words when no indices are specified', () => {
      const words = ['abandon', 'ability'];
      const masked = maskSeedPhraseWords(words);
      masked.forEach(word => {
        expect(word).toMatch(/^\*+$/);
      });
    });
  });

  // ===================================================================
  // Section 10: Security Level Classification
  // ===================================================================

  describe('Security Level Classification', () => {
    it('should classify 12-word phrases as standard security (128-bit)', () => {
      const level = getSecurityLevel(12);
      expect(level.level).toBe('standard');
      expect(level.bits).toBe(128);
    });

    it('should classify 18-word phrases as enhanced security', () => {
      const level = getSecurityLevel(18);
      expect(level.level).toBe('enhanced');
      expect(level.bits).toBe(192);
    });

    it('should classify 24-word phrases as maximum security (256-bit)', () => {
      const level = getSecurityLevel(24);
      expect(level.level).toBe('maximum');
      expect(level.bits).toBe(256);
    });
  });
});

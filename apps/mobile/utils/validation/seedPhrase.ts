/**
 * Seed phrase validation utilities for Protocol 01
 */

import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

export type ValidWordCount = 12 | 15 | 18 | 21 | 24;

export interface SeedPhraseValidationResult {
  isValid: boolean;
  error?: SeedPhraseValidationError;
  wordCount?: number;
  invalidWords?: InvalidWordInfo[];
}

export interface SeedPhraseValidationError {
  code: 'EMPTY' | 'WRONG_WORD_COUNT' | 'INVALID_WORDS' | 'INVALID_CHECKSUM';
  message: string;
}

export interface InvalidWordInfo {
  word: string;
  index: number;
  suggestions?: string[];
}

const VALID_WORD_COUNTS: ValidWordCount[] = [12, 15, 18, 21, 24];

/**
 * Validate a seed phrase (mnemonic)
 */
export function validateSeedPhrase(
  input: string | string[]
): SeedPhraseValidationResult {
  // Convert to array
  const words = normalizeToWordArray(input);

  // Check for empty input
  if (words.length === 0) {
    return {
      isValid: false,
      error: {
        code: 'EMPTY',
        message: 'Seed phrase is required',
      },
    };
  }

  // Check word count
  if (!VALID_WORD_COUNTS.includes(words.length as ValidWordCount)) {
    return {
      isValid: false,
      wordCount: words.length,
      error: {
        code: 'WRONG_WORD_COUNT',
        message: `Invalid word count: ${words.length}. Must be 12, 15, 18, 21, or 24 words.`,
      },
    };
  }

  // Check each word
  const invalidWords: InvalidWordInfo[] = [];

  words.forEach((word, index) => {
    if (!wordlist.includes(word.toLowerCase())) {
      invalidWords.push({
        word,
        index,
        suggestions: getSuggestions(word, wordlist),
      });
    }
  });

  if (invalidWords.length > 0) {
    return {
      isValid: false,
      wordCount: words.length,
      invalidWords,
      error: {
        code: 'INVALID_WORDS',
        message: `Invalid word(s) at position(s): ${invalidWords.map(w => w.index + 1).join(', ')}`,
      },
    };
  }

  // Validate checksum
  const mnemonic = words.join(' ').toLowerCase();
  if (!validateMnemonic(mnemonic, wordlist)) {
    return {
      isValid: false,
      wordCount: words.length,
      error: {
        code: 'INVALID_CHECKSUM',
        message: 'Invalid seed phrase checksum. Please verify all words and their order.',
      },
    };
  }

  return {
    isValid: true,
    wordCount: words.length,
  };
}

/**
 * Quick check if seed phrase is valid
 */
export function isValidSeedPhrase(input: string | string[]): boolean {
  return validateSeedPhrase(input).isValid;
}

/**
 * Validate a single word
 */
export function validateWord(word: string): boolean {
  if (!word || typeof word !== 'string') {
    return false;
  }
  return wordlist.includes(word.toLowerCase().trim());
}

/**
 * Validate word at specific position
 */
export function validateWordAtPosition(
  word: string,
  position: number,
  totalWords: ValidWordCount
): { isValid: boolean; suggestions?: string[] } {
  if (position < 0 || position >= totalWords) {
    return { isValid: false };
  }

  const isValid = validateWord(word);
  if (isValid) {
    return { isValid: true };
  }

  return {
    isValid: false,
    suggestions: getSuggestions(word, wordlist),
  };
}

/**
 * Get word suggestions for autocomplete
 */
export function getWordSuggestions(
  prefix: string,
  limit: number = 5
): string[] {
  if (!prefix || prefix.length < 1) {
    return [];
  }

  const lowerPrefix = prefix.toLowerCase().trim();

  return wordlist
    .filter(word => word.startsWith(lowerPrefix))
    .slice(0, limit);
}

/**
 * Check if word count is valid
 */
export function isValidWordCount(count: number): count is ValidWordCount {
  return VALID_WORD_COUNTS.includes(count as ValidWordCount);
}

/**
 * Get valid word counts
 */
export function getValidWordCounts(): ValidWordCount[] {
  return [...VALID_WORD_COUNTS];
}

/**
 * Normalize input to word array
 */
export function normalizeToWordArray(input: string | string[]): string[] {
  if (Array.isArray(input)) {
    return input.map(w => w.trim().toLowerCase()).filter(w => w.length > 0);
  }

  if (typeof input !== 'string') {
    return [];
  }

  return input
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 0);
}

/**
 * Normalize seed phrase string
 */
export function normalizeSeedPhrase(input: string): string {
  return normalizeToWordArray(input).join(' ');
}

/**
 * Count words in input
 */
export function countWords(input: string): number {
  return normalizeToWordArray(input).length;
}

/**
 * Get progress for partial seed phrase entry
 */
export function getSeedPhraseProgress(
  words: string[],
  targetCount: ValidWordCount
): { entered: number; total: number; percentage: number } {
  const validWords = words.filter(w => validateWord(w));
  return {
    entered: validWords.length,
    total: targetCount,
    percentage: Math.round((validWords.length / targetCount) * 100),
  };
}

/**
 * Check if all words so far are valid (for progressive validation)
 */
export function validatePartialSeedPhrase(words: string[]): {
  allWordsValid: boolean;
  invalidIndices: number[];
} {
  const invalidIndices: number[] = [];

  words.forEach((word, index) => {
    if (word.trim() && !validateWord(word)) {
      invalidIndices.push(index);
    }
  });

  return {
    allWordsValid: invalidIndices.length === 0,
    invalidIndices,
  };
}

/**
 * Get similar words (for typo suggestions)
 */
function getSuggestions(word: string, wordlist: string[], limit: number = 3): string[] {
  const lowerWord = word.toLowerCase().trim();
  if (!lowerWord) return [];

  // First try prefix match
  const prefixMatches = wordlist
    .filter(w => w.startsWith(lowerWord.slice(0, 2)))
    .slice(0, limit);

  if (prefixMatches.length > 0) {
    return prefixMatches;
  }

  // Then try contains
  const containsMatches = wordlist
    .filter(w => w.includes(lowerWord.slice(0, 3)))
    .slice(0, limit);

  return containsMatches;
}

/**
 * Mask seed phrase words for secure display
 */
export function maskSeedPhraseWords(
  words: string[],
  showIndices: number[] = []
): string[] {
  return words.map((word, index) => {
    if (showIndices.includes(index)) {
      return word;
    }
    return '*'.repeat(word.length);
  });
}

/**
 * Get security level description based on word count
 */
export function getSecurityLevel(wordCount: ValidWordCount): {
  level: 'standard' | 'enhanced' | 'maximum';
  bits: number;
  description: string;
} {
  const bitsMap: Record<ValidWordCount, number> = {
    12: 128,
    15: 160,
    18: 192,
    21: 224,
    24: 256,
  };

  const bits = bitsMap[wordCount];

  if (wordCount <= 12) {
    return {
      level: 'standard',
      bits,
      description: 'Standard security (128-bit)',
    };
  } else if (wordCount <= 18) {
    return {
      level: 'enhanced',
      bits,
      description: 'Enhanced security (160-192 bit)',
    };
  } else {
    return {
      level: 'maximum',
      bits,
      description: 'Maximum security (224-256 bit)',
    };
  }
}

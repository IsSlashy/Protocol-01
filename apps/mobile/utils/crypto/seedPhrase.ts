/**
 * Seed phrase (mnemonic) utilities for Protocol 01
 * Implements BIP39 mnemonic generation and validation
 */

import * as bip39 from 'bip39';
import * as Crypto from 'expo-crypto';

export type MnemonicStrength = 128 | 160 | 192 | 224 | 256;
export type WordCount = 12 | 15 | 18 | 21 | 24;

export interface SeedPhraseError {
  code: 'GENERATION_FAILED' | 'INVALID_MNEMONIC' | 'INVALID_WORD' | 'INVALID_CHECKSUM' | 'WRONG_WORD_COUNT';
  message: string;
  details?: string;
}

export interface ValidationResult {
  isValid: boolean;
  error?: SeedPhraseError;
  invalidWords?: string[];
}

// Map word count to entropy bits
const WORD_COUNT_TO_STRENGTH: Record<WordCount, MnemonicStrength> = {
  12: 128,
  15: 160,
  18: 192,
  21: 224,
  24: 256,
};

/**
 * Generate a new BIP39 mnemonic seed phrase
 */
export function generateSeedPhrase(wordCount: WordCount = 12): string[] {
  const strength = WORD_COUNT_TO_STRENGTH[wordCount];

  if (!strength) {
    throw createSeedError(
      'GENERATION_FAILED',
      `Invalid word count: ${wordCount}. Must be 12, 15, 18, 21, or 24.`
    );
  }

  const mnemonic = bip39.generateMnemonic(strength);
  return mnemonic.split(' ');
}

/**
 * Generate mnemonic as string
 */
export function generateMnemonic(wordCount: WordCount = 12): string {
  return generateSeedPhrase(wordCount).join(' ');
}

/**
 * Validate a seed phrase
 */
export function validateSeedPhrase(words: string[] | string): ValidationResult {
  const wordArray = typeof words === 'string' ? words.trim().split(/\s+/) : words;

  // Check word count
  if (![12, 15, 18, 21, 24].includes(wordArray.length)) {
    return {
      isValid: false,
      error: createSeedError(
        'WRONG_WORD_COUNT',
        `Invalid word count: ${wordArray.length}. Must be 12, 15, 18, 21, or 24.`
      ),
    };
  }

  // Check each word is in the wordlist
  const wordlist = bip39.wordlists.english;
  const invalidWords: string[] = [];

  for (const word of wordArray) {
    if (!wordlist.includes(word.toLowerCase())) {
      invalidWords.push(word);
    }
  }

  if (invalidWords.length > 0) {
    return {
      isValid: false,
      error: createSeedError(
        'INVALID_WORD',
        `Invalid word(s) found: ${invalidWords.join(', ')}`
      ),
      invalidWords,
    };
  }

  // Validate mnemonic (includes checksum validation)
  const mnemonic = wordArray.join(' ').toLowerCase();
  if (!bip39.validateMnemonic(mnemonic)) {
    return {
      isValid: false,
      error: createSeedError(
        'INVALID_CHECKSUM',
        'Invalid mnemonic checksum. Please check the words and their order.'
      ),
    };
  }

  return { isValid: true };
}

/**
 * Check if a single word is valid
 */
export function isValidWord(word: string): boolean {
  const wordlist = bip39.wordlists.english;
  return wordlist.includes(word.toLowerCase());
}

/**
 * Get word suggestions for autocomplete
 */
export function getWordSuggestions(prefix: string, limit: number = 5): string[] {
  if (!prefix || prefix.length < 1) {
    return [];
  }

  const wordlist = bip39.wordlists.english;
  const lowerPrefix = prefix.toLowerCase();

  return wordlist
    .filter(word => word.startsWith(lowerPrefix))
    .slice(0, limit);
}

/**
 * Get the full wordlist
 */
export function getWordlist(): string[] {
  return [...bip39.wordlists.english];
}

/**
 * Get word index in wordlist
 */
export function getWordIndex(word: string): number {
  const wordlist = bip39.wordlists.english;
  return wordlist.indexOf(word.toLowerCase());
}

/**
 * Convert mnemonic to seed (Buffer)
 */
export async function mnemonicToSeed(mnemonic: string, passphrase?: string): Promise<Buffer> {
  const validation = validateSeedPhrase(mnemonic);
  if (!validation.isValid) {
    throw validation.error;
  }

  return bip39.mnemonicToSeed(mnemonic.toLowerCase(), passphrase);
}

/**
 * Convert mnemonic to seed (hex string)
 */
export async function mnemonicToSeedHex(mnemonic: string, passphrase?: string): Promise<string> {
  const seed = await mnemonicToSeed(mnemonic, passphrase);
  return seed.toString('hex');
}

/**
 * Convert mnemonic to entropy
 */
export function mnemonicToEntropy(mnemonic: string): string {
  const validation = validateSeedPhrase(mnemonic);
  if (!validation.isValid) {
    throw validation.error;
  }

  return bip39.mnemonicToEntropy(mnemonic.toLowerCase());
}

/**
 * Convert entropy to mnemonic
 */
export function entropyToMnemonic(entropy: string): string {
  return bip39.entropyToMnemonic(entropy);
}

/**
 * Normalize mnemonic (lowercase, trim, normalize spaces)
 */
export function normalizeMnemonic(mnemonic: string): string {
  return mnemonic
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .join(' ');
}

/**
 * Split mnemonic string to words array
 */
export function splitMnemonic(mnemonic: string): string[] {
  return normalizeMnemonic(mnemonic).split(' ');
}

/**
 * Join words array to mnemonic string
 */
export function joinMnemonic(words: string[]): string {
  return words.map(w => w.toLowerCase().trim()).join(' ');
}

/**
 * Mask seed phrase for display (e.g., "word1 **** **** word4")
 */
export function maskSeedPhrase(
  words: string[],
  visibleIndices: number[] = [0, words.length - 1]
): string[] {
  return words.map((word, index) => {
    if (visibleIndices.includes(index)) {
      return word;
    }
    return '*'.repeat(word.length);
  });
}

/**
 * Generate a random word from wordlist (for testing/UI)
 */
export function getRandomWord(): string {
  const wordlist = bip39.wordlists.english;
  const randomIndex = Math.floor(Math.random() * wordlist.length);
  return wordlist[randomIndex];
}

/**
 * Check if words array has correct format
 */
export function hasCorrectFormat(words: string[]): boolean {
  if (!Array.isArray(words)) return false;
  if (![12, 15, 18, 21, 24].includes(words.length)) return false;

  return words.every(word => {
    return typeof word === 'string' && word.length > 0 && !/\s/.test(word);
  });
}

/**
 * Get word count label
 */
export function getWordCountLabel(count: WordCount): string {
  const labels: Record<WordCount, string> = {
    12: '12 words (Standard)',
    15: '15 words',
    18: '18 words',
    21: '21 words',
    24: '24 words (High Security)',
  };
  return labels[count] || `${count} words`;
}

/**
 * Calculate entropy bits from word count
 */
export function wordCountToEntropyBits(wordCount: WordCount): number {
  return WORD_COUNT_TO_STRENGTH[wordCount];
}

function createSeedError(
  code: SeedPhraseError['code'],
  message: string,
  details?: string
): SeedPhraseError {
  return { code, message, details };
}

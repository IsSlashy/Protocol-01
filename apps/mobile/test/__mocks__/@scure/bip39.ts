/**
 * Mock: @scure/bip39
 *
 * Provides real-ish mnemonic generation using a small wordlist subset
 * and deterministic seed derivation for testing.
 */
import { createHash, randomBytes } from 'crypto';

const MINI_WORDLIST = [
  'abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract',
  'absurd', 'abuse', 'access', 'accident', 'account', 'accuse', 'achieve', 'acid',
  'across', 'act', 'action', 'actor', 'actual', 'add', 'address', 'adjust',
];

export function generateMnemonic(wordlist: string[], strength: number = 128): string {
  const wordCount = strength === 128 ? 12 : strength === 256 ? 24 : Math.floor(strength / 10.67);
  const words: string[] = [];
  for (let i = 0; i < wordCount; i++) {
    const idx = Math.floor(Math.random() * wordlist.length);
    words.push(wordlist[idx]);
  }
  return words.join(' ');
}

export function validateMnemonic(mnemonic: string, wordlist: string[]): boolean {
  const words = mnemonic.trim().toLowerCase().split(/\s+/);
  if (![12, 15, 18, 21, 24].includes(words.length)) return false;
  // Check all words are in the wordlist
  if (!words.every(w => wordlist.includes(w))) return false;
  // Reject when all words are the same (invalid checksum simulation)
  const uniqueWords = new Set(words);
  if (uniqueWords.size === 1) return false;
  return true;
}

export function mnemonicToSeedSync(mnemonic: string, passphrase?: string): Buffer {
  const input = `${mnemonic}${passphrase || ''}`;
  // Return a deterministic 64-byte buffer
  const hash1 = createHash('sha512').update(input).digest();
  return Buffer.from(hash1);
}

export async function mnemonicToSeed(mnemonic: string, passphrase?: string): Promise<Buffer> {
  return mnemonicToSeedSync(mnemonic, passphrase);
}

export function mnemonicToEntropy(mnemonic: string, wordlist: string[]): string {
  const hash = createHash('sha256').update(mnemonic).digest('hex');
  return hash.slice(0, 32);
}

export function entropyToMnemonic(entropy: Buffer | Uint8Array, wordlist: string[]): string {
  const count = 12;
  const words: string[] = [];
  for (let i = 0; i < count; i++) {
    const idx = (entropy[i % entropy.length] ?? 0) % wordlist.length;
    words.push(wordlist[idx]);
  }
  return words.join(' ');
}

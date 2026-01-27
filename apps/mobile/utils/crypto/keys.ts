/**
 * Key derivation utilities for Protocol 01
 * Implements BIP32/BIP44 key derivation for Solana
 */

import * as Crypto from 'expo-crypto';
import { Keypair } from '@solana/web3.js';
import { validateMnemonic, mnemonicToSeed } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { derivePath } from 'ed25519-hd-key';

// Solana BIP44 derivation path
const SOLANA_DERIVATION_PATH = "m/44'/501'/0'/0'";

export interface DerivedKeypair {
  publicKey: string;
  secretKey: Uint8Array;
  path: string;
}

export interface KeyDerivationResult {
  keypair: Keypair;
  publicKey: string;
  path: string;
}

export interface KeyDerivationError {
  code: 'INVALID_MNEMONIC' | 'DERIVATION_FAILED' | 'INVALID_PATH' | 'INVALID_SEED';
  message: string;
}

/**
 * Derive Solana keypair from mnemonic
 */
export async function deriveKeypairFromMnemonic(
  mnemonic: string,
  accountIndex: number = 0
): Promise<KeyDerivationResult> {
  try {
    // Validate mnemonic
    if (!validateMnemonic(mnemonic, wordlist)) {
      throw createKeyError('INVALID_MNEMONIC', 'Invalid mnemonic phrase');
    }

    // Convert mnemonic to seed
    const seed = await mnemonicToSeed(mnemonic);

    // Derive path for account
    const path = getDerivationPath(accountIndex);
    const derived = derivePath(path, seed.toString('hex'));

    // Create Solana keypair
    const keypair = Keypair.fromSeed(derived.key);

    return {
      keypair,
      publicKey: keypair.publicKey.toBase58(),
      path,
    };
  } catch (error) {
    if ((error as KeyDerivationError).code) {
      throw error;
    }
    throw createKeyError('DERIVATION_FAILED', 'Failed to derive keypair');
  }
}

/**
 * Derive multiple accounts from mnemonic
 */
export async function deriveMultipleAccounts(
  mnemonic: string,
  count: number = 5
): Promise<KeyDerivationResult[]> {
  const accounts: KeyDerivationResult[] = [];

  for (let i = 0; i < count; i++) {
    const result = await deriveKeypairFromMnemonic(mnemonic, i);
    accounts.push(result);
  }

  return accounts;
}

/**
 * Get derivation path for account index
 */
export function getDerivationPath(accountIndex: number = 0): string {
  return `m/44'/501'/${accountIndex}'/0'`;
}

/**
 * Derive keypair from seed bytes
 */
export function deriveKeypairFromSeed(seed: Uint8Array): Keypair {
  if (seed.length !== 32) {
    throw createKeyError('INVALID_SEED', 'Seed must be 32 bytes');
  }
  return Keypair.fromSeed(seed);
}

/**
 * Generate new random keypair
 */
export function generateRandomKeypair(): Keypair {
  return Keypair.generate();
}

/**
 * Extract public key from keypair
 */
export function getPublicKeyString(keypair: Keypair): string {
  return keypair.publicKey.toBase58();
}

/**
 * Convert secret key to base64
 */
export function secretKeyToBase64(secretKey: Uint8Array): string {
  return Buffer.from(secretKey).toString('base64');
}

/**
 * Convert base64 to secret key
 */
export function base64ToSecretKey(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

/**
 * Restore keypair from secret key
 */
export function keypairFromSecretKey(secretKey: Uint8Array): Keypair {
  return Keypair.fromSecretKey(secretKey);
}

/**
 * Restore keypair from base64 secret
 */
export function keypairFromBase64(base64Secret: string): Keypair {
  const secretKey = base64ToSecretKey(base64Secret);
  return Keypair.fromSecretKey(secretKey);
}

/**
 * Derive child key for specific purpose
 */
export async function deriveChildKey(
  parentSeed: Uint8Array,
  purpose: string
): Promise<Uint8Array> {
  // Hash parent seed with purpose to derive child key
  const combined = new Uint8Array(parentSeed.length + purpose.length);
  combined.set(parentSeed);
  combined.set(new TextEncoder().encode(purpose), parentSeed.length);

  const hash = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    Buffer.from(combined).toString('hex')
  );

  return hexToBytes(hash);
}

/**
 * Derive encryption key from master key
 */
export async function deriveEncryptionKey(
  masterKey: Uint8Array
): Promise<string> {
  const childKey = await deriveChildKey(masterKey, 'encryption');
  return bytesToHex(childKey);
}

/**
 * Derive signing key from master key
 */
export async function deriveSigningKeypair(
  masterKey: Uint8Array
): Promise<Keypair> {
  const childKey = await deriveChildKey(masterKey, 'signing');
  return Keypair.fromSeed(childKey.slice(0, 32));
}

/**
 * Validate derivation path format
 */
export function isValidDerivationPath(path: string): boolean {
  const pathRegex = /^m(\/\d+'?)+$/;
  return pathRegex.test(path);
}

/**
 * Parse derivation path
 */
export function parseDerivationPath(path: string): number[] {
  if (!isValidDerivationPath(path)) {
    throw createKeyError('INVALID_PATH', 'Invalid derivation path format');
  }

  return path
    .split('/')
    .slice(1)
    .map(segment => {
      const hardened = segment.endsWith("'");
      const index = parseInt(segment.replace("'", ''), 10);
      return hardened ? index + 0x80000000 : index;
    });
}

/**
 * Check if path is hardened
 */
export function isHardenedPath(path: string): boolean {
  return path.includes("'");
}

// Helper functions

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function createKeyError(
  code: KeyDerivationError['code'],
  message: string
): KeyDerivationError {
  return { code, message };
}

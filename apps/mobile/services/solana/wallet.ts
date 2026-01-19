import { Keypair } from '@solana/web3.js';
import * as SecureStore from 'expo-secure-store';
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import CryptoJS from 'crypto-js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

// Secure storage keys
const STORAGE_KEYS = {
  MNEMONIC: 'p01_mnemonic',
  PRIVATE_KEY: 'p01_private_key',
  PUBLIC_KEY: 'p01_public_key',
  WALLET_EXISTS: 'p01_wallet_exists',
};

// Shared secure options for consistent read/write
const SECURE_OPTIONS = {
  keychainService: 'protocol-01',
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

// Solana derivation path (BIP44)
const SOLANA_DERIVATION_PATH = "m/44'/501'/0'/0'";

export interface WalletInfo {
  publicKey: string;
  mnemonic?: string;
}

/**
 * Generate a new mnemonic phrase (24 words)
 */
export function generateMnemonic(): string {
  return bip39.generateMnemonic(wordlist, 256);
}

/**
 * Validate a mnemonic phrase
 */
export function validateMnemonic(mnemonic: string): boolean {
  return bip39.validateMnemonic(mnemonic, wordlist);
}

/**
 * Derive seed from mnemonic using BIP39
 */
async function mnemonicToSeed(mnemonic: string): Promise<Uint8Array> {
  return bip39.mnemonicToSeed(mnemonic);
}

/**
 * HMAC-SHA512 using crypto-js
 */
function hmacSha512(key: Uint8Array | string, data: Uint8Array): Uint8Array {
  // Convert key to WordArray
  let keyWords: CryptoJS.lib.WordArray;
  if (typeof key === 'string') {
    keyWords = CryptoJS.enc.Utf8.parse(key);
  } else {
    keyWords = CryptoJS.lib.WordArray.create(key as unknown as number[]);
  }

  // Convert data to WordArray
  const dataWords = CryptoJS.lib.WordArray.create(data as unknown as number[]);

  // Compute HMAC-SHA512
  const hmac = CryptoJS.HmacSHA512(dataWords, keyWords);

  // Convert result to Uint8Array
  const words = hmac.words;
  const sigBytes = hmac.sigBytes;
  const result = new Uint8Array(sigBytes);

  for (let i = 0; i < sigBytes; i++) {
    result[i] = (words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
  }

  return result;
}

/**
 * Derive keypair from seed using SLIP-0010/ED25519
 */
function deriveKeyFromSeed(seed: Uint8Array, path: string): Uint8Array {
  const ED25519_CURVE = 'ed25519 seed';

  // Master key derivation
  const I = hmacSha512(ED25519_CURVE, seed);
  let key = I.slice(0, 32);
  let chainCode = I.slice(32);

  // Parse path and derive
  const segments = path
    .split('/')
    .slice(1)
    .map((segment) => {
      const hardened = segment.endsWith("'");
      const index = parseInt(hardened ? segment.slice(0, -1) : segment, 10);
      return hardened ? index + 0x80000000 : index;
    });

  for (const segment of segments) {
    const indexBytes = new Uint8Array(4);
    new DataView(indexBytes.buffer).setUint32(0, segment, false);

    const data = new Uint8Array(1 + 32 + 4);
    data[0] = 0x00;
    data.set(key, 1);
    data.set(indexBytes, 33);

    const I = hmacSha512(chainCode, data);
    key = I.slice(0, 32);
    chainCode = I.slice(32);
  }

  return key;
}

/**
 * Derive keypair from mnemonic
 */
export async function deriveKeypairFromMnemonic(mnemonic: string): Promise<Keypair> {
  const seed = await mnemonicToSeed(mnemonic);
  const derivedSeed = deriveKeyFromSeed(seed, SOLANA_DERIVATION_PATH);
  const keyPair = nacl.sign.keyPair.fromSeed(derivedSeed);
  return Keypair.fromSecretKey(keyPair.secretKey);
}

/**
 * Create a new wallet and store it securely
 */
export async function createWallet(): Promise<WalletInfo> {
  console.log('[Wallet] Creating new wallet...');
  const mnemonic = generateMnemonic();
  const keypair = await deriveKeypairFromMnemonic(mnemonic);

  console.log('[Wallet] Storing wallet data...');
  await SecureStore.setItemAsync(STORAGE_KEYS.MNEMONIC, mnemonic, SECURE_OPTIONS);
  await SecureStore.setItemAsync(
    STORAGE_KEYS.PRIVATE_KEY,
    bs58.encode(keypair.secretKey),
    SECURE_OPTIONS
  );
  await SecureStore.setItemAsync(
    STORAGE_KEYS.PUBLIC_KEY,
    keypair.publicKey.toBase58(),
    SECURE_OPTIONS
  );
  await SecureStore.setItemAsync(STORAGE_KEYS.WALLET_EXISTS, 'true', SECURE_OPTIONS);
  console.log('[Wallet] Wallet created successfully, publicKey:', keypair.publicKey.toBase58());

  return {
    publicKey: keypair.publicKey.toBase58(),
    mnemonic,
  };
}

/**
 * Import wallet from mnemonic with comprehensive validation
 */
export async function importWallet(mnemonic: string): Promise<WalletInfo> {
  // Input validation
  if (!mnemonic || typeof mnemonic !== 'string') {
    throw new Error('Mnemonic is required');
  }

  // Normalize mnemonic - remove extra whitespace, convert to lowercase
  const normalizedMnemonic = mnemonic
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, ''); // Remove any non-alphanumeric characters

  // Validate word count (12, 15, 18, 21, or 24 words)
  const wordCount = normalizedMnemonic.split(' ').length;
  if (![12, 15, 18, 21, 24].includes(wordCount)) {
    throw new Error(`Invalid word count: ${wordCount}. Expected 12, 15, 18, 21, or 24 words.`);
  }

  // Validate mnemonic checksum
  if (!validateMnemonic(normalizedMnemonic)) {
    throw new Error('Invalid mnemonic phrase. Please check the words and their order.');
  }

  const keypair = await deriveKeypairFromMnemonic(normalizedMnemonic);

  await SecureStore.setItemAsync(STORAGE_KEYS.MNEMONIC, normalizedMnemonic, SECURE_OPTIONS);
  await SecureStore.setItemAsync(
    STORAGE_KEYS.PRIVATE_KEY,
    bs58.encode(keypair.secretKey),
    SECURE_OPTIONS
  );
  await SecureStore.setItemAsync(
    STORAGE_KEYS.PUBLIC_KEY,
    keypair.publicKey.toBase58(),
    SECURE_OPTIONS
  );
  await SecureStore.setItemAsync(STORAGE_KEYS.WALLET_EXISTS, 'true', SECURE_OPTIONS);

  return {
    publicKey: keypair.publicKey.toBase58(),
  };
}

/**
 * Check if wallet exists
 */
export async function walletExists(): Promise<boolean> {
  try {
    const exists = await SecureStore.getItemAsync(STORAGE_KEYS.WALLET_EXISTS, SECURE_OPTIONS);
    console.log('[Wallet] walletExists check - raw value:', exists);
    return exists === 'true';
  } catch (error) {
    console.error('[Wallet] walletExists error:', error);
    return false;
  }
}

/**
 * Get stored public key
 */
export async function getPublicKey(): Promise<string | null> {
  return SecureStore.getItemAsync(STORAGE_KEYS.PUBLIC_KEY, SECURE_OPTIONS);
}

/**
 * Get keypair from secure storage
 */
export async function getKeypair(): Promise<Keypair | null> {
  const privateKeyStr = await SecureStore.getItemAsync(STORAGE_KEYS.PRIVATE_KEY, SECURE_OPTIONS);
  if (!privateKeyStr) return null;

  const secretKey = bs58.decode(privateKeyStr);
  return Keypair.fromSecretKey(secretKey);
}

/**
 * Get mnemonic from secure storage (for backup display)
 */
export async function getMnemonic(): Promise<string | null> {
  return SecureStore.getItemAsync(STORAGE_KEYS.MNEMONIC, SECURE_OPTIONS);
}

/**
 * Delete wallet from secure storage
 * Also resets onboarding state so user can start fresh
 */
export async function deleteWallet(): Promise<void> {
  await SecureStore.deleteItemAsync(STORAGE_KEYS.MNEMONIC, SECURE_OPTIONS);
  await SecureStore.deleteItemAsync(STORAGE_KEYS.PRIVATE_KEY, SECURE_OPTIONS);
  await SecureStore.deleteItemAsync(STORAGE_KEYS.PUBLIC_KEY, SECURE_OPTIONS);
  await SecureStore.deleteItemAsync(STORAGE_KEYS.WALLET_EXISTS, SECURE_OPTIONS);
  // Reset onboarding state for fresh start
  await SecureStore.deleteItemAsync('p01_onboarded');
  // Clean up any temp data
  await SecureStore.deleteItemAsync('p01_temp_mnemonic');
  await SecureStore.deleteItemAsync('security_method');
  await SecureStore.deleteItemAsync('wallet_pin');
}

/**
 * Format public key for display (shortened)
 */
export function formatPublicKey(publicKey: string, chars: number = 4): string {
  if (publicKey.length <= chars * 2 + 3) return publicKey;
  return `${publicKey.slice(0, chars)}...${publicKey.slice(-chars)}`;
}

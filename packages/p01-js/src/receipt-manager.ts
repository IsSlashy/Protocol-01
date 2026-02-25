/**
 * Receipt Manager Module for Protocol 01
 *
 * Provides serialization, deserialization, and encryption utilities for
 * ShieldReceipt objects. The SDK does NOT store secrets -- it provides
 * tools for the host application to handle receipt persistence securely.
 *
 * Encryption uses AES-256-GCM via the existing @noble/ciphers dependency.
 * Keys are derived from passwords using HKDF (SHA-256) with a random salt.
 *
 * @module receipt-manager
 */

import { sha256 } from '@noble/hashes/sha256';
import { hkdf } from '@noble/hashes/hkdf';
import { randomBytes } from '@noble/hashes/utils';

import type { ShieldReceipt } from './shielded-pool';

// ============ Constants ============

/** AES-256-GCM key size in bytes */
const AES_KEY_SIZE = 32;

/** AES-256-GCM nonce/IV size in bytes */
const AES_NONCE_SIZE = 12;

/** HKDF salt size in bytes */
const SALT_SIZE = 16;

/** Magic bytes to identify encrypted receipts ('P01R' in ASCII) */
const MAGIC_BYTES = new Uint8Array([0x50, 0x30, 0x31, 0x52]);

/** Current format version */
const FORMAT_VERSION = 1;

// ============ JSON Serialization ============

/**
 * Serialize a ShieldReceipt to a JSON string.
 *
 * This produces a plain-text JSON representation. For secure storage,
 * use serializeReceipt() with a password instead.
 *
 * @param receipt - The ShieldReceipt to serialize
 * @returns JSON string representation
 *
 * @example
 * ```typescript
 * const json = receiptToJSON(receipt);
 * localStorage.setItem('receipt', json);
 * ```
 */
export function receiptToJSON(receipt: ShieldReceipt): string {
  validateReceipt(receipt);

  return JSON.stringify({
    version: FORMAT_VERSION,
    secret: receipt.secret,
    nullifierPreimage: receipt.nullifierPreimage,
    depositEpoch: receipt.depositEpoch,
    tokenMint: receipt.tokenMint,
    commitment: receipt.commitment,
    leafIndex: receipt.leafIndex,
    denomination: receipt.denomination,
    pool: receipt.pool,
  });
}

/**
 * Deserialize a ShieldReceipt from a JSON string.
 *
 * @param json - JSON string produced by receiptToJSON()
 * @returns Deserialized ShieldReceipt
 * @throws Error if the JSON is invalid or missing required fields
 *
 * @example
 * ```typescript
 * const json = localStorage.getItem('receipt');
 * const receipt = receiptFromJSON(json);
 * ```
 */
export function receiptFromJSON(json: string): ShieldReceipt {
  let data: any;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('Invalid JSON: cannot parse receipt data.');
  }

  // Validate required fields
  const required = [
    'secret',
    'nullifierPreimage',
    'depositEpoch',
    'tokenMint',
    'commitment',
    'leafIndex',
    'denomination',
    'pool',
  ];

  for (const field of required) {
    if (data[field] === undefined || data[field] === null) {
      throw new Error(`Invalid receipt: missing required field '${field}'.`);
    }
  }

  const receipt: ShieldReceipt = {
    secret: String(data.secret),
    nullifierPreimage: String(data.nullifierPreimage),
    depositEpoch: Number(data.depositEpoch),
    tokenMint: String(data.tokenMint),
    commitment: String(data.commitment),
    leafIndex: Number(data.leafIndex),
    denomination: Number(data.denomination),
    pool: String(data.pool),
  };

  return receipt;
}

// ============ Encrypted Serialization ============

/**
 * Serialize and encrypt a ShieldReceipt with a password.
 *
 * Uses AES-256-GCM for authenticated encryption.
 * The key is derived from the password using HKDF (SHA-256) with a random salt.
 *
 * Output format (base64-encoded):
 * [4 bytes magic] [1 byte version] [16 bytes salt] [12 bytes nonce] [N bytes ciphertext+tag]
 *
 * @param receipt - The ShieldReceipt to encrypt
 * @param password - Password for encryption (use a strong password)
 * @returns Base64-encoded encrypted receipt string
 * @throws Error if encryption fails
 *
 * @example
 * ```typescript
 * const encrypted = await serializeReceipt(receipt, 'my-strong-password');
 * // Store `encrypted` safely (e.g., file, database, clipboard)
 * ```
 */
export async function serializeReceipt(
  receipt: ShieldReceipt,
  password: string
): Promise<string> {
  validateReceipt(receipt);

  if (!password || password.length < 1) {
    throw new Error('Password is required for receipt encryption.');
  }

  // Serialize to JSON
  const json = receiptToJSON(receipt);
  const plaintext = new TextEncoder().encode(json);

  // Generate random salt and nonce
  const salt = randomBytes(SALT_SIZE);
  const nonce = randomBytes(AES_NONCE_SIZE);

  // Derive encryption key from password via HKDF
  const key = deriveKeyFromPassword(password, salt);

  // Encrypt using Web Crypto API (AES-256-GCM)
  const ciphertext = await encryptAES256GCM(plaintext, key, nonce);

  // Assemble output: magic + version + salt + nonce + ciphertext
  const output = new Uint8Array(
    MAGIC_BYTES.length + 1 + SALT_SIZE + AES_NONCE_SIZE + ciphertext.length
  );
  let offset = 0;

  output.set(MAGIC_BYTES, offset);
  offset += MAGIC_BYTES.length;

  output[offset] = FORMAT_VERSION;
  offset += 1;

  output.set(salt, offset);
  offset += SALT_SIZE;

  output.set(nonce, offset);
  offset += AES_NONCE_SIZE;

  output.set(ciphertext, offset);

  // Base64 encode the entire payload
  return uint8ArrayToBase64(output);
}

/**
 * Decrypt and deserialize a ShieldReceipt from an encrypted string.
 *
 * @param encrypted - Base64-encoded encrypted receipt from serializeReceipt()
 * @param password - Password used during encryption
 * @returns Deserialized ShieldReceipt
 * @throws Error if decryption fails (wrong password, corrupted data)
 *
 * @example
 * ```typescript
 * const receipt = await deserializeReceipt(encrypted, 'my-strong-password');
 * console.log('Denomination:', receipt.denomination);
 * ```
 */
export async function deserializeReceipt(
  encrypted: string,
  password: string
): Promise<ShieldReceipt> {
  if (!encrypted || encrypted.length === 0) {
    throw new Error('Encrypted receipt data is required.');
  }

  if (!password || password.length < 1) {
    throw new Error('Password is required for receipt decryption.');
  }

  // Decode from base64
  let data: Uint8Array;
  try {
    data = base64ToUint8Array(encrypted);
  } catch {
    throw new Error('Invalid encrypted receipt: not valid base64.');
  }

  // Minimum size: magic(4) + version(1) + salt(16) + nonce(12) + tag(16) = 49 bytes
  if (data.length < 49) {
    throw new Error('Invalid encrypted receipt: data too short.');
  }

  let offset = 0;

  // Verify magic bytes
  const magic = data.slice(offset, offset + MAGIC_BYTES.length);
  offset += MAGIC_BYTES.length;

  if (!constantTimeEqual(magic, MAGIC_BYTES)) {
    throw new Error(
      'Invalid encrypted receipt: missing magic bytes. ' +
      'This data was not encrypted by serializeReceipt().'
    );
  }

  // Check version
  const version = data[offset];
  offset += 1;

  if (version !== FORMAT_VERSION) {
    throw new Error(
      `Unsupported receipt format version: ${version}. Expected ${FORMAT_VERSION}.`
    );
  }

  // Extract salt, nonce, ciphertext
  const salt = data.slice(offset, offset + SALT_SIZE);
  offset += SALT_SIZE;

  const nonce = data.slice(offset, offset + AES_NONCE_SIZE);
  offset += AES_NONCE_SIZE;

  const ciphertext = data.slice(offset);

  // Derive key from password
  const key = deriveKeyFromPassword(password, salt);

  // Decrypt
  let plaintext: Uint8Array;
  try {
    plaintext = await decryptAES256GCM(ciphertext, key, nonce);
  } catch {
    throw new Error(
      'Decryption failed: wrong password or corrupted data. ' +
      'Please verify the password and try again.'
    );
  }

  // Parse JSON
  const json = new TextDecoder().decode(plaintext);
  return receiptFromJSON(json);
}

// ============ Internal Helpers ============

/**
 * Derive an AES-256 key from a password and salt using HKDF.
 */
function deriveKeyFromPassword(password: string, salt: Uint8Array): Uint8Array {
  const passwordBytes = new TextEncoder().encode(password);
  // Use HKDF with SHA-256: extract + expand
  const info = new TextEncoder().encode('p01-receipt-encryption-v1');
  return hkdf(sha256, passwordBytes, salt, info, AES_KEY_SIZE);
}

/**
 * Encrypt data with AES-256-GCM using Web Crypto API.
 */
async function encryptAES256GCM(
  plaintext: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array
): Promise<Uint8Array> {
  const subtle = getCryptoSubtle();

  const cryptoKey = await subtle.importKey(
    'raw',
    new Uint8Array(key).buffer,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );

  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv: new Uint8Array(nonce).buffer },
    cryptoKey,
    new Uint8Array(plaintext).buffer
  );

  return new Uint8Array(ciphertext);
}

/**
 * Decrypt data with AES-256-GCM using Web Crypto API.
 */
async function decryptAES256GCM(
  ciphertext: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array
): Promise<Uint8Array> {
  const subtle = getCryptoSubtle();

  const cryptoKey = await subtle.importKey(
    'raw',
    new Uint8Array(key).buffer,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  const plaintext = await subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(nonce).buffer },
    cryptoKey,
    new Uint8Array(ciphertext).buffer
  );

  return new Uint8Array(plaintext);
}

/**
 * Get the Web Crypto SubtleCrypto API (cross-platform).
 */
function getCryptoSubtle(): SubtleCrypto {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    return globalThis.crypto.subtle;
  }

  // Node.js fallback
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodeCrypto = require('crypto');
    if (nodeCrypto.webcrypto?.subtle) {
      return nodeCrypto.webcrypto.subtle;
    }
  } catch {
    // Ignore
  }

  throw new Error(
    'Web Crypto API (SubtleCrypto) is not available. ' +
    'Please use a modern browser or Node.js 15+.'
  );
}

/**
 * Validate a ShieldReceipt has all required fields.
 */
function validateReceipt(receipt: ShieldReceipt): void {
  if (!receipt) {
    throw new Error('Receipt is required.');
  }
  if (!receipt.secret) {
    throw new Error('Receipt is missing required field: secret.');
  }
  if (!receipt.nullifierPreimage) {
    throw new Error('Receipt is missing required field: nullifierPreimage.');
  }
  if (receipt.depositEpoch === undefined || receipt.depositEpoch === null) {
    throw new Error('Receipt is missing required field: depositEpoch.');
  }
  if (!receipt.tokenMint) {
    throw new Error('Receipt is missing required field: tokenMint.');
  }
  if (!receipt.commitment) {
    throw new Error('Receipt is missing required field: commitment.');
  }
  if (receipt.denomination === undefined || receipt.denomination === null) {
    throw new Error('Receipt is missing required field: denomination.');
  }
  if (!receipt.pool) {
    throw new Error('Receipt is missing required field: pool.');
  }
}

/**
 * Constant-time byte array comparison to prevent timing attacks.
 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

/**
 * Encode Uint8Array to base64 (cross-platform).
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  const binary = String.fromCharCode(...bytes);
  return btoa(binary);
}

/**
 * Decode base64 to Uint8Array (cross-platform).
 */
function base64ToUint8Array(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

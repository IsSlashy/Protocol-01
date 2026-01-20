/**
 * End-to-End Encryption Module for Protocol 01
 *
 * Provides asymmetric and symmetric encryption primitives:
 * - X25519 + XSalsa20-Poly1305 for asymmetric encryption
 * - AES-256-GCM for symmetric encryption (Web Crypto API)
 *
 * All functions are browser-compatible via Web Crypto API and noble libraries.
 */

import type { EncryptedPayload, EncryptedMemo } from './types';

// ============ Lazy Imports for Tree Shaking ============

let x25519: typeof import('@noble/curves/ed25519').x25519 | null = null;
let xsalsa20poly1305: typeof import('@noble/ciphers/salsa').xsalsa20poly1305 | null = null;
let randomBytes: typeof import('@noble/ciphers/webcrypto').randomBytes | null = null;

/**
 * Lazily load @noble/curves for X25519
 */
async function getX25519(): Promise<typeof import('@noble/curves/ed25519').x25519> {
  if (!x25519) {
    const mod = await import('@noble/curves/ed25519');
    x25519 = mod.x25519;
  }
  return x25519;
}

/**
 * Lazily load @noble/ciphers for XSalsa20-Poly1305
 */
async function getXSalsa20Poly1305(): Promise<typeof import('@noble/ciphers/salsa').xsalsa20poly1305> {
  if (!xsalsa20poly1305) {
    const mod = await import('@noble/ciphers/salsa');
    xsalsa20poly1305 = mod.xsalsa20poly1305;
  }
  return xsalsa20poly1305;
}

/**
 * Lazily load random bytes generator
 */
async function getRandomBytes(): Promise<typeof import('@noble/ciphers/webcrypto').randomBytes> {
  if (!randomBytes) {
    const mod = await import('@noble/ciphers/webcrypto');
    randomBytes = mod.randomBytes;
  }
  return randomBytes;
}

// ============ Constants ============

/** X25519 public key size in bytes */
const X25519_PUBLIC_KEY_SIZE = 32;

/** X25519 private key size in bytes */
const X25519_PRIVATE_KEY_SIZE = 32;

/** XSalsa20-Poly1305 nonce size in bytes */
const XSALSA20_NONCE_SIZE = 24;

/** AES-256-GCM key size in bytes */
const AES_KEY_SIZE = 32;

/** AES-256-GCM nonce/IV size in bytes */
const AES_NONCE_SIZE = 12;

/** Current encryption version */
const ENCRYPTION_VERSION = 1;

// ============ Utility Functions ============

/**
 * Convert Uint8Array to base64 string
 */
function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  // Browser environment
  const binary = String.fromCharCode(...bytes);
  return btoa(binary);
}

/**
 * Convert base64 string to Uint8Array
 */
function fromBase64(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
  // Browser environment
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Convert string to Uint8Array (UTF-8)
 */
function stringToBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

/**
 * Convert Uint8Array to string (UTF-8)
 */
function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/**
 * Generate cryptographically secure random bytes
 */
async function secureRandomBytes(length: number): Promise<Uint8Array> {
  // Try Web Crypto API first (works in browser and modern Node.js)
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    const bytes = new Uint8Array(length);
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  }

  // Fall back to noble/ciphers randomBytes
  const randBytes = await getRandomBytes();
  return randBytes(length);
}

/**
 * Derive a shared secret using X25519 ECDH
 */
async function deriveSharedSecret(
  privateKey: Uint8Array,
  publicKey: Uint8Array
): Promise<Uint8Array> {
  const x = await getX25519();
  return x.getSharedSecret(privateKey, publicKey);
}

/**
 * Generate an X25519 key pair
 */
async function generateX25519KeyPair(): Promise<{
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}> {
  const x = await getX25519();
  const privateKey = await secureRandomBytes(X25519_PRIVATE_KEY_SIZE);
  const publicKey = x.getPublicKey(privateKey);
  return { publicKey, privateKey };
}

// ============ Asymmetric Encryption (X25519 + XSalsa20-Poly1305) ============

/**
 * Encrypts a message for a specific recipient using asymmetric encryption.
 *
 * Uses X25519 for key exchange and XSalsa20-Poly1305 for authenticated encryption.
 * This is the same algorithm used by NaCl/libsodium's crypto_box.
 *
 * @param message - The message to encrypt (string or Uint8Array)
 * @param recipientPublicKey - The recipient's X25519 public key (32 bytes)
 * @returns Encrypted payload with ephemeral public key for decryption
 *
 * @example
 * ```typescript
 * const payload = await encryptForRecipient(
 *   "Hello, Alice!",
 *   alicePublicKey
 * );
 * // Send payload to Alice - only she can decrypt it
 * ```
 */
export async function encryptForRecipient(
  message: Uint8Array | string,
  recipientPublicKey: Uint8Array
): Promise<EncryptedPayload> {
  // Validate recipient public key
  if (recipientPublicKey.length !== X25519_PUBLIC_KEY_SIZE) {
    throw new Error(
      `Invalid recipient public key size: expected ${X25519_PUBLIC_KEY_SIZE} bytes, got ${recipientPublicKey.length}`
    );
  }

  // Convert message to bytes if needed
  const messageBytes = typeof message === 'string' ? stringToBytes(message) : message;

  // Generate ephemeral key pair for this message
  const ephemeral = await generateX25519KeyPair();

  // Derive shared secret using ECDH
  const sharedSecret = await deriveSharedSecret(ephemeral.privateKey, recipientPublicKey);

  // Generate random nonce
  const nonce = await secureRandomBytes(XSALSA20_NONCE_SIZE);

  // Encrypt with XSalsa20-Poly1305
  const xsalsa = await getXSalsa20Poly1305();
  const cipher = xsalsa(sharedSecret, nonce);
  const ciphertext = cipher.encrypt(messageBytes);

  return {
    ciphertext: toBase64(ciphertext),
    nonce: toBase64(nonce),
    ephemeralPublicKey: toBase64(ephemeral.publicKey),
    algorithm: 'x25519-xsalsa20-poly1305',
    version: ENCRYPTION_VERSION,
  };
}

/**
 * Decrypts a message that was encrypted for the recipient.
 *
 * @param payload - The encrypted payload from encryptForRecipient
 * @param recipientPrivateKey - The recipient's X25519 private key (32 bytes)
 * @returns The decrypted message as Uint8Array
 *
 * @example
 * ```typescript
 * const decrypted = await decryptFromSender(payload, alicePrivateKey);
 * const message = new TextDecoder().decode(decrypted);
 * console.log(message); // "Hello, Alice!"
 * ```
 */
export async function decryptFromSender(
  payload: EncryptedPayload,
  recipientPrivateKey: Uint8Array
): Promise<Uint8Array> {
  // Validate private key
  if (recipientPrivateKey.length !== X25519_PRIVATE_KEY_SIZE) {
    throw new Error(
      `Invalid recipient private key size: expected ${X25519_PRIVATE_KEY_SIZE} bytes, got ${recipientPrivateKey.length}`
    );
  }

  // Validate algorithm
  if (payload.algorithm !== 'x25519-xsalsa20-poly1305') {
    throw new Error(
      `Unsupported algorithm: ${payload.algorithm}. Expected x25519-xsalsa20-poly1305`
    );
  }

  // Decode payload components
  const ciphertext = fromBase64(payload.ciphertext);
  const nonce = fromBase64(payload.nonce);
  const ephemeralPublicKey = fromBase64(payload.ephemeralPublicKey);

  // Validate nonce size
  if (nonce.length !== XSALSA20_NONCE_SIZE) {
    throw new Error(
      `Invalid nonce size: expected ${XSALSA20_NONCE_SIZE} bytes, got ${nonce.length}`
    );
  }

  // Derive shared secret using ECDH
  const sharedSecret = await deriveSharedSecret(recipientPrivateKey, ephemeralPublicKey);

  // Decrypt with XSalsa20-Poly1305
  const xsalsa = await getXSalsa20Poly1305();
  const cipher = xsalsa(sharedSecret, nonce);

  try {
    return cipher.decrypt(ciphertext);
  } catch (error) {
    throw new Error(
      'Decryption failed: invalid ciphertext or authentication tag. ' +
        'The message may have been tampered with or the wrong key was used.'
    );
  }
}

// ============ Symmetric Encryption (AES-256-GCM via Web Crypto) ============

/**
 * Encrypts a message using AES-256-GCM symmetric encryption.
 *
 * Uses Web Crypto API for broad browser compatibility and hardware acceleration.
 *
 * @param message - The message to encrypt
 * @param key - 256-bit (32 bytes) encryption key
 * @returns Ciphertext and nonce needed for decryption
 *
 * @example
 * ```typescript
 * const key = crypto.getRandomValues(new Uint8Array(32));
 * const { ciphertext, nonce } = await encryptSymmetric(
 *   new TextEncoder().encode("Secret message"),
 *   key
 * );
 * ```
 */
export async function encryptSymmetric(
  message: Uint8Array,
  key: Uint8Array
): Promise<{ ciphertext: Uint8Array; nonce: Uint8Array }> {
  // Validate key size
  if (key.length !== AES_KEY_SIZE) {
    throw new Error(
      `Invalid key size: expected ${AES_KEY_SIZE} bytes, got ${key.length}`
    );
  }

  // Generate random nonce/IV
  const nonce = await secureRandomBytes(AES_NONCE_SIZE);

  // Get Web Crypto API
  const crypto = getCryptoSubtle();

  // Import the key (create fresh ArrayBuffer to satisfy TypeScript)
  const keyBuffer = new Uint8Array(key).buffer;
  const cryptoKey = await crypto.importKey(
    'raw',
    keyBuffer,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );

  // Encrypt (create fresh ArrayBuffers)
  const nonceBuffer = new Uint8Array(nonce).buffer;
  const messageBuffer = new Uint8Array(message).buffer;
  const ciphertext = await crypto.encrypt(
    {
      name: 'AES-GCM',
      iv: nonceBuffer,
    },
    cryptoKey,
    messageBuffer
  );

  return {
    ciphertext: new Uint8Array(ciphertext),
    nonce,
  };
}

/**
 * Decrypts a message using AES-256-GCM symmetric encryption.
 *
 * @param ciphertext - The encrypted data from encryptSymmetric
 * @param nonce - The nonce used during encryption
 * @param key - 256-bit (32 bytes) encryption key
 * @returns The decrypted message
 *
 * @example
 * ```typescript
 * const decrypted = await decryptSymmetric(ciphertext, nonce, key);
 * const message = new TextDecoder().decode(decrypted);
 * ```
 */
export async function decryptSymmetric(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  key: Uint8Array
): Promise<Uint8Array> {
  // Validate key size
  if (key.length !== AES_KEY_SIZE) {
    throw new Error(
      `Invalid key size: expected ${AES_KEY_SIZE} bytes, got ${key.length}`
    );
  }

  // Validate nonce size
  if (nonce.length !== AES_NONCE_SIZE) {
    throw new Error(
      `Invalid nonce size: expected ${AES_NONCE_SIZE} bytes, got ${nonce.length}`
    );
  }

  // Get Web Crypto API
  const crypto = getCryptoSubtle();

  // Import the key (create fresh ArrayBuffer to satisfy TypeScript)
  const keyBuffer = new Uint8Array(key).buffer;
  const cryptoKey = await crypto.importKey(
    'raw',
    keyBuffer,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  // Decrypt (create fresh ArrayBuffers)
  try {
    const nonceBuffer = new Uint8Array(nonce).buffer;
    const ciphertextBuffer = new Uint8Array(ciphertext).buffer;
    const plaintext = await crypto.decrypt(
      {
        name: 'AES-GCM',
        iv: nonceBuffer,
      },
      cryptoKey,
      ciphertextBuffer
    );

    return new Uint8Array(plaintext);
  } catch {
    throw new Error(
      'Decryption failed: invalid ciphertext or authentication tag. ' +
        'The message may have been tampered with or the wrong key was used.'
    );
  }
}

/**
 * Get Web Crypto SubtleCrypto API
 */
function getCryptoSubtle(): SubtleCrypto {
  // Browser environment
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    return globalThis.crypto.subtle;
  }

  // Node.js environment
  if (typeof globalThis.crypto === 'undefined') {
    // Try to load from Node.js crypto module
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const nodeCrypto = require('crypto');
      if (nodeCrypto.webcrypto?.subtle) {
        return nodeCrypto.webcrypto.subtle;
      }
    } catch {
      // Ignore
    }
  }

  throw new Error(
    'Web Crypto API (SubtleCrypto) is not available. ' +
      'Please use a modern browser or Node.js 15+.'
  );
}

// ============ Encrypted Memos ============

/**
 * Creates an encrypted memo for a blockchain transaction.
 *
 * Memos are encrypted using asymmetric encryption so only the recipient
 * can read them. Optionally includes sender's public key for verification.
 *
 * @param content - The memo content (max 256 characters recommended)
 * @param recipientPublicKey - The recipient's X25519 public key
 * @param senderKeyPair - Optional sender's key pair for verification
 * @returns Encrypted memo ready to be attached to a transaction
 *
 * @example
 * ```typescript
 * const memo = await createEncryptedMemo(
 *   "Payment for invoice #12345",
 *   recipientPublicKey,
 *   senderKeyPair // Optional: allows recipient to verify sender
 * );
 * // Attach memo to transaction
 * ```
 */
export async function createEncryptedMemo(
  content: string,
  recipientPublicKey: Uint8Array,
  senderKeyPair?: { publicKey: Uint8Array; privateKey: Uint8Array }
): Promise<EncryptedMemo> {
  // Validate content length (memo data on Solana is limited)
  if (content.length > 1024) {
    throw new Error(
      `Memo content too long: ${content.length} characters. Maximum recommended: 1024`
    );
  }

  // Encrypt the memo content
  const payload = await encryptForRecipient(content, recipientPublicKey);

  const encryptedMemo: EncryptedMemo = {
    payload,
    recipientPublicKey: toBase64(recipientPublicKey),
  };

  // Add sender's public key if provided (for verification)
  if (senderKeyPair) {
    encryptedMemo.senderPublicKey = toBase64(senderKeyPair.publicKey);
  }

  return encryptedMemo;
}

/**
 * Decrypts an encrypted memo from a transaction.
 *
 * @param memo - The encrypted memo from the transaction
 * @param recipientPrivateKey - The recipient's X25519 private key
 * @returns The decrypted memo content as string
 *
 * @example
 * ```typescript
 * const content = await decryptMemo(memo, myPrivateKey);
 * console.log(content); // "Payment for invoice #12345"
 * ```
 */
export async function decryptMemo(
  memo: EncryptedMemo,
  recipientPrivateKey: Uint8Array
): Promise<string> {
  // Verify recipient public key matches
  const expectedPublicKey = fromBase64(memo.recipientPublicKey);
  const x = await getX25519();
  const actualPublicKey = x.getPublicKey(recipientPrivateKey);

  // Compare public keys
  if (!constantTimeEqual(expectedPublicKey, actualPublicKey)) {
    throw new Error(
      'Recipient public key mismatch. This memo was not encrypted for this key pair.'
    );
  }

  // Decrypt the payload
  const decrypted = await decryptFromSender(memo.payload, recipientPrivateKey);

  return bytesToString(decrypted);
}

// ============ Helper Functions ============

/**
 * Constant-time comparison of two Uint8Arrays to prevent timing attacks
 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }

  return result === 0;
}

// ============ Key Generation Utilities ============

/**
 * Generates a new X25519 key pair for encryption.
 *
 * @returns A new key pair with 32-byte public and private keys
 *
 * @example
 * ```typescript
 * const keyPair = await generateEncryptionKeyPair();
 * // Store keyPair.privateKey securely
 * // Share keyPair.publicKey with others
 * ```
 */
export async function generateEncryptionKeyPair(): Promise<{
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}> {
  return generateX25519KeyPair();
}

/**
 * Generates a random 256-bit key for symmetric encryption.
 *
 * @returns A 32-byte random key
 *
 * @example
 * ```typescript
 * const key = await generateSymmetricKey();
 * // Use for encryptSymmetric/decryptSymmetric
 * ```
 */
export async function generateSymmetricKey(): Promise<Uint8Array> {
  return secureRandomBytes(AES_KEY_SIZE);
}

/**
 * Derives an X25519 public key from a private key.
 *
 * @param privateKey - The private key (32 bytes)
 * @returns The corresponding public key (32 bytes)
 */
export async function getPublicKeyFromPrivate(
  privateKey: Uint8Array
): Promise<Uint8Array> {
  if (privateKey.length !== X25519_PRIVATE_KEY_SIZE) {
    throw new Error(
      `Invalid private key size: expected ${X25519_PRIVATE_KEY_SIZE} bytes, got ${privateKey.length}`
    );
  }

  const x = await getX25519();
  return x.getPublicKey(privateKey);
}

// ============ Encoding Utilities (exported for convenience) ============

/**
 * Encode bytes to base64 string
 */
export function encodeBase64(bytes: Uint8Array): string {
  return toBase64(bytes);
}

/**
 * Decode base64 string to bytes
 */
export function decodeBase64(base64: string): Uint8Array {
  return fromBase64(base64);
}

/**
 * Encode string to UTF-8 bytes
 */
export function encodeUtf8(str: string): Uint8Array {
  return stringToBytes(str);
}

/**
 * Decode UTF-8 bytes to string
 */
export function decodeUtf8(bytes: Uint8Array): string {
  return bytesToString(bytes);
}

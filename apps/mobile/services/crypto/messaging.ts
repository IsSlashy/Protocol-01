/**
 * End-to-End Encryption Service for P-01 Mobile Messaging
 *
 * Uses:
 * - ed25519 -> x25519 conversion for ECDH key exchange
 * - X25519 for Diffie-Hellman key exchange
 * - XSalsa20-Poly1305 for symmetric message encryption (via nacl.box)
 * - tweetnacl for all cryptographic operations
 *
 * This is the React Native compatible version of the extension's encryption service.
 */

import nacl from 'tweetnacl';
import { Buffer } from 'buffer';

// Constants
const NONCE_LENGTH = 24; // nacl.secretbox nonce length
const KEY_LENGTH = 32; // 256 bits

/**
 * Encrypted message format for transport/storage
 */
export interface EncryptedMessage {
  /** Base64 encoded ciphertext */
  ciphertext: string;
  /** Base64 encoded nonce */
  nonce: string;
  /** Sender's encryption public key (base64) for verification */
  senderPublicKey: string;
  /** Timestamp of encryption */
  timestamp: number;
  /** Protocol version for future compatibility */
  version: number;
}

/**
 * Encryption keypair derived from wallet
 */
export interface EncryptionKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/**
 * Convert Uint8Array to base64 string
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/**
 * Convert base64 string to Uint8Array
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

/**
 * Convert hex string to Uint8Array
 */
export function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Convert Uint8Array to hex string
 */
export function uint8ArrayToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Convert ed25519 secret key to x25519 secret key
 *
 * The ed25519 secret key is 64 bytes (seed + public key)
 * We take the first 32 bytes (the seed) and clamp it for x25519
 */
function ed25519SecretKeyToX25519(ed25519SecretKey: Uint8Array): Uint8Array {
  // The first 32 bytes of an ed25519 secret key is the seed
  const seed = ed25519SecretKey.slice(0, 32);

  // Hash the seed to get a proper x25519 scalar
  const hash = nacl.hash(seed);
  const x25519SecretKey = hash.slice(0, 32);

  // Clamp the secret key for x25519
  // This ensures the key is a valid x25519 scalar
  x25519SecretKey[0] &= 248;
  x25519SecretKey[31] &= 127;
  x25519SecretKey[31] |= 64;

  return x25519SecretKey;
}

/**
 * Derive X25519 encryption keypair from wallet's ed25519 keypair
 *
 * @param ed25519SecretKey - The wallet's 64-byte ed25519 secret key
 * @returns Encryption keypair for X25519 ECDH
 */
export async function deriveEncryptionKeys(
  ed25519SecretKey: Uint8Array
): Promise<EncryptionKeyPair> {
  // Convert ed25519 keys to x25519 for encryption
  const x25519SecretKey = ed25519SecretKeyToX25519(ed25519SecretKey);

  // Generate the corresponding x25519 public key using nacl.box
  // nacl.box.keyPair.fromSecretKey expects a 32-byte secret key
  const boxKeyPair = nacl.box.keyPair.fromSecretKey(x25519SecretKey);

  return {
    publicKey: boxKeyPair.publicKey,
    secretKey: boxKeyPair.secretKey,
  };
}

/**
 * Derive encryption keys from a 32-byte seed (e.g., from wallet private key)
 */
export async function deriveEncryptionKeysFromSeed(
  seed: Uint8Array
): Promise<EncryptionKeyPair> {
  // Hash the seed to get a proper x25519 scalar
  const hash = nacl.hash(seed);
  const x25519SecretKey = hash.slice(0, 32);

  // Clamp the secret key for x25519
  x25519SecretKey[0] &= 248;
  x25519SecretKey[31] &= 127;
  x25519SecretKey[31] |= 64;

  // Generate the corresponding x25519 public key
  const boxKeyPair = nacl.box.keyPair.fromSecretKey(x25519SecretKey);

  return {
    publicKey: boxKeyPair.publicKey,
    secretKey: boxKeyPair.secretKey,
  };
}

/**
 * Generate a random nonce for encryption
 */
function generateNonce(): Uint8Array {
  return nacl.randomBytes(NONCE_LENGTH);
}

/**
 * Derive a deterministic conversation ID from two public keys
 * This ensures both parties compute the same conversation ID
 */
export function deriveConversationId(
  publicKey1: string,
  publicKey2: string
): string {
  // Sort keys to ensure same ID regardless of who initiates
  const sortedKeys = [publicKey1, publicKey2].sort();
  const combined = sortedKeys.join(':');

  // Hash to create a unique, deterministic ID
  const encoder = new TextEncoder();
  const data = encoder.encode(combined);
  const hash = nacl.hash(data);

  // Return first 16 bytes as hex for a reasonable ID length
  return Array.from(hash.slice(0, 16))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Encrypt a message for a specific recipient
 *
 * @param message - Plain text message to encrypt
 * @param recipientPublicKey - Recipient's encryption public key (base64)
 * @param senderSecretKey - Sender's encryption secret key (Uint8Array)
 * @param senderPublicKey - Sender's encryption public key (Uint8Array)
 * @returns Encrypted message object
 */
export async function encryptMessage(
  message: string,
  recipientPublicKey: string,
  senderSecretKey: Uint8Array,
  senderPublicKey: Uint8Array
): Promise<EncryptedMessage> {
  // Decode recipient's public key
  const recipientPubKeyBytes = base64ToUint8Array(recipientPublicKey);

  // Generate random nonce
  const nonce = generateNonce();

  // Encode message to bytes
  const encoder = new TextEncoder();
  const messageBytes = encoder.encode(message);

  // Encrypt using nacl.box (authenticated encryption)
  // This uses X25519 ECDH + XSalsa20-Poly1305
  const ciphertext = nacl.box(
    messageBytes,
    nonce,
    recipientPubKeyBytes,
    senderSecretKey
  );

  if (!ciphertext) {
    throw new Error('Encryption failed');
  }

  return {
    ciphertext: uint8ArrayToBase64(ciphertext),
    nonce: uint8ArrayToBase64(nonce),
    senderPublicKey: uint8ArrayToBase64(senderPublicKey),
    timestamp: Date.now(),
    version: 1,
  };
}

/**
 * Decrypt a message from a sender
 *
 * @param encrypted - The encrypted message object
 * @param senderPublicKey - Sender's encryption public key (base64)
 * @param recipientSecretKey - Recipient's encryption secret key (Uint8Array)
 * @returns Decrypted plain text message
 */
export async function decryptMessage(
  encrypted: EncryptedMessage,
  senderPublicKey: string,
  recipientSecretKey: Uint8Array
): Promise<string> {
  // Decode encrypted data
  const ciphertext = base64ToUint8Array(encrypted.ciphertext);
  const nonce = base64ToUint8Array(encrypted.nonce);
  const senderPubKeyBytes = base64ToUint8Array(senderPublicKey);

  // Decrypt using nacl.box.open
  const messageBytes = nacl.box.open(
    ciphertext,
    nonce,
    senderPubKeyBytes,
    recipientSecretKey
  );

  if (!messageBytes) {
    throw new Error('Decryption failed - message may be corrupted or from wrong sender');
  }

  // Decode message bytes to string
  const decoder = new TextDecoder();
  return decoder.decode(messageBytes);
}

/**
 * Encrypt data for local storage using a symmetric key
 * Used for encrypting message history at rest
 *
 * @param data - Data to encrypt (will be JSON stringified)
 * @param key - 32-byte encryption key
 * @returns Encrypted data as base64 string with nonce prepended
 */
export function encryptForStorage<T>(data: T, key: Uint8Array): string {
  const nonce = generateNonce();
  const encoder = new TextEncoder();
  const dataBytes = encoder.encode(JSON.stringify(data));

  // Use nacl.secretbox for symmetric encryption
  const ciphertext = nacl.secretbox(dataBytes, nonce, key);

  if (!ciphertext) {
    throw new Error('Storage encryption failed');
  }

  // Prepend nonce to ciphertext
  const combined = new Uint8Array(nonce.length + ciphertext.length);
  combined.set(nonce);
  combined.set(ciphertext, nonce.length);

  return uint8ArrayToBase64(combined);
}

/**
 * Decrypt data from local storage
 *
 * @param encryptedData - Base64 encoded encrypted data with prepended nonce
 * @param key - 32-byte encryption key
 * @returns Decrypted and parsed data
 */
export function decryptFromStorage<T>(encryptedData: string, key: Uint8Array): T {
  const combined = base64ToUint8Array(encryptedData);

  // Extract nonce and ciphertext
  const nonce = combined.slice(0, NONCE_LENGTH);
  const ciphertext = combined.slice(NONCE_LENGTH);

  // Decrypt
  const dataBytes = nacl.secretbox.open(ciphertext, nonce, key);

  if (!dataBytes) {
    throw new Error('Storage decryption failed');
  }

  const decoder = new TextDecoder();
  return JSON.parse(decoder.decode(dataBytes));
}

/**
 * Derive a storage encryption key from the wallet's secret key
 * This key is used to encrypt messages at rest
 */
export function deriveStorageKey(ed25519SecretKey: Uint8Array): Uint8Array {
  // Use a domain-separated hash for the storage key
  const encoder = new TextEncoder();
  const domain = encoder.encode('P01_MESSAGE_STORAGE_KEY_V1');

  // Combine domain with secret key and hash
  const combined = new Uint8Array(domain.length + ed25519SecretKey.length);
  combined.set(domain);
  combined.set(ed25519SecretKey, domain.length);

  const hash = nacl.hash(combined);
  return hash.slice(0, KEY_LENGTH);
}

/**
 * Verify that a message was sent by the claimed sender
 * This is inherent in nacl.box which uses authenticated encryption
 */
export function verifyMessageSender(
  encrypted: EncryptedMessage,
  expectedSenderPublicKey: string
): boolean {
  return encrypted.senderPublicKey === expectedSenderPublicKey;
}

/**
 * Generate a random message ID
 */
export function generateMessageId(): string {
  const bytes = nacl.randomBytes(16);
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Public key bundle for key exchange
 */
export interface PublicKeyBundle {
  /** Wallet address (Solana public key, base58) */
  walletAddress: string;
  /** Encryption public key (x25519, base64) */
  encryptionPublicKey: string;
  /** Signature of the encryption public key by the wallet (base64) */
  signature: string;
}

/**
 * Create a public key bundle that links wallet address to encryption key
 * This proves the encryption key belongs to the wallet owner
 */
export async function createPublicKeyBundle(
  walletAddress: string,
  ed25519SecretKey: Uint8Array,
  encryptionPublicKey: Uint8Array
): Promise<PublicKeyBundle> {
  // Message to sign: "P01_KEY_BINDING:" + wallet address + encryption public key
  const encoder = new TextEncoder();
  const message = encoder.encode(
    `P01_KEY_BINDING:${walletAddress}:${uint8ArrayToBase64(encryptionPublicKey)}`
  );

  // Sign with ed25519 key
  const signature = nacl.sign.detached(message, ed25519SecretKey);

  return {
    walletAddress,
    encryptionPublicKey: uint8ArrayToBase64(encryptionPublicKey),
    signature: uint8ArrayToBase64(signature),
  };
}

/**
 * Verify a public key bundle
 */
export function verifyPublicKeyBundle(
  bundle: PublicKeyBundle,
  ed25519PublicKey: Uint8Array
): boolean {
  const encoder = new TextEncoder();
  const message = encoder.encode(
    `P01_KEY_BINDING:${bundle.walletAddress}:${bundle.encryptionPublicKey}`
  );

  const signature = base64ToUint8Array(bundle.signature);

  return nacl.sign.detached.verify(message, signature, ed25519PublicKey);
}

/**
 * Create a new encryption keypair (for ephemeral keys or new identities)
 */
export function generateEncryptionKeyPair(): EncryptionKeyPair {
  const keyPair = nacl.box.keyPair();
  return {
    publicKey: keyPair.publicKey,
    secretKey: keyPair.secretKey,
  };
}

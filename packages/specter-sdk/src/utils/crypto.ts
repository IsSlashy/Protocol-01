import nacl from 'tweetnacl';
import { sha256 } from '@noble/hashes/sha256';
import { hkdf } from '@noble/hashes/hkdf';
import bs58 from 'bs58';
import {
  SALT_SIZE,
  IV_SIZE,
  AUTH_TAG_SIZE,
  KDF_ITERATIONS,
} from '../constants';

// ============================================================================
// Key Generation & Derivation
// ============================================================================

/**
 * Generate a random keypair for ephemeral use
 */
export function generateEphemeralKeypair(): nacl.BoxKeyPair {
  return nacl.box.keyPair();
}

/**
 * Generate a random Ed25519 signing keypair
 */
export function generateSigningKeypair(): nacl.SignKeyPair {
  return nacl.sign.keyPair();
}

/**
 * Derive a shared secret using ECDH (X25519)
 * @param privateKey - The private key (32 bytes)
 * @param publicKey - The public key (32 bytes)
 */
export function deriveSharedSecret(
  privateKey: Uint8Array,
  publicKey: Uint8Array
): Uint8Array {
  return nacl.scalarMult(privateKey, publicKey);
}

/**
 * Derive a key from shared secret using HKDF
 * @param sharedSecret - The shared secret
 * @param info - Context info for key derivation
 * @param length - Desired key length
 */
export function deriveKey(
  sharedSecret: Uint8Array,
  info: string,
  length: number = 32
): Uint8Array {
  return hkdf(sha256, sharedSecret, undefined, info, length);
}

/**
 * Derive a stealth private key from shared secret and spending key
 * @param spendingPrivateKey - The recipient's spending private key
 * @param sharedSecret - The ECDH shared secret
 */
export function deriveStealthPrivateKey(
  spendingPrivateKey: Uint8Array,
  sharedSecret: Uint8Array
): Uint8Array {
  const hashedSecret = sha256(sharedSecret);
  const privateKey = new Uint8Array(32);

  // Add the hashed secret to the spending private key (mod curve order)
  // This is a simplified version - in production, use proper scalar addition
  for (let i = 0; i < 32; i++) {
    privateKey[i] = (spendingPrivateKey[i]! + hashedSecret[i]!) % 256;
  }

  return privateKey;
}

/**
 * Compute a view tag from shared secret (first byte of hash)
 * @param sharedSecret - The ECDH shared secret
 */
export function computeViewTag(sharedSecret: Uint8Array): number {
  const hash = sha256(sharedSecret);
  return hash[0]!;
}

// ============================================================================
// Encryption & Decryption
// ============================================================================

/**
 * Encrypt data using XSalsa20-Poly1305 (NaCl secretbox)
 * @param plaintext - Data to encrypt
 * @param key - 32-byte encryption key
 */
export function encrypt(plaintext: Uint8Array, key: Uint8Array): Uint8Array {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ciphertext = nacl.secretbox(plaintext, nonce, key);

  // Combine nonce + ciphertext
  const combined = new Uint8Array(nonce.length + ciphertext.length);
  combined.set(nonce);
  combined.set(ciphertext, nonce.length);

  return combined;
}

/**
 * Decrypt data using XSalsa20-Poly1305 (NaCl secretbox)
 * @param combined - Combined nonce + ciphertext
 * @param key - 32-byte encryption key
 */
export function decrypt(combined: Uint8Array, key: Uint8Array): Uint8Array | null {
  const nonce = combined.slice(0, nacl.secretbox.nonceLength);
  const ciphertext = combined.slice(nacl.secretbox.nonceLength);

  return nacl.secretbox.open(ciphertext, nonce, key);
}

/**
 * Encrypt a message for a recipient using their public key (NaCl box)
 * @param plaintext - Data to encrypt
 * @param recipientPublicKey - Recipient's X25519 public key
 * @param senderPrivateKey - Sender's X25519 private key
 */
export function encryptForRecipient(
  plaintext: Uint8Array,
  recipientPublicKey: Uint8Array,
  senderPrivateKey: Uint8Array
): Uint8Array {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const ciphertext = nacl.box(plaintext, nonce, recipientPublicKey, senderPrivateKey);

  // Combine nonce + ciphertext
  const combined = new Uint8Array(nonce.length + ciphertext.length);
  combined.set(nonce);
  combined.set(ciphertext, nonce.length);

  return combined;
}

/**
 * Decrypt a message from a sender using their public key (NaCl box)
 * @param combined - Combined nonce + ciphertext
 * @param senderPublicKey - Sender's X25519 public key
 * @param recipientPrivateKey - Recipient's X25519 private key
 */
export function decryptFromSender(
  combined: Uint8Array,
  senderPublicKey: Uint8Array,
  recipientPrivateKey: Uint8Array
): Uint8Array | null {
  const nonce = combined.slice(0, nacl.box.nonceLength);
  const ciphertext = combined.slice(nacl.box.nonceLength);

  return nacl.box.open(ciphertext, nonce, senderPublicKey, recipientPrivateKey);
}

// ============================================================================
// Password-Based Encryption
// ============================================================================

/**
 * Derive a key from a password using PBKDF2-like derivation
 * @param password - The password string
 * @param salt - Salt for derivation
 */
export function deriveKeyFromPassword(
  password: string,
  salt: Uint8Array
): Uint8Array {
  const passwordBytes = new TextEncoder().encode(password);
  let key = new Uint8Array([...salt, ...passwordBytes]);

  // Simple iterative hashing (use proper PBKDF2 in production)
  for (let i = 0; i < Math.min(KDF_ITERATIONS, 10000); i++) {
    key = new Uint8Array(sha256(key));
  }

  return key;
}

/**
 * Encrypt data with a password
 * @param plaintext - Data to encrypt
 * @param password - Password string
 */
export function encryptWithPassword(plaintext: Uint8Array, password: string): Uint8Array {
  const salt = nacl.randomBytes(SALT_SIZE);
  const key = deriveKeyFromPassword(password, salt);
  const encrypted = encrypt(plaintext, key);

  // Combine salt + encrypted data
  const combined = new Uint8Array(salt.length + encrypted.length);
  combined.set(salt);
  combined.set(encrypted, salt.length);

  return combined;
}

/**
 * Decrypt data with a password
 * @param combined - Combined salt + nonce + ciphertext
 * @param password - Password string
 */
export function decryptWithPassword(
  combined: Uint8Array,
  password: string
): Uint8Array | null {
  const salt = combined.slice(0, SALT_SIZE);
  const encrypted = combined.slice(SALT_SIZE);
  const key = deriveKeyFromPassword(password, salt);

  return decrypt(encrypted, key);
}

// ============================================================================
// Hashing Utilities
// ============================================================================

/**
 * Hash data using SHA-256
 * @param data - Data to hash
 */
export function hash(data: Uint8Array): Uint8Array {
  return sha256(data);
}

/**
 * Hash a string using SHA-256
 * @param str - String to hash
 */
export function hashString(str: string): Uint8Array {
  return sha256(new TextEncoder().encode(str));
}

/**
 * Double SHA-256 hash
 * @param data - Data to hash
 */
export function doubleHash(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

// ============================================================================
// Encoding Utilities
// ============================================================================

/**
 * Encode bytes to base58
 */
export function toBase58(bytes: Uint8Array): string {
  return bs58.encode(bytes);
}

/**
 * Decode base58 to bytes
 */
export function fromBase58(str: string): Uint8Array {
  return bs58.decode(str);
}

/**
 * Encode bytes to hex string
 */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Decode hex string to bytes
 */
export function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ============================================================================
// Signature Utilities
// ============================================================================

/**
 * Sign a message using Ed25519
 * @param message - Message to sign
 * @param secretKey - 64-byte secret key (includes public key)
 */
export function sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return nacl.sign.detached(message, secretKey);
}

/**
 * Verify an Ed25519 signature
 * @param message - Original message
 * @param signature - Signature to verify
 * @param publicKey - 32-byte public key
 */
export function verify(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array
): boolean {
  return nacl.sign.detached.verify(message, signature, publicKey);
}

// ============================================================================
// Random Utilities
// ============================================================================

/**
 * Generate cryptographically secure random bytes
 * @param length - Number of bytes to generate
 */
export function randomBytes(length: number): Uint8Array {
  return nacl.randomBytes(length);
}

/**
 * Generate a random 32-byte seed
 */
export function randomSeed(): Uint8Array {
  return nacl.randomBytes(32);
}

// ============================================================================
// Key Conversion
// ============================================================================

/**
 * Convert Ed25519 public key to X25519 for encryption
 * @param ed25519PublicKey - Ed25519 public key (32 bytes)
 */
export function ed25519ToX25519PublicKey(ed25519PublicKey: Uint8Array): Uint8Array {
  // Note: This is a simplified conversion. In production, use a proper library
  // like @stablelib/ed25519 or similar that implements the birational map
  return sha256(ed25519PublicKey).slice(0, 32);
}

/**
 * Convert Ed25519 private key to X25519 for encryption
 * @param ed25519PrivateKey - Ed25519 private key (32 bytes, seed portion)
 */
export function ed25519ToX25519PrivateKey(ed25519PrivateKey: Uint8Array): Uint8Array {
  // The X25519 private key is derived from the Ed25519 seed
  return sha256(ed25519PrivateKey).slice(0, 32);
}

// ============================================================================
// Constant-Time Utilities
// ============================================================================

/**
 * Constant-time comparison of two byte arrays
 * @param a - First array
 * @param b - Second array
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i]! ^ b[i]!;
  }

  return result === 0;
}

/**
 * Securely clear sensitive data from memory
 * @param data - Data to clear
 */
export function secureClear(data: Uint8Array): void {
  data.fill(0);
}

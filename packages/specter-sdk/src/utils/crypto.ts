import nacl from 'tweetnacl';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { hkdf } from '@noble/hashes/hkdf';
import { ml_kem768 } from '@noble/post-quantum/ml-kem';
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import {
  SALT_SIZE,
  IV_SIZE,
  AUTH_TAG_SIZE,
  KDF_ITERATIONS,
  HYBRID_HKDF_INFO,
  STEALTH_SEED_INFO,
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
 * Derive a deterministic stealth seed from shared secret and spending public key.
 * Both sender and recipient can compute the same seed, producing matching keypairs.
 *
 * @param spendingPubKey - The recipient's spending public key (32 bytes)
 * @param sharedSecret - The (possibly hybrid) shared secret
 */
export function deriveStealthSeed(
  spendingPubKey: Uint8Array,
  sharedSecret: Uint8Array
): Uint8Array {
  return hkdf(sha256, sharedSecret, spendingPubKey, STEALTH_SEED_INFO, 32);
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
// Post-Quantum Hybrid Key Exchange (ML-KEM-768 / FIPS 203)
// ============================================================================

/**
 * Generate an ML-KEM-768 keypair for post-quantum hybrid stealth addresses
 * @returns publicKey (1184 bytes) and secretKey (2400 bytes)
 */
export function kemGenerateKeypair(): { publicKey: Uint8Array; secretKey: Uint8Array } {
  return ml_kem768.keygen();
}

/**
 * Encapsulate: sender creates a shared secret using the recipient's KEM public key
 * @param kemPubKey - Recipient's ML-KEM-768 public key (1184 bytes)
 * @returns cipherText (1088 bytes) and sharedSecret (32 bytes)
 */
export function kemEncapsulate(kemPubKey: Uint8Array): {
  cipherText: Uint8Array;
  sharedSecret: Uint8Array;
} {
  return ml_kem768.encapsulate(kemPubKey);
}

/**
 * Decapsulate: recipient recovers the shared secret from the KEM ciphertext
 * @param cipherText - KEM ciphertext from sender (1088 bytes)
 * @param kemSecretKey - Recipient's ML-KEM-768 secret key (2400 bytes)
 * @returns sharedSecret (32 bytes)
 */
export function kemDecapsulate(
  cipherText: Uint8Array,
  kemSecretKey: Uint8Array
): Uint8Array {
  return ml_kem768.decapsulate(cipherText, kemSecretKey);
}

/**
 * Derive a hybrid shared secret by combining classical ECDH and post-quantum KEM secrets.
 * Security holds if EITHER the classical or post-quantum scheme is secure.
 *
 * @param classicSecret - X25519 ECDH shared secret (32 bytes)
 * @param kemSecret - ML-KEM-768 shared secret (32 bytes)
 * @returns Combined shared secret (32 bytes)
 */
export function deriveHybridSharedSecret(
  classicSecret: Uint8Array,
  kemSecret: Uint8Array
): Uint8Array {
  const combined = new Uint8Array(classicSecret.length + kemSecret.length);
  combined.set(classicSecret);
  combined.set(kemSecret, classicSecret.length);
  return hkdf(sha256, combined, undefined, HYBRID_HKDF_INFO, 32);
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

// Field prime for Curve25519: p = 2^255 - 19
const CURVE25519_P = BigInt(
  '57896044618658097711785492504343953926634992332820282019728792003956564819949'
);

/**
 * Modular exponentiation: base^exp mod m
 * Used for computing modular inverse via Fermat's little theorem.
 */
function modPow(base: bigint, exp: bigint, m: bigint): bigint {
  let result = 1n;
  base = base % m;
  while (exp > 0n) {
    if (exp % 2n === 1n) {
      result = (result * base) % m;
    }
    exp = exp >> 1n;
    base = (base * base) % m;
  }
  return result;
}

/**
 * Convert a bigint to a 32-byte little-endian Uint8Array.
 */
function bigIntToLE32(value: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let v = value;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(v & 0xffn);
    v = v >> 8n;
  }
  return bytes;
}

/**
 * Convert an Ed25519 public key to an X25519 public key using the birational map.
 *
 * Applies the Edwards-to-Montgomery conversion: u = (1 + y) / (1 - y) mod p
 * where y is the y-coordinate of the Ed25519 point and p = 2^255 - 19.
 *
 * @param ed25519Pub - 32-byte Ed25519 public key
 * @returns 32-byte X25519 public key
 */
export function ed25519PublicKeyToX25519(ed25519Pub: Uint8Array): Uint8Array {
  if (ed25519Pub.length !== 32) {
    throw new Error('Ed25519 public key must be 32 bytes');
  }

  // Decode the Ed25519 point to get the affine y-coordinate
  const point = ed25519.ExtendedPoint.fromHex(ed25519Pub);
  const { y } = point.toAffine();

  const p = CURVE25519_P;

  // Birational map: u = (1 + y) / (1 - y) mod p
  const numerator = (1n + y) % p;
  const denominator = (p + 1n - (y % p)) % p;
  const denominatorInv = modPow(denominator, p - 2n, p);
  const u = (numerator * denominatorInv) % p;

  return bigIntToLE32(u);
}

/**
 * Convert an Ed25519 secret key (seed) to an X25519 secret key.
 *
 * Performs SHA-512 on the 32-byte seed, takes the first 32 bytes,
 * and applies RFC 7748 clamping:
 *   - scalar[0]  &= 248  (clear bottom 3 bits)
 *   - scalar[31] &= 127  (clear top bit)
 *   - scalar[31] |= 64   (set second-to-top bit)
 *
 * @param ed25519Seed - 32-byte Ed25519 seed (private key)
 * @returns 32-byte X25519 secret key
 */
export function ed25519SecretKeyToX25519(ed25519Seed: Uint8Array): Uint8Array {
  if (ed25519Seed.length !== 32) {
    throw new Error('Ed25519 seed must be 32 bytes');
  }

  const h = sha512(ed25519Seed);
  const scalar = new Uint8Array(h.slice(0, 32));

  // RFC 7748 clamping (scalar is always 32 bytes from sha512 slice)
  scalar[0] = scalar[0]! & 248;
  scalar[31] = scalar[31]! & 127;
  scalar[31] = scalar[31]! | 64;

  return scalar;
}

/**
 * Convert Ed25519 public key to X25519 for encryption.
 *
 * @deprecated This function produces INCORRECT results (uses SHA-256 instead of
 * the birational map). Use {@link ed25519PublicKeyToX25519} instead, or generate
 * X25519 keys directly with `nacl.box.keyPair()`.
 *
 * @param ed25519PublicKey - Ed25519 public key (32 bytes)
 */
export function ed25519ToX25519PublicKey(ed25519PublicKey: Uint8Array): Uint8Array {
  return ed25519PublicKeyToX25519(ed25519PublicKey);
}

/**
 * Convert Ed25519 private key to X25519 for encryption.
 *
 * @deprecated This function previously produced INCORRECT results (used SHA-256
 * instead of SHA-512 + clamping). Use {@link ed25519SecretKeyToX25519} instead,
 * or generate X25519 keys directly with `nacl.box.keyPair()`.
 *
 * @param ed25519PrivateKey - Ed25519 private key (32 bytes, seed portion)
 */
export function ed25519ToX25519PrivateKey(ed25519PrivateKey: Uint8Array): Uint8Array {
  return ed25519SecretKeyToX25519(ed25519PrivateKey);
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

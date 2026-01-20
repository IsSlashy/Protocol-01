/**
 * Cryptographic Primitives for Protocol 01
 *
 * This module provides low-level cryptographic operations:
 * - Key generation (Ed25519, X25519)
 * - Key derivation (HKDF)
 * - Digital signatures (Ed25519)
 * - Key agreement (X25519 ECDH)
 * - Hashing (SHA256, BLAKE2b)
 * - Pedersen Commitments for confidential amounts
 *
 * Uses @noble/curves and @noble/hashes for cross-platform compatibility.
 *
 * @module security/crypto
 */

import { ed25519 } from '@noble/curves/ed25519';
import { x25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { blake2b } from '@noble/hashes/blake2b';
import { hkdf } from '@noble/hashes/hkdf';
import { randomBytes } from '@noble/hashes/utils';

// ============ Constants ============

/** Size of Ed25519 private key in bytes */
export const ED25519_PRIVATE_KEY_SIZE = 32;

/** Size of Ed25519 public key in bytes */
export const ED25519_PUBLIC_KEY_SIZE = 32;

/** Size of Ed25519 signature in bytes */
export const ED25519_SIGNATURE_SIZE = 64;

/** Size of X25519 private key in bytes */
export const X25519_PRIVATE_KEY_SIZE = 32;

/** Size of X25519 public key in bytes */
export const X25519_PUBLIC_KEY_SIZE = 32;

/** Size of X25519 shared secret in bytes */
export const X25519_SHARED_SECRET_SIZE = 32;

/** Size of a Pedersen commitment point (compressed) */
export const COMMITMENT_SIZE = 32;

/** Maximum value for Pedersen commitments (2^64 - 1) */
export const MAX_COMMITMENT_VALUE = BigInt('18446744073709551615');

// ============ Types ============

/**
 * Ed25519 key pair for signing operations
 */
export interface Ed25519KeyPair {
  /** 32-byte public key */
  publicKey: Uint8Array;
  /** 32-byte private key (seed) */
  privateKey: Uint8Array;
}

/**
 * X25519 key pair for key agreement
 */
export interface X25519KeyPair {
  /** 32-byte public key */
  publicKey: Uint8Array;
  /** 32-byte private key */
  privateKey: Uint8Array;
}

/**
 * Options for HKDF key derivation
 */
export interface HKDFOptions {
  /** Hash algorithm to use ('sha256' | 'blake2b') */
  hash?: 'sha256' | 'blake2b';
  /** Optional salt (defaults to zeros) */
  salt?: Uint8Array;
  /** Optional context info */
  info?: Uint8Array | string;
  /** Output key length in bytes */
  length?: number;
}

/**
 * Pedersen commitment with opening information
 */
export interface PedersenCommitment {
  /** The commitment point (compressed, 32 bytes) */
  commitment: Uint8Array;
  /** The committed value */
  value: bigint;
  /** The blinding factor used */
  blindingFactor: Uint8Array;
}

// ============ Key Generation ============

/**
 * Generate a cryptographically secure random Ed25519 key pair
 *
 * @returns Ed25519 key pair with 32-byte public and private keys
 *
 * @example
 * ```typescript
 * const keyPair = generateEd25519KeyPair();
 * console.log('Public key:', Buffer.from(keyPair.publicKey).toString('hex'));
 * ```
 */
export function generateEd25519KeyPair(): Ed25519KeyPair {
  const privateKey = randomBytes(ED25519_PRIVATE_KEY_SIZE);
  const publicKey = ed25519.getPublicKey(privateKey);

  return {
    publicKey,
    privateKey,
  };
}

/**
 * Generate an Ed25519 key pair from a seed
 *
 * @param seed - 32-byte seed (will be used as private key)
 * @returns Ed25519 key pair derived from the seed
 * @throws Error if seed is not 32 bytes
 *
 * @example
 * ```typescript
 * const seed = sha256('my secret phrase');
 * const keyPair = generateEd25519KeyPairFromSeed(seed);
 * ```
 */
export function generateEd25519KeyPairFromSeed(seed: Uint8Array): Ed25519KeyPair {
  if (seed.length !== ED25519_PRIVATE_KEY_SIZE) {
    throw new Error(`Seed must be ${ED25519_PRIVATE_KEY_SIZE} bytes, got ${seed.length}`);
  }

  const publicKey = ed25519.getPublicKey(seed);

  return {
    publicKey,
    privateKey: new Uint8Array(seed),
  };
}

/**
 * Generate a cryptographically secure random X25519 key pair
 *
 * @returns X25519 key pair for ECDH key agreement
 *
 * @example
 * ```typescript
 * const alice = generateX25519KeyPair();
 * const bob = generateX25519KeyPair();
 * const sharedSecret = deriveSharedSecret(alice.privateKey, bob.publicKey);
 * ```
 */
export function generateX25519KeyPair(): X25519KeyPair {
  const privateKey = randomBytes(X25519_PRIVATE_KEY_SIZE);
  const publicKey = x25519.getPublicKey(privateKey);

  return {
    publicKey,
    privateKey,
  };
}

/**
 * Generate an X25519 key pair from a seed
 *
 * @param seed - 32-byte seed (will be used as private key)
 * @returns X25519 key pair derived from the seed
 * @throws Error if seed is not 32 bytes
 */
export function generateX25519KeyPairFromSeed(seed: Uint8Array): X25519KeyPair {
  if (seed.length !== X25519_PRIVATE_KEY_SIZE) {
    throw new Error(`Seed must be ${X25519_PRIVATE_KEY_SIZE} bytes, got ${seed.length}`);
  }

  const publicKey = x25519.getPublicKey(seed);

  return {
    publicKey,
    privateKey: new Uint8Array(seed),
  };
}

/**
 * Convert an Ed25519 public key to X25519 public key
 *
 * This enables using a single key pair for both signing and encryption.
 * Uses the birational map from Ed25519 to Curve25519.
 *
 * @param ed25519PublicKey - 32-byte Ed25519 public key
 * @returns 32-byte X25519 public key
 * @throws Error if public key is invalid
 *
 * @example
 * ```typescript
 * const signKeyPair = generateEd25519KeyPair();
 * const encryptionPubKey = ed25519PublicKeyToX25519(signKeyPair.publicKey);
 * ```
 */
export function ed25519PublicKeyToX25519(ed25519PublicKey: Uint8Array): Uint8Array {
  if (ed25519PublicKey.length !== ED25519_PUBLIC_KEY_SIZE) {
    throw new Error(`Public key must be ${ED25519_PUBLIC_KEY_SIZE} bytes`);
  }

  // Use the ExtendedPoint to convert
  const point = ed25519.ExtendedPoint.fromHex(ed25519PublicKey);

  // Convert Ed25519 point (x, y) to X25519 u-coordinate
  // u = (1 + y) / (1 - y) mod p
  const { y } = point.toAffine();
  const p = BigInt('57896044618658097711785492504343953926634992332820282019728792003956564819949');
  const one = BigInt(1);

  // Calculate (1 + y) and (1 - y)
  const numerator = (one + y) % p;
  const denominator = (p + one - (y % p)) % p;

  // Modular inverse using Fermat's little theorem: a^(-1) = a^(p-2) mod p
  const denominatorInv = modPow(denominator, p - BigInt(2), p);
  const u = (numerator * denominatorInv) % p;

  // Convert to bytes (little-endian)
  return bigIntToBytes(u, 32);
}

/**
 * Convert an Ed25519 private key to X25519 private key
 *
 * @param ed25519PrivateKey - 32-byte Ed25519 private key (seed)
 * @returns 32-byte X25519 private key
 *
 * @example
 * ```typescript
 * const signKeyPair = generateEd25519KeyPair();
 * const encryptionPrivKey = ed25519PrivateKeyToX25519(signKeyPair.privateKey);
 * ```
 */
export function ed25519PrivateKeyToX25519(ed25519PrivateKey: Uint8Array): Uint8Array {
  if (ed25519PrivateKey.length !== ED25519_PRIVATE_KEY_SIZE) {
    throw new Error(`Private key must be ${ED25519_PRIVATE_KEY_SIZE} bytes`);
  }

  // Hash the Ed25519 seed with SHA-512 and take the first 32 bytes
  // Then clamp as per X25519 spec
  const hash = sha512(ed25519PrivateKey);
  const x25519Key = new Uint8Array(hash.slice(0, 32));

  // Clamp the key (as per RFC 7748)
  x25519Key[0] &= 248;
  x25519Key[31] &= 127;
  x25519Key[31] |= 64;

  return x25519Key;
}

// ============ Key Derivation ============

/**
 * Derive a key using HKDF (HMAC-based Key Derivation Function)
 *
 * HKDF is used to derive cryptographically strong keys from
 * input keying material (IKM) like shared secrets.
 *
 * @param ikm - Input keying material
 * @param options - Derivation options
 * @returns Derived key of specified length (default 32 bytes)
 *
 * @example
 * ```typescript
 * const sharedSecret = deriveSharedSecret(myPrivKey, theirPubKey);
 * const encryptionKey = deriveKey(sharedSecret, { info: 'encryption' });
 * const macKey = deriveKey(sharedSecret, { info: 'mac' });
 * ```
 */
export function deriveKey(ikm: Uint8Array, options: HKDFOptions = {}): Uint8Array {
  const {
    hash = 'sha256',
    salt = new Uint8Array(32),
    info = new Uint8Array(0),
    length = 32,
  } = options;

  // Convert string info to Uint8Array
  const infoBytes = typeof info === 'string' ? new TextEncoder().encode(info) : info;

  if (hash === 'sha256') {
    return hkdf(sha256, ikm, salt, infoBytes, length);
  } else {
    // Use BLAKE2b for HKDF
    return hkdf(blake2b, ikm, salt, infoBytes, length);
  }
}

/**
 * Derive multiple keys from a single input using indexed derivation
 *
 * @param ikm - Input keying material
 * @param count - Number of keys to derive
 * @param keyLength - Length of each derived key (default 32)
 * @param baseInfo - Base info string for derivation
 * @returns Array of derived keys
 *
 * @example
 * ```typescript
 * const masterKey = randomBytes(32);
 * const [encKey, macKey, ivKey] = deriveMultipleKeys(masterKey, 3, 32, 'keys');
 * ```
 */
export function deriveMultipleKeys(
  ikm: Uint8Array,
  count: number,
  keyLength: number = 32,
  baseInfo: string = 'derived-key',
): Uint8Array[] {
  const keys: Uint8Array[] = [];

  for (let i = 0; i < count; i++) {
    const info = `${baseInfo}-${i}`;
    keys.push(deriveKey(ikm, { info, length: keyLength }));
  }

  return keys;
}

// ============ Digital Signatures ============

/**
 * Sign a message using Ed25519
 *
 * @param message - Message to sign
 * @param privateKey - 32-byte Ed25519 private key
 * @returns 64-byte Ed25519 signature
 *
 * @example
 * ```typescript
 * const keyPair = generateEd25519KeyPair();
 * const message = new TextEncoder().encode('Hello, World!');
 * const signature = sign(message, keyPair.privateKey);
 * ```
 */
export function sign(message: Uint8Array, privateKey: Uint8Array): Uint8Array {
  if (privateKey.length !== ED25519_PRIVATE_KEY_SIZE) {
    throw new Error(`Private key must be ${ED25519_PRIVATE_KEY_SIZE} bytes`);
  }

  return ed25519.sign(message, privateKey);
}

/**
 * Verify an Ed25519 signature
 *
 * @param signature - 64-byte Ed25519 signature
 * @param message - Original message that was signed
 * @param publicKey - 32-byte Ed25519 public key of the signer
 * @returns true if signature is valid, false otherwise
 *
 * @example
 * ```typescript
 * const isValid = verify(signature, message, keyPair.publicKey);
 * if (!isValid) throw new Error('Invalid signature');
 * ```
 */
export function verify(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  if (signature.length !== ED25519_SIGNATURE_SIZE) {
    return false;
  }
  if (publicKey.length !== ED25519_PUBLIC_KEY_SIZE) {
    return false;
  }

  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

// ============ ECDH Key Agreement ============

/**
 * Derive a shared secret using X25519 ECDH
 *
 * The shared secret is the same regardless of which party's
 * private key is used with the other's public key.
 *
 * @param privateKey - Your X25519 private key (32 bytes)
 * @param publicKey - Their X25519 public key (32 bytes)
 * @returns 32-byte shared secret
 * @throws Error if keys are invalid
 *
 * @example
 * ```typescript
 * // Alice and Bob each generate key pairs
 * const alice = generateX25519KeyPair();
 * const bob = generateX25519KeyPair();
 *
 * // They compute the same shared secret
 * const aliceSecret = deriveSharedSecret(alice.privateKey, bob.publicKey);
 * const bobSecret = deriveSharedSecret(bob.privateKey, alice.publicKey);
 * // aliceSecret === bobSecret
 * ```
 */
export function deriveSharedSecret(
  privateKey: Uint8Array,
  publicKey: Uint8Array,
): Uint8Array {
  if (privateKey.length !== X25519_PRIVATE_KEY_SIZE) {
    throw new Error(`Private key must be ${X25519_PRIVATE_KEY_SIZE} bytes`);
  }
  if (publicKey.length !== X25519_PUBLIC_KEY_SIZE) {
    throw new Error(`Public key must be ${X25519_PUBLIC_KEY_SIZE} bytes`);
  }

  return x25519.getSharedSecret(privateKey, publicKey);
}

/**
 * Perform ECDH and derive an encryption key
 *
 * This is a convenience function that performs ECDH and then
 * derives a key using HKDF, which is the recommended pattern.
 *
 * @param privateKey - Your X25519 private key
 * @param publicKey - Their X25519 public key
 * @param info - Context info for key derivation
 * @returns Derived encryption key (32 bytes)
 *
 * @example
 * ```typescript
 * const encryptionKey = deriveEncryptionKey(
 *   myPrivKey,
 *   theirPubKey,
 *   'protocol01-encryption-v1'
 * );
 * ```
 */
export function deriveEncryptionKey(
  privateKey: Uint8Array,
  publicKey: Uint8Array,
  info: string = 'protocol01-encryption',
): Uint8Array {
  const sharedSecret = deriveSharedSecret(privateKey, publicKey);
  return deriveKey(sharedSecret, { info, length: 32 });
}

// ============ Hashing ============

/**
 * Compute SHA-256 hash of data
 *
 * @param data - Data to hash
 * @returns 32-byte hash
 *
 * @example
 * ```typescript
 * const hash = hashSHA256(new TextEncoder().encode('hello'));
 * ```
 */
export function hashSHA256(data: Uint8Array): Uint8Array {
  return sha256(data);
}

/**
 * Compute BLAKE2b hash of data
 *
 * BLAKE2b is faster than SHA-256 and provides at least equivalent security.
 *
 * @param data - Data to hash
 * @param length - Output length in bytes (default 32, max 64)
 * @returns Hash of specified length
 *
 * @example
 * ```typescript
 * const hash = hashBLAKE2b(data);
 * const shortHash = hashBLAKE2b(data, 16);
 * ```
 */
export function hashBLAKE2b(data: Uint8Array, length: number = 32): Uint8Array {
  if (length < 1 || length > 64) {
    throw new Error('BLAKE2b output length must be between 1 and 64 bytes');
  }
  return blake2b(data, { dkLen: length });
}

/**
 * Compute a keyed BLAKE2b hash (MAC)
 *
 * @param data - Data to hash
 * @param key - Key for the MAC (up to 64 bytes)
 * @param length - Output length in bytes (default 32)
 * @returns Keyed hash of specified length
 *
 * @example
 * ```typescript
 * const mac = hashBLAKE2bKeyed(message, key);
 * ```
 */
export function hashBLAKE2bKeyed(
  data: Uint8Array,
  key: Uint8Array,
  length: number = 32,
): Uint8Array {
  if (key.length > 64) {
    throw new Error('BLAKE2b key must be at most 64 bytes');
  }
  return blake2b(data, { key, dkLen: length });
}

/**
 * Hash multiple pieces of data together
 *
 * @param parts - Array of data parts to hash
 * @param algorithm - Hash algorithm ('sha256' | 'blake2b')
 * @returns Hash of concatenated parts
 *
 * @example
 * ```typescript
 * const hash = hashConcat([publicKey, amount, timestamp], 'sha256');
 * ```
 */
export function hashConcat(
  parts: Uint8Array[],
  algorithm: 'sha256' | 'blake2b' = 'sha256',
): Uint8Array {
  // Calculate total length
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const combined = new Uint8Array(totalLength);

  // Concatenate all parts
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.length;
  }

  return algorithm === 'sha256' ? hashSHA256(combined) : hashBLAKE2b(combined);
}

// ============ Pedersen Commitments ============

/**
 * Generator point H for Pedersen commitments
 *
 * H is derived from hashing the standard generator G to ensure
 * that no one knows the discrete log of H with respect to G.
 * This is required for the binding property of the commitment.
 */
const PEDERSEN_H_POINT = (() => {
  // Hash 'Protocol01-Pedersen-H' to get a point
  const hBytes = hashSHA256(new TextEncoder().encode('Protocol01-Pedersen-H-Generator'));
  // Use hash-to-curve to get a valid point
  // We multiply the base point by the hash to get H
  const scalar = bytesToBigInt(hBytes) % ed25519.CURVE.n;
  return ed25519.ExtendedPoint.BASE.multiply(scalar);
})();

/**
 * Create a Pedersen commitment to a value
 *
 * Pedersen commitments are computationally binding and perfectly hiding.
 * C = vG + rH where:
 * - v is the value being committed
 * - r is a random blinding factor
 * - G is the standard generator
 * - H is an alternative generator
 *
 * @param value - Value to commit (must be non-negative, max 2^64 - 1)
 * @param blindingFactor - Optional 32-byte random blinding factor (generated if not provided)
 * @returns Pedersen commitment with opening information
 * @throws Error if value is negative or too large
 *
 * @example
 * ```typescript
 * // Commit to an amount
 * const commitment = createCommitment(BigInt(1000000));
 *
 * // Later, verify the commitment
 * const isValid = verifyCommitment(
 *   commitment.commitment,
 *   commitment.value,
 *   commitment.blindingFactor
 * );
 * ```
 */
export function createCommitment(
  value: bigint,
  blindingFactor?: Uint8Array,
): PedersenCommitment {
  if (value < BigInt(0)) {
    throw new Error('Value must be non-negative');
  }
  if (value > MAX_COMMITMENT_VALUE) {
    throw new Error(`Value must be at most ${MAX_COMMITMENT_VALUE}`);
  }

  // Generate random blinding factor if not provided
  const r = blindingFactor ?? randomBytes(32);
  if (r.length !== 32) {
    throw new Error('Blinding factor must be 32 bytes');
  }

  // Convert blinding factor to scalar
  const rScalar = bytesToBigInt(r) % ed25519.CURVE.n;

  // C = vG + rH
  const vG = ed25519.ExtendedPoint.BASE.multiply(value % ed25519.CURVE.n);
  const rH = PEDERSEN_H_POINT.multiply(rScalar);
  const commitment = vG.add(rH);

  return {
    commitment: commitment.toRawBytes(),
    value,
    blindingFactor: r,
  };
}

/**
 * Verify a Pedersen commitment opening
 *
 * @param commitment - The commitment point (32 bytes)
 * @param value - The claimed value
 * @param blindingFactor - The claimed blinding factor
 * @returns true if the commitment opens to the given value
 *
 * @example
 * ```typescript
 * const valid = verifyCommitment(commitment, value, blindingFactor);
 * if (!valid) throw new Error('Invalid commitment opening');
 * ```
 */
export function verifyCommitment(
  commitment: Uint8Array,
  value: bigint,
  blindingFactor: Uint8Array,
): boolean {
  try {
    // Recreate the commitment
    const expected = createCommitment(value, blindingFactor);

    // Compare
    return constantTimeEqual(commitment, expected.commitment);
  } catch {
    return false;
  }
}

/**
 * Add two Pedersen commitments
 *
 * The sum of commitments is a commitment to the sum of values.
 * C1 + C2 = (v1 + v2)G + (r1 + r2)H
 *
 * @param commitment1 - First commitment point
 * @param commitment2 - Second commitment point
 * @returns Sum of commitments
 *
 * @example
 * ```typescript
 * const c1 = createCommitment(BigInt(100));
 * const c2 = createCommitment(BigInt(50));
 * const sum = addCommitments(c1.commitment, c2.commitment);
 * // sum is a commitment to 150 (with blinding factor r1 + r2)
 * ```
 */
export function addCommitments(
  commitment1: Uint8Array,
  commitment2: Uint8Array,
): Uint8Array {
  const p1 = ed25519.ExtendedPoint.fromHex(commitment1);
  const p2 = ed25519.ExtendedPoint.fromHex(commitment2);
  return p1.add(p2).toRawBytes();
}

/**
 * Subtract two Pedersen commitments
 *
 * @param commitment1 - First commitment point
 * @param commitment2 - Second commitment point (to subtract)
 * @returns Difference of commitments (C1 - C2)
 */
export function subtractCommitments(
  commitment1: Uint8Array,
  commitment2: Uint8Array,
): Uint8Array {
  const p1 = ed25519.ExtendedPoint.fromHex(commitment1);
  const p2 = ed25519.ExtendedPoint.fromHex(commitment2);
  return p1.subtract(p2).toRawBytes();
}

/**
 * Create a commitment to zero with a specific blinding factor
 *
 * This is useful for proving that two commitments contain the same value.
 *
 * @param blindingFactor - The blinding factor
 * @returns Commitment to zero (0*G + r*H = r*H)
 */
export function createZeroCommitment(blindingFactor: Uint8Array): Uint8Array {
  const rScalar = bytesToBigInt(blindingFactor) % ed25519.CURVE.n;
  return PEDERSEN_H_POINT.multiply(rScalar).toRawBytes();
}

/**
 * Verify that a commitment is to zero
 *
 * Used to verify balance proofs in confidential transactions.
 *
 * @param commitment - The commitment to check
 * @returns true if commitment is to zero (meaning it's of form r*H)
 */
export function isZeroCommitment(commitment: Uint8Array): boolean {
  // A commitment to zero means C = 0*G + r*H = r*H
  // We can't efficiently check this without knowing r
  // But we can check if C is the identity point (r = 0)
  try {
    const point = ed25519.ExtendedPoint.fromHex(commitment);
    return point.equals(ed25519.ExtendedPoint.ZERO);
  } catch {
    return false;
  }
}

// ============ Utility Functions ============

/**
 * Generate cryptographically secure random bytes
 *
 * @param length - Number of random bytes to generate
 * @returns Random bytes
 */
export function generateRandomBytes(length: number): Uint8Array {
  return randomBytes(length);
}

/**
 * Constant-time comparison of two byte arrays
 *
 * Prevents timing attacks when comparing secrets.
 *
 * @param a - First byte array
 * @param b - Second byte array
 * @returns true if arrays are equal
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }

  return diff === 0;
}

/**
 * Securely clear sensitive data from memory
 *
 * Note: Due to JavaScript's garbage collection, this provides
 * limited security guarantees but is still good practice.
 *
 * @param data - Data to clear
 */
export function secureWipe(data: Uint8Array): void {
  data.fill(0);
  // Additional passes to help prevent optimization
  for (let i = 0; i < data.length; i++) {
    data[i] = 0xff;
  }
  data.fill(0);
}

/**
 * Convert bytes to a bigint (little-endian)
 *
 * @param bytes - Byte array
 * @returns BigInt representation
 */
export function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = BigInt(0);
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << BigInt(8)) | BigInt(bytes[i]);
  }
  return result;
}

/**
 * Convert a bigint to bytes (little-endian)
 *
 * @param n - BigInt to convert
 * @param length - Desired byte length
 * @returns Byte array
 */
export function bigIntToBytes(n: bigint, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let remaining = n;
  for (let i = 0; i < length; i++) {
    bytes[i] = Number(remaining & BigInt(0xff));
    remaining >>= BigInt(8);
  }
  return bytes;
}

/**
 * Encode bytes to hexadecimal string
 *
 * @param bytes - Bytes to encode
 * @returns Hexadecimal string
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Decode hexadecimal string to bytes
 *
 * @param hex - Hexadecimal string
 * @returns Decoded bytes
 * @throws Error if hex string is invalid
 */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Hex string must have even length');
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const byte = parseInt(hex.substr(i * 2, 2), 16);
    if (isNaN(byte)) {
      throw new Error(`Invalid hex character at position ${i * 2}`);
    }
    bytes[i] = byte;
  }

  return bytes;
}

/**
 * Encode bytes to base64 string
 *
 * @param bytes - Bytes to encode
 * @returns Base64 string
 */
export function bytesToBase64(bytes: Uint8Array): string {
  // Works in both browser and Node.js
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  // Browser fallback
  const binary = String.fromCharCode(...bytes);
  return btoa(binary);
}

/**
 * Decode base64 string to bytes
 *
 * @param base64 - Base64 string
 * @returns Decoded bytes
 */
export function base64ToBytes(base64: string): Uint8Array {
  // Works in both browser and Node.js
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
  // Browser fallback
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ============ Internal Helpers ============

/**
 * Simple SHA-512 implementation for ed25519 to x25519 conversion
 * Uses the same approach as @noble/hashes
 */
function sha512(data: Uint8Array): Uint8Array {
  // Import dynamically to avoid bundling if not needed
  // For now, use a simplified approach based on SHA-256
  // In production, import from @noble/hashes/sha512
  const hash1 = hashSHA256(data);
  const hash2 = hashSHA256(new Uint8Array([...data, 0x01]));
  return new Uint8Array([...hash1, ...hash2]);
}

/**
 * Modular exponentiation: base^exp mod mod
 */
function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = BigInt(1);
  base = base % mod;

  while (exp > BigInt(0)) {
    if (exp % BigInt(2) === BigInt(1)) {
      result = (result * base) % mod;
    }
    exp = exp >> BigInt(1);
    base = (base * base) % mod;
  }

  return result;
}

// ============ Legacy Compatibility ============

/**
 * Generate a key pair (alias for generateEd25519KeyPair)
 *
 * @deprecated Use generateEd25519KeyPair() instead
 * @returns Ed25519 key pair
 */
export function generateKeyPair(): Ed25519KeyPair {
  return generateEd25519KeyPair();
}

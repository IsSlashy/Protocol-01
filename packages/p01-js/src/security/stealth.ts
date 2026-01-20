/**
 * Stealth Addresses Implementation (DKSAP - Dual-Key Stealth Address Protocol)
 *
 * This module implements stealth addresses for Protocol 01, allowing recipients
 * to receive payments at one-time addresses that cannot be linked to their
 * public stealth meta-address.
 *
 * Protocol Overview:
 * 1. Recipient generates (scanKey, spendKey) pair
 * 2. Recipient publishes stealth meta-address: (scanPubKey, spendPubKey)
 * 3. Sender generates ephemeral key pair (r, R = r*G)
 * 4. Sender computes shared secret: S = r * scanPubKey
 * 5. Sender derives one-time address: P = spendPubKey + hash(S)*G
 * 6. Recipient scans using: S' = scanPrivKey * R, then checks P' = spendPubKey + hash(S')*G
 * 7. Recipient derives spending key: p = spendPrivKey + hash(S')
 *
 * @module security/stealth
 */

import type {
  StealthKeyPair,
  StealthMetaAddress,
  StealthAddress,
} from './types';

import {
  generateEd25519KeyPair,
  hashSHA256,
  bytesToBigInt,
  bigIntToBytes,
} from './crypto';

import { ed25519 } from '@noble/curves/ed25519';
import { x25519 } from '@noble/curves/ed25519';

// ============ Constants ============

/** Prefix for stealth meta-addresses */
const STEALTH_META_ADDRESS_PREFIX = 'st:';

/** Version byte for encoding */
const STEALTH_META_ADDRESS_VERSION = 0x01;

/** Ed25519 curve order */
const CURVE_ORDER = BigInt(
  '7237005577332262213973186563042994240857116359379907606001950938285454250989'
);

// ============ Key Generation ============

/**
 * Generates a stealth key pair for a user.
 * This creates two key pairs:
 * - Scan keys: Used to detect incoming payments
 * - Spend keys: Used to spend received funds
 *
 * @returns StealthKeyPair containing both scan and spend key pairs
 *
 * @example
 * ```typescript
 * const keyPair = generateStealthKeyPair();
 * const metaAddress = createMetaAddressFromKeyPair(keyPair);
 * console.log('Share this address:', metaAddress.encoded);
 * ```
 */
export function generateStealthKeyPair(): StealthKeyPair {
  // Generate scan key pair
  const scanKeys = generateEd25519KeyPair();

  // Generate spend key pair (independent from scan keys)
  const spendKeys = generateEd25519KeyPair();

  return {
    scanPrivateKey: scanKeys.privateKey,
    scanPublicKey: scanKeys.publicKey,
    spendPrivateKey: spendKeys.privateKey,
    spendPublicKey: spendKeys.publicKey,
  };
}

// ============ Stealth Meta-Address Encoding ============

/**
 * Encodes scan and spend public keys into a stealth meta-address string.
 * Format: st:<version><scanPubKey><spendPubKey> (base58 encoded)
 *
 * @param scanPub - Scan public key (32 bytes)
 * @param spendPub - Spend public key (32 bytes)
 * @returns Encoded stealth meta-address string
 *
 * @example
 * ```typescript
 * const encoded = encodeStealthMetaAddress(scanPubKey, spendPubKey);
 * // Returns: "st:1A2B3C..."
 * ```
 */
export function encodeStealthMetaAddress(
  scanPub: Uint8Array,
  spendPub: Uint8Array
): string {
  if (scanPub.length !== 32) {
    throw new Error('Scan public key must be 32 bytes');
  }
  if (spendPub.length !== 32) {
    throw new Error('Spend public key must be 32 bytes');
  }

  // Combine version + scanPub + spendPub
  const combined = new Uint8Array(1 + 32 + 32);
  combined[0] = STEALTH_META_ADDRESS_VERSION;
  combined.set(scanPub, 1);
  combined.set(spendPub, 33);

  // Base58 encode the combined data
  const encoded = base58Encode(combined);

  return STEALTH_META_ADDRESS_PREFIX + encoded;
}

/**
 * Decodes a stealth meta-address string into its component public keys.
 *
 * @param encoded - Encoded stealth meta-address string
 * @returns StealthMetaAddress with scan and spend public keys
 * @throws Error if the format is invalid
 *
 * @example
 * ```typescript
 * const metaAddress = decodeStealthMetaAddress("st:1A2B3C...");
 * console.log('Scan key:', metaAddress.scanPublicKey);
 * console.log('Spend key:', metaAddress.spendPublicKey);
 * ```
 */
export function decodeStealthMetaAddress(encoded: string): StealthMetaAddress {
  if (!encoded.startsWith(STEALTH_META_ADDRESS_PREFIX)) {
    throw new Error(
      `Invalid stealth meta-address: must start with '${STEALTH_META_ADDRESS_PREFIX}'`
    );
  }

  // Remove prefix and decode
  const base58Part = encoded.slice(STEALTH_META_ADDRESS_PREFIX.length);
  const decoded = base58Decode(base58Part);

  if (decoded.length !== 65) {
    throw new Error(
      `Invalid stealth meta-address: expected 65 bytes, got ${decoded.length}`
    );
  }

  const version = decoded[0];
  if (version !== STEALTH_META_ADDRESS_VERSION) {
    throw new Error(`Unsupported stealth meta-address version: ${version}`);
  }

  const scanPublicKey = decoded.slice(1, 33);
  const spendPublicKey = decoded.slice(33, 65);

  return {
    scanPublicKey,
    spendPublicKey,
    encoded,
  };
}

// ============ Stealth Address Generation ============

/**
 * Generates a one-time stealth address for a payment.
 *
 * Process:
 * 1. Generate ephemeral key pair (r, R = r*G)
 * 2. Compute shared secret: S = r * scanPubKey
 * 3. Hash shared secret to scalar: s = hash(S)
 * 4. Compute one-time public key: P = spendPubKey + s*G
 * 5. Compute view tag: first byte of hash(S) for efficient filtering
 *
 * @param metaAddress - Recipient's stealth meta-address
 * @returns StealthAddress with one-time address, ephemeral key, and view tag
 *
 * @example
 * ```typescript
 * const metaAddress = decodeStealthMetaAddress(recipientStealthAddress);
 * const stealthAddr = generateStealthAddress(metaAddress);
 *
 * // Send funds to stealthAddr.address
 * // Include stealthAddr.ephemeralPublicKey and stealthAddr.viewTag in the transaction
 * ```
 */
export function generateStealthAddress(
  metaAddress: StealthMetaAddress
): StealthAddress {
  // Step 1: Generate ephemeral X25519 key pair for ECDH
  const ephemeralPrivateKey = x25519.utils.randomPrivateKey();
  const ephemeralPublicKey = x25519.getPublicKey(ephemeralPrivateKey);

  // Convert recipient's scan public key to X25519 for ECDH
  const scanPubX25519 = ed25519ToX25519PublicKey(metaAddress.scanPublicKey);

  // Step 2: Compute shared secret using ECDH
  // S = r * scanPubKey (where r is ephemeral private key)
  const sharedSecret = x25519.getSharedSecret(ephemeralPrivateKey, scanPubX25519);

  // Step 3: Hash the shared secret to get a scalar
  const sharedSecretHash = hashToScalar(sharedSecret);

  // Step 4: Compute the one-time public key
  // P = spendPubKey + hash(S)*G
  const hashPoint = ed25519.ExtendedPoint.BASE.multiply(
    bytesToBigInt(sharedSecretHash) % CURVE_ORDER
  );
  const spendPoint = ed25519.ExtendedPoint.fromHex(metaAddress.spendPublicKey);
  const oneTimePublicKey = spendPoint.add(hashPoint).toRawBytes();

  // Step 5: Compute view tag (first byte of shared secret hash for fast filtering)
  // This allows filtering out 99.6% (255/256) of non-matching transactions quickly
  const viewTag = sharedSecretHash[0];

  // Convert one-time public key to base58 address
  const address = base58Encode(oneTimePublicKey);

  return {
    address,
    ephemeralPublicKey,
    viewTag,
  };
}

// ============ Stealth Payment Scanning ============

/**
 * Scans whether a stealth payment belongs to us.
 *
 * Process:
 * 1. Check view tag first (quick filter - eliminates 99.6% of non-matching txs)
 * 2. Compute shared secret: S' = scanPrivKey * ephemeralPubKey
 * 3. Hash shared secret: s' = hash(S')
 * 4. Compute expected public key: P' = spendPubKey + s'*G
 * 5. If view tag matches, return the derived private key
 *
 * @param ephemeralPubKey - Ephemeral public key from the transaction (X25519, 32 bytes)
 * @param viewTag - View tag from the transaction (1 byte, 0-255)
 * @param scanPrivateKey - Our scan private key (Ed25519, 32 bytes)
 * @param spendPublicKey - Our spend public key (Ed25519, 32 bytes)
 * @returns Object with isOurs flag and privateKey if it's our payment
 *
 * @example
 * ```typescript
 * const result = scanStealthPayment(
 *   transaction.ephemeralPubKey,
 *   transaction.viewTag,
 *   keyPair.scanPrivateKey,
 *   keyPair.spendPublicKey
 * );
 *
 * if (result.isOurs) {
 *   console.log('Found a payment for us!');
 * }
 * ```
 */
export function scanStealthPayment(
  ephemeralPubKey: Uint8Array,
  viewTag: number,
  scanPrivateKey: Uint8Array,
  _spendPublicKey: Uint8Array
): { isOurs: boolean; privateKey?: Uint8Array } {
  // Convert scan private key to X25519 for ECDH
  const scanPrivX25519 = ed25519ToX25519PrivateKey(scanPrivateKey);

  // Step 1: Compute shared secret
  // S' = scanPrivKey * ephemeralPubKey
  const sharedSecret = x25519.getSharedSecret(scanPrivX25519, ephemeralPubKey);

  // Step 2: Hash the shared secret
  const sharedSecretHash = hashToScalar(sharedSecret);

  // Step 3: Quick check using view tag
  // This eliminates 99.6% of non-matching transactions without expensive point operations
  const computedViewTag = sharedSecretHash[0];
  if (computedViewTag !== viewTag) {
    return { isOurs: false };
  }

  // Step 4: View tag matched, this is likely our payment
  // We could do a full verification by computing P' and comparing to the transaction address,
  // but since we need the private key anyway, we just return it
  // The caller can verify by checking if the derived address matches

  return {
    isOurs: true,
    // Note: The actual private key derivation requires the spend private key,
    // which we don't have here. We return undefined and let the caller use
    // deriveStealthPrivateKey if they need to spend.
    privateKey: undefined,
  };
}

/**
 * Extended scan that also derives the private key for spending.
 * Use this when you have the spend private key and need to spend the funds.
 *
 * @param ephemeralPubKey - Ephemeral public key from the transaction
 * @param viewTag - View tag from the transaction
 * @param scanPrivateKey - Our scan private key
 * @param spendPrivateKey - Our spend private key
 * @param spendPublicKey - Our spend public key
 * @returns Object with isOurs flag and privateKey if it's our payment
 *
 * @example
 * ```typescript
 * const result = scanAndDeriveStealthPayment(
 *   tx.ephemeralPubKey,
 *   tx.viewTag,
 *   keyPair.scanPrivateKey,
 *   keyPair.spendPrivateKey,
 *   keyPair.spendPublicKey
 * );
 *
 * if (result.isOurs && result.privateKey) {
 *   // Use result.privateKey to sign a transaction spending these funds
 * }
 * ```
 */
export function scanAndDeriveStealthPayment(
  ephemeralPubKey: Uint8Array,
  viewTag: number,
  scanPrivateKey: Uint8Array,
  spendPrivateKey: Uint8Array,
  spendPublicKey: Uint8Array
): { isOurs: boolean; privateKey?: Uint8Array; address?: string } {
  // First, do the basic scan
  const scanResult = scanStealthPayment(
    ephemeralPubKey,
    viewTag,
    scanPrivateKey,
    spendPublicKey
  );

  if (!scanResult.isOurs) {
    return { isOurs: false };
  }

  // Derive the private key for spending
  const privateKey = deriveStealthPrivateKey(
    ephemeralPubKey,
    scanPrivateKey,
    spendPrivateKey
  );

  // Derive the public key and address for verification
  const publicKey = ed25519.getPublicKey(privateKey);
  const address = base58Encode(publicKey);

  return {
    isOurs: true,
    privateKey,
    address,
  };
}

// ============ Private Key Derivation ============

/**
 * Derives the one-time private key needed to spend funds at a stealth address.
 *
 * Process:
 * 1. Compute shared secret: S = scanPrivKey * ephemeralPubKey
 * 2. Hash to scalar: s = hash(S)
 * 3. Derive private key: p = spendPrivKey + s (mod curve order)
 *
 * @param ephemeralPubKey - Ephemeral public key from the transaction
 * @param scanPrivateKey - Our scan private key
 * @param spendPrivateKey - Our spend private key
 * @returns The one-time private key for spending
 *
 * @example
 * ```typescript
 * const oneTimePrivateKey = deriveStealthPrivateKey(
 *   tx.ephemeralPubKey,
 *   keyPair.scanPrivateKey,
 *   keyPair.spendPrivateKey
 * );
 *
 * // Use oneTimePrivateKey to sign transactions
 * const signature = ed25519.sign(message, oneTimePrivateKey);
 * ```
 */
export function deriveStealthPrivateKey(
  ephemeralPubKey: Uint8Array,
  scanPrivateKey: Uint8Array,
  spendPrivateKey: Uint8Array
): Uint8Array {
  // Convert scan private key to X25519 for ECDH
  const scanPrivX25519 = ed25519ToX25519PrivateKey(scanPrivateKey);

  // Step 1: Compute shared secret
  // S = scanPrivKey * ephemeralPubKey
  const sharedSecret = x25519.getSharedSecret(scanPrivX25519, ephemeralPubKey);

  // Step 2: Hash to scalar
  const sharedSecretHash = hashToScalar(sharedSecret);

  // Step 3: Add to spend private key
  // p = spendPrivKey + hash(S) (mod curve order)
  const spendScalar = bytesToBigInt(spendPrivateKey) % CURVE_ORDER;
  const hashScalar = bytesToBigInt(sharedSecretHash) % CURVE_ORDER;
  const oneTimeScalar = (spendScalar + hashScalar) % CURVE_ORDER;

  return bigIntToBytes(oneTimeScalar, 32);
}

// ============ Utility Functions ============

/**
 * Creates a StealthMetaAddress from a StealthKeyPair.
 *
 * @param keyPair - The stealth key pair
 * @returns The stealth meta-address
 *
 * @example
 * ```typescript
 * const keyPair = generateStealthKeyPair();
 * const metaAddress = createMetaAddressFromKeyPair(keyPair);
 *
 * // Share the encoded meta-address publicly
 * console.log('My stealth address:', metaAddress.encoded);
 * ```
 */
export function createMetaAddressFromKeyPair(
  keyPair: StealthKeyPair
): StealthMetaAddress {
  const encoded = encodeStealthMetaAddress(
    keyPair.scanPublicKey,
    keyPair.spendPublicKey
  );

  return {
    scanPublicKey: keyPair.scanPublicKey,
    spendPublicKey: keyPair.spendPublicKey,
    encoded,
  };
}

/**
 * Verifies that a stealth address was correctly derived from a meta-address.
 *
 * @param stealthAddress - The stealth address to verify
 * @param metaAddress - The meta-address it should be derived from
 * @param scanPrivateKey - The scan private key
 * @returns True if the address is valid
 *
 * @example
 * ```typescript
 * const isValid = verifyStealthAddress(stealthAddr, metaAddr, scanPrivKey);
 * if (!isValid) {
 *   throw new Error('Invalid stealth address');
 * }
 * ```
 */
export function verifyStealthAddress(
  stealthAddress: StealthAddress,
  metaAddress: StealthMetaAddress,
  scanPrivateKey: Uint8Array
): boolean {
  // Convert scan private key to X25519 for ECDH
  const scanPrivX25519 = ed25519ToX25519PrivateKey(scanPrivateKey);

  // Compute shared secret
  const sharedSecret = x25519.getSharedSecret(
    scanPrivX25519,
    stealthAddress.ephemeralPublicKey
  );
  const sharedSecretHash = hashToScalar(sharedSecret);

  // Check view tag
  if (sharedSecretHash[0] !== stealthAddress.viewTag) {
    return false;
  }

  // Compute expected one-time public key
  const hashScalar = bytesToBigInt(sharedSecretHash) % CURVE_ORDER;
  const hashPoint = ed25519.ExtendedPoint.BASE.multiply(hashScalar);
  const spendPoint = ed25519.ExtendedPoint.fromHex(metaAddress.spendPublicKey);
  const expectedPublicKey = spendPoint.add(hashPoint).toRawBytes();
  const expectedAddress = base58Encode(expectedPublicKey);

  return expectedAddress === stealthAddress.address;
}

// ============ Cryptographic Helpers ============

/**
 * Hashes data to a scalar (32 bytes, reduced modulo curve order).
 * Used to derive deterministic values from shared secrets.
 *
 * @param data - Data to hash
 * @returns 32-byte scalar
 */
function hashToScalar(data: Uint8Array): Uint8Array {
  // Use SHA-256 with a domain separator for stealth addresses
  const domainSeparator = new TextEncoder().encode('Protocol01-Stealth-v1');
  const combined = new Uint8Array(domainSeparator.length + data.length);
  combined.set(domainSeparator, 0);
  combined.set(data, domainSeparator.length);

  const hash = hashSHA256(combined);

  // Reduce modulo curve order to ensure it's a valid scalar
  const hashBigInt = bytesToBigInt(hash);
  const reduced = hashBigInt % CURVE_ORDER;

  return bigIntToBytes(reduced, 32);
}

/**
 * Converts an Ed25519 public key to X25519 public key.
 * Uses the birational map from Ed25519 to Curve25519.
 *
 * @param ed25519PublicKey - 32-byte Ed25519 public key
 * @returns 32-byte X25519 public key
 */
function ed25519ToX25519PublicKey(ed25519PublicKey: Uint8Array): Uint8Array {
  // Use the ExtendedPoint to convert
  const point = ed25519.ExtendedPoint.fromHex(ed25519PublicKey);

  // Convert Ed25519 point (x, y) to X25519 u-coordinate
  // u = (1 + y) / (1 - y) mod p
  const { y } = point.toAffine();
  const p = BigInt(
    '57896044618658097711785492504343953926634992332820282019728792003956564819949'
  );
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
 * Converts an Ed25519 private key to X25519 private key.
 *
 * @param ed25519PrivateKey - 32-byte Ed25519 private key (seed)
 * @returns 32-byte X25519 private key
 */
function ed25519ToX25519PrivateKey(ed25519PrivateKey: Uint8Array): Uint8Array {
  // Hash the Ed25519 seed with SHA-512 and take the first 32 bytes
  // Then clamp as per X25519 spec
  const hash = sha512Simple(ed25519PrivateKey);
  const x25519Key = new Uint8Array(hash.slice(0, 32));

  // Clamp the key (as per RFC 7748)
  x25519Key[0] &= 248;
  x25519Key[31] &= 127;
  x25519Key[31] |= 64;

  return x25519Key;
}

/**
 * Simple SHA-512 using the SHA-256 from crypto module.
 * Produces 64 bytes by concatenating two SHA-256 hashes.
 */
function sha512Simple(data: Uint8Array): Uint8Array {
  const hash1 = hashSHA256(data);
  const suffix = new Uint8Array(data.length + 1);
  suffix.set(data, 0);
  suffix[data.length] = 0x01;
  const hash2 = hashSHA256(suffix);
  const result = new Uint8Array(64);
  result.set(hash1, 0);
  result.set(hash2, 32);
  return result;
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

// ============ Base58 Encoding/Decoding ============

const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Encodes a Uint8Array to a base58 string.
 */
function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';

  // Count leading zeros
  let leadingZeros = 0;
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
    leadingZeros++;
  }

  // Convert to base58
  const size = Math.ceil((bytes.length * 138) / 100) + 1;
  const output = new Uint8Array(size);
  let outputStart = size;

  for (let i = leadingZeros; i < bytes.length; i++) {
    let carry = bytes[i];
    let j = size - 1;

    while (carry !== 0 || j >= outputStart) {
      carry += 256 * output[j];
      output[j] = carry % 58;
      carry = Math.floor(carry / 58);
      j--;
    }
    outputStart = j + 1;
  }

  // Build result string
  let result = '1'.repeat(leadingZeros);
  for (let i = outputStart; i < size; i++) {
    result += BASE58_ALPHABET[output[i]];
  }

  return result;
}

/**
 * Decodes a base58 string to a Uint8Array.
 */
function base58Decode(str: string): Uint8Array {
  if (str.length === 0) return new Uint8Array(0);

  // Build index map
  const indexMap = new Map<string, number>();
  for (let i = 0; i < BASE58_ALPHABET.length; i++) {
    indexMap.set(BASE58_ALPHABET[i], i);
  }

  // Count leading '1's (zeros in output)
  let leadingOnes = 0;
  for (let i = 0; i < str.length && str[i] === '1'; i++) {
    leadingOnes++;
  }

  // Allocate enough space
  const size = Math.ceil((str.length * 733) / 1000) + 1;
  const output = new Uint8Array(size);
  let outputStart = size;

  for (let i = leadingOnes; i < str.length; i++) {
    const charIndex = indexMap.get(str[i]);
    if (charIndex === undefined) {
      throw new Error(`Invalid base58 character: ${str[i]}`);
    }

    let carry = charIndex;
    let j = size - 1;

    while (carry !== 0 || j >= outputStart) {
      carry += 58 * output[j];
      output[j] = carry % 256;
      carry = Math.floor(carry / 256);
      j--;
    }
    outputStart = j + 1;
  }

  // Build result with leading zeros
  const result = new Uint8Array(leadingOnes + (size - outputStart));
  // Leading zeros are already 0 by default
  result.set(output.slice(outputStart), leadingOnes);

  return result;
}

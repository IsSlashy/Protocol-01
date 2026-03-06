/**
 * Stealth address utilities for Protocol 01
 *
 * v1: X25519 ECDH for shared secret derivation
 * v2: Hybrid X25519 + ML-KEM-768 (FIPS 203) for post-quantum resistance
 */

import { Keypair, PublicKey } from '@solana/web3.js';
import * as Crypto from 'expo-crypto';
import nacl from 'tweetnacl';
import { ml_kem768 } from '@noble/post-quantum/ml-kem';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';

// ============= ECDH-like Shared Secret =============
// Uses nacl.box which internally does X25519 ECDH

/**
 * Generate an X25519 keypair for ECDH
 */
function generateX25519Keypair(): { publicKey: Uint8Array; secretKey: Uint8Array } {
  return nacl.box.keyPair();
}

/**
 * Convert Ed25519 seed to X25519 keypair
 * The seed is hashed to derive X25519 keys deterministically
 */
function seedToX25519Keypair(seed: Uint8Array): { publicKey: Uint8Array; secretKey: Uint8Array } {
  // Use the seed to derive an X25519 keypair deterministically
  // Hash the seed to get 32 bytes for X25519 secret key
  const hash = nacl.hash(seed);
  const secretKey = hash.slice(0, 32);
  // Derive public key from secret key
  return nacl.box.keyPair.fromSecretKey(secretKey);
}

/**
 * Compute X25519 shared secret using nacl.box
 */
function computeX25519SharedSecret(mySecretKey: Uint8Array, theirPublicKey: Uint8Array): Uint8Array {
  // nacl.box.before computes the shared secret
  return nacl.box.before(theirPublicKey, mySecretKey);
}

// ============= ML-KEM-768 Hybrid =============

/** HKDF info string for hybrid shared secret derivation (matches extension + specter-sdk) */
const HYBRID_HKDF_INFO = 'p01-hybrid-stealth-v2';

/** ML-KEM-768 sizes (FIPS 203) */
const KEM_PUBLIC_KEY_SIZE = 1184;
const KEM_SECRET_KEY_SIZE = 2400;
const KEM_CIPHERTEXT_SIZE = 1088;

/** Meta-address version prefixes */
const META_ADDRESS_PREFIX = 'st:';
const META_ADDRESS_VERSION_V1 = '01';
const META_ADDRESS_VERSION_V2 = '02';

function kemGenerateKeypair(): { publicKey: Uint8Array; secretKey: Uint8Array } {
  return ml_kem768.keygen();
}

function kemEncapsulate(kemPubKey: Uint8Array): { cipherText: Uint8Array; sharedSecret: Uint8Array } {
  return ml_kem768.encapsulate(kemPubKey);
}

function kemDecapsulate(cipherText: Uint8Array, kemSecretKey: Uint8Array): Uint8Array {
  return ml_kem768.decapsulate(cipherText, kemSecretKey);
}

/**
 * Combine classical ECDH + post-quantum KEM secrets via HKDF.
 * Security holds if EITHER the classical or post-quantum scheme is secure.
 */
function deriveHybridSharedSecret(
  classicSecret: Uint8Array,
  kemSecret: Uint8Array,
): Uint8Array {
  const combined = new Uint8Array(classicSecret.length + kemSecret.length);
  combined.set(classicSecret);
  combined.set(kemSecret, classicSecret.length);
  return hkdf(sha256, combined, undefined, HYBRID_HKDF_INFO, 32);
}

export interface StealthKeys {
  spendingKey: Keypair;
  viewingKey: Keypair;
  spendingPublicKey: string;
  viewingPublicKey: string;
  /** ML-KEM-768 public key (1184 bytes, v2 hybrid only) */
  kemPubKey?: Uint8Array;
  /** ML-KEM-768 secret key (2400 bytes, v2 hybrid only) */
  kemSecretKey?: Uint8Array;
}

export interface StealthAddress {
  address: string;
  ephemeralPublicKey: string;
  viewTag: string;
  /** ML-KEM-768 ciphertext (1088 bytes, v2 hybrid only) */
  kemCiphertext?: Uint8Array;
}

export interface StealthMeta {
  stealthAddress: string;
  ephemeralPublicKey: string;
  viewTag: string;
  timestamp: number;
}

export interface StealthScanResult {
  found: boolean;
  stealthAddress?: string;
  privateKey?: Uint8Array;
}

export interface StealthError {
  code: 'INVALID_KEY' | 'DERIVATION_FAILED' | 'SCAN_FAILED' | 'INVALID_ADDRESS';
  message: string;
}

/**
 * Generate a Keypair using expo-crypto for randomness
 * This avoids the crypto.getRandomValues issue in React Native
 */
async function generateKeypairSecure(): Promise<Keypair> {
  // Generate 32 random bytes using expo-crypto
  const randomBytes = await Crypto.getRandomBytesAsync(32);
  // Create keypair from seed
  return Keypair.fromSeed(randomBytes);
}

/**
 * Generate stealth key pair (spending and viewing keys).
 * If enableHybrid is true, also generates ML-KEM-768 keys for v2 post-quantum resistance.
 */
export async function generateStealthKeys(enableHybrid: boolean = true): Promise<StealthKeys> {
  const spendingKey = await generateKeypairSecure();
  const viewingKey = await generateKeypairSecure();

  const keys: StealthKeys = {
    spendingKey,
    viewingKey,
    spendingPublicKey: spendingKey.publicKey.toBase58(),
    viewingPublicKey: viewingKey.publicKey.toBase58(),
  };

  if (enableHybrid) {
    const kem = kemGenerateKeypair();
    keys.kemPubKey = kem.publicKey;
    keys.kemSecretKey = kem.secretKey;
  }

  return keys;
}

/**
 * Generate stealth address for a recipient.
 * Automatically uses hybrid mode (X25519 + ML-KEM-768) if recipientKemPubKey is provided.
 *
 * @param recipientSpendingPubKey - Recipient's Ed25519 spending public key (base58)
 * @param recipientViewingPubKey - Recipient's Ed25519 viewing public key (base58)
 * @param recipientViewingX25519Pub - Optional: Recipient's X25519 viewing public key (32 bytes)
 * @param recipientKemPubKey - Optional: Recipient's ML-KEM-768 public key (1184 bytes, v2 hybrid)
 */
export async function generateStealthAddress(
  recipientSpendingPubKey: string,
  recipientViewingPubKey: string,
  recipientViewingX25519Pub?: Uint8Array,
  recipientKemPubKey?: Uint8Array,
): Promise<StealthAddress> {
  try {
    // Generate ephemeral X25519 keypair for ECDH
    const ephemeralX25519 = generateX25519Keypair();

    // Get recipient's X25519 viewing public key
    let recipientX25519Public: Uint8Array;
    if (recipientViewingX25519Pub && recipientViewingX25519Pub.length === 32) {
      recipientX25519Public = recipientViewingX25519Pub;
    } else {
      const viewingPubBytes = new PublicKey(recipientViewingPubKey).toBytes();
      const recipientX25519Keypair = seedToX25519Keypair(viewingPubBytes);
      recipientX25519Public = recipientX25519Keypair.publicKey;
    }

    // Compute classical shared secret using X25519 ECDH
    const classicSecret = computeX25519SharedSecret(
      ephemeralX25519.secretKey,
      recipientX25519Public
    );

    let sharedSecret: Uint8Array;
    let kemCiphertext: Uint8Array | undefined;

    if (recipientKemPubKey && recipientKemPubKey.length === KEM_PUBLIC_KEY_SIZE) {
      // Hybrid mode: X25519 + ML-KEM-768
      const kem = kemEncapsulate(recipientKemPubKey);
      kemCiphertext = kem.cipherText;
      sharedSecret = deriveHybridSharedSecret(classicSecret, kem.sharedSecret);
    } else {
      // Classic mode: ECDH only
      sharedSecret = classicSecret;
    }

    // Derive stealth address using spending key + shared secret
    const stealthPubKey = await deriveStealthPublicKey(
      recipientSpendingPubKey,
      sharedSecret
    );

    // Generate view tag for efficient scanning
    const viewTag = await generateViewTag(sharedSecret);

    // Store ephemeral X25519 public key for recipient to compute shared secret
    const ephemeralPubKeyBase64 = Buffer.from(ephemeralX25519.publicKey).toString('base64');

    return {
      address: stealthPubKey,
      ephemeralPublicKey: ephemeralPubKeyBase64,
      viewTag,
      kemCiphertext,
    };
  } catch (error) {
    console.error('[Stealth] Generate error:', error);
    throw createStealthError('DERIVATION_FAILED', 'Failed to generate stealth address');
  }
}

/**
 * Scan for incoming stealth payments.
 * Supports v2 hybrid mode when kemCiphertext + kemSecretKey are provided.
 *
 * IMPORTANT: viewingPrivateKey must be the same seed used in getStealthKeys()
 * The X25519 private key is derived as: nacl.hash(viewingPrivateKey).slice(0, 32)
 */
export async function scanStealthPayment(
  ephemeralPublicKey: string,
  viewingPrivateKey: Uint8Array,
  spendingPrivateKey: Uint8Array,
  expectedViewTag?: string,
  kemCiphertext?: Uint8Array,
  kemSecretKey?: Uint8Array,
): Promise<StealthScanResult> {
  try {
    // Decode ephemeral X25519 public key (base64 encoded)
    let ephemeralX25519Public: Uint8Array;
    try {
      const decoded = Buffer.from(ephemeralPublicKey, 'base64');
      if (decoded.length === 32) {
        ephemeralX25519Public = new Uint8Array(decoded);
      } else {
        throw new Error('Invalid length');
      }
    } catch {
      try {
        const ephemeralPubBytes = new PublicKey(ephemeralPublicKey).toBytes();
        const ephemeralX25519 = seedToX25519Keypair(ephemeralPubBytes);
        ephemeralX25519Public = ephemeralX25519.publicKey;
      } catch {
        console.error('[Stealth] Failed to decode ephemeral public key');
        return { found: false };
      }
    }

    // Convert viewing private key to X25519 format
    const viewingSeed = viewingPrivateKey.slice(0, 32);
    const viewingX25519Secret = nacl.hash(viewingSeed).slice(0, 32);
    const viewingX25519Keypair = nacl.box.keyPair.fromSecretKey(viewingX25519Secret);

    // Compute classical shared secret using X25519 ECDH
    const classicSecret = computeX25519SharedSecret(
      viewingX25519Keypair.secretKey,
      ephemeralX25519Public
    );

    let sharedSecret: Uint8Array;

    if (kemCiphertext && kemSecretKey && kemCiphertext.length === KEM_CIPHERTEXT_SIZE) {
      // Hybrid mode: decapsulate KEM + combine with ECDH
      const kemSharedSecret = kemDecapsulate(kemCiphertext, kemSecretKey);
      sharedSecret = deriveHybridSharedSecret(classicSecret, kemSharedSecret);
    } else {
      sharedSecret = classicSecret;
    }

    // Check view tag for quick rejection
    if (expectedViewTag) {
      const computedViewTag = await generateViewTag(sharedSecret);
      if (computedViewTag !== expectedViewTag) {
        return { found: false };
      }
    }

    // Derive the stealth private key
    const stealthPrivateKey = await deriveStealthPrivateKey(
      spendingPrivateKey,
      sharedSecret
    );

    // Derive the corresponding keypair
    const stealthKeypair = Keypair.fromSeed(stealthPrivateKey);

    return {
      found: true,
      stealthAddress: stealthKeypair.publicKey.toBase58(),
      privateKey: stealthKeypair.secretKey,
    };
  } catch (error) {
    console.error('[Stealth] Scan error:', error);
    return { found: false };
  }
}

// Note: computeSharedSecret removed - now using X25519 ECDH via computeX25519SharedSecret

/**
 * Derive stealth public key from recipient's spending key and shared secret
 */
async function deriveStealthPublicKey(
  spendingPubKeyBase58: string,
  sharedSecret: Uint8Array
): Promise<string> {
  const spendingPubBytes = new PublicKey(spendingPubKeyBase58).toBytes();

  // Hash shared secret to get derivation factor
  const derivationHashHex = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    Buffer.from(sharedSecret).toString('hex')
  );
  const derivationBytes = hexToBytes(derivationHashHex);

  // Create deterministic keypair from derivation
  const derivedKeypair = Keypair.fromSeed(derivationBytes);

  // In a real implementation, we would do point addition
  // For now, we use a hash-based approach
  const combined = new Uint8Array(64);
  combined.set(spendingPubBytes);
  combined.set(derivationBytes);

  const stealthHashHex = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    Buffer.from(combined).toString('hex')
  );
  const stealthSeed = hexToBytes(stealthHashHex);

  const stealthKeypair = Keypair.fromSeed(stealthSeed);
  return stealthKeypair.publicKey.toBase58();
}

/**
 * Derive stealth private key for spending
 */
async function deriveStealthPrivateKey(
  spendingPrivateKey: Uint8Array,
  sharedSecret: Uint8Array
): Promise<Uint8Array> {
  // Hash shared secret to get derivation factor
  const derivationHashHex = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    Buffer.from(sharedSecret).toString('hex')
  );
  const derivationBytes = hexToBytes(derivationHashHex);

  // Combine spending key seed with derivation
  const spendingSeed = spendingPrivateKey.slice(0, 32);
  const combined = new Uint8Array(64);
  combined.set(spendingSeed);
  combined.set(derivationBytes);

  // Hash to get stealth private key seed
  const stealthHashHex = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    Buffer.from(combined).toString('hex')
  );

  return hexToBytes(stealthHashHex);
}

/**
 * Generate view tag for efficient scanning
 */
async function generateViewTag(sharedSecret: Uint8Array): Promise<string> {
  const hashHex = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    Buffer.from(sharedSecret).toString('hex') + 'view_tag'
  );

  // Return first 2 bytes (4 hex chars) as view tag
  return hashHex.slice(0, 4);
}

/**
 * Create stealth meta announcement data
 */
export function createStealthMeta(
  stealthAddress: StealthAddress
): StealthMeta {
  return {
    stealthAddress: stealthAddress.address,
    ephemeralPublicKey: stealthAddress.ephemeralPublicKey,
    viewTag: stealthAddress.viewTag,
    timestamp: Date.now(),
  };
}

/**
 * Encode stealth meta for on-chain storage
 */
export function encodeStealthMeta(meta: StealthMeta): string {
  return JSON.stringify(meta);
}

/**
 * Decode stealth meta from on-chain data
 */
export function decodeStealthMeta(encoded: string): StealthMeta {
  try {
    return JSON.parse(encoded) as StealthMeta;
  } catch {
    throw createStealthError('INVALID_ADDRESS', 'Invalid stealth meta data');
  }
}

/**
 * Validate stealth address format
 */
export function isValidStealthAddress(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate stealth address registry key
 */
export async function generateRegistryKey(
  spendingPubKey: string,
  viewingPubKey: string
): Promise<string> {
  const combined = spendingPubKey + viewingPubKey;
  const hash = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    combined
  );
  return hash.slice(0, 16);
}

// ============= Meta-Address v2 =============

/**
 * Create a publishable meta-address from stealth keys.
 * v1: st:01<base64(spending_x25519_pub(32) + viewing_x25519_pub(32))>
 * v2: st:02<base64(spending_x25519_pub(32) + viewing_x25519_pub(32) + kem_pub(1184))>
 */
export function createMetaAddress(keys: StealthKeys): string {
  const spendingBytes = keys.spendingKey.publicKey.toBytes();
  const viewingBytes = keys.viewingKey.publicKey.toBytes();

  if (keys.kemPubKey && keys.kemPubKey.length === KEM_PUBLIC_KEY_SIZE) {
    // v2: 32 + 32 + 1184 = 1248 bytes
    const combined = new Uint8Array(1248);
    combined.set(spendingBytes, 0);
    combined.set(viewingBytes, 32);
    combined.set(keys.kemPubKey, 64);
    return `${META_ADDRESS_PREFIX}${META_ADDRESS_VERSION_V2}${Buffer.from(combined).toString('base64')}`;
  }

  // v1: 32 + 32 = 64 bytes
  const combined = new Uint8Array(64);
  combined.set(spendingBytes, 0);
  combined.set(viewingBytes, 32);
  return `${META_ADDRESS_PREFIX}${META_ADDRESS_VERSION_V1}${Buffer.from(combined).toString('base64')}`;
}

export interface ParsedMetaAddress {
  spendingPubKey: Uint8Array;
  viewingPubKey: Uint8Array;
  kemPubKey?: Uint8Array;
}

/**
 * Parse a meta-address to extract public keys (v1 or v2).
 */
export function parseMetaAddress(metaAddress: string): ParsedMetaAddress {
  if (!metaAddress.startsWith(META_ADDRESS_PREFIX)) {
    throw createStealthError('INVALID_ADDRESS', 'Invalid meta-address: missing prefix');
  }

  const withoutPrefix = metaAddress.slice(META_ADDRESS_PREFIX.length);

  if (withoutPrefix.startsWith(META_ADDRESS_VERSION_V2)) {
    const encoded = withoutPrefix.slice(META_ADDRESS_VERSION_V2.length);
    const combined = new Uint8Array(Buffer.from(encoded, 'base64'));
    if (combined.length !== 1248) {
      throw createStealthError('INVALID_ADDRESS', `Invalid v2 meta-address: expected 1248 bytes, got ${combined.length}`);
    }
    return {
      spendingPubKey: combined.slice(0, 32),
      viewingPubKey: combined.slice(32, 64),
      kemPubKey: combined.slice(64, 64 + KEM_PUBLIC_KEY_SIZE),
    };
  }

  if (withoutPrefix.startsWith(META_ADDRESS_VERSION_V1)) {
    const encoded = withoutPrefix.slice(META_ADDRESS_VERSION_V1.length);
    const combined = new Uint8Array(Buffer.from(encoded, 'base64'));
    if (combined.length !== 64) {
      throw createStealthError('INVALID_ADDRESS', `Invalid v1 meta-address: expected 64 bytes, got ${combined.length}`);
    }
    return {
      spendingPubKey: combined.slice(0, 32),
      viewingPubKey: combined.slice(32, 64),
    };
  }

  throw createStealthError('INVALID_ADDRESS', 'Invalid meta-address version');
}

/**
 * Check if a string is a valid meta-address (v1 or v2).
 */
export function isMetaAddress(address: string): boolean {
  try {
    parseMetaAddress(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a stealth memo for on-chain announcement.
 * v1: "P01:STEALTH:<ephemeral_base64>"
 * v2: "P01:STEALTH:V2:<ephemeral_base64>:<kem_ciphertext_base64>"
 */
export function createStealthMemo(
  ephemeralPublicKey: string,
  kemCiphertext?: Uint8Array,
): string {
  if (kemCiphertext) {
    const kemBase64 = Buffer.from(kemCiphertext).toString('base64');
    return `P01:STEALTH:V2:${ephemeralPublicKey}:${kemBase64}`;
  }
  return `P01:STEALTH:${ephemeralPublicKey}`;
}

/**
 * Parse a stealth memo (v1 or v2).
 */
export function parseStealthMemo(memo: string): {
  ephemeralPublicKey: string;
  kemCiphertext?: Uint8Array;
} | null {
  const v2Prefix = 'P01:STEALTH:V2:';
  if (memo.startsWith(v2Prefix)) {
    const rest = memo.slice(v2Prefix.length);
    const colonIdx = rest.indexOf(':');
    if (colonIdx === -1) return null;
    const kemBytes = new Uint8Array(Buffer.from(rest.slice(colonIdx + 1), 'base64'));
    if (kemBytes.length !== KEM_CIPHERTEXT_SIZE) return null;
    return {
      ephemeralPublicKey: rest.slice(0, colonIdx),
      kemCiphertext: kemBytes,
    };
  }

  const v1Prefix = 'P01:STEALTH:';
  if (memo.startsWith(v1Prefix)) {
    return { ephemeralPublicKey: memo.slice(v1Prefix.length) };
  }

  return null;
}

// Helper functions

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function createStealthError(
  code: StealthError['code'],
  message: string
): StealthError {
  return { code, message };
}

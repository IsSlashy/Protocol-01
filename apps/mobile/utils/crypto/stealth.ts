/**
 * Stealth address utilities for Protocol 01
 *
 * Protocol (aligned with specter-sdk):
 * - Spending key: Ed25519 (Solana Keypair) for on-chain addresses
 * - Viewing key: X25519 for ECDH key exchange
 * - Ephemeral key: X25519 (nacl.box.keyPair)
 * - ECDH: nacl.scalarMult (raw X25519)
 * - Stealth seed: hkdf(sha256, sharedSecret, spendingPubKey, 'p01-stealth-seed', 32)
 * - View tag: sha256(sharedSecret)[0] (single byte, 0-255)
 *
 * v1: X25519 ECDH only
 * v2: Hybrid X25519 + ML-KEM-768 (FIPS 203) for post-quantum resistance
 */

import { Keypair, PublicKey } from '@solana/web3.js';
import * as Crypto from 'expo-crypto';
import nacl from 'tweetnacl';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import bs58 from 'bs58';

// ============= Constants =============

const STEALTH_SEED_INFO = 'p01-stealth-seed';
const HYBRID_HKDF_INFO = 'p01-hybrid-stealth-v2';
const KEM_PUBLIC_KEY_SIZE = 1184;
const KEM_CIPHERTEXT_SIZE = 1088;
const META_ADDRESS_PREFIX = 'st:';
const META_ADDRESS_VERSION_V1 = '01';
const META_ADDRESS_VERSION_V2 = '02';

// ============= Core Crypto =============

/**
 * Raw X25519 ECDH shared secret (matching specter-sdk's deriveSharedSecret).
 */
function deriveSharedSecret(mySecretKey: Uint8Array, theirPublicKey: Uint8Array): Uint8Array {
  return nacl.scalarMult(mySecretKey, theirPublicKey);
}

/**
 * HKDF-based stealth seed (matching specter-sdk's deriveStealthSeed).
 * Both sender and recipient derive the same seed, producing matching keypairs.
 */
function deriveStealthSeed(spendingPubKey: Uint8Array, sharedSecret: Uint8Array): Uint8Array {
  return hkdf(sha256, sharedSecret, spendingPubKey, STEALTH_SEED_INFO, 32);
}

/**
 * View tag: first byte of sha256(sharedSecret) (matching specter-sdk's computeViewTag).
 */
function computeViewTag(sharedSecret: Uint8Array): number {
  return sha256(sharedSecret)[0]!;
}

// ============= ML-KEM-768 Hybrid =============

function kemGenerateKeypair() { return ml_kem768.keygen(); }
function kemEncapsulate(pub: Uint8Array) { return ml_kem768.encapsulate(pub); }
function kemDecapsulate(ct: Uint8Array, sk: Uint8Array) { return ml_kem768.decapsulate(ct, sk); }

/**
 * Combine X25519 + ML-KEM-768 secrets via HKDF.
 * Security holds if EITHER scheme is secure.
 */
function deriveHybridSharedSecret(classicSecret: Uint8Array, kemSecret: Uint8Array): Uint8Array {
  const combined = new Uint8Array(classicSecret.length + kemSecret.length);
  combined.set(classicSecret);
  combined.set(kemSecret, classicSecret.length);
  return hkdf(sha256, combined, undefined, HYBRID_HKDF_INFO, 32);
}

// ============= Types =============

export interface StealthKeys {
  spendingKey: Keypair;
  /** X25519 viewing secret key (32 bytes) */
  viewingSecretKey: Uint8Array;
  /** X25519 viewing public key (32 bytes) */
  viewingPublicKey: Uint8Array;
  spendingPublicKey: string;
  kemPubKey?: Uint8Array;
  kemSecretKey?: Uint8Array;
}

export interface StealthAddress {
  address: string;
  ephemeralPublicKey: string;
  /** Single-byte view tag (0-255) */
  viewTag: number;
  kemCiphertext?: Uint8Array;
}

export interface StealthMeta {
  stealthAddress: string;
  ephemeralPublicKey: string;
  viewTag: number;
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

// ============= Key Generation =============

/**
 * Generate stealth keys: Ed25519 spending + X25519 viewing + optional ML-KEM-768.
 */
export async function generateStealthKeys(enableHybrid: boolean = true): Promise<StealthKeys> {
  const spendingSeed = await Crypto.getRandomBytesAsync(32);
  const spendingKey = Keypair.fromSeed(spendingSeed);

  const viewingSeed = await Crypto.getRandomBytesAsync(32);
  const viewingKeypair = nacl.box.keyPair.fromSecretKey(viewingSeed);

  const keys: StealthKeys = {
    spendingKey,
    viewingSecretKey: viewingKeypair.secretKey,
    viewingPublicKey: viewingKeypair.publicKey,
    spendingPublicKey: spendingKey.publicKey.toBase58(),
  };

  if (enableHybrid) {
    const kem = kemGenerateKeypair();
    keys.kemPubKey = kem.publicKey;
    keys.kemSecretKey = kem.secretKey;
  }

  return keys;
}

// ============= Stealth Address Generation =============

/**
 * Generate a one-time stealth address for a recipient.
 * Uses X25519 ECDH + HKDF seed derivation matching specter-sdk protocol.
 *
 * @param recipientSpendingPub - Ed25519 spending public key (32 bytes)
 * @param recipientViewingPub - X25519 viewing public key (32 bytes)
 * @param recipientKemPubKey - ML-KEM-768 public key (1184 bytes, v2 hybrid)
 */
export function generateStealthAddress(
  recipientSpendingPub: Uint8Array,
  recipientViewingPub: Uint8Array,
  recipientKemPubKey?: Uint8Array,
): StealthAddress {
  try {
    const ephemeral = nacl.box.keyPair();

    // X25519 ECDH: s = scalarMult(r, V)
    const classicSecret = deriveSharedSecret(ephemeral.secretKey, recipientViewingPub);

    let sharedSecret: Uint8Array;
    let kemCiphertext: Uint8Array | undefined;

    if (recipientKemPubKey && recipientKemPubKey.length === KEM_PUBLIC_KEY_SIZE) {
      const kem = kemEncapsulate(recipientKemPubKey);
      kemCiphertext = kem.cipherText;
      sharedSecret = deriveHybridSharedSecret(classicSecret, kem.sharedSecret);
    } else {
      sharedSecret = classicSecret;
    }

    // HKDF-based stealth seed → Ed25519 keypair
    const stealthSeed = deriveStealthSeed(recipientSpendingPub, sharedSecret);
    const stealthKeypair = nacl.sign.keyPair.fromSeed(stealthSeed);

    return {
      address: new PublicKey(stealthKeypair.publicKey).toBase58(),
      ephemeralPublicKey: bs58.encode(ephemeral.publicKey),
      viewTag: computeViewTag(sharedSecret),
      kemCiphertext,
    };
  } catch (error) {
    console.error('[Stealth] Generate error:', error);
    throw createStealthError('DERIVATION_FAILED', 'Failed to generate stealth address');
  }
}

// ============= Scanning =============

/**
 * Scan for an incoming stealth payment.
 *
 * @param ephemeralPublicKey - Sender's ephemeral X25519 public key (base58)
 * @param viewingSecretKey - Recipient's X25519 viewing secret key (32 bytes)
 * @param spendingPubKey - Recipient's Ed25519 spending public key (32 bytes)
 * @param expectedViewTag - View tag for quick rejection (0-255)
 * @param kemCiphertext - ML-KEM-768 ciphertext (1088 bytes, v2)
 * @param kemSecretKey - ML-KEM-768 secret key (2400 bytes, v2)
 */
export function scanStealthPayment(
  ephemeralPublicKey: string,
  viewingSecretKey: Uint8Array,
  spendingPubKey: Uint8Array,
  expectedViewTag?: number,
  kemCiphertext?: Uint8Array,
  kemSecretKey?: Uint8Array,
): StealthScanResult {
  try {
    // Decode ephemeral key (base58, with base64 fallback for old memos)
    let ephemeralPub: Uint8Array;
    try {
      const decoded = bs58.decode(ephemeralPublicKey);
      if (decoded.length !== 32) throw new Error('Invalid length');
      ephemeralPub = new Uint8Array(decoded);
    } catch {
      try {
        const decoded = Buffer.from(ephemeralPublicKey, 'base64');
        if (decoded.length !== 32) throw new Error('Invalid length');
        ephemeralPub = new Uint8Array(decoded);
      } catch {
        return { found: false };
      }
    }

    // X25519 ECDH: s = scalarMult(v, R)
    const classicSecret = deriveSharedSecret(viewingSecretKey, ephemeralPub);

    let sharedSecret: Uint8Array;
    if (kemCiphertext && kemSecretKey && kemCiphertext.length === KEM_CIPHERTEXT_SIZE) {
      sharedSecret = deriveHybridSharedSecret(
        classicSecret,
        kemDecapsulate(kemCiphertext, kemSecretKey),
      );
    } else {
      sharedSecret = classicSecret;
    }

    // Quick rejection via view tag
    if (expectedViewTag !== undefined && computeViewTag(sharedSecret) !== expectedViewTag) {
      return { found: false };
    }

    // Derive stealth keypair (same seed as sender computed)
    const stealthSeed = deriveStealthSeed(spendingPubKey, sharedSecret);
    const stealthKeypair = Keypair.fromSecretKey(
      nacl.sign.keyPair.fromSeed(stealthSeed).secretKey,
    );

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

// ============= Meta Helpers =============

export function createStealthMeta(stealthAddress: StealthAddress): StealthMeta {
  return {
    stealthAddress: stealthAddress.address,
    ephemeralPublicKey: stealthAddress.ephemeralPublicKey,
    viewTag: stealthAddress.viewTag,
    timestamp: Date.now(),
  };
}

export function encodeStealthMeta(meta: StealthMeta): string {
  return JSON.stringify(meta);
}

export function decodeStealthMeta(encoded: string): StealthMeta {
  try {
    return JSON.parse(encoded) as StealthMeta;
  } catch {
    throw createStealthError('INVALID_ADDRESS', 'Invalid stealth meta data');
  }
}

export function isValidStealthAddress(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

export function generateRegistryKey(spendingPubKey: string, viewingPubKey: string): string {
  const hash = sha256(new TextEncoder().encode(spendingPubKey + viewingPubKey));
  return Array.from(hash.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ============= Meta-Address v1/v2 =============

/**
 * Create a publishable meta-address from stealth keys.
 * v1: st:01<base58(spending_ed25519_pub(32) + viewing_x25519_pub(32))>
 * v2: st:02<base58(spending_ed25519_pub(32) + viewing_x25519_pub(32) + kem_pub(1184))>
 */
export function createMetaAddress(keys: StealthKeys): string {
  const spendingBytes = keys.spendingKey.publicKey.toBytes();
  const viewingBytes = keys.viewingPublicKey;

  if (keys.kemPubKey && keys.kemPubKey.length === KEM_PUBLIC_KEY_SIZE) {
    const combined = new Uint8Array(1248);
    combined.set(spendingBytes, 0);
    combined.set(viewingBytes, 32);
    combined.set(keys.kemPubKey, 64);
    return `${META_ADDRESS_PREFIX}${META_ADDRESS_VERSION_V2}${bs58.encode(combined)}`;
  }

  const combined = new Uint8Array(64);
  combined.set(spendingBytes, 0);
  combined.set(viewingBytes, 32);
  return `${META_ADDRESS_PREFIX}${META_ADDRESS_VERSION_V1}${bs58.encode(combined)}`;
}

export interface ParsedMetaAddress {
  spendingPubKey: Uint8Array;
  viewingPubKey: Uint8Array;
  kemPubKey?: Uint8Array;
}

export function parseMetaAddress(metaAddress: string): ParsedMetaAddress {
  if (!metaAddress.startsWith(META_ADDRESS_PREFIX)) {
    throw createStealthError('INVALID_ADDRESS', 'Invalid meta-address: missing prefix');
  }

  const withoutPrefix = metaAddress.slice(META_ADDRESS_PREFIX.length);

  if (withoutPrefix.startsWith(META_ADDRESS_VERSION_V2)) {
    const encoded = withoutPrefix.slice(META_ADDRESS_VERSION_V2.length);
    const combined = bs58.decode(encoded);
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
    const combined = bs58.decode(encoded);
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

export function isMetaAddress(address: string): boolean {
  try {
    parseMetaAddress(address);
    return true;
  } catch {
    return false;
  }
}

// ============= Memo =============

/**
 * Create a stealth memo for on-chain announcement.
 * v1: "P01:STEALTH:<ephemeral_base58>"
 * v2: "P01:STEALTH:V2:<ephemeral_base58>:<kem_ciphertext_base58>"
 */
export function createStealthMemo(
  ephemeralPublicKey: string,
  kemCiphertext?: Uint8Array,
): string {
  if (kemCiphertext) {
    return `P01:STEALTH:V2:${ephemeralPublicKey}:${bs58.encode(kemCiphertext)}`;
  }
  return `P01:STEALTH:${ephemeralPublicKey}`;
}

export function parseStealthMemo(memo: string): {
  ephemeralPublicKey: string;
  kemCiphertext?: Uint8Array;
} | null {
  const v2Prefix = 'P01:STEALTH:V2:';
  if (memo.startsWith(v2Prefix)) {
    const rest = memo.slice(v2Prefix.length);
    const colonIdx = rest.indexOf(':');
    if (colonIdx === -1) return null;
    const kemBytes = bs58.decode(rest.slice(colonIdx + 1));
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

// ============= Simple Stealth (for plain Solana addresses) =============

/**
 * Derive a unique stealth address from a plain Solana recipient address.
 *
 * Unlike generateStealthAddress() which requires a meta-address (viewing + spending keys),
 * this works with any Solana wallet address. Used by Privacy Shield in subscription streams
 * to generate a unique recipient per payment, breaking the on-chain payment pattern.
 *
 * Algorithm (matches extension's deriveStealthAddress):
 *   ephemeralSeed = sha256(senderSecret || nonce_LE32 || recipientPubkey)
 *   sharedSecret  = sha256(ephemeralSecret || recipientPubkey)
 *   stealthKeypair = nacl.sign.keyPair.fromSeed(sharedSecret)
 */
export function deriveStealthAddressSimple(
  recipientPubkey: string,
  senderSecret: Uint8Array,
  nonce: number,
): { stealthAddress: string; ephemeralPubkey: string } {
  // Deterministic ephemeral seed from sender secret + nonce + recipient
  const nonceBytes = new Uint8Array(32);
  new DataView(nonceBytes.buffer).setUint32(0, nonce, true);

  const recipientBytes = new TextEncoder().encode(recipientPubkey);
  const ephemeralSeed = sha256(
    Uint8Array.from([...senderSecret.slice(0, 32), ...nonceBytes, ...recipientBytes]),
  );

  const ephemeralKeypair = nacl.sign.keyPair.fromSeed(ephemeralSeed);

  // Derive shared secret → stealth keypair
  const sharedSecret = sha256(
    Uint8Array.from([...ephemeralKeypair.secretKey.slice(0, 32), ...recipientBytes]),
  );
  const stealthKeypair = nacl.sign.keyPair.fromSeed(sharedSecret);
  const stealthPubkey = new PublicKey(stealthKeypair.publicKey);

  return {
    stealthAddress: stealthPubkey.toBase58(),
    ephemeralPubkey: Buffer.from(ephemeralKeypair.publicKey).toString('hex'),
  };
}

// ============= Helpers =============

function createStealthError(code: StealthError['code'], message: string): StealthError {
  return { code, message };
}

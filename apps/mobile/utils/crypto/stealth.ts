/**
 * Stealth address utilities for Protocol 01
 * Implements stealth address generation and scanning with proper ECDH
 */

import { Keypair, PublicKey } from '@solana/web3.js';
import * as Crypto from 'expo-crypto';
import nacl from 'tweetnacl';

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

export interface StealthKeys {
  spendingKey: Keypair;
  viewingKey: Keypair;
  spendingPublicKey: string;
  viewingPublicKey: string;
}

export interface StealthAddress {
  address: string;
  ephemeralPublicKey: string;
  viewTag: string;
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
 * Generate stealth key pair (spending and viewing keys)
 * Now async to use expo-crypto for secure randomness
 */
export async function generateStealthKeys(): Promise<StealthKeys> {
  const spendingKey = await generateKeypairSecure();
  const viewingKey = await generateKeypairSecure();

  return {
    spendingKey,
    viewingKey,
    spendingPublicKey: spendingKey.publicKey.toBase58(),
    viewingPublicKey: viewingKey.publicKey.toBase58(),
  };
}

/**
 * Generate stealth address for a recipient
 * Uses proper X25519 ECDH for shared secret derivation
 *
 * @param recipientSpendingPubKey - Recipient's Ed25519 spending public key (base58)
 * @param recipientViewingPubKey - Recipient's Ed25519 viewing public key (base58)
 * @param recipientViewingX25519Pub - Optional: Recipient's X25519 viewing public key (32 bytes)
 */
export async function generateStealthAddress(
  recipientSpendingPubKey: string,
  recipientViewingPubKey: string,
  recipientViewingX25519Pub?: Uint8Array
): Promise<StealthAddress> {
  try {
    // Generate ephemeral X25519 keypair for ECDH
    const ephemeralX25519 = generateX25519Keypair();

    // Get recipient's X25519 viewing public key
    let recipientX25519Public: Uint8Array;
    if (recipientViewingX25519Pub && recipientViewingX25519Pub.length === 32) {
      // Use provided X25519 public key directly (new format)
      recipientX25519Public = recipientViewingX25519Pub;
    } else {
      // Derive X25519 from Ed25519 viewing key (legacy fallback)
      // Note: This uses the Ed25519 public key bytes as seed, which must match recipient's derivation
      const viewingPubBytes = new PublicKey(recipientViewingPubKey).toBytes();
      const recipientX25519Keypair = seedToX25519Keypair(viewingPubBytes);
      recipientX25519Public = recipientX25519Keypair.publicKey;
    }

    // Compute shared secret using X25519 ECDH
    // Sender: ephemeralSecret * recipientViewingX25519Public
    const sharedSecret = computeX25519SharedSecret(
      ephemeralX25519.secretKey,
      recipientX25519Public
    );

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
      ephemeralPublicKey: ephemeralPubKeyBase64, // base64 of X25519 key
      viewTag,
    };
  } catch (error) {
    console.error('[Stealth] Generate error:', error);
    throw createStealthError('DERIVATION_FAILED', 'Failed to generate stealth address');
  }
}

/**
 * Scan for incoming stealth payments
 * Uses proper X25519 ECDH for shared secret derivation (matches generateStealthAddress)
 *
 * IMPORTANT: viewingPrivateKey must be the same seed used in getStealthKeys()
 * The X25519 private key is derived as: nacl.hash(viewingPrivateKey).slice(0, 32)
 */
export async function scanStealthPayment(
  ephemeralPublicKey: string,
  viewingPrivateKey: Uint8Array,
  spendingPrivateKey: Uint8Array,
  expectedViewTag?: string
): Promise<StealthScanResult> {
  try {
    // Decode ephemeral X25519 public key (base64 encoded)
    let ephemeralX25519Public: Uint8Array;
    try {
      // Try as base64 (new format)
      const decoded = Buffer.from(ephemeralPublicKey, 'base64');
      if (decoded.length === 32) {
        ephemeralX25519Public = new Uint8Array(decoded);
      } else {
        throw new Error('Invalid length');
      }
    } catch {
      // Fallback: try as base58 Solana public key (old format)
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
    // MUST match getStealthKeys: nacl.hash(viewingKey).slice(0, 32)
    const viewingSeed = viewingPrivateKey.slice(0, 32);
    const viewingX25519Secret = nacl.hash(viewingSeed).slice(0, 32);
    const viewingX25519Keypair = nacl.box.keyPair.fromSecretKey(viewingX25519Secret);

    // Compute shared secret using X25519 ECDH
    // Recipient: viewingX25519Secret * ephemeralX25519Public
    const sharedSecret = computeX25519SharedSecret(
      viewingX25519Keypair.secretKey,
      ephemeralX25519Public
    );

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

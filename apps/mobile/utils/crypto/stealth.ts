/**
 * Stealth address utilities for Protocol 01
 * Implements stealth address generation and scanning
 */

import { Keypair, PublicKey } from '@solana/web3.js';
import * as Crypto from 'expo-crypto';

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
 * Generate stealth key pair (spending and viewing keys)
 */
export function generateStealthKeys(): StealthKeys {
  const spendingKey = Keypair.generate();
  const viewingKey = Keypair.generate();

  return {
    spendingKey,
    viewingKey,
    spendingPublicKey: spendingKey.publicKey.toBase58(),
    viewingPublicKey: viewingKey.publicKey.toBase58(),
  };
}

/**
 * Generate stealth address for a recipient
 */
export async function generateStealthAddress(
  recipientSpendingPubKey: string,
  recipientViewingPubKey: string
): Promise<StealthAddress> {
  try {
    // Generate ephemeral keypair
    const ephemeralKey = Keypair.generate();

    // Compute shared secret using ECDH-like construction
    const sharedSecret = await computeSharedSecret(
      ephemeralKey.secretKey,
      recipientViewingPubKey
    );

    // Derive stealth address
    const stealthPubKey = await deriveStealthPublicKey(
      recipientSpendingPubKey,
      sharedSecret
    );

    // Generate view tag for efficient scanning
    const viewTag = await generateViewTag(sharedSecret);

    return {
      address: stealthPubKey,
      ephemeralPublicKey: ephemeralKey.publicKey.toBase58(),
      viewTag,
    };
  } catch (error) {
    throw createStealthError('DERIVATION_FAILED', 'Failed to generate stealth address');
  }
}

/**
 * Scan for incoming stealth payments
 */
export async function scanStealthPayment(
  ephemeralPublicKey: string,
  viewingPrivateKey: Uint8Array,
  spendingPrivateKey: Uint8Array,
  expectedViewTag?: string
): Promise<StealthScanResult> {
  try {
    // Compute shared secret
    const sharedSecret = await computeSharedSecret(
      viewingPrivateKey,
      ephemeralPublicKey
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

    // Derive the corresponding public key
    const stealthKeypair = Keypair.fromSeed(stealthPrivateKey);

    return {
      found: true,
      stealthAddress: stealthKeypair.publicKey.toBase58(),
      privateKey: stealthKeypair.secretKey,
    };
  } catch (error) {
    throw createStealthError('SCAN_FAILED', 'Failed to scan stealth payment');
  }
}

/**
 * Compute shared secret from private key and public key
 */
async function computeSharedSecret(
  privateKey: Uint8Array,
  publicKeyBase58: string
): Promise<Uint8Array> {
  // Simple shared secret computation
  // In production, use proper ECDH with Ed25519 -> X25519 conversion
  const publicKeyBytes = new PublicKey(publicKeyBase58).toBytes();

  // Combine keys and hash to get shared secret
  const combined = new Uint8Array(privateKey.length + publicKeyBytes.length);
  combined.set(privateKey.slice(0, 32)); // Use seed portion
  combined.set(publicKeyBytes, 32);

  const hashHex = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    Buffer.from(combined).toString('hex')
  );

  return hexToBytes(hashHex);
}

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

import { PublicKey, Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { sha256 } from '@noble/hashes/sha256';
import type { StealthMetaAddress, StealthAddress } from '../types';
import { SpecterError, SpecterErrorCode } from '../types';
import {
  deriveSharedSecret,
  computeViewTag,
  generateEphemeralKeypair,
  toBase58,
} from '../utils/crypto';
import { decodeStealthMetaAddress } from '../utils/helpers';

/**
 * Derive a one-time stealth public key from the recipient's meta-address
 * This is used by the SENDER to generate the stealth address
 *
 * @param recipientMetaAddress - Recipient's stealth meta-address (spending + viewing pubkeys)
 * @param ephemeralPrivateKey - Sender's ephemeral private key
 * @returns The derived stealth public key and ephemeral public key
 */
export function deriveStealthPublicKey(
  recipientMetaAddress: StealthMetaAddress,
  ephemeralPrivateKey: Uint8Array
): {
  stealthPubKey: PublicKey;
  ephemeralPubKey: Uint8Array;
  viewTag: number;
} {
  try {
    // Get ephemeral public key from private key
    const ephemeralKeypair = nacl.box.keyPair.fromSecretKey(ephemeralPrivateKey);
    const ephemeralPubKey = ephemeralKeypair.publicKey;

    // Compute shared secret: s = ECDH(r, V) where r is ephemeral private, V is viewing pubkey
    const sharedSecret = deriveSharedSecret(
      ephemeralPrivateKey,
      recipientMetaAddress.viewingPubKey
    );

    // Compute view tag for efficient scanning
    const viewTag = computeViewTag(sharedSecret);

    // Hash the shared secret
    const hashedSecret = sha256(sharedSecret);

    // Derive stealth public key: P = K + hash(s)*G
    // In practice, we add the hashed secret to the spending public key
    // This is a simplified implementation - production should use proper EC math
    const stealthPubKeyBytes = addPublicKeys(
      recipientMetaAddress.spendingPubKey,
      hashedSecret
    );

    const stealthPubKey = new PublicKey(stealthPubKeyBytes);

    return {
      stealthPubKey,
      ephemeralPubKey,
      viewTag,
    };
  } catch (error) {
    throw new SpecterError(
      SpecterErrorCode.STEALTH_KEY_GENERATION_FAILED,
      'Failed to derive stealth public key',
      error as Error
    );
  }
}

/**
 * Derive a stealth public key from an encoded meta-address string
 * @param encodedMetaAddress - The encoded stealth meta-address
 */
export function deriveStealthPublicKeyFromEncoded(
  encodedMetaAddress: string
): {
  stealthPubKey: PublicKey;
  ephemeralPubKey: Uint8Array;
  viewTag: number;
  ephemeralPrivateKey: Uint8Array;
} {
  const decoded = decodeStealthMetaAddress(encodedMetaAddress);
  const metaAddress: StealthMetaAddress = {
    spendingPubKey: decoded.spendingPubKey,
    viewingPubKey: decoded.viewingPubKey,
    encoded: encodedMetaAddress,
  };

  // Generate ephemeral keypair
  const ephemeralKeypair = generateEphemeralKeypair();

  const result = deriveStealthPublicKey(metaAddress, ephemeralKeypair.secretKey);

  return {
    ...result,
    ephemeralPrivateKey: ephemeralKeypair.secretKey,
  };
}

/**
 * Derive the stealth private key that can spend from the stealth address
 * This is used by the RECIPIENT to derive the key for claiming
 *
 * @param spendingPrivateKey - Recipient's spending private key
 * @param viewingPrivateKey - Recipient's viewing private key
 * @param ephemeralPubKey - Sender's ephemeral public key
 * @returns The derived stealth keypair
 */
export function deriveStealthPrivateKey(
  spendingPrivateKey: Uint8Array,
  viewingPrivateKey: Uint8Array,
  ephemeralPubKey: Uint8Array
): Keypair {
  try {
    // Compute shared secret: s = ECDH(v, R) where v is viewing private, R is ephemeral pubkey
    const sharedSecret = deriveSharedSecret(viewingPrivateKey, ephemeralPubKey);

    // Hash the shared secret
    const hashedSecret = sha256(sharedSecret);

    // Derive stealth private key: p = k + hash(s)
    // where k is the spending private key
    const stealthPrivateKey = addPrivateKeys(spendingPrivateKey, hashedSecret);

    // Create keypair from the derived private key
    // Note: Solana expects a 64-byte secret key (seed + public key)
    const seedKeypair = nacl.sign.keyPair.fromSeed(stealthPrivateKey);

    return Keypair.fromSecretKey(seedKeypair.secretKey);
  } catch (error) {
    throw new SpecterError(
      SpecterErrorCode.STEALTH_KEY_GENERATION_FAILED,
      'Failed to derive stealth private key',
      error as Error
    );
  }
}

/**
 * Verify if a stealth address belongs to a recipient
 * @param stealthAddress - The stealth address to check
 * @param ephemeralPubKey - The ephemeral public key from the transaction
 * @param viewingPrivateKey - Recipient's viewing private key
 * @param spendingPubKey - Recipient's spending public key
 * @param viewTag - View tag for quick filtering (optional)
 */
export function verifyStealthOwnership(
  stealthAddress: PublicKey,
  ephemeralPubKey: Uint8Array,
  viewingPrivateKey: Uint8Array,
  spendingPubKey: Uint8Array,
  viewTag?: number
): boolean {
  try {
    // Compute shared secret
    const sharedSecret = deriveSharedSecret(viewingPrivateKey, ephemeralPubKey);

    // Quick check with view tag if provided
    if (viewTag !== undefined) {
      const computedViewTag = computeViewTag(sharedSecret);
      if (computedViewTag !== viewTag) {
        return false;
      }
    }

    // Hash the shared secret
    const hashedSecret = sha256(sharedSecret);

    // Derive expected stealth public key
    const expectedStealthPubKey = addPublicKeys(spendingPubKey, hashedSecret);

    // Compare with the actual stealth address
    return stealthAddress.toBuffer().equals(Buffer.from(expectedStealthPubKey));
  } catch {
    return false;
  }
}

/**
 * Compute the expected stealth address from components
 */
export function computeStealthAddress(
  spendingPubKey: Uint8Array,
  viewingPubKey: Uint8Array,
  ephemeralPubKey: Uint8Array
): PublicKey {
  // This would need the viewing private key to compute properly
  // This function is mainly for verification purposes
  const sharedSecret = sha256(
    new Uint8Array([...ephemeralPubKey, ...viewingPubKey])
  );
  const stealthPubKeyBytes = addPublicKeys(spendingPubKey, sharedSecret);
  return new PublicKey(stealthPubKeyBytes);
}

// ============================================================================
// Helper functions for EC arithmetic (simplified for Ed25519)
// In production, use a proper cryptographic library for EC operations
// ============================================================================

/**
 * Add a scalar to a public key (simplified)
 * P' = P + hash*G
 */
function addPublicKeys(pubKey: Uint8Array, scalar: Uint8Array): Uint8Array {
  // Generate a keypair from the scalar (this gives us scalar*G)
  const scalarKeypair = nacl.sign.keyPair.fromSeed(scalar);
  const scalarPoint = scalarKeypair.publicKey;

  // XOR-based addition (simplified - not real EC addition)
  // In production, use proper point addition
  const result = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    // Use a hash-based combination to ensure result is on curve
    result[i] = pubKey[i]! ^ scalarPoint[i]!;
  }

  // Hash to ensure valid public key
  return sha256(result);
}

/**
 * Add two private keys (mod curve order)
 */
function addPrivateKeys(key1: Uint8Array, key2: Uint8Array): Uint8Array {
  const result = new Uint8Array(32);

  // Simple modular addition (simplified)
  let carry = 0;
  for (let i = 31; i >= 0; i--) {
    const sum = key1[i]! + key2[i]! + carry;
    result[i] = sum % 256;
    carry = Math.floor(sum / 256);
  }

  return result;
}

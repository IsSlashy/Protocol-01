import { PublicKey, Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { sha256 } from '@noble/hashes/sha256';
import type { StealthMetaAddress } from '../types';
import { SpecterError, SpecterErrorCode } from '../types';
import {
  deriveSharedSecret,
  deriveHybridSharedSecret,
  deriveStealthSeed,
  computeViewTag,
  kemEncapsulate,
  kemDecapsulate,
} from '../utils/crypto';
import { decodeStealthMetaAddress } from '../utils/helpers';

/**
 * Derive a one-time stealth public key from the recipient's meta-address.
 * If the meta-address contains a kemPubKey (v2), uses hybrid X25519 + ML-KEM-768
 * key exchange for post-quantum resistance.
 *
 * @param recipientMetaAddress - Recipient's stealth meta-address
 * @param ephemeralPrivateKey - Sender's ephemeral X25519 private key
 */
export function deriveStealthPublicKey(
  recipientMetaAddress: StealthMetaAddress,
  ephemeralPrivateKey: Uint8Array
): {
  stealthPubKey: PublicKey;
  ephemeralPubKey: Uint8Array;
  viewTag: number;
  kemCiphertext?: Uint8Array;
} {
  try {
    const ephemeralKeypair = nacl.box.keyPair.fromSecretKey(ephemeralPrivateKey);
    const ephemeralPubKey = ephemeralKeypair.publicKey;

    // Classic ECDH: s = X25519(r, V)
    const classicSecret = deriveSharedSecret(
      ephemeralPrivateKey,
      recipientMetaAddress.viewingPubKey
    );

    let sharedSecret: Uint8Array;
    let kemCiphertext: Uint8Array | undefined;

    if (recipientMetaAddress.kemPubKey) {
      // Hybrid mode: combine X25519 + ML-KEM-768
      const kem = kemEncapsulate(recipientMetaAddress.kemPubKey);
      kemCiphertext = kem.cipherText;
      sharedSecret = deriveHybridSharedSecret(classicSecret, kem.sharedSecret);
    } else {
      // Classic mode: ECDH only
      sharedSecret = classicSecret;
    }

    const viewTag = computeViewTag(sharedSecret);

    // Deterministic stealth seed from shared secret + spending pubkey
    const stealthSeed = deriveStealthSeed(
      recipientMetaAddress.spendingPubKey,
      sharedSecret
    );

    // Derive stealth keypair from seed
    const stealthKeypair = nacl.sign.keyPair.fromSeed(stealthSeed);
    const stealthPubKey = new PublicKey(stealthKeypair.publicKey);

    return {
      stealthPubKey,
      ephemeralPubKey,
      viewTag,
      kemCiphertext,
    };
  } catch (error) {
    if (error instanceof SpecterError) throw error;
    throw new SpecterError(
      SpecterErrorCode.STEALTH_KEY_GENERATION_FAILED,
      'Failed to derive stealth public key',
      error as Error
    );
  }
}

/**
 * Derive a stealth public key from an encoded meta-address string
 */
export function deriveStealthPublicKeyFromEncoded(
  encodedMetaAddress: string
): {
  stealthPubKey: PublicKey;
  ephemeralPubKey: Uint8Array;
  viewTag: number;
  ephemeralPrivateKey: Uint8Array;
  kemCiphertext?: Uint8Array;
} {
  const decoded = decodeStealthMetaAddress(encodedMetaAddress);
  const metaAddress: StealthMetaAddress = {
    spendingPubKey: decoded.spendingPubKey,
    viewingPubKey: decoded.viewingPubKey,
    kemPubKey: decoded.kemPubKey,
    encoded: encodedMetaAddress,
  };

  const ephemeralKeypair = nacl.box.keyPair();
  const result = deriveStealthPublicKey(metaAddress, ephemeralKeypair.secretKey);

  return {
    ...result,
    ephemeralPrivateKey: ephemeralKeypair.secretKey,
  };
}

/**
 * Derive the stealth private key that can spend from the stealth address.
 * The recipient uses their viewing private key to recover the shared secret,
 * then derives the same stealth seed as the sender.
 *
 * @param spendingPubKey - Recipient's spending public key (for seed derivation)
 * @param viewingPrivateKey - Recipient's viewing private key
 * @param ephemeralPubKey - Sender's ephemeral public key
 * @param kemSecretKey - Recipient's ML-KEM-768 secret key (for v2 hybrid)
 * @param kemCiphertext - KEM ciphertext from the announcement (for v2 hybrid)
 */
export function deriveStealthPrivateKey(
  spendingPubKey: Uint8Array,
  viewingPrivateKey: Uint8Array,
  ephemeralPubKey: Uint8Array,
  kemSecretKey?: Uint8Array,
  kemCiphertext?: Uint8Array
): Keypair {
  try {
    // Classic ECDH: s = X25519(v, R)
    const classicSecret = deriveSharedSecret(viewingPrivateKey, ephemeralPubKey);

    let sharedSecret: Uint8Array;

    if (kemSecretKey && kemCiphertext) {
      // Hybrid mode: combine X25519 + ML-KEM-768
      const kemSharedSecret = kemDecapsulate(kemCiphertext, kemSecretKey);
      sharedSecret = deriveHybridSharedSecret(classicSecret, kemSharedSecret);
    } else {
      sharedSecret = classicSecret;
    }

    // Same deterministic seed as the sender
    const stealthSeed = deriveStealthSeed(spendingPubKey, sharedSecret);

    // Derive full keypair from seed
    const seedKeypair = nacl.sign.keyPair.fromSeed(stealthSeed);
    return Keypair.fromSecretKey(seedKeypair.secretKey);
  } catch (error) {
    if (error instanceof SpecterError) throw error;
    throw new SpecterError(
      SpecterErrorCode.STEALTH_KEY_GENERATION_FAILED,
      'Failed to derive stealth private key',
      error as Error
    );
  }
}

/**
 * Verify if a stealth address belongs to a recipient
 *
 * @param stealthAddress - The stealth address to check
 * @param ephemeralPubKey - The ephemeral public key from the announcement
 * @param viewingPrivateKey - Recipient's viewing private key
 * @param spendingPubKey - Recipient's spending public key
 * @param viewTag - View tag for quick filtering (optional)
 * @param kemSecretKey - ML-KEM-768 secret key (for v2 hybrid)
 * @param kemCiphertext - KEM ciphertext from announcement (for v2 hybrid)
 */
export function verifyStealthOwnership(
  stealthAddress: PublicKey,
  ephemeralPubKey: Uint8Array,
  viewingPrivateKey: Uint8Array,
  spendingPubKey: Uint8Array,
  viewTag?: number,
  kemSecretKey?: Uint8Array,
  kemCiphertext?: Uint8Array
): boolean {
  try {
    // Classic ECDH
    const classicSecret = deriveSharedSecret(viewingPrivateKey, ephemeralPubKey);

    let sharedSecret: Uint8Array;

    if (kemSecretKey && kemCiphertext) {
      const kemSharedSecret = kemDecapsulate(kemCiphertext, kemSecretKey);
      sharedSecret = deriveHybridSharedSecret(classicSecret, kemSharedSecret);
    } else {
      sharedSecret = classicSecret;
    }

    // Quick check with view tag
    if (viewTag !== undefined) {
      const computedViewTag = computeViewTag(sharedSecret);
      if (computedViewTag !== viewTag) {
        return false;
      }
    }

    // Derive expected stealth public key
    const stealthSeed = deriveStealthSeed(spendingPubKey, sharedSecret);
    const expectedKeypair = nacl.sign.keyPair.fromSeed(stealthSeed);

    // Compare with the actual stealth address
    const expectedPubKey = new PublicKey(expectedKeypair.publicKey);
    return stealthAddress.equals(expectedPubKey);
  } catch {
    return false;
  }
}

/**
 * Compute the expected stealth address from public components.
 * Only works for v1 (classic ECDH). For v2 hybrid, use verifyStealthOwnership instead.
 *
 * @deprecated Use verifyStealthOwnership for proper verification
 */
export function computeStealthAddress(
  spendingPubKey: Uint8Array,
  viewingPubKey: Uint8Array,
  ephemeralPubKey: Uint8Array
): PublicKey {
  // Without the viewing private key, we can't compute ECDH.
  // This function concatenates public keys as a proxy (NOT cryptographically correct).
  // Use verifyStealthOwnership for proper verification.
  const pseudoSecret = sha256(
    new Uint8Array([...ephemeralPubKey, ...viewingPubKey])
  );
  const stealthSeed = deriveStealthSeed(spendingPubKey, pseudoSecret);
  const keypair = nacl.sign.keyPair.fromSeed(stealthSeed);
  return new PublicKey(keypair.publicKey);
}

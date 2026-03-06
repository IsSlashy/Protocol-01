import { PublicKey, Keypair } from '@solana/web3.js';
import type {
  StealthAddress,
  StealthMetaAddress,
  StealthAddressOptions,
} from '../types';
import { SpecterError, SpecterErrorCode } from '../types';
import { generateEphemeralKeypair, kemGenerateKeypair } from '../utils/crypto';
import { encodeStealthMetaAddress, decodeStealthMetaAddress } from '../utils/helpers';
import { KEM_CIPHERTEXT_SIZE } from '../constants';
import {
  deriveStealthPublicKey,
} from './derive';

/**
 * Generate a stealth meta-address from spending and viewing keypairs.
 * If `enableHybrid` is true, also generates an ML-KEM-768 keypair for
 * post-quantum resistance (v2 meta-address).
 *
 * @param spendingKeypair - Keypair for spending
 * @param viewingKeypair - Keypair for viewing/scanning
 * @param enableHybrid - Generate v2 hybrid meta-address with ML-KEM-768
 * @returns Meta-address and optionally the KEM secret key (caller must store securely)
 */
export function generateStealthMetaAddress(
  spendingKeypair: Keypair,
  viewingKeypair: Keypair,
  enableHybrid: boolean = false
): StealthMetaAddress & { kemSecretKey?: Uint8Array } {
  const spendingPubKey = spendingKeypair.publicKey.toBytes();
  const viewingPubKey = viewingKeypair.publicKey.toBytes();

  if (enableHybrid) {
    const kem = kemGenerateKeypair();
    return {
      spendingPubKey,
      viewingPubKey,
      kemPubKey: kem.publicKey,
      encoded: encodeStealthMetaAddress(spendingPubKey, viewingPubKey, kem.publicKey),
      kemSecretKey: kem.secretKey,
    };
  }

  return {
    spendingPubKey,
    viewingPubKey,
    encoded: encodeStealthMetaAddress(spendingPubKey, viewingPubKey),
  };
}

/**
 * Parse an encoded stealth meta-address (v1 or v2)
 */
export function parseStealthMetaAddress(encoded: string): StealthMetaAddress {
  try {
    const decoded = decodeStealthMetaAddress(encoded);
    return {
      spendingPubKey: decoded.spendingPubKey,
      viewingPubKey: decoded.viewingPubKey,
      kemPubKey: decoded.kemPubKey,
      encoded,
    };
  } catch (error) {
    throw new SpecterError(
      SpecterErrorCode.INVALID_STEALTH_ADDRESS,
      'Invalid stealth meta-address format',
      error as Error
    );
  }
}

/**
 * Generate a one-time stealth address for receiving a payment.
 * Automatically uses hybrid mode if the meta-address contains a KEM public key.
 */
export function generateStealthAddress(
  recipientMetaAddress: StealthMetaAddress | string,
  _options: StealthAddressOptions = {}
): StealthAddress & { ephemeralPrivateKey: Uint8Array } {
  try {
    const metaAddress =
      typeof recipientMetaAddress === 'string'
        ? parseStealthMetaAddress(recipientMetaAddress)
        : recipientMetaAddress;

    const ephemeralKeypair = generateEphemeralKeypair();

    const { stealthPubKey, ephemeralPubKey, viewTag, kemCiphertext } =
      deriveStealthPublicKey(metaAddress, ephemeralKeypair.secretKey);

    return {
      address: stealthPubKey,
      ephemeralPubKey,
      viewTag,
      kemCiphertext,
      createdAt: new Date(),
      ephemeralPrivateKey: ephemeralKeypair.secretKey,
    };
  } catch (error) {
    if (error instanceof SpecterError) throw error;
    throw new SpecterError(
      SpecterErrorCode.STEALTH_KEY_GENERATION_FAILED,
      'Failed to generate stealth address',
      error as Error
    );
  }
}

/**
 * Generate multiple stealth addresses for a recipient
 */
export function generateMultipleStealthAddresses(
  recipientMetaAddress: StealthMetaAddress | string,
  count: number
): Array<StealthAddress & { ephemeralPrivateKey: Uint8Array }> {
  if (count < 1 || count > 100) {
    throw new SpecterError(
      SpecterErrorCode.STEALTH_KEY_GENERATION_FAILED,
      'Count must be between 1 and 100'
    );
  }

  const addresses: Array<StealthAddress & { ephemeralPrivateKey: Uint8Array }> = [];
  for (let i = 0; i < count; i++) {
    addresses.push(generateStealthAddress(recipientMetaAddress));
  }
  return addresses;
}

/**
 * Create a stealth announcement for on-chain publication.
 * Format is length-based:
 *   v1 (65 bytes):  [viewTag(1)] [ephemeralPubKey(32)] [stealthAddress(32)]
 *   v2 (1153 bytes): [viewTag(1)] [ephemeralPubKey(32)] [stealthAddress(32)] [kemCiphertext(1088)]
 */
export function createStealthAnnouncement(
  stealthAddress: PublicKey,
  ephemeralPubKey: Uint8Array,
  viewTag: number,
  kemCiphertext?: Uint8Array
): Uint8Array {
  const baseSize = 65;
  const totalSize = kemCiphertext ? baseSize + KEM_CIPHERTEXT_SIZE : baseSize;

  const announcement = new Uint8Array(totalSize);
  announcement[0] = viewTag;
  announcement.set(ephemeralPubKey, 1);
  announcement.set(stealthAddress.toBytes(), 33);

  if (kemCiphertext) {
    announcement.set(kemCiphertext, 65);
  }

  return announcement;
}

/**
 * Parse a stealth announcement (v1 or v2, detected by length)
 */
export function parseStealthAnnouncement(announcement: Uint8Array): {
  viewTag: number;
  ephemeralPubKey: Uint8Array;
  stealthAddress: PublicKey;
  kemCiphertext?: Uint8Array;
} {
  if (announcement.length !== 65 && announcement.length !== 65 + KEM_CIPHERTEXT_SIZE) {
    throw new SpecterError(
      SpecterErrorCode.INVALID_STEALTH_ADDRESS,
      `Invalid announcement length: ${announcement.length} (expected 65 or ${65 + KEM_CIPHERTEXT_SIZE})`
    );
  }

  const result: {
    viewTag: number;
    ephemeralPubKey: Uint8Array;
    stealthAddress: PublicKey;
    kemCiphertext?: Uint8Array;
  } = {
    viewTag: announcement[0]!,
    ephemeralPubKey: announcement.slice(1, 33),
    stealthAddress: new PublicKey(announcement.slice(33, 65)),
  };

  // v2: includes KEM ciphertext
  if (announcement.length > 65) {
    result.kemCiphertext = announcement.slice(65, 65 + KEM_CIPHERTEXT_SIZE);
  }

  return result;
}

/**
 * Generate stealth data for a transfer
 */
export function generateStealthTransferData(
  recipientMetaAddress: StealthMetaAddress | string,
  amount: bigint
): {
  stealthAddress: PublicKey;
  ephemeralPubKey: Uint8Array;
  viewTag: number;
  announcement: Uint8Array;
  kemCiphertext?: Uint8Array;
  amount: bigint;
} {
  const stealth = generateStealthAddress(recipientMetaAddress);

  return {
    stealthAddress: stealth.address,
    ephemeralPubKey: stealth.ephemeralPubKey,
    viewTag: stealth.viewTag,
    kemCiphertext: stealth.kemCiphertext,
    announcement: createStealthAnnouncement(
      stealth.address,
      stealth.ephemeralPubKey,
      stealth.viewTag,
      stealth.kemCiphertext
    ),
    amount,
  };
}

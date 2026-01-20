import { PublicKey, Keypair } from '@solana/web3.js';
import type {
  StealthAddress,
  StealthMetaAddress,
  StealthAddressOptions,
} from '../types';
import { SpecterError, SpecterErrorCode } from '../types';
import { generateEphemeralKeypair } from '../utils/crypto';
import { encodeStealthMetaAddress, decodeStealthMetaAddress } from '../utils/helpers';
import {
  deriveStealthPublicKey,
  deriveStealthPublicKeyFromEncoded,
} from './derive';

/**
 * Generate a stealth meta-address from spending and viewing keypairs
 * @param spendingKeypair - Keypair for spending (private key stays with recipient)
 * @param viewingKeypair - Keypair for viewing/scanning (private key stays with recipient)
 */
export function generateStealthMetaAddress(
  spendingKeypair: Keypair,
  viewingKeypair: Keypair
): StealthMetaAddress {
  const spendingPubKey = spendingKeypair.publicKey.toBytes();
  const viewingPubKey = viewingKeypair.publicKey.toBytes();

  return {
    spendingPubKey,
    viewingPubKey,
    encoded: encodeStealthMetaAddress(spendingPubKey, viewingPubKey),
  };
}

/**
 * Parse an encoded stealth meta-address
 * @param encoded - The encoded stealth meta-address string
 */
export function parseStealthMetaAddress(encoded: string): StealthMetaAddress {
  try {
    const { spendingPubKey, viewingPubKey } = decodeStealthMetaAddress(encoded);
    return {
      spendingPubKey,
      viewingPubKey,
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
 * Generate a one-time stealth address for receiving a payment
 * This creates a fresh address that can only be spent by the meta-address owner
 *
 * @param recipientMetaAddress - The recipient's stealth meta-address
 * @param options - Optional configuration for the stealth address
 */
export function generateStealthAddress(
  recipientMetaAddress: StealthMetaAddress | string,
  options: StealthAddressOptions = {}
): StealthAddress & { ephemeralPrivateKey: Uint8Array } {
  try {
    // Parse meta-address if string
    const metaAddress =
      typeof recipientMetaAddress === 'string'
        ? parseStealthMetaAddress(recipientMetaAddress)
        : recipientMetaAddress;

    // Generate ephemeral keypair for this transaction
    const ephemeralKeypair = generateEphemeralKeypair();

    // Derive the stealth public key
    const { stealthPubKey, ephemeralPubKey, viewTag } = deriveStealthPublicKey(
      metaAddress,
      ephemeralKeypair.secretKey
    );

    return {
      address: stealthPubKey,
      ephemeralPubKey,
      viewTag,
      createdAt: new Date(),
      ephemeralPrivateKey: ephemeralKeypair.secretKey,
    };
  } catch (error) {
    if (error instanceof SpecterError) {
      throw error;
    }
    throw new SpecterError(
      SpecterErrorCode.STEALTH_KEY_GENERATION_FAILED,
      'Failed to generate stealth address',
      error as Error
    );
  }
}

/**
 * Generate multiple stealth addresses for a recipient
 * Useful for batch payments or privacy-enhanced transfers
 *
 * @param recipientMetaAddress - The recipient's stealth meta-address
 * @param count - Number of addresses to generate
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
 * Create a shareable stealth address announcement
 * This is the data that gets published on-chain for the recipient to find
 *
 * @param stealthAddress - The generated stealth address
 * @param ephemeralPubKey - The ephemeral public key
 * @param viewTag - The view tag
 */
export function createStealthAnnouncement(
  stealthAddress: PublicKey,
  ephemeralPubKey: Uint8Array,
  viewTag: number
): Uint8Array {
  // Format: [view_tag (1 byte)] [ephemeral_pubkey (32 bytes)] [stealth_address (32 bytes)]
  const announcement = new Uint8Array(65);
  announcement[0] = viewTag;
  announcement.set(ephemeralPubKey, 1);
  announcement.set(stealthAddress.toBytes(), 33);
  return announcement;
}

/**
 * Parse a stealth announcement
 * @param announcement - The announcement data
 */
export function parseStealthAnnouncement(announcement: Uint8Array): {
  viewTag: number;
  ephemeralPubKey: Uint8Array;
  stealthAddress: PublicKey;
} {
  if (announcement.length !== 65) {
    throw new SpecterError(
      SpecterErrorCode.INVALID_STEALTH_ADDRESS,
      'Invalid announcement length'
    );
  }

  return {
    viewTag: announcement[0]!,
    ephemeralPubKey: announcement.slice(1, 33),
    stealthAddress: new PublicKey(announcement.slice(33, 65)),
  };
}

/**
 * Generate stealth data for a transfer
 * Returns all the data needed to execute a stealth transfer
 *
 * @param recipientMetaAddress - Recipient's meta-address
 * @param amount - Amount to transfer
 */
export function generateStealthTransferData(
  recipientMetaAddress: StealthMetaAddress | string,
  amount: bigint
): {
  stealthAddress: PublicKey;
  ephemeralPubKey: Uint8Array;
  viewTag: number;
  announcement: Uint8Array;
  amount: bigint;
} {
  const stealth = generateStealthAddress(recipientMetaAddress);

  return {
    stealthAddress: stealth.address,
    ephemeralPubKey: stealth.ephemeralPubKey,
    viewTag: stealth.viewTag,
    announcement: createStealthAnnouncement(
      stealth.address,
      stealth.ephemeralPubKey,
      stealth.viewTag
    ),
    amount,
  };
}

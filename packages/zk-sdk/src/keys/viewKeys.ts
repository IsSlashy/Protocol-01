/**
 * View Keys System
 *
 * Implements Zcash-style viewing keys that allow:
 * - Viewing incoming transactions without spending capability
 * - Sharing with auditors for compliance
 * - Proving receipt of funds
 *
 * Key Hierarchy:
 * ┌─────────────────────────────────────────────────────────────┐
 * │  Spending Key (sk)                                          │
 * │  └── Full control: spend + view                             │
 * │      │                                                      │
 * │      ├── Full Viewing Key (fvk)                             │
 * │      │   └── View all: incoming + outgoing + balances       │
 * │      │       │                                              │
 * │      │       └── Incoming Viewing Key (ivk)                 │
 * │      │           └── View incoming only                     │
 * │      │                                                      │
 * │      └── Outgoing Viewing Key (ovk)                         │
 * │          └── View outgoing only (for sender records)        │
 * └─────────────────────────────────────────────────────────────┘
 */

import { poseidonHash } from '../circuits';

// Domain separators for key derivation
const DOMAIN_FVK = BigInt('0x01'); // Full Viewing Key
const DOMAIN_IVK = BigInt('0x02'); // Incoming Viewing Key
const DOMAIN_OVK = BigInt('0x03'); // Outgoing Viewing Key
const DOMAIN_DK = BigInt('0x04');  // Decryption Key

/**
 * Spending Key - Master key with full control
 */
export interface SpendingKey {
  sk: bigint;
  publicKey: bigint;
}

/**
 * Full Viewing Key - Can view all transactions but not spend
 */
export interface FullViewingKey {
  ak: bigint;      // Authorizing key (for verifying ownership)
  nk: bigint;      // Nullifier key (for detecting spent notes)
  ovk: bigint;     // Outgoing viewing key
  dk: bigint;      // Decryption key
  publicKey: bigint;
}

/**
 * Incoming Viewing Key - Can only view incoming transactions
 */
export interface IncomingViewingKey {
  ivk: bigint;     // Incoming viewing key scalar
  dk: bigint;      // Decryption key
  publicKey: bigint;
}

/**
 * Outgoing Viewing Key - Can view outgoing transactions (for sender)
 */
export interface OutgoingViewingKey {
  ovk: bigint;
  publicKey: bigint;
}

/**
 * Generate a spending key from entropy
 */
export function generateSpendingKey(entropy: Uint8Array): SpendingKey {
  // Convert entropy to bigint
  const sk = bytesToBigInt(entropy) % FIELD_MODULUS;

  // Derive public key
  const publicKey = poseidonHash([sk, BigInt(0)]);

  return { sk, publicKey };
}

/**
 * Derive Full Viewing Key from Spending Key
 */
export function deriveFullViewingKey(sk: SpendingKey): FullViewingKey {
  // Authorizing key - proves ownership without spending
  const ak = poseidonHash([sk.sk, DOMAIN_FVK, BigInt(1)]);

  // Nullifier key - for detecting spent notes
  const nk = poseidonHash([sk.sk, DOMAIN_FVK, BigInt(2)]);

  // Outgoing viewing key
  const ovk = poseidonHash([sk.sk, DOMAIN_OVK]);

  // Decryption key
  const dk = poseidonHash([sk.sk, DOMAIN_DK]);

  return {
    ak,
    nk,
    ovk,
    dk,
    publicKey: sk.publicKey,
  };
}

/**
 * Derive Incoming Viewing Key from Full Viewing Key
 */
export function deriveIncomingViewingKey(fvk: FullViewingKey): IncomingViewingKey {
  // IVK is derived from ak and nk
  const ivk = poseidonHash([fvk.ak, fvk.nk, DOMAIN_IVK]);

  return {
    ivk,
    dk: fvk.dk,
    publicKey: fvk.publicKey,
  };
}

/**
 * Derive Outgoing Viewing Key from Full Viewing Key
 */
export function deriveOutgoingViewingKey(fvk: FullViewingKey): OutgoingViewingKey {
  return {
    ovk: fvk.ovk,
    publicKey: fvk.publicKey,
  };
}

/**
 * Try to decrypt a note with an Incoming Viewing Key
 * Returns the decrypted note if successful, null otherwise
 */
export function tryDecryptWithIVK(
  ivk: IncomingViewingKey,
  encryptedNote: EncryptedNote
): DecryptedNote | null {
  try {
    // Derive shared secret using IVK and ephemeral public key
    const sharedSecret = poseidonHash([ivk.ivk, encryptedNote.ephemeralPubKey]);

    // Derive decryption key
    const decryptionKey = poseidonHash([sharedSecret, ivk.dk]);

    // Decrypt note fields
    const amount = decryptField(encryptedNote.encAmount, decryptionKey, BigInt(0));
    const randomness = decryptField(encryptedNote.encRandomness, decryptionKey, BigInt(1));

    // Verify the commitment matches
    const expectedCommitment = poseidonHash([
      amount,
      ivk.publicKey,
      randomness,
      encryptedNote.tokenMint,
    ]);

    if (expectedCommitment !== encryptedNote.commitment) {
      return null; // Not our note
    }

    return {
      amount,
      owner: ivk.publicKey,
      randomness,
      tokenMint: encryptedNote.tokenMint,
      commitment: encryptedNote.commitment,
    };
  } catch {
    return null;
  }
}

/**
 * Try to view an outgoing transaction with OVK
 */
export function tryDecryptOutgoing(
  ovk: OutgoingViewingKey,
  encryptedMemo: bigint[],
  ephemeralPubKey: bigint
): OutgoingTransactionInfo | null {
  try {
    // Derive shared secret
    const sharedSecret = poseidonHash([ovk.ovk, ephemeralPubKey]);

    // Decrypt memo containing recipient and amount
    const recipient = decryptField(encryptedMemo[0], sharedSecret, BigInt(0));
    const amount = decryptField(encryptedMemo[1], sharedSecret, BigInt(1));

    return { recipient, amount };
  } catch {
    return null;
  }
}

/**
 * Scan blockchain for notes belonging to a viewing key
 */
export async function scanForNotes(
  ivk: IncomingViewingKey,
  commitments: CommitmentEvent[],
  startIndex: number = 0
): Promise<ScannedNote[]> {
  const foundNotes: ScannedNote[] = [];

  for (let i = startIndex; i < commitments.length; i++) {
    const event = commitments[i];
    const decrypted = tryDecryptWithIVK(ivk, event.encryptedNote);

    if (decrypted) {
      foundNotes.push({
        ...decrypted,
        leafIndex: event.leafIndex,
        blockTime: event.blockTime,
        txSignature: event.txSignature,
      });
    }
  }

  return foundNotes;
}

/**
 * Check if a nullifier belongs to one of our notes (using FVK)
 */
export function checkNullifier(
  fvk: FullViewingKey,
  nullifier: bigint,
  knownNotes: DecryptedNote[]
): DecryptedNote | null {
  for (const note of knownNotes) {
    // Compute expected nullifier
    const expectedNullifier = poseidonHash([
      note.commitment,
      fvk.nk,
    ]);

    if (expectedNullifier === nullifier) {
      return note;
    }
  }

  return null;
}

/**
 * Serialize viewing key for export/sharing
 */
export function serializeViewingKey(key: FullViewingKey | IncomingViewingKey | OutgoingViewingKey): string {
  const keyType = 'ivk' in key ? 'ivk' : 'ovk' in key && 'ak' in key ? 'fvk' : 'ovk';

  const data = {
    type: keyType,
    version: 1,
    ...Object.fromEntries(
      Object.entries(key).map(([k, v]) => [k, v.toString(16)])
    ),
  };

  // Encode as base64
  return Buffer.from(JSON.stringify(data)).toString('base64');
}

/**
 * Deserialize viewing key from string
 */
export function deserializeViewingKey(serialized: string): FullViewingKey | IncomingViewingKey | OutgoingViewingKey {
  const data = JSON.parse(Buffer.from(serialized, 'base64').toString());

  const restored: any = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === 'type' || key === 'version') continue;
    restored[key] = BigInt('0x' + value);
  }

  return restored;
}

/**
 * Generate a shareable viewing key URI
 */
export function generateViewingKeyURI(
  key: IncomingViewingKey,
  label?: string
): string {
  const serialized = serializeViewingKey(key);
  const params = new URLSearchParams({
    key: serialized,
    ...(label && { label }),
  });

  return `specter://viewkey?${params.toString()}`;
}

// Helper functions
function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = BigInt(0);
  for (let i = 0; i < bytes.length; i++) {
    result = (result << BigInt(8)) + BigInt(bytes[i]);
  }
  return result;
}

function decryptField(encrypted: bigint, key: bigint, index: bigint): bigint {
  const mask = poseidonHash([key, index]);
  return (encrypted - mask + FIELD_MODULUS) % FIELD_MODULUS;
}

// Field modulus for BN254
const FIELD_MODULUS = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');

// Types
export interface EncryptedNote {
  commitment: bigint;
  encAmount: bigint;
  encRandomness: bigint;
  ephemeralPubKey: bigint;
  tokenMint: bigint;
}

export interface DecryptedNote {
  amount: bigint;
  owner: bigint;
  randomness: bigint;
  tokenMint: bigint;
  commitment: bigint;
}

export interface ScannedNote extends DecryptedNote {
  leafIndex: number;
  blockTime: number;
  txSignature: string;
}

export interface CommitmentEvent {
  leafIndex: number;
  encryptedNote: EncryptedNote;
  blockTime: number;
  txSignature: string;
}

export interface OutgoingTransactionInfo {
  recipient: bigint;
  amount: bigint;
}

export default {
  generateSpendingKey,
  deriveFullViewingKey,
  deriveIncomingViewingKey,
  deriveOutgoingViewingKey,
  tryDecryptWithIVK,
  tryDecryptOutgoing,
  scanForNotes,
  checkNullifier,
  serializeViewingKey,
  deserializeViewingKey,
  generateViewingKeyURI,
};

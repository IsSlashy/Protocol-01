/**
 * Circuit utilities for ZK operations
 * Implements Poseidon hash and related cryptographic primitives
 */

import { buildPoseidon, type Poseidon } from 'circomlibjs';
import { poseidon1, poseidon2, poseidon3, poseidon4 } from 'poseidon-lite';
import { FIELD_MODULUS } from '../constants';

let poseidonInstance: Poseidon | null = null;

/**
 * Initialize the Poseidon hash function
 */
async function initPoseidon(): Promise<Poseidon> {
  if (!poseidonInstance) {
    poseidonInstance = await buildPoseidon();
  }
  return poseidonInstance;
}

/**
 * Export field modulus
 */
export { FIELD_MODULUS };

/**
 * Compute Poseidon hash of inputs
 * @param inputs Array of field elements (bigint or number). Must be non-empty.
 * @returns Hash as bigint
 * @throws If inputs array is empty or not provided
 */
export async function poseidonHash(inputs: (bigint | number)[]): Promise<bigint> {
  if (!inputs || inputs.length === 0) {
    throw new Error(
      'poseidonHash: inputs array must be non-empty. ' +
      'Provide at least one field element to hash.'
    );
  }

  const poseidon = await initPoseidon();
  const hash = poseidon(inputs.map(x => BigInt(x)));
  return poseidon.F.toObject(hash);
}

/**
 * Compute Poseidon hash synchronously (after initialization)
 */
export function poseidonHashSync(poseidon: Poseidon, inputs: (bigint | number)[]): bigint {
  const hash = poseidon(inputs.map(x => BigInt(x)));
  return poseidon.F.toObject(hash);
}

/**
 * Synchronous Poseidon hash using poseidon-lite (no async init needed).
 * Supports 1-4 inputs. Use this when async initialization is not desirable.
 * Produces identical output to the async poseidonHash for the same inputs.
 */
export function poseidonHashLite(inputs: (bigint | number)[]): bigint {
  if (!inputs || inputs.length === 0) {
    throw new Error(
      'poseidonHashLite: inputs array must be non-empty. ' +
      'Provide at least one field element to hash.'
    );
  }

  const bigInputs = inputs.map(x => BigInt(x));

  switch (bigInputs.length) {
    case 1: return poseidon1(bigInputs);
    case 2: return poseidon2(bigInputs);
    case 3: return poseidon3(bigInputs);
    case 4: return poseidon4(bigInputs);
    default:
      throw new Error(
        `poseidonHashLite: unsupported input length ${bigInputs.length}. ` +
        'poseidon-lite supports 1-4 inputs. Use poseidonHash for more.'
      );
  }
}

/**
 * Compute note commitment
 * Commitment = Poseidon(amount, owner_pubkey, randomness, token_mint)
 *
 * @throws If any parameter is undefined or null
 */
export async function computeCommitment(
  amount: bigint,
  ownerPubkey: bigint,
  randomness: bigint,
  tokenMint: bigint
): Promise<bigint> {
  if (amount === undefined || amount === null) {
    throw new Error('computeCommitment: amount is required.');
  }
  if (ownerPubkey === undefined || ownerPubkey === null) {
    throw new Error('computeCommitment: ownerPubkey is required.');
  }
  if (randomness === undefined || randomness === null) {
    throw new Error('computeCommitment: randomness is required.');
  }
  if (tokenMint === undefined || tokenMint === null) {
    throw new Error('computeCommitment: tokenMint is required.');
  }

  return poseidonHash([amount, ownerPubkey, randomness, tokenMint]);
}

/**
 * Compute nullifier for a note
 * Nullifier = Poseidon(commitment, spending_key_hash)
 *
 * @throws If commitment or spendingKeyHash is undefined or null
 */
export async function computeNullifier(
  commitment: bigint,
  spendingKeyHash: bigint
): Promise<bigint> {
  if (commitment === undefined || commitment === null) {
    throw new Error('computeNullifier: commitment is required.');
  }
  if (spendingKeyHash === undefined || spendingKeyHash === null) {
    throw new Error('computeNullifier: spendingKeyHash is required.');
  }

  return poseidonHash([commitment, spendingKeyHash]);
}

/**
 * Derive owner public key from spending key
 * owner_pubkey = Poseidon(spending_key, 0) — domain tag 0
 * Matches circuit SpendingKeyDerivation in poseidon.circom.
 */
export async function deriveOwnerPubkey(spendingKey: bigint): Promise<bigint> {
  return poseidonHash([spendingKey, BigInt(0)]);
}

/**
 * Compute spending key hash for nullifier
 * spending_key_hash = Poseidon(spending_key, 1) — domain tag 1
 * Matches circuit SpendingKeyHash in poseidon.circom.
 */
export async function computeSpendingKeyHash(spendingKey: bigint): Promise<bigint> {
  return poseidonHash([spendingKey, BigInt(1)]);
}

/**
 * Convert bytes to field element
 */
export function bytesToField(bytes: Uint8Array): bigint {
  let result = BigInt(0);
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << BigInt(8)) | BigInt(bytes[i]);
  }
  return result % FIELD_MODULUS;
}

/**
 * Convert field element to 32 bytes (little-endian)
 */
export function fieldToBytes(field: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let value = field;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(value & BigInt(0xff));
    value >>= BigInt(8);
  }
  return bytes;
}

/**
 * Generate random field element using rejection sampling to avoid modular bias.
 *
 * NOTE: This file uses circomlibjs for Poseidon hashing; poseidon-lite is used
 * elsewhere (zkspl-sdk, privacy-toolkit). Both produce identical outputs for
 * the same inputs — they implement the same Poseidon specification.
 */
export function randomFieldElement(): bigint {
  while (true) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    // Read as big-endian to get the full 256-bit value before reduction
    let value = BigInt(0);
    for (let i = 0; i < 32; i++) {
      value = (value << BigInt(8)) | BigInt(bytes[i]);
    }
    if (value < FIELD_MODULUS) return value;
  }
}

/**
 * Convert public key to field element
 */
export function pubkeyToField(pubkey: Uint8Array): bigint {
  return bytesToField(pubkey);
}

/**
 * Get initialized Poseidon instance for batch operations
 */
export async function getPoseidon(): Promise<Poseidon> {
  return initPoseidon();
}

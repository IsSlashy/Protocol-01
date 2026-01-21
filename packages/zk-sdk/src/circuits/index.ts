/**
 * Circuit utilities for ZK operations
 * Implements Poseidon hash and related cryptographic primitives
 */

import { buildPoseidon, type Poseidon } from 'circomlibjs';
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
 * @param inputs Array of field elements (bigint or number)
 * @returns Hash as bigint
 */
export async function poseidonHash(inputs: (bigint | number)[]): Promise<bigint> {
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
 * Compute note commitment
 * Commitment = Poseidon(amount, owner_pubkey, randomness, token_mint)
 */
export async function computeCommitment(
  amount: bigint,
  ownerPubkey: bigint,
  randomness: bigint,
  tokenMint: bigint
): Promise<bigint> {
  return poseidonHash([amount, ownerPubkey, randomness, tokenMint]);
}

/**
 * Compute nullifier for a note
 * Nullifier = Poseidon(commitment, spending_key_hash)
 */
export async function computeNullifier(
  commitment: bigint,
  spendingKeyHash: bigint
): Promise<bigint> {
  return poseidonHash([commitment, spendingKeyHash]);
}

/**
 * Derive owner public key from spending key
 * owner_pubkey = Poseidon(spending_key)
 */
export async function deriveOwnerPubkey(spendingKey: bigint): Promise<bigint> {
  return poseidonHash([spendingKey]);
}

/**
 * Compute spending key hash for nullifier
 */
export async function computeSpendingKeyHash(spendingKey: bigint): Promise<bigint> {
  return poseidonHash([spendingKey]);
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
 * Generate random field element
 */
export function randomFieldElement(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToField(bytes);
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

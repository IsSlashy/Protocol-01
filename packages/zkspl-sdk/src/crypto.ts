/**
 * Cryptographic utilities for zkSPL.
 *
 * Uses `poseidon-lite` for Poseidon hashing (circom-compatible).
 * All field elements live in BN254 scalar field.
 */

import { poseidon1, poseidon2, poseidon4 } from 'poseidon-lite';
import { FIELD_MODULUS } from './constants';
import type { FieldElement, Bytes32 } from './types';

// ---------------------------------------------------------------------------
// Poseidon hashing (synchronous, no WASM init needed)
// ---------------------------------------------------------------------------

/**
 * Poseidon hash of 1..n inputs.
 * Uses poseidon-lite's pre-compiled variants (poseidon1..poseidon4).
 */
export function poseidonHash(inputs: (bigint | number)[]): bigint {
  const values = inputs.map(v => BigInt(v));
  switch (values.length) {
    case 1:
      return poseidon1(values) as bigint;
    case 2:
      return poseidon2(values) as bigint;
    case 4:
      return poseidon4(values) as bigint;
    default:
      // For other arities, fall back to poseidon2 chaining.
      // In practice the zkSPL circuits only use 1, 2, and 4 inputs.
      throw new Error(
        `poseidonHash: unsupported arity ${values.length}. ` +
          'zkSPL circuits use 1, 2, or 4 inputs.'
      );
  }
}

// ---------------------------------------------------------------------------
// Commitment functions (match the circom templates exactly)
// ---------------------------------------------------------------------------

/**
 * Balance commitment = Poseidon(balance, salt, owner_pubkey, token_mint)
 *
 * This is the core on-chain representation of a hidden balance.
 */
export function createBalanceCommitment(
  balance: bigint,
  salt: FieldElement,
  ownerPubkey: FieldElement,
  tokenMint: FieldElement
): FieldElement {
  return poseidonHash([balance, salt, ownerPubkey, tokenMint]);
}

/**
 * Amount commitment = Poseidon(amount, amount_salt)
 *
 * Used in confidential transfers to link sender and recipient
 * without revealing the amount publicly.
 */
export function createAmountCommitment(
  amount: bigint,
  amountSalt: FieldElement
): FieldElement {
  return poseidonHash([amount, amountSalt]);
}

/**
 * Derive owner public key from spending key.
 *
 * owner_pubkey = Poseidon(spending_key)
 */
export function deriveOwnerPubkey(spendingKey: FieldElement): FieldElement {
  return poseidonHash([spendingKey]);
}

// ---------------------------------------------------------------------------
// Salt generation
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically random field element suitable for use
 * as a salt, spending key, or amount salt.
 */
export function randomSalt(): FieldElement {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToField(bytes);
}

/**
 * Derive a deterministic salt from spending key and nonce.
 *
 * salt = Poseidon(spendingKey, nonce)
 *
 * This is recoverable: given the spending key and nonce, the salt can
 * always be recomputed. This prevents state loss when local storage
 * gets corrupted — we can replay from on-chain nonce.
 */
export function deriveDeterministicSalt(
  spendingKey: FieldElement,
  nonce: bigint,
): FieldElement {
  return poseidonHash([spendingKey, nonce]);
}

// ---------------------------------------------------------------------------
// Field <-> byte conversions
// ---------------------------------------------------------------------------

/**
 * Convert a field element to 32 bytes (little-endian).
 */
export function fieldToBytes(field: bigint): Bytes32 {
  const bytes = new Uint8Array(32);
  let value = field;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}

/**
 * Convert a field element to 32 bytes (big-endian).
 * Used for G1/G2 point encoding for the alt_bn128 precompile.
 */
export function fieldToBytesBE(field: bigint): Bytes32 {
  const bytes = new Uint8Array(32);
  let value = field;
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}

/**
 * Convert 32 bytes (little-endian) to a field element, reduced mod p.
 */
export function bytesToField(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result % FIELD_MODULUS;
}

/**
 * Convert a Solana PublicKey's bytes to a field element.
 */
export function pubkeyToField(pubkeyBytes: Uint8Array): bigint {
  return bytesToField(pubkeyBytes);
}

/**
 * Compute the zero amount hash: Poseidon(0, 0).
 * Used for deposit / withdraw where the private transfer amount is zero.
 */
export function zeroAmountHash(): FieldElement {
  return createAmountCommitment(0n, 0n);
}

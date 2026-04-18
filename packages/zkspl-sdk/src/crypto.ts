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
 * Poseidon hash of 1..4 inputs.
 * Uses poseidon-lite's pre-compiled variants (poseidon1, poseidon2, poseidon4).
 *
 * @param inputs - Array of 1, 2, or 4 bigint/number values to hash.
 * @returns The Poseidon hash as a BN254 field element.
 * @throws If the inputs array is empty, has 3 elements, or has more than 4 elements.
 *
 * @example
 * ```ts
 * const hash = poseidonHash([123n, 456n]); // 2-input Poseidon
 * ```
 */
export function poseidonHash(inputs: (bigint | number)[]): bigint {
  if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > 4) {
    throw new Error(
      `poseidonHash: expected 1-4 inputs, got ${Array.isArray(inputs) ? inputs.length : typeof inputs}. ` +
        'The zkSPL circuits support Poseidon with 1, 2, or 4 inputs.'
    );
  }

  const values = inputs.map(v => BigInt(v));
  switch (values.length) {
    case 1:
      return poseidon1(values) as bigint;
    case 2:
      return poseidon2(values) as bigint;
    case 4:
      return poseidon4(values) as bigint;
    default:
      // 3 inputs: poseidon-lite does not ship a poseidon3 variant.
      throw new Error(
        `poseidonHash: unsupported arity ${values.length}. ` +
          'zkSPL circuits use 1, 2, or 4 inputs (poseidon3 is not available).'
      );
  }
}

// ---------------------------------------------------------------------------
// Commitment functions (match the circom templates exactly)
// ---------------------------------------------------------------------------

/**
 * Balance commitment = Poseidon(balance, Poseidon(salt, nonce), owner_pubkey, token_mint)
 *
 * This is the core on-chain representation of a hidden balance.
 * The nonce is bound into the salt via an inner hash to prevent replay attacks.
 *
 * @param balance     - Current plaintext balance (must be >= 0).
 * @param salt        - Random or deterministic salt (field element).
 * @param nonce       - On-chain nonce for this account.
 * @param ownerPubkey - Derived owner public key (from spending key).
 * @param tokenMint   - Token mint as a field element.
 * @returns The Poseidon commitment as a BN254 field element.
 * @throws If any parameter is undefined or null.
 */
export function createBalanceCommitment(
  balance: bigint,
  salt: FieldElement,
  nonce: bigint,
  ownerPubkey: FieldElement,
  tokenMint: FieldElement
): FieldElement {
  if (balance === undefined || balance === null) {
    throw new Error('createBalanceCommitment: balance is required (got undefined/null).');
  }
  if (salt === undefined || salt === null) {
    throw new Error('createBalanceCommitment: salt is required (got undefined/null).');
  }
  if (nonce === undefined || nonce === null) {
    throw new Error('createBalanceCommitment: nonce is required (got undefined/null).');
  }
  if (ownerPubkey === undefined || ownerPubkey === null) {
    throw new Error('createBalanceCommitment: ownerPubkey is required (got undefined/null).');
  }
  if (tokenMint === undefined || tokenMint === null) {
    throw new Error('createBalanceCommitment: tokenMint is required (got undefined/null).');
  }

  const augmentedSalt = poseidon2([salt, nonce]);
  return poseidon4([balance, augmentedSalt, ownerPubkey, tokenMint]);
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
 * owner_pubkey = Poseidon(spending_key, 0) — domain tag 0
 * Matches circuit SpendingKeyDerivation in poseidon.circom.
 */
export function deriveOwnerPubkey(spendingKey: FieldElement): FieldElement {
  return poseidon2([spendingKey, 0n]);
}

// ---------------------------------------------------------------------------
// Salt generation
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically random field element suitable for use
 * as a salt, spending key, or amount salt.
 * Uses rejection sampling to avoid modular bias.
 */
export function randomSalt(): FieldElement {
  while (true) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    // Read as big-endian to get the full 256-bit value before reduction
    let value = 0n;
    for (let i = 0; i < 32; i++) value = (value << 8n) | BigInt(bytes[i]);
    if (value < FIELD_MODULUS) return value;
  }
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

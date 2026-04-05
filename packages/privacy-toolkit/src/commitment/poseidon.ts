import { poseidon2, poseidon4 } from 'poseidon-lite';
import type { FieldElement } from './types';

function validateBigint(value: unknown, name: string, fnName: string): asserts value is bigint {
  if (typeof value !== 'bigint') {
    throw new TypeError(
      `${fnName}: ${name} must be a bigint, got ${typeof value}`,
    );
  }
}

/**
 * Create a note commitment using Poseidon hash.
 * commitment = Poseidon(nullifierPreimage, secret, epoch, tokenIdentifier)
 *
 * This 4-input commitment binds the note to:
 * - The nullifier preimage (for spending)
 * - A random secret (for privacy)
 * - A time parameter (for time-lock enforcement)
 * - A token identifier (for multi-asset support)
 */
export function createCommitment(
  nullifierPreimage: FieldElement,
  secret: FieldElement,
  epoch: FieldElement,
  tokenIdentifier: FieldElement,
): FieldElement {
  validateBigint(nullifierPreimage, 'nullifierPreimage', 'createCommitment');
  validateBigint(secret, 'secret', 'createCommitment');
  validateBigint(epoch, 'epoch', 'createCommitment');
  validateBigint(tokenIdentifier, 'tokenIdentifier', 'createCommitment');
  return poseidon4([nullifierPreimage, secret, epoch, tokenIdentifier]);
}

/**
 * Compute a nullifier from its preimage and secret.
 * nullifier = Poseidon(nullifierPreimage, secret)
 *
 * The nullifier is revealed when spending a note. It prevents double-spending
 * without revealing which note was spent.
 */
export function computeNullifier(
  nullifierPreimage: FieldElement,
  secret: FieldElement,
): FieldElement {
  validateBigint(nullifierPreimage, 'nullifierPreimage', 'computeNullifier');
  validateBigint(secret, 'secret', 'computeNullifier');
  return poseidon2([nullifierPreimage, secret]);
}

/**
 * Create a balance commitment (account-model, 4 inputs with nonce binding).
 * commitment = Poseidon(balance, Poseidon(salt, nonce), ownerPubkey, tokenMint)
 *
 * The nonce is bound into the salt via an inner Poseidon hash to prevent replay attacks.
 * Matches the BalanceCommitment template in confidential_balance.circom.
 */
export function createBalanceCommitment(
  balance: FieldElement,
  salt: FieldElement,
  nonce: FieldElement,
  ownerPubkey: FieldElement,
  tokenMint: FieldElement,
): FieldElement {
  validateBigint(balance, 'balance', 'createBalanceCommitment');
  validateBigint(salt, 'salt', 'createBalanceCommitment');
  validateBigint(nonce, 'nonce', 'createBalanceCommitment');
  validateBigint(ownerPubkey, 'ownerPubkey', 'createBalanceCommitment');
  validateBigint(tokenMint, 'tokenMint', 'createBalanceCommitment');
  const augmentedSalt = poseidon2([salt, nonce]);
  return poseidon4([balance, augmentedSalt, ownerPubkey, tokenMint]);
}

/**
 * Derive an owner public key from a spending key.
 * ownerPubkey = Poseidon(spendingKey, 0) — domain tag 0
 * Matches circuit SpendingKeyDerivation in poseidon.circom.
 */
export function deriveOwnerPubkey(spendingKey: FieldElement): FieldElement {
  return poseidon2([spendingKey, 0n]);
}

import { poseidon2, poseidon4 } from 'poseidon-lite';
import type { FieldElement } from './types';

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
  return poseidon2([nullifierPreimage, secret]);
}

/**
 * Create a balance commitment (account-model, 4 inputs).
 * commitment = Poseidon(balance, salt, ownerPubkey, tokenMint)
 */
export function createBalanceCommitment(
  balance: FieldElement,
  salt: FieldElement,
  ownerPubkey: FieldElement,
  tokenMint: FieldElement,
): FieldElement {
  return poseidon4([balance, salt, ownerPubkey, tokenMint]);
}

/**
 * Derive an owner public key from a spending key.
 * ownerPubkey = Poseidon(spendingKey)
 */
export function deriveOwnerPubkey(spendingKey: FieldElement): FieldElement {
  return poseidon2([spendingKey, 0n]);
}

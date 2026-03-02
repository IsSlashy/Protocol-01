import { poseidon2 } from 'poseidon-lite';
import type { FieldElement } from './types';

/**
 * Create an amount commitment that links sender and recipient.
 *
 * amountHash = Poseidon(amount, salt)
 *
 * Both sender and recipient include this hash in their proofs.
 * Since they use the same amount and salt, the hashes match,
 * proving conservation (sender debited == recipient credited)
 * without revealing the amount publicly.
 *
 * The salt must be shared between sender and recipient out-of-band.
 */
export function createAmountHash(
  amount: FieldElement,
  salt: FieldElement,
): FieldElement {
  return poseidon2([amount, salt]);
}

/**
 * Zero amount hash: Poseidon(0, 0).
 * Used for deposit/withdraw operations where no private transfer occurs.
 */
export function zeroAmountHash(): FieldElement {
  return createAmountHash(0n, 0n);
}

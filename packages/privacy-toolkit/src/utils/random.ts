import type { FieldElement } from '../commitment/types';

/** BN254 scalar field order */
const FIELD_ORDER = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617'
);

/**
 * Generate a cryptographically random field element in the BN254 scalar field.
 * Requires crypto.getRandomValues (CSPRNG) — no insecure fallback.
 */
export function randomFieldElement(): FieldElement {
  const bytes = new Uint8Array(32);
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    throw new Error('CSPRNG not available — crypto.getRandomValues is required for secure operation');
  }
  let n = 0n;
  for (let i = 0; i < 32; i++) n = (n << 8n) | BigInt(bytes[i]);
  return n % FIELD_ORDER;
}

/**
 * Generate a random secret for use in commitments.
 */
export function generateSecret(): FieldElement {
  return randomFieldElement();
}

/**
 * Generate a random nullifier preimage.
 */
export function generateNullifierPreimage(): FieldElement {
  return randomFieldElement();
}

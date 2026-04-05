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
  if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.getRandomValues) {
    throw new Error('CSPRNG not available — crypto.getRandomValues is required for secure operation');
  }
  // Rejection sampling: avoid modular bias by only accepting values < FIELD_ORDER
  while (true) {
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    let n = 0n;
    for (let i = 0; i < 32; i++) n = (n << 8n) | BigInt(bytes[i]);
    if (n < FIELD_ORDER) return n;
  }
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

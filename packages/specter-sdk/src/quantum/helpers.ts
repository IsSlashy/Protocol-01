/**
 * Helper functions for hash-timelock vault and commit-reveal protocol
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';

// ── Hash-Timelock Vault ───────────────────────────────────────────

/**
 * Generate a random 32-byte vault secret.
 * Store this securely — it's the quantum-safe authorization credential.
 */
export function generateVaultSecret(): Uint8Array {
  return randomBytes(32);
}

/**
 * Compute the commitment for a hash-timelock vault: SHA-256(secret).
 * The commitment is stored on-chain; the secret stays with the user.
 */
export function computeHashVaultCommitment(secret: Uint8Array): Uint8Array {
  return sha256(secret);
}

// ── Commit-Then-Reveal ────────────────────────────────────────────

/**
 * Generate a random 32-byte nonce for commit-reveal.
 */
export function generateNonce(): Uint8Array {
  return randomBytes(32);
}

/**
 * Compute commitment hash: SHA-256(action_data || nonce).
 * Must match on-chain verification exactly.
 */
export function computeCommitment(actionData: Uint8Array, nonce: Uint8Array): Uint8Array {
  const combined = new Uint8Array(actionData.length + nonce.length);
  combined.set(actionData);
  combined.set(nonce, actionData.length);
  return sha256(combined);
}

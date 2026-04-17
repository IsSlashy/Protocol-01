/**
 * P4.5 — SHA-512 commitments for very-long-lived authorization records.
 *
 * The existing hash-timelock vault and commit-reveal primitives use SHA-256.
 * Under Grover's algorithm, SHA-256 preimage resistance drops from 2^256 to
 * 2^128 — still computationally infeasible for any adversary we can project.
 * For almost every on-chain commitment in Protocol 01, SHA-256 is sufficient
 * and has a crucial advantage on Solana: the `sha256` syscall is
 * hardware-accelerated (~1K CU per hash), while SHA-512 has no syscall and
 * runs in software (~30-50K CU per hash).
 *
 * This module is for the few cases where the margin of SHA-256 is *not*
 * sufficient on its own:
 *   - commitments meant to survive multi-decade (30+ year) storage where
 *     future constant-factor improvements to Grover could matter
 *   - commitments that authorize very-high-value cold-storage vaults where
 *     the extra ~2^128 preimage margin is worth paying for
 *   - hash-based signature pubkey commitments that are the cryptographic
 *     bottleneck of a scheme (currently none in Protocol 01 — WOTS+ chain
 *     security dominates the PK-hash at SHA-256)
 *
 * It is NOT a drop-in replacement for the on-chain `p01_quantum_vault`
 * commitments. Those store 32-byte SHA-256 digests and use the Solana
 * SHA-256 syscall on reveal. Migrating those to SHA-512 would:
 *   - double the PDA commitment size (32 → 64 bytes)
 *   - add 30-50x the reveal CU cost
 *   - require a v2 instruction variant + backward-compat logic
 * without materially changing the practical security of the vault (2^128 PQ
 * is already unreachable).
 *
 * Callers who need the extra margin should use this primitive off-chain
 * (e.g., for client-side key derivation, seed-phrase commitment archives,
 * or future v2 instructions that explicitly opt into 64-byte commitments).
 */
import { sha512 } from '@noble/hashes/sha512';
import { randomBytes } from '@noble/hashes/utils';
import { constantTimeEqual } from '../utils/crypto';

// ── Constants ─────────────────────────────────────────────────────────────

/** SHA-512 digest size in bytes. */
export const LONG_TERM_COMMIT_SIZE = 64;

/** Domain-separation tag mixed into every long-term commitment. */
export const LONG_TERM_COMMIT_DOMAIN = new TextEncoder().encode(
  'p01:long-term-commit-v1',
);

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Generate a random 32-byte secret suitable for a long-term commitment.
 * The secret is the preimage the holder keeps; the commitment is what gets
 * stored publicly. Storage of the secret is the caller's responsibility.
 */
export function generateLongTermSecret(): Uint8Array {
  return randomBytes(32);
}

/**
 * Compute a long-term commitment: SHA-512(domain || secret || salt).
 *
 * The domain tag prevents any collision between this scheme and other
 * SHA-512 uses in the codebase. The optional salt lets callers build a
 * per-record commitment without changing the secret (e.g., so one master
 * secret can authorize multiple independent records, each with a different
 * salt).
 *
 * Returns a 64-byte digest — twice the size of the SHA-256 commitment used
 * by `computeHashVaultCommitment`, and with ~2^256 classical / ~2^128
 * quantum (Grover) collision resistance on the full digest, and ~2^512
 * classical / ~2^256 quantum preimage resistance.
 *
 * @param secret - the preimage held by the authorized party
 * @param salt   - optional per-record salt (any length); default: empty
 */
export function computeLongTermCommitment(
  secret: Uint8Array,
  salt?: Uint8Array,
): Uint8Array {
  const saltBytes = salt ?? new Uint8Array(0);
  const input = new Uint8Array(
    LONG_TERM_COMMIT_DOMAIN.length + secret.length + saltBytes.length,
  );
  let offset = 0;
  input.set(LONG_TERM_COMMIT_DOMAIN, offset);
  offset += LONG_TERM_COMMIT_DOMAIN.length;
  input.set(secret, offset);
  offset += secret.length;
  input.set(saltBytes, offset);
  return sha512(input);
}

/**
 * Verify a long-term commitment in constant time.
 *
 * Recomputes `computeLongTermCommitment(secret, salt)` and compares the
 * result against the stored commitment. Constant-time comparison is used to
 * avoid leaking bit-position information in case this is ever run inside a
 * longer pipeline that could be timed by an attacker.
 */
export function verifyLongTermCommitment(
  commitment: Uint8Array,
  secret: Uint8Array,
  salt?: Uint8Array,
): boolean {
  if (commitment.length !== LONG_TERM_COMMIT_SIZE) return false;
  const expected = computeLongTermCommitment(secret, salt);
  return constantTimeEqual(commitment, expected);
}

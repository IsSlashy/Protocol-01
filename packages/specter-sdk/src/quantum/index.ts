/**
 * Quantum-safe vault SDK
 *
 * Application-layer defenses against quantum attacks on Ed25519:
 * 1. Winternitz OTS (WOTS+) — hash-based one-time signatures
 * 2. Hash-timelock vault — SHA-256 preimage lock
 * 3. Commit-then-reveal — two-phase transaction authorization
 */

export {
  // WOTS+ types
  type WotsKeypair,
  type WotsSignature,
  // WOTS+ functions
  generateWotsKeypair,
  wotsSign,
  wotsVerify,
  deriveWotsKeypair,
  computeWithdrawMessage,
  // WOTS+ constants
  WOTS_CHAINS,
  WOTS_W,
  WOTS_SIG_SIZE,
  WOTS_PUBKEY_SIZE,
  HASH_SIZE,
} from './wots';

export {
  // Hash vault
  computeHashVaultCommitment,
  generateVaultSecret,
  // Commit-reveal
  computeCommitment,
  generateNonce,
} from './helpers';

export {
  // Long-term (SHA-512) commitments — P4.5
  computeLongTermCommitment,
  generateLongTermSecret,
  verifyLongTermCommitment,
  LONG_TERM_COMMIT_SIZE,
  LONG_TERM_COMMIT_DOMAIN,
} from './longTermCommit';

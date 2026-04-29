/**
 * `@protocol-01/zk-sdk` — STARK-native utilities for Protocol 01 shielded
 * transactions on Solana.
 *
 * v1.0.0 BREAKING CHANGE: dropped the v0.x Groth16 + snarkjs surface and the
 * high-level `ShieldedClient` facade. Use {@link STARK_CIRCUITS} +
 * {@link createStarkProver} for proof generation, or the higher-level
 * `@protocol-01/privacy-sdk` for end-to-end shield / transfer / unshield
 * transaction flows backed by `p01_stark_verifier` on Solana.
 */

// Note management (UTXO note encryption + spending key helpers)
export {
  Note,
  EncryptedNote,
  createNote,
  encryptNote,
  decryptNote,
  type NoteData,
} from './notes';

// Merkle tree utilities
export {
  MerkleTree,
  generateMerkleProof,
  verifyMerkleProof,
  type MerkleProof,
} from './merkle';

// STARK prover wiring (re-exports from `@protocol-01/stark-prover` plus
// circuit-id helpers).
export {
  createStarkProver,
  STARK_CIRCUITS,
  requestTransferProof,
  requestMerkleUpdateProof,
  type StarkProofGenerator,
  type StarkProofOutcome,
  type StarkProverConfig,
  type StarkCircuitId,
} from './prover';

// Circuit utilities (Goldilocks-Poseidon hash primitives)
export {
  poseidonHash,
  computeCommitment,
  computeNullifier,
  deriveOwnerPubkey,
  computeSpendingKeyHash,
} from './circuits';

// Types
export * from './types';

// Constants & configuration
export {
  FIELD_MODULUS,
  MERKLE_TREE_DEPTH,
  MAX_TREE_LEAVES,
  ZERO_VALUE,
  ZK_SHIELDED_PROGRAM_ID,
  STARK_VERIFIER_PROGRAM_ID,
  PDA_SEEDS,
  ENCRYPTION,
  DEFAULT_RELAYER_FEE_BPS,
  MAX_RELAYER_FEE_BPS,
  MAX_HISTORICAL_ROOTS,
  PROOF_GENERATION_TIMEOUT,
  PROGRAM_IDS,
  getProgramId,
  IX_DISCRIMINATORS,
  type NetworkId,
} from './constants';

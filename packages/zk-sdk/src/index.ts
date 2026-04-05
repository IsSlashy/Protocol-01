// Main exports for @protocol-01/zk-sdk

// Core client
export { ShieldedClient, type ShieldedClientConfig } from './client';

// Note management
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

// Prover utilities
export {
  ZkProver,
  generateProof,
  type ProofInputs,
  type Groth16Proof,
  type ZkProverConfig,
} from './prover';

// Circuit utilities
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
  PDA_SEEDS,
  ENCRYPTION,
  DEFAULT_RELAYER_FEE_BPS,
  MAX_RELAYER_FEE_BPS,
  MAX_HISTORICAL_ROOTS,
  PROOF_GENERATION_TIMEOUT,
  CIRCUIT_FILES,
  PROGRAM_IDS,
  getProgramId,
  IX_DISCRIMINATORS,
  type NetworkId,
} from './constants';

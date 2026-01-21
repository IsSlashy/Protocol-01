// Main exports for @specter-protocol/zk-sdk

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
} from './prover';

// Circuit utilities
export {
  poseidonHash,
  computeCommitment,
  computeNullifier,
  deriveOwnerPubkey,
  FIELD_MODULUS,
} from './circuits';

// Types
export * from './types';

// Constants
export * from './constants';

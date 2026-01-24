/**
 * Constants for the ZK shielded system
 */

/**
 * BN254 field modulus
 */
export const FIELD_MODULUS = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617'
);

/**
 * Default Merkle tree depth (2^20 = ~1M notes)
 */
export const MERKLE_TREE_DEPTH = 20;

/**
 * Maximum tree leaves
 */
export const MAX_TREE_LEAVES = 2 ** MERKLE_TREE_DEPTH;

/**
 * Zero value for empty Merkle tree leaves
 * Computed as Poseidon(0)
 */
export const ZERO_VALUE = BigInt(
  '21663839004416932945382355908790599225266501822907911457504978515578255421292'
);

/**
 * Program ID for the ZK shielded pool (deployed on devnet)
 */
export const ZK_SHIELDED_PROGRAM_ID = '8dK17NxQUFPWsLg7eJphiCjSyVfBk2ywC5GU6ctK4qrY';

/**
 * Seed prefixes for PDA derivation
 */
export const PDA_SEEDS = {
  SHIELDED_POOL: Buffer.from('shielded_pool'),
  MERKLE_TREE: Buffer.from('merkle_tree'),
  NULLIFIER_SET: Buffer.from('nullifier_set'),
  NULLIFIER_BATCH: Buffer.from('nullifier_batch'),
} as const;

/**
 * Encryption constants
 */
export const ENCRYPTION = {
  /** XChaCha20-Poly1305 nonce size */
  NONCE_SIZE: 24,
  /** Encrypted note overhead (nonce + tag) */
  OVERHEAD: 40,
  /** Key size */
  KEY_SIZE: 32,
} as const;

/**
 * Default relayer fee in basis points (0.1%)
 */
export const DEFAULT_RELAYER_FEE_BPS = 10;

/**
 * Maximum relayer fee in basis points (1%)
 */
export const MAX_RELAYER_FEE_BPS = 100;

/**
 * Number of historical roots to keep
 */
export const MAX_HISTORICAL_ROOTS = 100;

/**
 * Proof generation timeout (ms)
 */
export const PROOF_GENERATION_TIMEOUT = 120000; // 2 minutes

/**
 * Circuit files
 */
export const CIRCUIT_FILES = {
  WASM: 'transfer.wasm',
  ZKEY: 'transfer_final.zkey',
  VK: 'verification_key.json',
} as const;

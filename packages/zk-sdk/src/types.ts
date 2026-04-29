import { PublicKey } from '@solana/web3.js';

// Re-export host-supplied STARK prover types so consumers of this SDK
// don't have to take an extra dep on `@protocol-01/stark-prover`.
export type {
  StarkProofOutcome,
  StarkProofGenerator,
  StarkProverConfig,
  StarkCircuitId,
} from '@protocol-01/stark-prover';

/**
 * 32-byte array type alias
 */
export type Bytes32 = Uint8Array;

/**
 * Field element (BigInt within the Goldilocks field, p = 2^64 - 2^32 + 1).
 * All on-chain commitments / nullifiers / merkle leaves are Goldilocks u64s
 * packed into the low 8 bytes of a 32-byte LE buffer.
 */
export type FieldElement = bigint;

/**
 * Represents a shielded note
 */
export interface NoteData {
  /** Amount in lamports/atomic units */
  amount: bigint;
  /** Owner's public key (derived from spending key) */
  ownerPubkey: FieldElement;
  /** Random blinding factor */
  randomness: FieldElement;
  /** Token mint address as field element */
  tokenMint: FieldElement;
  /** Computed commitment */
  commitment: FieldElement;
  /** Leaf index in Merkle tree (if inserted) */
  leafIndex?: number;
}

/**
 * Encrypted note for storage
 */
export interface EncryptedNoteData {
  /** Encrypted ciphertext */
  ciphertext: Uint8Array;
  /** Ephemeral public key for decryption */
  ephemeralPubkey: Uint8Array;
  /** Note commitment (public) */
  commitment: Bytes32;
  /** Encryption nonce */
  nonce: Uint8Array;
}

/**
 * Merkle proof for note membership
 */
export interface MerkleProofData {
  /** Path indices (0 = left, 1 = right) */
  pathIndices: number[];
  /** Sibling hashes along the path */
  pathElements: FieldElement[];
  /** Leaf index */
  leafIndex: number;
}

/**
 * Canonical STARK private-input shape. Each circuit has its own set of keys
 * — see the per-circuit dispatch in `@protocol-01/stark-prover/src/index.ts`
 * (`generateProofBytes`) and the worker contract in
 * `apps/extension/src/shared/workers/starkProver.worker.ts:43-67` for the
 * authoritative key names.
 *
 * Values are decimal strings (or string arrays / number arrays for the
 * merkle-path / merkle-update circuits). The SDK forwards this map verbatim
 * to the host-supplied `generateStarkProof`.
 */
export type StarkPrivateInputs = Record<string, string | string[] | number[]>;

/**
 * Public inputs derivable for a circuit-5 (transfer) STARK proof. Returned
 * inside `StarkProofOutcome.publicInputs` once the prover has finished.
 *
 * Order matches the on-chain verifier:
 *   [nullifier1, nullifier2, outputCommitment1, outputCommitment2, publicAmount, tokenMint]
 */
export interface TransferPublicInputs {
  merkleRoot: FieldElement;
  nullifier1: FieldElement;
  nullifier2: FieldElement;
  outputCommitment1: FieldElement;
  outputCommitment2: FieldElement;
  publicAmount: bigint;
  tokenMint: FieldElement;
}

/**
 * ZK Address for receiving shielded payments
 */
export interface ZkAddress {
  /** Receiving public key (for commitment) */
  receivingPubkey: FieldElement;
  /** Viewing key for scanning notes */
  viewingKey: Uint8Array;
  /** Encoded string format */
  encoded: string;
}

/**
 * Shielded pool state
 */
export interface PoolState {
  /** Pool public key */
  pubkey: PublicKey;
  /** Token mint */
  tokenMint: PublicKey;
  /** Current Merkle root */
  merkleRoot: Bytes32;
  /** Tree depth */
  treeDepth: number;
  /** Next leaf index */
  nextLeafIndex: number;
  /** Total shielded amount */
  totalShielded: bigint;
  /** Pool active status */
  isActive: boolean;
}

/**
 * Transaction result
 */
export interface ShieldedTxResult {
  /** Transaction signature */
  signature: string;
  /** New note commitments created */
  newCommitments: Bytes32[];
  /** Nullifiers spent */
  nullifiersSpent: Bytes32[];
  /** New Merkle root */
  newRoot: Bytes32;
}

/**
 * Spending key pair
 */
export interface SpendingKeyPair {
  /** Private spending key */
  spendingKey: FieldElement;
  /** Derived owner pubkey */
  ownerPubkey: FieldElement;
  /** For nullifier computation */
  spendingKeyHash: FieldElement;
}

/**
 * Note scan result
 */
export interface NoteScanResult {
  /** Found notes */
  notes: NoteData[];
  /** Scanned up to this leaf index */
  scannedToIndex: number;
  /** Total balance */
  totalBalance: bigint;
}

/**
 * Network configuration options for SDK clients.
 * These can be passed into ShieldedClientConfig or used standalone.
 */
export interface NetworkConfig {
  /**
   * Solana network to connect to.
   * Determines which program ID is used by default.
   * @default 'devnet'
   */
  network?: 'devnet' | 'mainnet-beta' | 'localnet';

  /**
   * Override the program ID directly. Takes precedence over the `network` field.
   * Use this when deploying a custom instance of the ZK shielded program.
   */
  programId?: string;

  /**
   * Override the STARK verifier program ID. Takes precedence over the
   * default `p01_stark_verifier` ID baked into this package.
   */
  starkVerifierProgramId?: string;
}

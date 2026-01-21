import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';

/**
 * 32-byte array type alias
 */
export type Bytes32 = Uint8Array;

/**
 * Field element (BigInt within BN254 field)
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
 * Groth16 proof structure
 */
export interface Groth16ProofData {
  /** G1 point pi_a (compressed) */
  pi_a: Uint8Array;
  /** G2 point pi_b (compressed) */
  pi_b: Uint8Array;
  /** G1 point pi_c (compressed) */
  pi_c: Uint8Array;
}

/**
 * Public inputs for transfer proof
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
 * Private inputs for transfer proof
 */
export interface TransferPrivateInputs {
  // Input note 1
  inAmount1: bigint;
  inOwnerPubkey1: FieldElement;
  inRandomness1: FieldElement;
  inPathIndices1: number[];
  inPathElements1: FieldElement[];

  // Input note 2
  inAmount2: bigint;
  inOwnerPubkey2: FieldElement;
  inRandomness2: FieldElement;
  inPathIndices2: number[];
  inPathElements2: FieldElement[];

  // Output note 1
  outAmount1: bigint;
  outRecipient1: FieldElement;
  outRandomness1: FieldElement;

  // Output note 2
  outAmount2: bigint;
  outRecipient2: FieldElement;
  outRandomness2: FieldElement;

  // Spending key
  spendingKey: FieldElement;
}

/**
 * Full proof inputs (public + private)
 */
export interface FullProofInputs {
  public: TransferPublicInputs;
  private: TransferPrivateInputs;
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

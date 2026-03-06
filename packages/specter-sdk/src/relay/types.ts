import type { PublicKey, Transaction, Connection } from '@solana/web3.js';

// ============================================================================
// Relayer Program Constants
// ============================================================================

export const RELAYER_PROGRAM_ID_DEVNET = '2okhzLVr6FEq5jP19KT6VurcSutx2zE4RhkRamrk5WpW';

export const RELAY_SEEDS = {
  CONFIG: 'relayer_config',
  RELAYER_NODE: 'relayer_node',
  RELAY_JOB: 'relay_job',
} as const;

// ============================================================================
// Types
// ============================================================================

/** On-chain relayer node data */
export interface RelayerNodeInfo {
  /** Relayer node PDA */
  address: PublicKey;
  /** Operator wallet */
  operator: PublicKey;
  /** X25519 encryption public key (32 bytes) */
  encryptionKey: Uint8Array;
  /** SOL staked in lamports */
  stake: number;
  /** Successful jobs */
  jobsCompleted: number;
  /** Failed/expired jobs */
  jobsFailed: number;
  /** Reputation score (0-10000) */
  reputationScore: number;
  /** Whether currently active */
  isActive: boolean;
}

/** On-chain relayer config */
export interface RelayerConfigInfo {
  authority: PublicKey;
  minStake: number;
  maxRelayers: number;
  jobFeeLamports: number;
  protocolFeeBps: number;
  protocolFeeWallet: PublicKey;
  jobTimeoutSlots: number;
  activeRelayerCount: number;
  isActive: boolean;
}

/** Job status enum matching on-chain */
export enum JobStatus {
  Pending = 0,
  Completed = 1,
  Expired = 2,
  Cancelled = 3,
}

/** On-chain relay job data */
export interface RelayJobInfo {
  address: PublicKey;
  jobId: Uint8Array;
  assignedRelayer: PublicKey;
  submitter: PublicKey;
  feeLamports: number;
  postedAtSlot: number;
  deadlineSlot: number;
  status: JobStatus;
}

/** Options for submitting a relay job */
export interface SubmitRelayJobOptions {
  /** Solana connection */
  connection: Connection;
  /** Relayer program ID */
  programId: PublicKey;
  /** The serialized transaction to relay (will be encrypted) */
  transaction: Transaction;
  /** Ephemeral keypair to submit the job (should not be linked to user's main wallet) */
  ephemeralKeypair: import('@solana/web3.js').Keypair;
  /** Override the relayer to use (if not set, uses deterministic selection) */
  relayerOverride?: PublicKey;
  /** Timeout in ms to wait for job completion (default: 120_000) */
  timeout?: number;
}

/** Result of submitting a relay job */
export interface RelayJobResult {
  /** Job ID (32 bytes) */
  jobId: Uint8Array;
  /** Job PDA address */
  jobAddress: PublicKey;
  /** Assigned relayer */
  assignedRelayer: PublicKey;
  /** Submission tx signature */
  submitSignature: string;
  /** Fee paid in lamports */
  feePaid: number;
  /** Deadline slot for completion */
  deadlineSlot: number;
}

/** Result of monitoring a job */
export interface JobCompletionResult {
  /** Whether the job completed successfully */
  success: boolean;
  /** Final job status */
  status: JobStatus;
  /** Completion tx signature (if completed) */
  txSignature?: string;
}

/** Encrypted payload format: ephemeral_pubkey (32) || nonce (24) || ciphertext */
export const ENCRYPTED_PAYLOAD_OVERHEAD = 32 + 24 + 16; // pubkey + nonce + Poly1305 tag

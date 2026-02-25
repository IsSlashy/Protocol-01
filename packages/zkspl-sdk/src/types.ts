import { PublicKey } from '@solana/web3.js';

// ---------------------------------------------------------------------------
// Field / byte aliases
// ---------------------------------------------------------------------------

/** 32-byte array (commitment, hash, etc.) */
export type Bytes32 = Uint8Array;

/** BN254 field element */
export type FieldElement = bigint;

// ---------------------------------------------------------------------------
// Groth16 proof (on-chain representation)
// ---------------------------------------------------------------------------

/** Groth16 proof structure matching the Anchor IDL Groth16Proof type */
export interface Groth16Proof {
  /** G1 point pi_a (64 bytes: x || y) */
  pi_a: Uint8Array; // [u8; 64]
  /** G2 point pi_b (128 bytes: x0 || x1 || y0 || y1) */
  pi_b: Uint8Array; // [u8; 128]
  /** G1 point pi_c (64 bytes: x || y) */
  pi_c: Uint8Array; // [u8; 64]
}

// ---------------------------------------------------------------------------
// On-chain account types (deserialized from Anchor)
// ---------------------------------------------------------------------------

/** On-chain MintConfig account */
export interface MintConfigAccount {
  authority: PublicKey;
  tokenMint: PublicKey;
  balanceVkHash: Bytes32;
  proofVkHash: Bytes32;
  isActive: boolean;
  accountCount: bigint;
  createdAt: bigint;
  bump: number;
}

/** On-chain PendingCredit entry */
export interface PendingCredit {
  amountHash: Bytes32;
  sender: PublicKey;
  timestamp: bigint;
}

/** On-chain ConfidentialAccount */
export interface ConfidentialAccountData {
  owner: PublicKey;
  mint: PublicKey;
  balanceCommitment: Bytes32;
  nonce: bigint;
  pendingCredits: PendingCredit[];
  viewerKeys: PublicKey[];
  isInitialized: boolean;
  createdAt: bigint;
  lastTxAt: bigint;
  bump: number;
}

// ---------------------------------------------------------------------------
// Circuit input types
// ---------------------------------------------------------------------------

/**
 * Public inputs for the confidential_balance circuit.
 *
 * Matches: old_commitment, new_commitment, amount_hash,
 *          public_credit, public_debit, token_mint, nonce
 */
export interface ConfidentialBalancePublicInputs {
  oldCommitment: FieldElement;
  newCommitment: FieldElement;
  amountHash: FieldElement;
  publicCredit: bigint;
  publicDebit: bigint;
  tokenMint: FieldElement;
  nonce: bigint;
}

/**
 * Private inputs for the confidential_balance circuit.
 */
export interface ConfidentialBalancePrivateInputs {
  oldBalance: bigint;
  oldSalt: FieldElement;
  newBalance: bigint;
  newSalt: FieldElement;
  amount: bigint;
  amountSalt: FieldElement;
  spendingKey: FieldElement;
  isDebit: 0 | 1;
}

/**
 * Public inputs for the balance_proof (sufficiency) circuit.
 *
 * Matches: balance_commitment, threshold, token_mint
 */
export interface BalanceProofPublicInputs {
  balanceCommitment: FieldElement;
  threshold: bigint;
  tokenMint: FieldElement;
}

/**
 * Private inputs for the balance_proof circuit.
 */
export interface BalanceProofPrivateInputs {
  balance: bigint;
  salt: FieldElement;
  spendingKey: FieldElement;
}

// ---------------------------------------------------------------------------
// Local state types
// ---------------------------------------------------------------------------

/** Persisted local state for a single (owner, mint) confidential account */
export interface LocalAccountState {
  /** The SPL token mint (base58) */
  tokenMint: string;
  /** Current plaintext balance known to the owner */
  balance: bigint;
  /** Current salt used in the on-chain commitment */
  salt: FieldElement;
  /** Current on-chain nonce */
  nonce: bigint;
  /** Owner spending key (encrypted at rest by the caller) */
  spendingKey: FieldElement;
  /** Pending credits the owner knows about but has not applied yet */
  knownPendingCredits: KnownPendingCredit[];
}

/** A pending credit the owner has the plaintext amount for */
export interface KnownPendingCredit {
  /** Poseidon(amount, amountSalt) */
  amountHash: FieldElement;
  /** Plaintext amount */
  amount: bigint;
  /** Salt used in the amount commitment */
  amountSalt: FieldElement;
  /** Sender pubkey (base58) */
  sender: string;
}

// ---------------------------------------------------------------------------
// Prover configuration
// ---------------------------------------------------------------------------

/** Configuration for proof generation */
export interface ProverConfig {
  /** URL of a remote Rust prover (e.g., http://localhost:3001/prove) */
  remoteProverUrl?: string;
  /**
   * URL of the relayer for proof generation via its zkSPL endpoints.
   * e.g., "https://relayer.example.com" (without trailing slash).
   *
   * When set, the prover will first attempt to generate proofs via:
   *   POST {relayerUrl}/api/zkspl/prove/deposit
   *   POST {relayerUrl}/api/zkspl/prove/withdraw
   *   POST {relayerUrl}/api/zkspl/prove/transfer
   *   POST {relayerUrl}/api/zkspl/prove/balance-proof
   *
   * Falls back to remoteProverUrl (Rust prover), then local snarkjs.
   */
  relayerUrl?: string;
  /** Path / URL of the confidential_balance circuit WASM */
  balanceWasmPath?: string;
  /** Path / URL of the confidential_balance circuit zkey */
  balanceZkeyPath?: string;
  /** Path / URL of the balance_proof circuit WASM */
  proofWasmPath?: string;
  /** Path / URL of the balance_proof circuit zkey */
  proofZkeyPath?: string;
  /** Timeout for proof generation in ms (default 120000) */
  timeout?: number;
}

/**
 * The operation type for proof generation.
 * Used to route to the correct relayer endpoint.
 */
export type ZkSplOperationType = 'deposit' | 'withdraw' | 'transfer' | 'balance-proof';

// ---------------------------------------------------------------------------
// Transaction result
// ---------------------------------------------------------------------------

/** Result of an on-chain zkSPL operation */
export interface ZkSplTxResult {
  /** Solana transaction signature */
  signature: string;
  /** New balance commitment written on-chain */
  newCommitment: Bytes32;
  /** Updated local balance (after operation) */
  newBalance: bigint;
  /** Updated nonce */
  newNonce: bigint;
}

// ---------------------------------------------------------------------------
// Events (emitted by the program)
// ---------------------------------------------------------------------------

export interface AccountCreatedEvent {
  owner: PublicKey;
  mint: PublicKey;
  timestamp: bigint;
}

export interface DepositEvent {
  owner: PublicKey;
  mint: PublicKey;
  amount: bigint;
  newCommitment: Bytes32;
  nonce: bigint;
  timestamp: bigint;
}

export interface WithdrawEvent {
  owner: PublicKey;
  mint: PublicKey;
  amount: bigint;
  newCommitment: Bytes32;
  nonce: bigint;
  timestamp: bigint;
}

export interface TransferEvent {
  sender: PublicKey;
  recipient: PublicKey;
  mint: PublicKey;
  amountHash: Bytes32;
  senderNonce: bigint;
  timestamp: bigint;
}

export interface ApplyPendingEvent {
  owner: PublicKey;
  mint: PublicKey;
  amountHash: Bytes32;
  nonce: bigint;
  remainingPending: number;
  timestamp: bigint;
}

export interface BalanceProofEvent {
  owner: PublicKey;
  mint: PublicKey;
  threshold: bigint;
  verified: boolean;
  timestamp: bigint;
}

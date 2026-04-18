import { PublicKey } from '@solana/web3.js';

// ---------------------------------------------------------------------------
// Field / byte aliases
// ---------------------------------------------------------------------------

/** 32-byte array (commitment, hash, etc.) */
export type Bytes32 = Uint8Array;

/** BN254 field element */
export type FieldElement = bigint;

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
 * Public inputs for the STARK `confidential_balance` circuit (ID 4) —
 * consumed by deposit, withdraw, apply_pending, and (indirectly) transfer
 * when callers prepare their STARK proof.
 *
 * Order (must match proof generation):
 *   old_commitment, new_commitment, amount_hash,
 *   public_credit, public_debit, token_mint, nonce
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
 * Public inputs for the STARK `balance_proof` circuit (ID 2).
 *
 * Order: balance_commitment, threshold, token_mint
 */
export interface BalanceProofPublicInputs {
  balanceCommitment: FieldElement;
  threshold: bigint;
  tokenMint: FieldElement;
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
// STARK proof reference (passed to zkSPL instructions)
// ---------------------------------------------------------------------------

/**
 * Circuit identifiers used by `p01_stark_verifier` and reconstructed by zkSPL.
 * Must stay in sync with the Rust `stark_proof` module.
 *
 * NOTE: zkSPL's confidential_transfer uses circuit 4 (confidential_balance)
 * for the sender's commitment update. Circuit 5 (transfer, UTXO-style) is
 * used by `zk_shielded` denominated pools, not here.
 */
export const CIRCUIT_BALANCE_PROOF = 2;
export const CIRCUIT_CONFIDENTIAL_BALANCE = 4;

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

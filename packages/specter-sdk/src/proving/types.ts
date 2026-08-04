// ============================================================================
// Client-Side zkSPL Prover — Type Definitions (STARK migration)
// ============================================================================
//
// TRUST THE MATH, NOT THE NODES.
// Every type here is designed to ensure private data NEVER leaves the device.
// The spending_key, balance, salt — all stay local.
//
// Post-quantum migration: Groth16/BN254 has been replaced by STARKs over the
// Goldilocks field, generated via `@protocol-01/stark-prover`. The high-level
// proof input shapes (deposit / withdraw / transfer / balance-proof) remain
// stable — only the proof representation changes. Public/private input
// objects continue to be authored in the host language with `bigint`s and
// then flattened to a `Record<string, string | string[] | number[]>` map for
// the WASM bindings.
//
// ============================================================================

import type { StarkProofOutcome } from '../../../stark-prover/src/types'; // relative — see client-prover.ts

// ---------------------------------------------------------------------------
// Field element alias
// ---------------------------------------------------------------------------

/**
 * Goldilocks field element.
 *
 * All circuit signals operate in the 64-bit Goldilocks field
 * (p = 2^64 - 2^32 + 1 = 18446744069414584321). Values are represented as
 * `bigint` in TypeScript and serialized to decimal strings when handed to
 * the WASM prover.
 */
export type FieldElement = bigint;

// ---------------------------------------------------------------------------
// Operation types
// ---------------------------------------------------------------------------

/**
 * The four zkSPL operations that require proof generation.
 *
 * - deposit:       SPL -> zkSPL (public_credit > 0, public_debit = 0)
 * - withdraw:      zkSPL -> SPL (public_debit > 0, public_credit = 0)
 * - transfer:      private send/receive (both public_credit and public_debit = 0)
 * - balance-proof: prove balance >= threshold without revealing actual balance
 */
export type ZkSplOperation = 'deposit' | 'withdraw' | 'transfer' | 'balance-proof';

// ---------------------------------------------------------------------------
// Confidential Balance circuit inputs (deposit / withdraw / transfer)
// ---------------------------------------------------------------------------

/**
 * Public inputs for the confidential_balance circuit.
 *
 * These are visible on-chain and bound into the STARK transcript.
 * Circuit signal order: old_commitment, new_commitment, amount_hash,
 *                       public_credit, public_debit, token_mint, nonce
 */
export interface ConfidentialBalancePublicInputs {
  /** Current on-chain balance commitment: Poseidon(balance, salt, owner_pubkey, token_mint) */
  oldCommitment: FieldElement;

  /** New balance commitment to be written on-chain */
  newCommitment: FieldElement;

  /** Poseidon(amount, amount_salt) — links sender & recipient in private transfers */
  amountHash: FieldElement;

  /** Public deposit amount (non-zero only for deposits) */
  publicCredit: bigint;

  /** Public withdraw amount (non-zero only for withdrawals) */
  publicDebit: bigint;

  /** Token mint identifier */
  tokenMint: FieldElement;

  /** Anti-replay nonce (must match on-chain account nonce) */
  nonce: bigint;
}

/**
 * Private inputs for the confidential_balance circuit.
 *
 * THESE NEVER LEAVE THE DEVICE. This is the entire point of client-side proving.
 */
export interface ConfidentialBalancePrivateInputs {
  /** Current actual balance (secret) */
  oldBalance: bigint;

  /** Current commitment salt (secret) */
  oldSalt: FieldElement;

  /** Balance after this operation (secret) */
  newBalance: bigint;

  /** New commitment salt — must differ from oldSalt for privacy (secret) */
  newSalt: FieldElement;

  /** Transfer amount for private send/receive; 0 for deposit/withdraw (secret) */
  amount: bigint;

  /** Salt for the amount commitment (secret) */
  amountSalt: FieldElement;

  /** The owner's spending key — THE most sensitive value (secret) */
  spendingKey: FieldElement;

  /** Direction: 1 = sending (debit), 0 = receiving (credit) */
  isDebit: 0 | 1;
}

// ---------------------------------------------------------------------------
// Balance Proof (sufficiency) circuit inputs
// ---------------------------------------------------------------------------

/**
 * Public inputs for the balance_proof (sufficiency) circuit.
 *
 * Proves balance >= threshold without revealing the actual balance.
 * Circuit signal order: balance_commitment, threshold, token_mint
 */
export interface BalanceProofPublicInputs {
  /** On-chain balance commitment */
  balanceCommitment: FieldElement;

  /** Minimum balance being proven */
  threshold: bigint;

  /** Token mint identifier */
  tokenMint: FieldElement;
}

/**
 * Private inputs for the balance_proof circuit.
 *
 * THESE NEVER LEAVE THE DEVICE.
 */
export interface BalanceProofPrivateInputs {
  /** Actual balance (secret) */
  balance: bigint;

  /** Commitment salt (secret) */
  salt: FieldElement;

  /** Spending key — proves ownership (secret) */
  spendingKey: FieldElement;
}

// ---------------------------------------------------------------------------
// Unified proof input types (for the prove() method)
// ---------------------------------------------------------------------------

/**
 * Inputs for a deposit proof.
 */
export interface DepositProofInputs {
  operation: 'deposit';
  public: ConfidentialBalancePublicInputs;
  private: ConfidentialBalancePrivateInputs;
}

/**
 * Inputs for a withdraw proof.
 */
export interface WithdrawProofInputs {
  operation: 'withdraw';
  public: ConfidentialBalancePublicInputs;
  private: ConfidentialBalancePrivateInputs;
}

/**
 * Inputs for a confidential transfer proof (send or receive side).
 */
export interface TransferProofInputs {
  operation: 'transfer';
  public: ConfidentialBalancePublicInputs;
  private: ConfidentialBalancePrivateInputs;
}

/**
 * Inputs for a balance sufficiency proof.
 */
export interface BalanceSufficiencyProofInputs {
  operation: 'balance-proof';
  public: BalanceProofPublicInputs;
  private: BalanceProofPrivateInputs;
}

/**
 * Union of all proof input types.
 */
export type ZkSplProofInputs =
  | DepositProofInputs
  | WithdrawProofInputs
  | TransferProofInputs
  | BalanceSufficiencyProofInputs;

// ---------------------------------------------------------------------------
// Proof output
// ---------------------------------------------------------------------------

/**
 * The result of proof generation.
 *
 * Re-exported from `@protocol-01/stark-prover`. The on-chain proof bytes
 * have already been uploaded and verified by `p01_stark_verifier`; what the
 * caller receives is a `proofBuffer` PDA (consumed by downstream programs
 * such as `zk_shielded`) plus the public inputs that were bound into the
 * transcript.
 */
export type { StarkProofOutcome } from '../../../stark-prover/src/types'; // relative — see client-prover.ts

// ---------------------------------------------------------------------------
// Prover configuration
// ---------------------------------------------------------------------------

/**
 * Re-export the STARK prover config so callers can construct a
 * `StarkClientProver` with the same shape used by the rest of the SDK.
 */
export type { StarkProverConfig } from '../../../stark-prover/src/types'; // relative — see client-prover.ts

// ---------------------------------------------------------------------------
// Validation error
// ---------------------------------------------------------------------------

/**
 * Error thrown when proof inputs fail validation.
 */
export class ProofInputValidationError extends Error {
  public readonly operation: ZkSplOperation;
  public readonly violations: string[];

  constructor(operation: ZkSplOperation, violations: string[]) {
    super(
      `Invalid ${operation} proof inputs: ${violations.join('; ')}`
    );
    this.name = 'ProofInputValidationError';
    this.operation = operation;
    this.violations = violations;
  }
}

// ---------------------------------------------------------------------------
// Internal helper alias used by the prover
// ---------------------------------------------------------------------------

/**
 * The narrow shape accepted by `StarkProofGenerator`. Re-exported so the
 * input builders below can advertise it as their return type.
 */
export type StarkPrivateInputMap = Record<string, string | string[] | number[]>;

// Pin a runtime use of the imported StarkProofOutcome so tsup keeps the
// transitive dependency edge during build (otherwise an `import type` may
// be elided and dts emit could re-resolve through the wrong path).
export type _StarkProofOutcomeReExportAnchor = StarkProofOutcome;

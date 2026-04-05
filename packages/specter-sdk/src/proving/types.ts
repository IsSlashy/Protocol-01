// ============================================================================
// Client-Side zkSPL Prover — Type Definitions
// ============================================================================
//
// TRUST THE MATH, NOT THE NODES.
// Every type here is designed to ensure private data NEVER leaves the device.
// The spending_key, balance, salt — all stay local.
//
// ============================================================================

// ---------------------------------------------------------------------------
// Field element alias
// ---------------------------------------------------------------------------

/**
 * BN254 scalar field element.
 *
 * All circuit signals operate in the BN254 field
 * (p = 21888242871839275222246405745257275088548364400416034343698204186575808495617).
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
 * These are visible on-chain and passed to the verifier contract.
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
 * Raw snarkjs proof format — the intermediate representation before
 * byte conversion for on-chain submission.
 */
export interface SnarkjsProof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
}

/**
 * The result of proof generation.
 *
 * This is the ONLY thing that leaves the device — the proof and public signals.
 * The proof reveals NOTHING about the private inputs (spending_key, balance, salt).
 */
export interface ProofResult {
  /** Groth16 proof in snarkjs format */
  proof: SnarkjsProof;

  /** Public signals (circuit outputs) as decimal strings */
  publicSignals: string[];

  /** Time taken for proof generation in milliseconds */
  provingTimeMs: number;
}

// ---------------------------------------------------------------------------
// Prover configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for circuit file locations.
 *
 * Circuit files (.wasm and .zkey) are loaded lazily from these URLs.
 * In browser: fetched via HTTP. In Node: loaded from filesystem.
 */
export interface CircuitFileConfig {
  /** URL or path to the circuit's WASM file */
  wasmUrl: string;

  /** URL or path to the circuit's proving key (.zkey) file */
  zkeyUrl: string;
}

/**
 * Full prover configuration.
 */
export interface ClientProverConfig {
  /**
   * Circuit files for the confidential_balance circuit.
   * Used for deposit, withdraw, and transfer operations.
   */
  balanceCircuit: CircuitFileConfig;

  /**
   * Circuit files for the balance_proof (sufficiency) circuit.
   * Used for proving balance >= threshold.
   */
  sufficiencyCircuit: CircuitFileConfig;

  /**
   * Base URL or directory path for circuit files.
   * When set, circuit file URLs in balanceCircuit/sufficiencyCircuit can be
   * specified as relative paths (e.g. 'confidential_balance.wasm') and they
   * will be resolved against this base.
   *
   * @example
   * ```ts
   * const prover = new ClientProver({
   *   circuitBaseUrl: 'https://cdn.example.com/circuits/',
   *   balanceCircuit: { wasmUrl: 'confidential_balance.wasm', zkeyUrl: 'confidential_balance_final.zkey' },
   *   sufficiencyCircuit: { wasmUrl: 'balance_proof.wasm', zkeyUrl: 'balance_proof_final.zkey' },
   * });
   * ```
   */
  circuitBaseUrl?: string;

  /**
   * Timeout for proof generation in milliseconds.
   * Default: 60000 (60 seconds — the circuit is small, ~1382 constraints).
   */
  timeout?: number;

  /**
   * Optional progress callback for circuit file downloads.
   * Reports bytes loaded and total bytes (if known from Content-Length).
   */
  onProgress?: ProgressCallback;
}

/**
 * Progress callback for circuit file loading.
 */
export type ProgressCallback = (event: ProgressEvent) => void;

/**
 * Progress event reported during circuit file download.
 */
export interface ProgressEvent {
  /** Which circuit is being loaded */
  circuit: 'balance' | 'sufficiency';

  /** Which file is being loaded */
  file: 'wasm' | 'zkey';

  /** Bytes loaded so far */
  loaded: number;

  /** Total bytes (0 if unknown) */
  total: number;

  /** Whether this file is fully loaded */
  done: boolean;
}

// ---------------------------------------------------------------------------
// Circuit loading state
// ---------------------------------------------------------------------------

/**
 * The loaded state of a circuit's files.
 */
export interface CircuitFiles {
  /** The compiled circuit WASM (Uint8Array or path string for Node) */
  wasm: Uint8Array | string;

  /** The proving key (Uint8Array or path string for Node) */
  zkey: Uint8Array | string;
}

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

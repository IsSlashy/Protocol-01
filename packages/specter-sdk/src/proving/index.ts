// ============================================================================
// Client-Side zkSPL Prover — Public API (STARK migration)
// ============================================================================
//
// TRUST THE MATH, NOT THE NODES.
//
// This module exports everything needed to generate zkSPL STARK proofs
// entirely on the client device. No private data ever leaves the user's
// machine. The underlying prover is `@protocol-01/stark-prover`, which uses
// post-quantum-safe STARKs over the Goldilocks field — no trusted setup, no
// elliptic-curve assumptions.
//
// ============================================================================

// ---------------------------------------------------------------------------
// Main prover class
// ---------------------------------------------------------------------------

export {
  StarkClientProver,
  buildBalanceCircuitInputs,
  buildSufficiencyCircuitInputs,
  validateInputs,
  circuitIdForOperation,
  type StarkClientProverInit,
} from './client-prover';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type {
  // Field element
  FieldElement,

  // Operation type
  ZkSplOperation,

  // Confidential balance circuit inputs
  ConfidentialBalancePublicInputs,
  ConfidentialBalancePrivateInputs,

  // Balance proof circuit inputs
  BalanceProofPublicInputs,
  BalanceProofPrivateInputs,

  // Unified proof input types
  DepositProofInputs,
  WithdrawProofInputs,
  TransferProofInputs,
  BalanceSufficiencyProofInputs,
  ZkSplProofInputs,

  // Proof output (re-exported from @protocol-01/stark-prover)
  StarkProofOutcome,

  // Configuration (re-exported from @protocol-01/stark-prover)
  StarkProverConfig,

  // Internal helper alias
  StarkPrivateInputMap,
} from './types';

// Error class (exported as value, not just type)
export { ProofInputValidationError } from './types';

// ============================================================================
// Client-Side zkSPL Prover — Public API
// ============================================================================
//
// TRUST THE MATH, NOT THE NODES.
//
// This module exports everything needed to generate zkSPL Groth16 proofs
// entirely on the client device. No private data ever leaves the user's machine.
//
// ============================================================================

// ---------------------------------------------------------------------------
// Main prover class
// ---------------------------------------------------------------------------

export { ClientProver } from './client-prover';

// ---------------------------------------------------------------------------
// Circuit file loader
// ---------------------------------------------------------------------------

export { CircuitLoader } from './circuit-loader';

// ---------------------------------------------------------------------------
// Proof format conversion utilities
// ---------------------------------------------------------------------------

export {
  snarkjsProofToBytes,
  parsePublicSignals,
  buildBalanceCircuitInputs,
  buildSufficiencyCircuitInputs,
  type Groth16ProofBytes,
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

  // Proof output
  SnarkjsProof,
  ProofResult,

  // Configuration
  CircuitFileConfig,
  ClientProverConfig,
  ProgressCallback,
  ProgressEvent,

  // Circuit loading state
  CircuitFiles,
} from './types';

// Error class (exported as value, not just type)
export { ProofInputValidationError } from './types';

// ============================================================================
// Client-Side zkSPL Prover — Main Prover Class (STARK migration)
// ============================================================================
//
// TRUST THE MATH, NOT THE NODES.
//
// This module dispatches zkSPL proof requests to `@protocol-01/stark-prover`,
// which generates STARK proofs over the Goldilocks field ENTIRELY on the
// user's device. The spending_key, balance, and salt NEVER leave this
// machine — only the resulting proof bytes (and their public inputs) are
// uploaded to the on-chain `p01_stark_verifier`.
//
// Operation routing — must match `programs/p01_stark_verifier/src/lib.rs:15-21`:
//   - 'deposit'        -> CONFIDENTIAL_BALANCE (4)  (public_credit > 0)
//   - 'withdraw'       -> CONFIDENTIAL_BALANCE (4)  (public_debit > 0)
//   - 'transfer'       -> CONFIDENTIAL_BALANCE (4)  (private amount > 0)
//   - 'balance-proof'  -> BALANCE_PROOF        (2)
//
// All three balance-update operations route to circuit 4 because the
// confidential_balance circuit handles the same delta + spending-key binding
// regardless of whether the delta is funded publicly (deposit/withdraw) or
// privately (transfer). Circuit 5 (TRANSFER) is reserved for the 2-in-2-out
// shielded transfer with nullifier outputs, which is *not* a confidential
// balance update — it is the higher-level UTXO-style transfer used by the
// transfer module, not by the zkSPL balance API.
//
// ============================================================================

import {
  STARK_CIRCUITS,
  createStarkProver,
  type StarkProofGenerator,
  type StarkProofOutcome,
  type StarkProverConfig,
} from '../../../stark-prover/src/index'; // relative on purpose: tsup inlines
// the JS either way (noExternal), but its d.ts bundler resolves with node10
// semantics and would leave a bare '@protocol-01/stark-prover' specifier in
// the emitted d.ts — a package the tgz consumer does not have. Same fix as
// merchant-sdk's service-registry import; measured 2026-08-04.

import {
  ProofInputValidationError,
  type BalanceProofPrivateInputs,
  type BalanceProofPublicInputs,
  type BalanceSufficiencyProofInputs,
  type ConfidentialBalancePrivateInputs,
  type ConfidentialBalancePublicInputs,
  type DepositProofInputs,
  type StarkPrivateInputMap,
  type TransferProofInputs,
  type WithdrawProofInputs,
  type ZkSplOperation,
  type ZkSplProofInputs,
} from './types';

// ---------------------------------------------------------------------------
// Input builders — convert typed inputs to the STARK prover's flat string map
// ---------------------------------------------------------------------------

/**
 * Build the flat string-keyed input object for the confidential_balance
 * circuit (STARK circuit id 4).
 *
 * The WASM bindings consume:
 *   spendingKey, oldBalance, oldSalt, newBalance, newSalt,
 *   amount, amountSalt, tokenMint
 *
 * The host-level public inputs (publicCredit, publicDebit, oldCommitment,
 * newCommitment, amountHash, nonce) are recomputed inside the circuit from
 * the private witness and asserted against the bound transcript, so we
 * forward them here for completeness — the WASM dispatcher only reads the
 * keys it needs and ignores the rest.
 */
export function buildBalanceCircuitInputs(
  pub: ConfidentialBalancePublicInputs,
  priv: ConfidentialBalancePrivateInputs,
): StarkPrivateInputMap {
  return {
    // Witness consumed by `generate_confidential_balance_stark_proof`
    spendingKey: priv.spendingKey.toString(),
    oldBalance: priv.oldBalance.toString(),
    oldSalt: priv.oldSalt.toString(),
    newBalance: priv.newBalance.toString(),
    newSalt: priv.newSalt.toString(),
    amount: priv.amount.toString(),
    amountSalt: priv.amountSalt.toString(),
    tokenMint: pub.tokenMint.toString(),

    // Host-level extras — kept in the map so verifiers / loggers can
    // inspect the originating intent without re-deriving from the witness.
    oldCommitment: pub.oldCommitment.toString(),
    newCommitment: pub.newCommitment.toString(),
    amountHash: pub.amountHash.toString(),
    publicCredit: pub.publicCredit.toString(),
    publicDebit: pub.publicDebit.toString(),
    nonce: pub.nonce.toString(),
    isDebit: priv.isDebit.toString(),
  };
}

/**
 * Build the flat string-keyed input object for the balance_proof circuit
 * (STARK circuit id 2).
 *
 * The WASM bindings consume: spendingKey, balance, salt, tokenMint.
 * Public inputs (balanceCommitment, threshold) are recomputed inside the
 * circuit and bound into the STARK transcript.
 */
export function buildSufficiencyCircuitInputs(
  pub: BalanceProofPublicInputs,
  priv: BalanceProofPrivateInputs,
): StarkPrivateInputMap {
  return {
    spendingKey: priv.spendingKey.toString(),
    balance: priv.balance.toString(),
    salt: priv.salt.toString(),
    tokenMint: pub.tokenMint.toString(),

    // Host-level extras
    balanceCommitment: pub.balanceCommitment.toString(),
    threshold: pub.threshold.toString(),
  };
}

// ---------------------------------------------------------------------------
// Input validation — operation-shape checks, independent of proof system
// ---------------------------------------------------------------------------

/**
 * Validate proof inputs for a deposit operation.
 *
 * Deposit rules:
 *   - public_debit MUST be 0 (you're depositing, not withdrawing)
 *   - public_credit MUST be > 0 (the deposit amount)
 *   - is_debit MUST be 0 (not debiting the confidential balance for a public op)
 *   - amount MUST be 0 (no private transfer component)
 */
function validateDepositInputs(
  pub: ConfidentialBalancePublicInputs,
  priv: ConfidentialBalancePrivateInputs,
): string[] {
  const violations: string[] = [];

  if (pub.publicDebit !== 0n) {
    violations.push(`public_debit must be 0 for deposit, got ${pub.publicDebit}`);
  }
  if (pub.publicCredit <= 0n) {
    violations.push(`public_credit must be > 0 for deposit, got ${pub.publicCredit}`);
  }
  if (priv.amount !== 0n) {
    violations.push(`private amount must be 0 for deposit, got ${priv.amount}`);
  }
  if (priv.isDebit !== 0) {
    violations.push(`is_debit must be 0 for deposit, got ${priv.isDebit}`);
  }

  return violations;
}

/**
 * Validate proof inputs for a withdraw operation.
 *
 * Withdraw rules:
 *   - public_credit MUST be 0 (you're withdrawing, not depositing)
 *   - public_debit MUST be > 0 (the withdrawal amount)
 *   - is_debit MUST be 0 (not debiting via the private amount path)
 *   - amount MUST be 0 (no private transfer component)
 */
function validateWithdrawInputs(
  pub: ConfidentialBalancePublicInputs,
  priv: ConfidentialBalancePrivateInputs,
): string[] {
  const violations: string[] = [];

  if (pub.publicCredit !== 0n) {
    violations.push(`public_credit must be 0 for withdraw, got ${pub.publicCredit}`);
  }
  if (pub.publicDebit <= 0n) {
    violations.push(`public_debit must be > 0 for withdraw, got ${pub.publicDebit}`);
  }
  if (priv.amount !== 0n) {
    violations.push(`private amount must be 0 for withdraw, got ${priv.amount}`);
  }
  if (priv.isDebit !== 0) {
    violations.push(`is_debit must be 0 for withdraw, got ${priv.isDebit}`);
  }

  return violations;
}

/**
 * Validate proof inputs for a confidential transfer (send or receive side).
 *
 * Transfer rules:
 *   - public_credit MUST be 0 (no public deposit in a private transfer)
 *   - public_debit MUST be 0 (no public withdrawal in a private transfer)
 *   - amount MUST be > 0 (the transfer amount)
 *   - is_debit MUST be 0 or 1
 */
function validateTransferInputs(
  pub: ConfidentialBalancePublicInputs,
  priv: ConfidentialBalancePrivateInputs,
): string[] {
  const violations: string[] = [];

  if (pub.publicCredit !== 0n) {
    violations.push(`public_credit must be 0 for transfer, got ${pub.publicCredit}`);
  }
  if (pub.publicDebit !== 0n) {
    violations.push(`public_debit must be 0 for transfer, got ${pub.publicDebit}`);
  }
  if (priv.amount <= 0n) {
    violations.push(`amount must be > 0 for transfer, got ${priv.amount}`);
  }
  if (priv.isDebit !== 0 && priv.isDebit !== 1) {
    violations.push(`is_debit must be 0 or 1, got ${priv.isDebit}`);
  }

  return violations;
}

/**
 * Validate proof inputs for a balance sufficiency proof.
 *
 * Rules:
 *   - threshold MUST be >= 0
 *   - balance MUST be >= 0
 */
function validateBalanceProofInputs(
  pub: BalanceProofPublicInputs,
  priv: BalanceProofPrivateInputs,
): string[] {
  const violations: string[] = [];

  if (pub.threshold < 0n) {
    violations.push(`threshold must be >= 0, got ${pub.threshold}`);
  }
  if (priv.balance < 0n) {
    violations.push(`balance must be >= 0, got ${priv.balance}`);
  }

  return violations;
}

/**
 * Validate inputs for a given operation type.
 * Throws ProofInputValidationError if validation fails.
 *
 * Exported because hosts that pre-flight inputs before queuing a proof
 * (e.g. UI form validators) want to share the exact same rules.
 */
export function validateInputs(inputs: ZkSplProofInputs): void {
  let violations: string[];

  switch (inputs.operation) {
    case 'deposit':
      violations = validateDepositInputs(inputs.public, inputs.private);
      break;
    case 'withdraw':
      violations = validateWithdrawInputs(inputs.public, inputs.private);
      break;
    case 'transfer':
      violations = validateTransferInputs(inputs.public, inputs.private);
      break;
    case 'balance-proof':
      violations = validateBalanceProofInputs(inputs.public, inputs.private);
      break;
    default: {
      const op = (inputs as { operation?: unknown }).operation;
      throw new Error(`Unknown operation: ${String(op)}`);
    }
  }

  if (violations.length > 0) {
    throw new ProofInputValidationError(inputs.operation, violations);
  }
}

// ---------------------------------------------------------------------------
// Operation -> circuit id routing
// ---------------------------------------------------------------------------

/**
 * Map a high-level zkSPL operation to the on-chain circuit id consumed by
 * `p01_stark_verifier`. Centralising this mapping makes mismatched ids a
 * compile-time bug rather than a silent runtime acceptance.
 *
 * SEE: `programs/p01_stark_verifier/src/lib.rs:15-21`.
 */
export function circuitIdForOperation(op: ZkSplOperation): number {
  switch (op) {
    case 'deposit':
    case 'withdraw':
    case 'transfer':
      return STARK_CIRCUITS.CONFIDENTIAL_BALANCE; // 4
    case 'balance-proof':
      return STARK_CIRCUITS.BALANCE_PROOF; // 2
    default: {
      const exhaustive: never = op;
      throw new Error(`Unknown operation: ${String(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// StarkClientProver
// ---------------------------------------------------------------------------

/**
 * Constructor argument for `StarkClientProver`.
 *
 * Either pass a pre-built `generator` (handy for tests + DI), or a
 * `StarkProverConfig` from which a generator will be created via
 * `createStarkProver`. Exactly one must be supplied.
 */
export interface StarkClientProverInit {
  /** Pre-built generator — typically obtained from `createStarkProver(...)`. */
  generator?: StarkProofGenerator;
  /** Solana connection + payer config — convenience for production callers. */
  config?: StarkProverConfig;
}

/**
 * Client-side STARK prover for zkSPL operations.
 *
 * Generates proofs entirely on the user's device by delegating to
 * `@protocol-01/stark-prover`. The WASM bindings produce a proof + public
 * inputs, the upload protocol pushes the proof bytes into a buffer PDA on
 * `p01_stark_verifier`, and the two-phase DEEP-ALI verifier blesses the
 * buffer for downstream programs to consume.
 *
 * ZERO private data leaves the device. The spending_key, balance, and salt
 * are used only inside the WASM proof generator.
 *
 * @example
 * ```ts
 * import { createStarkProver } from '@protocol-01/stark-prover';
 * import { StarkClientProver } from '@protocol-01/specter-sdk/proving';
 *
 * const handle = createStarkProver({ connection, payer });
 * const prover = new StarkClientProver({ generator: handle.generateStarkProof });
 *
 * const result = await prover.prove({
 *   operation: 'deposit',
 *   public: { oldCommitment, newCommitment, amountHash, publicCredit: 100n, publicDebit: 0n, tokenMint, nonce },
 *   private: { oldBalance, oldSalt, newBalance, newSalt, amount: 0n, amountSalt: 0n, spendingKey, isDebit: 0 },
 * });
 * console.log(result.proofBuffer.toBase58()); // PDA holding the verified proof
 * ```
 */
export class StarkClientProver {
  private readonly generator: StarkProofGenerator;

  constructor(init: StarkClientProverInit) {
    if (init.generator && init.config) {
      throw new Error('StarkClientProver: pass either `generator` OR `config`, not both.');
    }
    if (init.generator) {
      this.generator = init.generator;
    } else if (init.config) {
      this.generator = createStarkProver(init.config).generateStarkProof;
    } else {
      throw new Error('StarkClientProver: one of `generator` or `config` is required.');
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Generate a STARK proof for any zkSPL operation.
   *
   * This is the main entry point. It:
   *   1. Validates the inputs match the operation type
   *   2. Builds the flat string-keyed input map
   *   3. Routes to the correct STARK circuit id
   *   4. Generates and uploads the proof via the bound generator
   *
   * @throws {ProofInputValidationError} if inputs violate operation rules
   * @throws {Error} if proof generation or upload fails
   */
  async prove(inputs: ZkSplProofInputs): Promise<StarkProofOutcome> {
    validateInputs(inputs);

    const circuitId = circuitIdForOperation(inputs.operation);
    const map: StarkPrivateInputMap =
      inputs.operation === 'balance-proof'
        ? buildSufficiencyCircuitInputs(inputs.public, inputs.private)
        : buildBalanceCircuitInputs(inputs.public, inputs.private);

    return this.generator(circuitId, map);
  }

  /**
   * Generate a deposit proof. Convenience wrapper with type narrowing.
   */
  async proveDeposit(
    pub: ConfidentialBalancePublicInputs,
    priv: ConfidentialBalancePrivateInputs,
  ): Promise<StarkProofOutcome> {
    return this.prove({ operation: 'deposit', public: pub, private: priv } satisfies DepositProofInputs);
  }

  /**
   * Generate a withdraw proof. Convenience wrapper with type narrowing.
   */
  async proveWithdraw(
    pub: ConfidentialBalancePublicInputs,
    priv: ConfidentialBalancePrivateInputs,
  ): Promise<StarkProofOutcome> {
    return this.prove({ operation: 'withdraw', public: pub, private: priv } satisfies WithdrawProofInputs);
  }

  /**
   * Generate a confidential transfer proof. Convenience wrapper with type narrowing.
   */
  async proveTransfer(
    pub: ConfidentialBalancePublicInputs,
    priv: ConfidentialBalancePrivateInputs,
  ): Promise<StarkProofOutcome> {
    return this.prove({ operation: 'transfer', public: pub, private: priv } satisfies TransferProofInputs);
  }

  /**
   * Generate a balance sufficiency proof. Convenience wrapper with type narrowing.
   */
  async proveBalanceSufficiency(
    pub: BalanceProofPublicInputs,
    priv: BalanceProofPrivateInputs,
  ): Promise<StarkProofOutcome> {
    return this.prove({
      operation: 'balance-proof',
      public: pub,
      private: priv,
    } satisfies BalanceSufficiencyProofInputs);
  }
}

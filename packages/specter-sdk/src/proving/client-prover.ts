// ============================================================================
// Client-Side zkSPL Prover — Main Prover Class
// ============================================================================
//
// TRUST THE MATH, NOT THE NODES.
//
// This module generates Groth16 proofs for the zkSPL confidential balance
// circuit ENTIRELY on the user's device. The spending_key, balance, and salt
// NEVER leave this machine.
//
// The confidential_balance circuit has only ~1,382 constraints — it should
// prove in roughly 2-5 seconds in a modern browser using snarkjs WASM.
//
// ============================================================================

import { CircuitLoader } from './circuit-loader';
import {
  ProofInputValidationError,
  type BalanceProofPrivateInputs,
  type BalanceProofPublicInputs,
  type BalanceSufficiencyProofInputs,
  type ClientProverConfig,
  type CircuitFiles,
  type ConfidentialBalancePrivateInputs,
  type ConfidentialBalancePublicInputs,
  type DepositProofInputs,
  type ProgressCallback,
  type ProofResult,
  type SnarkjsProof,
  type TransferProofInputs,
  type WithdrawProofInputs,
  type ZkSplOperation,
  type ZkSplProofInputs,
} from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default proof generation timeout: 60 seconds */
const DEFAULT_TIMEOUT = 60_000;

/** Circuit cache labels */
const BALANCE_CIRCUIT = 'balance';
const SUFFICIENCY_CIRCUIT = 'sufficiency';

/**
 * Resolve a potentially relative URL against a base.
 * If the url is already absolute (starts with http:// or https:// or /), return it as-is.
 */
function resolveUrl(base: string, url: string): string {
  if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('/')) {
    return url;
  }
  return base + url;
}

// ---------------------------------------------------------------------------
// Input builders — convert typed inputs to snarkjs flat string map
// ---------------------------------------------------------------------------

/**
 * Build the flat string-keyed input object for the confidential_balance circuit.
 *
 * Signal ordering matches the circom template:
 *   Public:  old_commitment, new_commitment, amount_hash,
 *            public_credit, public_debit, token_mint, nonce
 *   Private: old_balance, old_salt, new_balance, new_salt,
 *            amount, amount_salt, spending_key, is_debit
 */
export function buildBalanceCircuitInputs(
  pub: ConfidentialBalancePublicInputs,
  priv: ConfidentialBalancePrivateInputs,
): Record<string, string> {
  return {
    // Public inputs
    old_commitment: pub.oldCommitment.toString(),
    new_commitment: pub.newCommitment.toString(),
    amount_hash: pub.amountHash.toString(),
    public_credit: pub.publicCredit.toString(),
    public_debit: pub.publicDebit.toString(),
    token_mint: pub.tokenMint.toString(),
    nonce: pub.nonce.toString(),
    // Private inputs
    old_balance: priv.oldBalance.toString(),
    old_salt: priv.oldSalt.toString(),
    new_balance: priv.newBalance.toString(),
    new_salt: priv.newSalt.toString(),
    amount: priv.amount.toString(),
    amount_salt: priv.amountSalt.toString(),
    spending_key: priv.spendingKey.toString(),
    is_debit: priv.isDebit.toString(),
  };
}

/**
 * Build the flat string-keyed input object for the balance_proof circuit.
 *
 * Signal ordering:
 *   Public:  balance_commitment, threshold, token_mint
 *   Private: balance, salt, spending_key
 */
export function buildSufficiencyCircuitInputs(
  pub: BalanceProofPublicInputs,
  priv: BalanceProofPrivateInputs,
): Record<string, string> {
  return {
    // Public inputs
    balance_commitment: pub.balanceCommitment.toString(),
    threshold: pub.threshold.toString(),
    token_mint: pub.tokenMint.toString(),
    // Private inputs
    balance: priv.balance.toString(),
    salt: priv.salt.toString(),
    spending_key: priv.spendingKey.toString(),
  };
}

// ---------------------------------------------------------------------------
// Input validation
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
 */
function validateInputs(inputs: ZkSplProofInputs): void {
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
    default:
      throw new Error(`Unknown operation: ${(inputs as ZkSplProofInputs).operation}`);
  }

  if (violations.length > 0) {
    throw new ProofInputValidationError(inputs.operation, violations);
  }
}

// ---------------------------------------------------------------------------
// ClientProver
// ---------------------------------------------------------------------------

/**
 * Client-side Groth16 prover for zkSPL circuits.
 *
 * Generates proofs entirely on the user's device using snarkjs.
 * Circuit files (.wasm and .zkey) are loaded lazily from configured URLs
 * and cached in memory for subsequent proofs.
 *
 * ZERO private data leaves the device. The spending_key, balance, and salt
 * are used only inside the WASM proof generator.
 *
 * @example
 * ```ts
 * const prover = new ClientProver({
 *   balanceCircuit: {
 *     wasmUrl: 'https://cdn.example.com/circuits/confidential_balance.wasm',
 *     zkeyUrl: 'https://cdn.example.com/circuits/confidential_balance_final.zkey',
 *   },
 *   sufficiencyCircuit: {
 *     wasmUrl: 'https://cdn.example.com/circuits/balance_proof.wasm',
 *     zkeyUrl: 'https://cdn.example.com/circuits/balance_proof_final.zkey',
 *   },
 * });
 *
 * // Preload circuit files in background
 * await prover.preloadCircuits();
 *
 * // Generate a deposit proof — spending_key never leaves this device
 * const result = await prover.prove({
 *   operation: 'deposit',
 *   public: { oldCommitment, newCommitment, amountHash, publicCredit: 100n, publicDebit: 0n, tokenMint, nonce },
 *   private: { oldBalance, oldSalt, newBalance, newSalt, amount: 0n, amountSalt: 0n, spendingKey, isDebit: 0 },
 * });
 * ```
 */
export class ClientProver {
  private readonly config: ClientProverConfig;
  private readonly loader: CircuitLoader;
  private readonly timeout: number;

  constructor(config: ClientProverConfig) {
    // Resolve relative circuit URLs against circuitBaseUrl if provided
    if (config.circuitBaseUrl) {
      const base = config.circuitBaseUrl.endsWith('/')
        ? config.circuitBaseUrl
        : config.circuitBaseUrl + '/';
      config = {
        ...config,
        balanceCircuit: {
          wasmUrl: resolveUrl(base, config.balanceCircuit.wasmUrl),
          zkeyUrl: resolveUrl(base, config.balanceCircuit.zkeyUrl),
        },
        sufficiencyCircuit: {
          wasmUrl: resolveUrl(base, config.sufficiencyCircuit.wasmUrl),
          zkeyUrl: resolveUrl(base, config.sufficiencyCircuit.zkeyUrl),
        },
      };
    }
    this.config = config;
    this.loader = new CircuitLoader();
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Generate a Groth16 proof for any zkSPL operation.
   *
   * This is the main entry point. It:
   *   1. Validates the inputs match the operation type
   *   2. Loads circuit files if not already cached
   *   3. Generates the proof using snarkjs
   *   4. Returns the proof and public signals
   *
   * @throws {ProofInputValidationError} if inputs violate operation rules
   * @throws {Error} if circuit files cannot be loaded or proof generation fails
   */
  async prove(inputs: ZkSplProofInputs): Promise<ProofResult> {
    // Step 1: Validate inputs
    validateInputs(inputs);

    // Step 2: Route to the correct circuit
    if (inputs.operation === 'balance-proof') {
      return this.proveSufficiency(inputs);
    }

    return this.proveBalance(inputs);
  }

  /**
   * Generate a deposit proof.
   * Convenience wrapper around prove() with type narrowing.
   */
  async proveDeposit(
    pub: ConfidentialBalancePublicInputs,
    priv: ConfidentialBalancePrivateInputs,
  ): Promise<ProofResult> {
    return this.prove({ operation: 'deposit', public: pub, private: priv });
  }

  /**
   * Generate a withdraw proof.
   * Convenience wrapper around prove() with type narrowing.
   */
  async proveWithdraw(
    pub: ConfidentialBalancePublicInputs,
    priv: ConfidentialBalancePrivateInputs,
  ): Promise<ProofResult> {
    return this.prove({ operation: 'withdraw', public: pub, private: priv });
  }

  /**
   * Generate a confidential transfer proof (send or receive side).
   * Convenience wrapper around prove() with type narrowing.
   */
  async proveTransfer(
    pub: ConfidentialBalancePublicInputs,
    priv: ConfidentialBalancePrivateInputs,
  ): Promise<ProofResult> {
    return this.prove({ operation: 'transfer', public: pub, private: priv });
  }

  /**
   * Generate a balance sufficiency proof.
   * Convenience wrapper around prove() with type narrowing.
   */
  async proveBalanceSufficiency(
    pub: BalanceProofPublicInputs,
    priv: BalanceProofPrivateInputs,
  ): Promise<ProofResult> {
    return this.prove({ operation: 'balance-proof', public: pub, private: priv });
  }

  /**
   * Preload all circuit files in the background.
   * Call this early (e.g., on app startup) so proofs generate instantly later.
   *
   * @returns Object with loading results for each circuit
   */
  async preloadCircuits(
    onProgress?: ProgressCallback,
  ): Promise<{ balance: boolean; sufficiency: boolean }> {
    const [balance, sufficiency] = await Promise.all([
      this.loader.preload(BALANCE_CIRCUIT, this.config.balanceCircuit, onProgress),
      this.loader.preload(SUFFICIENCY_CIRCUIT, this.config.sufficiencyCircuit, onProgress),
    ]);
    return { balance, sufficiency };
  }

  /**
   * Check if circuit files are loaded and ready for proof generation.
   */
  isReady(circuit?: 'balance' | 'sufficiency'): boolean {
    if (circuit) {
      return this.loader.isLoaded(circuit);
    }
    return this.loader.isLoaded(BALANCE_CIRCUIT) && this.loader.isLoaded(SUFFICIENCY_CIRCUIT);
  }

  /**
   * Check if circuit files are currently being loaded.
   */
  isLoading(circuit?: 'balance' | 'sufficiency'): boolean {
    if (circuit) {
      return this.loader.isLoading(circuit);
    }
    return this.loader.isLoading(BALANCE_CIRCUIT) || this.loader.isLoading(SUFFICIENCY_CIRCUIT);
  }

  /**
   * Clear cached circuit files to free memory.
   */
  clearCache(circuit?: 'balance' | 'sufficiency'): void {
    this.loader.clear(circuit);
  }

  // -------------------------------------------------------------------------
  // Internal proving methods
  // -------------------------------------------------------------------------

  /**
   * Generate a proof for the confidential_balance circuit (deposit/withdraw/transfer).
   */
  private async proveBalance(
    inputs: DepositProofInputs | WithdrawProofInputs | TransferProofInputs,
  ): Promise<ProofResult> {
    const circuitInputs = buildBalanceCircuitInputs(inputs.public, inputs.private);
    const circuitFiles = await this.loader.load(
      BALANCE_CIRCUIT,
      this.config.balanceCircuit,
      this.config.onProgress,
    );
    return this.generateProof(circuitInputs, circuitFiles);
  }

  /**
   * Generate a proof for the balance_proof (sufficiency) circuit.
   */
  private async proveSufficiency(
    inputs: BalanceSufficiencyProofInputs,
  ): Promise<ProofResult> {
    const circuitInputs = buildSufficiencyCircuitInputs(inputs.public, inputs.private);
    const circuitFiles = await this.loader.load(
      SUFFICIENCY_CIRCUIT,
      this.config.sufficiencyCircuit,
      this.config.onProgress,
    );
    return this.generateProof(circuitInputs, circuitFiles);
  }

  /**
   * Core proof generation using snarkjs.groth16.fullProve.
   *
   * This is where the magic happens — the proof is generated entirely locally.
   * The snarkjs WASM runtime evaluates the circuit with the provided inputs
   * and produces a Groth16 proof that can be verified on-chain.
   */
  private async generateProof(
    inputs: Record<string, string>,
    circuitFiles: CircuitFiles,
  ): Promise<ProofResult> {
    // Dynamic import: snarkjs is not required at module load time.
    // This keeps the initial bundle size small and allows the module to be
    // imported in environments where snarkjs isn't available yet.
    const snarkjs = await import('snarkjs');

    const startTime = performance.now();

    // Race proof generation against timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Proof generation timed out after ${this.timeout}ms`)),
        this.timeout,
      );
      // Unref the timer in Node so it doesn't prevent process exit
      if (typeof timer === 'object' && 'unref' in timer) {
        (timer as NodeJS.Timeout).unref();
      }
    });

    const provePromise = (async (): Promise<ProofResult> => {
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(
        inputs,
        circuitFiles.wasm,
        circuitFiles.zkey,
      );

      const provingTimeMs = Math.round(performance.now() - startTime);

      return {
        proof: proof as SnarkjsProof,
        publicSignals: publicSignals as string[],
        provingTimeMs,
      };
    })();

    return Promise.race([provePromise, timeoutPromise]);
  }
}

// ---------------------------------------------------------------------------
// Proof format conversion utilities
// ---------------------------------------------------------------------------

/**
 * BN254 field modulus — used for field element byte conversion.
 */
const FIELD_MODULUS = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617'
);

/**
 * Convert a field element to 32 bytes (big-endian).
 * Used for G1/G2 point encoding for the alt_bn128 precompile.
 */
function fieldToBytesBE(field: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let value = field < 0n ? field + FIELD_MODULUS : field;
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}

/**
 * Convert G1 affine point [x, y, "1"] to 64 bytes (x || y, big-endian).
 */
function g1ToBytes(point: string[]): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set(fieldToBytesBE(BigInt(point[0]!)), 0);
  bytes.set(fieldToBytesBE(BigInt(point[1]!)), 32);
  return bytes;
}

/**
 * Convert G2 affine point [[x_real, x_imag], [y_real, y_imag], ["1","0"]]
 * to 128 bytes in alt_bn128 format: (x_imag, x_real, y_imag, y_real).
 */
function g2ToBytes(point: string[][]): Uint8Array {
  const bytes = new Uint8Array(128);
  bytes.set(fieldToBytesBE(BigInt(point[0]![1]!)), 0);   // x_imag
  bytes.set(fieldToBytesBE(BigInt(point[0]![0]!)), 32);  // x_real
  bytes.set(fieldToBytesBE(BigInt(point[1]![1]!)), 64);  // y_imag
  bytes.set(fieldToBytesBE(BigInt(point[1]![0]!)), 96);  // y_real
  return bytes;
}

/**
 * Groth16 proof in on-chain byte representation.
 * Matches the Anchor IDL `Groth16Proof` type.
 */
export interface Groth16ProofBytes {
  /** G1 point pi_a (64 bytes: x || y, big-endian) */
  pi_a: Uint8Array;
  /** G2 point pi_b (128 bytes: x_imag || x_real || y_imag || y_real, big-endian) */
  pi_b: Uint8Array;
  /** G1 point pi_c (64 bytes: x || y, big-endian) */
  pi_c: Uint8Array;
}

/**
 * Convert a snarkjs proof to the on-chain Groth16 byte layout.
 *
 * snarkjs returns proof points as decimal string arrays.
 * The on-chain verifier expects raw bytes in alt_bn128 format.
 *
 * This matches the exact same conversion used by the relayer and
 * the existing @protocol-01/zkspl-sdk prover, ensuring proof format compatibility.
 */
export function snarkjsProofToBytes(proof: SnarkjsProof): Groth16ProofBytes {
  return {
    pi_a: g1ToBytes(proof.pi_a),
    pi_b: g2ToBytes(proof.pi_b),
    pi_c: g1ToBytes(proof.pi_c),
  };
}

/**
 * Convert public signals from decimal strings to bigint array.
 * Useful for downstream processing (e.g., building Solana instructions).
 */
export function parsePublicSignals(signals: string[]): bigint[] {
  return signals.map(s => BigInt(s));
}

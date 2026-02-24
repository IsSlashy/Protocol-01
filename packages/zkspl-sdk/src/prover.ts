/**
 * Proof generation for zkSPL circuits.
 *
 * Supports two backends:
 *   1. Local snarkjs (WASM + zkey files)
 *   2. Remote Rust prover via HTTP POST
 *
 * The remote prover is preferred in production (much faster, ~3s vs ~3min).
 */

import { fieldToBytes } from './crypto';
import { CIRCUIT_FILES, PROOF_GENERATION_TIMEOUT } from './constants';
import type {
  Groth16Proof,
  ProverConfig,
  ConfidentialBalancePublicInputs,
  ConfidentialBalancePrivateInputs,
  BalanceProofPublicInputs,
  BalanceProofPrivateInputs,
} from './types';

// ---------------------------------------------------------------------------
// Circuit input builders
// ---------------------------------------------------------------------------

/**
 * Build the flat string-keyed input object that snarkjs / the remote prover
 * expects for the confidential_balance circuit.
 */
export function buildBalanceCircuitInputs(
  pub: ConfidentialBalancePublicInputs,
  priv: ConfidentialBalancePrivateInputs
): Record<string, string> {
  return {
    // Public
    old_commitment: pub.oldCommitment.toString(),
    new_commitment: pub.newCommitment.toString(),
    amount_hash: pub.amountHash.toString(),
    public_credit: pub.publicCredit.toString(),
    public_debit: pub.publicDebit.toString(),
    token_mint: pub.tokenMint.toString(),
    nonce: pub.nonce.toString(),
    // Private
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
 */
export function buildProofCircuitInputs(
  pub: BalanceProofPublicInputs,
  priv: BalanceProofPrivateInputs
): Record<string, string> {
  return {
    // Public
    balance_commitment: pub.balanceCommitment.toString(),
    threshold: pub.threshold.toString(),
    token_mint: pub.tokenMint.toString(),
    // Private
    balance: priv.balance.toString(),
    salt: priv.salt.toString(),
    spending_key: priv.spendingKey.toString(),
  };
}

// ---------------------------------------------------------------------------
// Proof-to-bytes conversion
// ---------------------------------------------------------------------------

/**
 * Convert a snarkjs proof JSON to the on-chain Groth16Proof byte layout.
 *
 * snarkjs returns:
 *   pi_a: [x, y, "1"]  (G1 affine)
 *   pi_b: [[x0, x1], [y0, y1], ["1","0"]]  (G2 affine)
 *   pi_c: [x, y, "1"]  (G1 affine)
 */
export function snarkjsProofToBytes(proof: {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
}): Groth16Proof {
  return {
    pi_a: g1ToBytes(proof.pi_a),
    pi_b: g2ToBytes(proof.pi_b),
    pi_c: g1ToBytes(proof.pi_c),
  };
}

function g1ToBytes(point: string[]): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set(fieldToBytes(BigInt(point[0])), 0);
  bytes.set(fieldToBytes(BigInt(point[1])), 32);
  return bytes;
}

function g2ToBytes(point: string[][]): Uint8Array {
  const bytes = new Uint8Array(128);
  bytes.set(fieldToBytes(BigInt(point[0][0])), 0);
  bytes.set(fieldToBytes(BigInt(point[0][1])), 32);
  bytes.set(fieldToBytes(BigInt(point[1][0])), 64);
  bytes.set(fieldToBytes(BigInt(point[1][1])), 96);
  return bytes;
}

// ---------------------------------------------------------------------------
// ZkSplProver class
// ---------------------------------------------------------------------------

/**
 * Proof generation manager for zkSPL.
 *
 * Tries the remote Rust prover first (if configured), then falls back to
 * local snarkjs.
 */
export class ZkSplProver {
  private config: Required<ProverConfig>;

  constructor(config: ProverConfig = {}) {
    this.config = {
      remoteProverUrl: config.remoteProverUrl ?? '',
      balanceWasmPath: config.balanceWasmPath ?? CIRCUIT_FILES.BALANCE_WASM,
      balanceZkeyPath: config.balanceZkeyPath ?? CIRCUIT_FILES.BALANCE_ZKEY,
      proofWasmPath: config.proofWasmPath ?? CIRCUIT_FILES.PROOF_WASM,
      proofZkeyPath: config.proofZkeyPath ?? CIRCUIT_FILES.PROOF_ZKEY,
      timeout: config.timeout ?? PROOF_GENERATION_TIMEOUT,
    };
  }

  // -------------------------------------------------------------------------
  // High-level: generate balance update proof
  // -------------------------------------------------------------------------

  /**
   * Generate a Groth16 proof for the confidential_balance circuit.
   * Used for deposit, withdraw, send (debit side), receive (credit side / apply_pending).
   */
  async generateBalanceProof(
    pub: ConfidentialBalancePublicInputs,
    priv: ConfidentialBalancePrivateInputs
  ): Promise<{ proof: Groth16Proof; publicSignals: string[] }> {
    const inputs = buildBalanceCircuitInputs(pub, priv);

    if (this.config.remoteProverUrl) {
      try {
        return await this.proveRemote('confidential_balance', inputs);
      } catch (err) {
        console.warn(
          '[ZkSplProver] Remote prover failed, falling back to local snarkjs:',
          err
        );
      }
    }

    return this.proveLocal(
      inputs,
      this.config.balanceWasmPath,
      this.config.balanceZkeyPath
    );
  }

  // -------------------------------------------------------------------------
  // High-level: generate balance sufficiency proof
  // -------------------------------------------------------------------------

  /**
   * Generate a Groth16 proof for the balance_proof (sufficiency) circuit.
   * Used for `prove_balance` (DeFi composability).
   */
  async generateSufficiencyProof(
    pub: BalanceProofPublicInputs,
    priv: BalanceProofPrivateInputs
  ): Promise<{ proof: Groth16Proof; publicSignals: string[] }> {
    const inputs = buildProofCircuitInputs(pub, priv);

    if (this.config.remoteProverUrl) {
      try {
        return await this.proveRemote('balance_proof', inputs);
      } catch (err) {
        console.warn(
          '[ZkSplProver] Remote prover failed, falling back to local snarkjs:',
          err
        );
      }
    }

    return this.proveLocal(
      inputs,
      this.config.proofWasmPath,
      this.config.proofZkeyPath
    );
  }

  // -------------------------------------------------------------------------
  // Remote prover
  // -------------------------------------------------------------------------

  private async proveRemote(
    circuit: string,
    inputs: Record<string, string>
  ): Promise<{ proof: Groth16Proof; publicSignals: string[] }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(this.config.remoteProverUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ circuit, inputs }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Remote prover HTTP ${response.status}: ${text}`);
      }

      const data = await response.json();

      // The remote prover returns the proof in snarkjs format
      const proof = snarkjsProofToBytes(data.proof);
      return { proof, publicSignals: data.publicSignals };
    } finally {
      clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------
  // Local snarkjs prover
  // -------------------------------------------------------------------------

  private async proveLocal(
    inputs: Record<string, string>,
    wasmPath: string,
    zkeyPath: string
  ): Promise<{ proof: Groth16Proof; publicSignals: string[] }> {
    // Dynamic import so snarkjs is not required at module load time
    const snarkjs = await import('snarkjs');

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error('Local proof generation timed out')),
        this.config.timeout
      );
    });

    const provePromise = (async () => {
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(
        inputs,
        wasmPath,
        zkeyPath
      );
      return {
        proof: snarkjsProofToBytes(proof),
        publicSignals: publicSignals as string[],
      };
    })();

    return Promise.race([provePromise, timeoutPromise]);
  }
}

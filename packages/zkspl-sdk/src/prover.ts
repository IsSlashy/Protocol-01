/**
 * Proof generation for zkSPL circuits.
 *
 * Supports three backends (tried in order):
 *   1. Relayer HTTP endpoints (POST /api/zkspl/prove/{operation})
 *   2. Remote Rust prover via HTTP POST (direct, /prove/zkspl or /prove/balance-proof)
 *   3. Local snarkjs (WASM + zkey files)
 *
 * The relayer and remote prover are preferred in production (much faster, ~3s vs ~3min).
 * Each tier falls back to the next on failure.
 */

import { fieldToBytesBE } from './crypto';
import { CIRCUIT_FILES, PROOF_GENERATION_TIMEOUT } from './constants';
import type {
  Groth16Proof,
  ProverConfig,
  ConfidentialBalancePublicInputs,
  ConfidentialBalancePrivateInputs,
  BalanceProofPublicInputs,
  BalanceProofPrivateInputs,
  ZkSplOperationType,
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
  bytes.set(fieldToBytesBE(BigInt(point[0])), 0);
  bytes.set(fieldToBytesBE(BigInt(point[1])), 32);
  return bytes;
}

function g2ToBytes(point: string[][]): Uint8Array {
  // alt_bn128 (EIP-197) expects G2 as: (x_imag, x_real, y_imag, y_real)
  // snarkjs JSON is: [[x_real, x_imag], [y_real, y_imag]]
  const bytes = new Uint8Array(128);
  bytes.set(fieldToBytesBE(BigInt(point[0][1])), 0);   // x_imag
  bytes.set(fieldToBytesBE(BigInt(point[0][0])), 32);  // x_real
  bytes.set(fieldToBytesBE(BigInt(point[1][1])), 64);  // y_imag
  bytes.set(fieldToBytesBE(BigInt(point[1][0])), 96);  // y_real
  return bytes;
}

// ---------------------------------------------------------------------------
// ZkSplProver class
// ---------------------------------------------------------------------------

/**
 * Proof generation manager for zkSPL.
 *
 * Proof generation cascade (each tier falls back to the next):
 *   1. Relayer (if relayerUrl configured) — operation-specific endpoints
 *   2. Remote Rust prover (if remoteProverUrl configured) — circuit-level endpoints
 *   3. Local snarkjs — WASM + zkey files
 */
export class ZkSplProver {
  private config: Required<ProverConfig>;

  constructor(config: ProverConfig = {}) {
    this.config = {
      remoteProverUrl: config.remoteProverUrl ?? '',
      relayerUrl: config.relayerUrl ?? '',
      balanceWasmPath: config.balanceWasmPath ?? CIRCUIT_FILES.BALANCE_WASM,
      balanceZkeyPath: config.balanceZkeyPath ?? CIRCUIT_FILES.BALANCE_ZKEY,
      proofWasmPath: config.proofWasmPath ?? CIRCUIT_FILES.PROOF_WASM,
      proofZkeyPath: config.proofZkeyPath ?? CIRCUIT_FILES.PROOF_ZKEY,
      timeout: config.timeout ?? PROOF_GENERATION_TIMEOUT,
    };
  }

  /**
   * Update the relayer URL at runtime (e.g., after config reload).
   */
  setRelayerUrl(url: string): void {
    this.config.relayerUrl = url;
  }

  /**
   * Update the remote Rust prover URL at runtime.
   */
  setRemoteProverUrl(url: string): void {
    this.config.remoteProverUrl = url;
  }

  // -------------------------------------------------------------------------
  // High-level: generate balance update proof
  // -------------------------------------------------------------------------

  /**
   * Generate a Groth16 proof for the confidential_balance circuit.
   * Used for deposit, withdraw, send (debit side), receive (credit side / apply_pending).
   *
   * @param pub - Public inputs for the circuit
   * @param priv - Private inputs for the circuit
   * @param operationType - Optional operation type for relayer routing.
   *   When the relayer URL is configured, this determines which endpoint is called:
   *   'deposit' -> POST /api/zkspl/prove/deposit
   *   'withdraw' -> POST /api/zkspl/prove/withdraw
   *   'transfer' -> POST /api/zkspl/prove/transfer
   *   If omitted, the relayer is skipped and only the Rust prover / local snarkjs are used.
   */
  async generateBalanceProof(
    pub: ConfidentialBalancePublicInputs,
    priv: ConfidentialBalancePrivateInputs,
    operationType?: ZkSplOperationType
  ): Promise<{ proof: Groth16Proof; publicSignals: string[] }> {
    const inputs = buildBalanceCircuitInputs(pub, priv);

    // 1. Try relayer first (if configured and operation type is known)
    if (this.config.relayerUrl && operationType) {
      try {
        return await this.proveViaRelayer(operationType, inputs);
      } catch (err) {
        console.warn(
          '[ZkSplProver] Relayer proof generation failed, trying Rust prover:',
          err
        );
      }
    }

    // 2. Try remote Rust prover
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

    // 3. Fall back to local snarkjs
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

    // 1. Try relayer first (if configured)
    if (this.config.relayerUrl) {
      try {
        return await this.proveViaRelayer('balance-proof', inputs);
      } catch (err) {
        console.warn(
          '[ZkSplProver] Relayer proof generation failed, trying Rust prover:',
          err
        );
      }
    }

    // 2. Try remote Rust prover
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

    // 3. Fall back to local snarkjs
    return this.proveLocal(
      inputs,
      this.config.proofWasmPath,
      this.config.proofZkeyPath
    );
  }

  // -------------------------------------------------------------------------
  // Relayer-based proof generation
  // -------------------------------------------------------------------------

  /**
   * Generate a proof via the relayer's zkSPL endpoints.
   *
   * Endpoints:
   *   POST {relayerUrl}/api/zkspl/prove/deposit
   *   POST {relayerUrl}/api/zkspl/prove/withdraw
   *   POST {relayerUrl}/api/zkspl/prove/transfer
   *   POST {relayerUrl}/api/zkspl/prove/balance-proof
   *
   * Request body: { inputs: Record<string, string> }
   * Response body: { proof: { pi_a, pi_b, pi_c }, publicSignals: string[] }
   */
  private async proveViaRelayer(
    operation: ZkSplOperationType,
    inputs: Record<string, string>
  ): Promise<{ proof: Groth16Proof; publicSignals: string[] }> {
    const baseUrl = this.config.relayerUrl.replace(/\/+$/, '');
    const url = `${baseUrl}/api/zkspl/prove/${operation}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `Relayer HTTP ${response.status} from ${operation}: ${text}`
        );
      }

      const data = await response.json();

      if (!data.proof || !data.publicSignals) {
        throw new Error(
          `Relayer response missing proof or publicSignals for ${operation}`
        );
      }

      // The relayer returns the proof in snarkjs format (pi_a, pi_b, pi_c as
      // string arrays). Convert to on-chain byte layout.
      const proof = snarkjsProofToBytes(data.proof);
      return { proof, publicSignals: data.publicSignals };
    } finally {
      clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------
  // Remote Rust prover (direct)
  // -------------------------------------------------------------------------

  private async proveRemote(
    circuit: string,
    inputs: Record<string, string>
  ): Promise<{ proof: Groth16Proof; publicSignals: string[] }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeout);

    // Route to the correct prover endpoint based on circuit type.
    // The base remoteProverUrl is e.g. "https://relayer.example.com/prove".
    // zkSPL circuits use /prove/zkspl and /prove/balance-proof.
    const circuitPaths: Record<string, string> = {
      confidential_balance: '/zkspl',
      balance_proof: '/balance-proof',
    };
    const url = this.config.remoteProverUrl + (circuitPaths[circuit] ?? '');

    try {
      const response = await fetch(url, {
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

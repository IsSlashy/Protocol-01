/**
 * STARK Proof Generator Adapter for Protocol 01 (p01-js merchant SDK).
 *
 * Thin wrapper around `@protocol-01/stark-prover`. The host application
 * builds a `StarkProofGenerator` once (typically via `createStarkProver`)
 * and passes it in here. This module exposes a circuit-1 (POOL_COMMITMENT)
 * convenience that mirrors the privacy-sdk shield/unshield pattern so
 * merchants can plug a single generator into both the merchant SDK and
 * `@protocol-01/privacy-sdk`.
 *
 * Circuit details (POOL_COMMITMENT, id 1):
 * - System: STARK over the Goldilocks field (DEEP-ALI), Blake3 Merkle.
 * - Public inputs (verified on-chain by `p01_stark_verifier`):
 *     [nullifier, commitment]
 * - Private inputs (`Record<string, string | string[] | number[]>`):
 *     - `nullifierPreimage` — hex/decimal field element
 *     - `secret`            — hex/decimal field element
 *     - `depositEpoch`      — slot/epoch as decimal
 *     - `tokenMint`         — mint pubkey as decimal field element
 *
 * The Groth16/snarkjs pipeline shipped in 0.2.x is gone — proof generation,
 * upload, and on-chain verification are all handled by `p01_stark_verifier`
 * via `@protocol-01/stark-prover`. Client-side verification is no longer a
 * supported entry point: the on-chain verifier is the source of truth.
 *
 * @module proof-generator
 */

import {
  STARK_CIRCUITS,
  type StarkProofGenerator,
  type StarkProofOutcome,
} from '@protocol-01/stark-prover';

// ============ Types ============

/**
 * Outcome of a STARK proof generation + on-chain verification roundtrip.
 *
 * Re-exported from `@protocol-01/stark-prover` for callers that prefer to
 * import the type from the merchant SDK without taking a second dep.
 *
 * BREAKING CHANGE (0.3.0): replaces the Groth16 `{ proof: { pi_a, pi_b,
 * pi_c }, publicSignals }` shape from 0.2.x. Migrate by reading
 * `proofBuffer` (PDA of the verified buffer held by `p01_stark_verifier`)
 * and `publicInputs` (decimal `bigint[]` in circuit-defined order).
 */
export type ProofResult = StarkProofOutcome;

/**
 * Configuration for the STARK proof generator helper.
 *
 * BREAKING CHANGE (0.3.0): `wasmPath`, `zkeyPath`, and `useWebWorker` are
 * gone. Pass a `StarkProofGenerator` (typically the
 * `generateStarkProof` method returned by
 * `createStarkProver(...)` in `@protocol-01/stark-prover`).
 */
export interface ProofGeneratorConfig {
  /**
   * Host-supplied STARK proof generator. Build it once at app startup with
   * `createStarkProver({ connection, payer })` from
   * `@protocol-01/stark-prover` and reuse the same handle for every call.
   */
  prover: StarkProofGenerator;
}

/**
 * Input signals for the denominated pool circuit (STARK circuit 1,
 * POOL_COMMITMENT).
 *
 * Field elements are decimal strings; `pathElements` / `pathIndices` are
 * accepted but ignored by circuit 1 (kept for transitional compatibility
 * with callers wiring up the legacy 0.2.x shape — they are consumed by
 * MERKLE_PATH / MERKLE_UPDATE on the privacy-sdk side instead).
 */
export interface DenominatedPoolInputs {
  /** Nullifier preimage as a decimal field element. */
  nullifierPreimage: string;
  /** Secret as a decimal field element. */
  secret: string;
  /** Deposit slot/epoch as decimal. */
  depositEpoch: string;
  /** Token mint as a decimal field element. */
  tokenMint: string;
  /**
   * (Unused by POOL_COMMITMENT; supplied to MERKLE_PATH on the privacy-sdk
   * unshield path.) Merkle path elements as decimal strings.
   */
  pathElements?: string[];
  /**
   * (Unused by POOL_COMMITMENT.) Merkle path indices as '0'/'1' strings.
   */
  pathIndices?: string[];
}

// ============ Proof Generation ============

/**
 * Generate a STARK proof for the denominated pool deposit circuit
 * (POOL_COMMITMENT, circuit id 1) and submit it on-chain via
 * `p01_stark_verifier`.
 *
 * Returns the PDA of the verified proof buffer plus the public inputs
 * bound into the transcript. The host can pass `proofBuffer` straight to
 * `zk_shielded` shield/unshield instructions which read the verified
 * buffer cross-program.
 *
 * REQUIRES: a `StarkProofGenerator` from `@protocol-01/stark-prover` —
 * pass the `generateStarkProof` returned by `createStarkProver(...)`.
 *
 * @param inputs - Circuit input signals (decimal strings, field elements).
 * @param prover - Host-supplied STARK generator.
 * @returns `StarkProofOutcome` with `proofBuffer`, `circuitId: 1`, and
 *          `publicInputs: [nullifier, commitment]`.
 *
 * @example
 * ```ts
 * import { createStarkProver } from '@protocol-01/stark-prover';
 * import { generateDenominatedPoolStarkProof } from '@protocol-01/p01-js';
 *
 * const { generateStarkProof } = createStarkProver({ connection, payer });
 *
 * const result = await generateDenominatedPoolStarkProof(
 *   {
 *     nullifierPreimage: '12345...',
 *     secret: '67890...',
 *     depositEpoch: '1000000',
 *     tokenMint: '99999...',
 *   },
 *   generateStarkProof,
 * );
 *
 * console.log(result.proofBuffer.toBase58()); // PDA of verified buffer
 * ```
 */
export async function generateDenominatedPoolStarkProof(
  inputs: Record<string, string | string[] | number[]>,
  prover: StarkProofGenerator,
): Promise<StarkProofOutcome> {
  if (typeof prover !== 'function') {
    throw new Error(
      'generateDenominatedPoolStarkProof() requires a StarkProofGenerator. ' +
        'Build one via createStarkProver({ connection, payer }) from ' +
        '@protocol-01/stark-prover and pass the returned `generateStarkProof`.',
    );
  }

  const required = ['nullifierPreimage', 'secret', 'depositEpoch', 'tokenMint'] as const;
  for (const key of required) {
    if (inputs[key] === undefined || inputs[key] === null) {
      throw new Error(
        `Missing required private input "${key}" for POOL_COMMITMENT (circuit 1).`,
      );
    }
  }

  return prover(STARK_CIRCUITS.POOL_COMMITMENT, inputs);
}

// ============ Proof Verification ============

/**
 * Client-side proof verification is not supported in 0.3.0+.
 *
 * On-chain verification is performed by the `p01_stark_verifier` Solana
 * program during the chunked upload flow inside
 * `@protocol-01/stark-prover`. By the time this SDK returns a
 * `StarkProofOutcome`, the proof has already passed the two-phase DEEP-ALI
 * verifier on-chain — there is nothing left to check off-chain.
 *
 * If you need a re-validation hook (e.g. for an audit log), inspect the
 * `proofBuffer` PDA on-chain or rerun the prover.
 *
 * @deprecated Removed in 0.3.0. Always throws.
 */
export function verifyProof(): never {
  throw new Error(
    'On-chain verification handled by p01_stark_verifier; client-side verify not supported.',
  );
}

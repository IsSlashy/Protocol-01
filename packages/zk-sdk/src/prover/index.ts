/**
 * STARK prover adapter.
 *
 * v1.0.0 of `@protocol-01/zk-sdk` no longer ships a Groth16 prover. Proof
 * generation is delegated to `@protocol-01/stark-prover`, which produces
 * Goldilocks-field STARK proofs and uploads them to `p01_stark_verifier` on
 * Solana. This module re-exports the public surface of `stark-prover` plus
 * a couple of typed helpers that wrap the most common circuit calls.
 *
 * For the canonical wiring pattern see
 * `packages/privacy-sdk/src/modules/shield.ts:1208-1237` (private
 * `requestStarkProof`).
 */

import {
  createStarkProver,
  STARK_CIRCUITS,
  type StarkProofGenerator,
  type StarkProofOutcome,
  type StarkProverConfig,
  type StarkCircuitId,
} from '@protocol-01/stark-prover';

export {
  createStarkProver,
  STARK_CIRCUITS,
  type StarkProofGenerator,
  type StarkProofOutcome,
  type StarkProverConfig,
  type StarkCircuitId,
};

import type { StarkPrivateInputs } from '../types';

/**
 * Generate a circuit-5 (transfer) STARK proof. Thin wrapper that hardcodes
 * the circuit ID so callers don't have to remember it.
 *
 * @param generator Host-supplied generator from
 *   `createStarkProver(...).generateStarkProof` (or any function with the
 *   same shape).
 * @param privateInputs Circuit-5 private inputs — see
 *   `@protocol-01/stark-prover/src/index.ts` for the canonical key names
 *   (`spendingKey`, `tokenMint`, `inAmount1`, `inRand1`, `inAmount2`,
 *   `inRand2`, `outAmount1`, `outRecipient1`, `outRand1`, `outAmount2`,
 *   `outRecipient2`, `outRand2`, `publicAmount`).
 */
export async function requestTransferProof(
  generator: StarkProofGenerator,
  privateInputs: StarkPrivateInputs,
): Promise<StarkProofOutcome> {
  return generator(STARK_CIRCUITS.TRANSFER, privateInputs);
}

/**
 * Generate a circuit-6 (merkle_update) STARK proof for variable-pool shield.
 *
 * ⚠️ WARNING: circuit 6 is not yet exported by the bundled WASM. This call
 * will throw at runtime until the WASM is rebuilt — see
 * `packages/stark-prover/README.md` for the rebuild command.
 *
 * Required inputs: `oldLeaf`, `newLeaf`, `pathElements`, `pathIndices`.
 */
export async function requestMerkleUpdateProof(
  generator: StarkProofGenerator,
  privateInputs: StarkPrivateInputs,
): Promise<StarkProofOutcome> {
  return generator(STARK_CIRCUITS.MERKLE_UPDATE, privateInputs);
}

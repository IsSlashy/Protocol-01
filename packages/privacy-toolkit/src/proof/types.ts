/**
 * snarkjs-compatible Groth16 proof format (legacy backward-compat).
 *
 * Structural shape matching the object historically returned by
 * `snarkjs.groth16.fullProve`. Kept for callers still consuming Groth16
 * proofs; Protocol 01 itself has migrated to STARK proofs at runtime, so
 * `snarkjs` is no longer a required dependency of this package.
 */
export interface SnarkjsProof {
  pi_a: [string, string, string];
  pi_b: [[string, string], [string, string], [string, string]];
  pi_c: [string, string, string];
  protocol: string;
  curve: string;
}

/**
 * On-chain proof format for Solana (256 bytes)
 * Layout: pi_a (64) | pi_b (128) | pi_c (64)
 */
export type OnChainProofBytes = number[];

/**
 * Result of proof format conversion
 */
export interface ProofConversionResult {
  proofBytes: OnChainProofBytes;
  publicInputsLE: number[][];
}

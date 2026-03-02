/**
 * snarkjs proof format (as returned by snarkjs.groth16.fullProve)
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

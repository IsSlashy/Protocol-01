import type { SnarkjsProof, OnChainProofBytes } from './types';

/**
 * Convert a field element string to 32 big-endian bytes.
 */
function fieldToBeBytes32(str: string): number[] {
  let n = BigInt(str);
  const bytes = new Array(32);
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(n & 0xFFn);
    n >>= 8n;
  }
  return bytes;
}

/**
 * Convert a snarkjs Groth16 proof to the 256-byte on-chain format
 * expected by Solana's alt_bn128 pairing precompile.
 *
 * Layout (256 bytes total):
 *   - pi_a: 2 x 32 bytes (G1 point: x, y)
 *   - pi_b: 2 x 2 x 32 bytes (G2 point, with real/imaginary SWAPPED)
 *   - pi_c: 2 x 32 bytes (G1 point: x, y)
 *
 * CRITICAL: snarkjs G2 format is [[c0_x, c1_x], [c0_y, c1_y]]
 * but the EIP-197 / alt_bn128 precompile expects [c1_x, c0_x, c1_y, c0_y]
 * (imaginary part first, then real part).
 *
 * This function handles the swap automatically.
 */
export function proofToOnChainBytes(proof: SnarkjsProof): OnChainProofBytes {
  const bytes: number[] = [];

  // pi_a (G1): [x, y]
  bytes.push(...fieldToBeBytes32(proof.pi_a[0]));
  bytes.push(...fieldToBeBytes32(proof.pi_a[1]));

  // pi_b (G2): swap real/imaginary for EIP-197 format
  // snarkjs: [[c0_x, c1_x], [c0_y, c1_y]]
  // on-chain: [c1_x, c0_x, c1_y, c0_y] (imaginary first)
  bytes.push(...fieldToBeBytes32(proof.pi_b[0][1])); // x_imag
  bytes.push(...fieldToBeBytes32(proof.pi_b[0][0])); // x_real
  bytes.push(...fieldToBeBytes32(proof.pi_b[1][1])); // y_imag
  bytes.push(...fieldToBeBytes32(proof.pi_b[1][0])); // y_real

  // pi_c (G1): [x, y]
  bytes.push(...fieldToBeBytes32(proof.pi_c[0]));
  bytes.push(...fieldToBeBytes32(proof.pi_c[1]));

  return bytes;
}

/**
 * Convert public input strings to little-endian 32-byte arrays
 * for Solana on-chain storage.
 *
 * Solana stores values in little-endian, but the alt_bn128 precompile
 * expects big-endian. The on-chain verifier handles the LE->BE conversion.
 */
export function publicInputsToLE(inputs: string[]): number[][] {
  return inputs.map(input => {
    let n = BigInt(input);
    const bytes = new Array(32);
    for (let i = 0; i < 32; i++) {
      bytes[i] = Number(n & 0xFFn);
      n >>= 8n;
    }
    return bytes;
  });
}

/**
 * Convert public input strings to big-endian 32-byte arrays.
 * Use this when sending directly to the alt_bn128 precompile.
 */
export function publicInputsToBE(inputs: string[]): number[][] {
  return inputs.map(input => fieldToBeBytes32(input));
}

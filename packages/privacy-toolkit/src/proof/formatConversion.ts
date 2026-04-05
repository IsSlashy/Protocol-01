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
 * **Why the G2 coordinate swap?**
 * snarkjs outputs G2 points as [[c0_x, c1_x], [c0_y, c1_y]] where c0 is
 * the real coefficient and c1 is the imaginary coefficient of the Fp2 element.
 * However, the EIP-197 / alt_bn128 pairing precompile (used by Solana) expects
 * G2 points serialized as [c1_x, c0_x, c1_y, c0_y] — imaginary part first,
 * then real part. This ordering matches the Ethereum Yellow Paper's convention
 * for encoding elements of Fp2 = Fp[u]/(u^2 + 1). Without this swap, the
 * pairing check will fail with a valid proof.
 *
 * This function handles the swap automatically.
 *
 * @param proof - A snarkjs Groth16 proof object (as returned by `snarkjs.groth16.fullProve`)
 * @returns A 256-element number array ready for on-chain verification
 * @throws {TypeError} If the proof object is missing required fields or has invalid structure
 */
export function proofToOnChainBytes(proof: SnarkjsProof): OnChainProofBytes {
  if (!proof || typeof proof !== 'object') {
    throw new TypeError(
      'proofToOnChainBytes: proof must be a SnarkjsProof object with pi_a, pi_b, and pi_c fields',
    );
  }
  if (
    !Array.isArray(proof.pi_a) ||
    proof.pi_a.length < 2 ||
    typeof proof.pi_a[0] !== 'string' ||
    typeof proof.pi_a[1] !== 'string'
  ) {
    throw new TypeError(
      'proofToOnChainBytes: proof.pi_a must be an array of at least 2 numeric strings [x, y, ...]',
    );
  }
  if (
    !Array.isArray(proof.pi_b) ||
    proof.pi_b.length < 2 ||
    !Array.isArray(proof.pi_b[0]) ||
    proof.pi_b[0].length < 2 ||
    !Array.isArray(proof.pi_b[1]) ||
    proof.pi_b[1].length < 2
  ) {
    throw new TypeError(
      'proofToOnChainBytes: proof.pi_b must be an array of at least 2 sub-arrays, each with at least 2 numeric strings [[c0_x, c1_x], [c0_y, c1_y], ...]',
    );
  }
  if (
    !Array.isArray(proof.pi_c) ||
    proof.pi_c.length < 2 ||
    typeof proof.pi_c[0] !== 'string' ||
    typeof proof.pi_c[1] !== 'string'
  ) {
    throw new TypeError(
      'proofToOnChainBytes: proof.pi_c must be an array of at least 2 numeric strings [x, y, ...]',
    );
  }
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
 *
 * @param inputs - Array of numeric strings representing public signals
 * @returns Array of 32-byte little-endian number arrays
 * @throws {TypeError} If inputs is not a non-empty array of strings
 */
export function publicInputsToLE(inputs: string[]): number[][] {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new TypeError(
      'publicInputsToLE: inputs must be a non-empty array of numeric strings',
    );
  }
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
 *
 * @param inputs - Array of numeric strings representing public signals
 * @returns Array of 32-byte big-endian number arrays
 * @throws {TypeError} If inputs is not a non-empty array of strings
 */
export function publicInputsToBE(inputs: string[]): number[][] {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new TypeError(
      'publicInputsToBE: inputs must be a non-empty array of numeric strings',
    );
  }
  return inputs.map(input => fieldToBeBytes32(input));
}

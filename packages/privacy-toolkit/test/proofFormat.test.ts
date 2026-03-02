import { describe, it, expect } from 'vitest';
import { proofToOnChainBytes, publicInputsToLE, publicInputsToBE } from '../src/proof/formatConversion';
import type { SnarkjsProof } from '../src/proof/types';

describe('Proof Format Conversion', () => {
  const mockProof: SnarkjsProof = {
    pi_a: ['1', '2', '1'],
    pi_b: [['3', '4'], ['5', '6'], ['1', '1']],
    pi_c: ['7', '8', '1'],
    protocol: 'groth16',
    curve: 'bn128',
  };

  it('converts proof to 256 bytes', () => {
    const bytes = proofToOnChainBytes(mockProof);
    expect(bytes).toHaveLength(256);
  });

  it('swaps G2 real/imaginary correctly', () => {
    const bytes = proofToOnChainBytes(mockProof);
    // pi_b starts at offset 64 (after pi_a)
    // First 32 bytes of pi_b should be field(4) = pi_b[0][1] (imaginary x)
    // Then field(3) = pi_b[0][0] (real x)
    const xImag = bytes.slice(64, 96);
    const xReal = bytes.slice(96, 128);
    // field(4) should have 4 at the last byte (big-endian)
    expect(xImag[31]).toBe(4);
    // field(3) should have 3 at the last byte
    expect(xReal[31]).toBe(3);
  });

  it('converts public inputs to LE', () => {
    const inputs = ['256', '65536'];
    const result = publicInputsToLE(inputs);
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(32);
    // 256 in LE: [0, 1, 0, 0, ...]
    expect(result[0][0]).toBe(0);
    expect(result[0][1]).toBe(1);
  });

  it('converts public inputs to BE', () => {
    const inputs = ['256'];
    const result = publicInputsToBE(inputs);
    expect(result[0]).toHaveLength(32);
    // 256 in BE: [..., 0, 1, 0]
    expect(result[0][30]).toBe(1);
    expect(result[0][31]).toBe(0);
  });

  it('handles large field elements', () => {
    const large = '21888242871839275222246405745257275088548364400416034343698204186575808495616';
    const result = publicInputsToLE([large]);
    expect(result[0]).toHaveLength(32);
    // Should not throw
  });
});

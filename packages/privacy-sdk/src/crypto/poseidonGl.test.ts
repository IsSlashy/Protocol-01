/**
 * Parity tests for Goldilocks Poseidon TS port.
 *
 * Vectors are locked against:
 *   - stark/src/poseidon/mod.rs::parity (off-chain Rust prover)
 *   - programs/p01_stark_verifier (on-chain Solana verifier)
 *
 * If any of these drift, the prover/verifier protocol is broken — DO NOT
 * "fix" the test by updating the constants. Find the root cause first.
 */

import { describe, it, expect } from 'vitest';
import {
  GOLDILOCKS_MODULUS,
  fieldAdd,
  fieldMul,
  fieldPow,
  fieldReduce,
  poseidonPermute,
  poseidonHash2,
  poseidonHash4,
} from './poseidonGl';

describe('Goldilocks field arithmetic', () => {
  it('GOLDILOCKS_MODULUS is 2^64 - 2^32 + 1', () => {
    expect(GOLDILOCKS_MODULUS).toBe((1n << 64n) - (1n << 32n) + 1n);
    expect(GOLDILOCKS_MODULUS).toBe(18446744069414584321n);
  });

  it('fieldReduce wraps negatives into [0, p)', () => {
    expect(fieldReduce(-1n)).toBe(GOLDILOCKS_MODULUS - 1n);
    expect(fieldReduce(0n)).toBe(0n);
    expect(fieldReduce(GOLDILOCKS_MODULUS)).toBe(0n);
    expect(fieldReduce(GOLDILOCKS_MODULUS + 7n)).toBe(7n);
  });

  it('fieldAdd handles 64-bit overflow', () => {
    const a = GOLDILOCKS_MODULUS - 1n;
    expect(fieldAdd(a, 1n)).toBe(0n);
    expect(fieldAdd(a, a)).toBe(GOLDILOCKS_MODULUS - 2n);
  });

  it('fieldMul handles full 128-bit product', () => {
    const a = GOLDILOCKS_MODULUS - 1n; // -1 mod p
    expect(fieldMul(a, a)).toBe(1n);   // (-1)*(-1) = 1
  });

  it('fieldPow matches pow7 parity (Rust: pow7(2)=128, pow7(3)=2187)', () => {
    expect(fieldPow(2n, 7n)).toBe(128n);
    expect(fieldPow(3n, 7n)).toBe(2187n);
    expect(fieldPow(0n, 7n)).toBe(0n);
    expect(fieldPow(1n, 7n)).toBe(1n);
  });
});

describe('Poseidon permutation determinism', () => {
  it('poseidonPermute is deterministic', () => {
    const a: [bigint, bigint, bigint] = [1n, 2n, 3n];
    const b: [bigint, bigint, bigint] = [1n, 2n, 3n];
    poseidonPermute(a);
    poseidonPermute(b);
    expect(a).toEqual(b);
  });

  it('permute mutates in place AND returns the same reference', () => {
    const s: [bigint, bigint, bigint] = [0n, 0n, 0n];
    const out = poseidonPermute(s);
    expect(out).toBe(s);
  });

  it('hash order matters: hash2(a,b) !== hash2(b,a)', () => {
    expect(poseidonHash2(1n, 2n)).not.toBe(poseidonHash2(2n, 1n));
  });
});

describe('Poseidon parity vectors (LOCKED — Rust + on-chain)', () => {
  it('poseidonHash2(0, 0) === 18051734659105196655n', () => {
    expect(poseidonHash2(0n, 0n)).toBe(18051734659105196655n);
  });

  it('poseidonHash4(1, 2, 3, 4) === 3933389460072713373n (t=5 permutation)', () => {
    expect(poseidonHash4(1n, 2n, 3n, 4n)).toBe(3933389460072713373n);
  });

  // Bonus parity for hash2(1,2) — also locked in Rust parity module.
  it('poseidonHash2(1, 2) === 18184238532291717445n', () => {
    expect(poseidonHash2(1n, 2n)).toBe(18184238532291717445n);
  });
});

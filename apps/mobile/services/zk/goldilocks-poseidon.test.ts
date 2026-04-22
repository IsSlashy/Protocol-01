/**
 * Parity tests for `goldilocks-poseidon.ts` against the Rust STARK prover
 * (`stark/src/poseidon/mod.rs` + `stark/src/air/merkle_update.rs`).
 *
 * Reference vectors are produced by:
 *   - `cargo test --lib --release poseidon` (T3/T5 parity constants)
 *   - `cargo run --release --bin gen_proof -p p01-stark -- merkle-update \
 *        0 1 "0,0,0,0,0,0,0,0,0,0,0,0,0,0,0" "0,0,0,0,0,0,0,0,0,0,0,0,0,0,0"`
 *      → public_inputs = [old_leaf=0, new_leaf=1, old_root, new_root, depth=15]
 *
 * Any failure here means the TS hash drifted from Rust and on-chain proofs
 * built by the mobile client will be rejected. DO NOT "fix" by changing
 * expected values — re-run the Rust reference and trace the divergence.
 */

import { describe, it, expect } from 'vitest';
import {
  GOLDILOCKS_MODULUS,
  ROUND_CONSTANTS_T3,
  ROUND_CONSTANTS_T5,
  MDS_MATRIX_T3,
  MDS_MATRIX_T5,
  poseidonPermutationT3,
  poseidonPermutationT5,
  goldilocksHash2to1,
  goldilocksHash4to1,
  computeCommitmentHash,
  computeGoldilocksZeroCascade,
} from './goldilocks-poseidon';

// -----------------------------------------------------------------------------
// Sanity of table sizes (catches any accidental reformatting)
// -----------------------------------------------------------------------------

describe('goldilocks-poseidon tables', () => {
  it('has 90 t=3 round constants (30 rounds × 3)', () => {
    expect(ROUND_CONSTANTS_T3.length).toBe(90);
  });
  it('has 150 t=5 round constants (30 rounds × 5)', () => {
    expect(ROUND_CONSTANTS_T5.length).toBe(150);
  });
  it('has circulant t=3 MDS [[3,1,1],[1,3,1],[1,1,3]]', () => {
    expect(MDS_MATRIX_T3.length).toBe(3);
    expect(MDS_MATRIX_T3[0]).toEqual([3n, 1n, 1n]);
    expect(MDS_MATRIX_T3[1]).toEqual([1n, 3n, 1n]);
    expect(MDS_MATRIX_T3[2]).toEqual([1n, 1n, 3n]);
  });
  it('has circulant t=5 MDS with 5 on the diagonal', () => {
    expect(MDS_MATRIX_T5.length).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(MDS_MATRIX_T5[i][i]).toBe(5n);
    }
  });
  it('Goldilocks modulus is 2^64 - 2^32 + 1', () => {
    expect(GOLDILOCKS_MODULUS).toBe((1n << 64n) - (1n << 32n) + 1n);
  });
});

// -----------------------------------------------------------------------------
// Parity vectors (locked to Rust test `parity_vectors_t3` and `_t5`)
// -----------------------------------------------------------------------------

describe('goldilocks-poseidon parity with Rust', () => {
  it('hash2(0, 0) matches Rust POSEIDON_T3_ZERO_ZERO', () => {
    // stark/src/poseidon/mod.rs::parity::POSEIDON_T3_ZERO_ZERO
    expect(goldilocksHash2to1(0n, 0n)).toBe(18051734659105196655n);
  });

  it('hash2(1, 2) matches Rust POSEIDON_T3_ONE_TWO', () => {
    // stark/src/poseidon/mod.rs::parity::POSEIDON_T3_ONE_TWO
    expect(goldilocksHash2to1(1n, 2n)).toBe(18184238532291717445n);
  });

  it('hash2 is order-sensitive', () => {
    expect(goldilocksHash2to1(1n, 2n)).not.toBe(goldilocksHash2to1(2n, 1n));
  });

  it('hash4(1, 2, 3, 4) matches Rust POSEIDON_T5_ONE_TWO_THREE_FOUR', () => {
    // stark/src/poseidon/mod.rs::parity::POSEIDON_T5_ONE_TWO_THREE_FOUR
    expect(goldilocksHash4to1(1n, 2n, 3n, 4n)).toBe(3933389460072713373n);
  });

  it('permutationT3 is deterministic', () => {
    const a = poseidonPermutationT3([7n, 11n, 0n]);
    const b = poseidonPermutationT3([7n, 11n, 0n]);
    expect(a).toEqual(b);
  });

  it('permutationT5 is deterministic', () => {
    const a = poseidonPermutationT5([1n, 2n, 3n, 4n, 0n]);
    const b = poseidonPermutationT5([1n, 2n, 3n, 4n, 0n]);
    expect(a).toEqual(b);
  });
});

// -----------------------------------------------------------------------------
// Merkle update cross-check (circuit 6 reference vector)
// -----------------------------------------------------------------------------

describe('merkle_update root cross-check', () => {
  /**
   * Reproduce the on-chain old_root / new_root computed by Rust
   * `compute_update_roots(old_leaf, new_leaf, path_elements, path_indices)`.
   *
   * Reference: `cargo run --release --bin gen_proof -p p01-stark -- \
   *   merkle-update 0 1 "0,0,0,0,0,0,0,0,0,0,0,0,0,0,0" \
   *                     "0,0,0,0,0,0,0,0,0,0,0,0,0,0,0"`
   *   → public_inputs = [0, 1, 14147879776411177461, 9402648886471099004, 15]
   */
  function computeUpdateRoots(
    oldLeaf: bigint,
    newLeaf: bigint,
    pathElements: bigint[],
    pathIndices: number[],
  ): { oldRoot: bigint; newRoot: bigint } {
    let oldCur = oldLeaf;
    let newCur = newLeaf;
    for (let i = 0; i < pathElements.length; i++) {
      const sibling = pathElements[i];
      if (pathIndices[i] === 0) {
        oldCur = goldilocksHash2to1(oldCur, sibling);
        newCur = goldilocksHash2to1(newCur, sibling);
      } else {
        oldCur = goldilocksHash2to1(sibling, oldCur);
        newCur = goldilocksHash2to1(sibling, newCur);
      }
    }
    return { oldRoot: oldCur, newRoot: newCur };
  }

  it('zero-path depth-15 update 0 -> 1 matches Rust gen_proof output', () => {
    const path = new Array<bigint>(15).fill(0n);
    const indices = new Array<number>(15).fill(0);
    const { oldRoot, newRoot } = computeUpdateRoots(0n, 1n, path, indices);
    expect(oldRoot).toBe(14147879776411177461n);
    expect(newRoot).toBe(9402648886471099004n);
  });

  it('zero cascade is self-consistent (zero[L] = hash(zero[L-1], zero[L-1]))', () => {
    // The zero cascade represents a fully-empty subtree at each level: both
    // children are the empty-subtree hash one level down. This is distinct
    // from the "zero-sibling" chain `hash(cur, 0)` used by an all-zero path
    // witness in `compute_update_roots`.
    const cascade = computeGoldilocksZeroCascade(10);
    expect(cascade.length).toBe(11);
    expect(cascade[0]).toBe(0n);
    for (let i = 1; i <= 10; i++) {
      expect(cascade[i]).toBe(goldilocksHash2to1(cascade[i - 1], cascade[i - 1]));
    }
    // First level: hash(0, 0) is the canonical Rust parity vector.
    expect(cascade[1]).toBe(18051734659105196655n);
  });

  it('zero-sibling chain (all-zero path) matches Rust merkle_update old_root', () => {
    // With path_indices=0 on every level the current hash is always LEFT and
    // the zero sibling is RIGHT → cur := hash2(cur, 0). This must agree with
    // the Rust reference old_root (14147879776411177461) for leaf=0.
    let cur = 0n;
    for (let i = 0; i < 15; i++) {
      cur = goldilocksHash2to1(cur, 0n);
    }
    expect(cur).toBe(14147879776411177461n);
  });

  it('commitment hash over 4 inputs follows pool_commitment layout', () => {
    // pool_commitment = hash(hash(a, b), hash(c, d))
    const a = 11n, b = 22n, c = 33n, d = 44n;
    const expected = goldilocksHash2to1(
      goldilocksHash2to1(a, b),
      goldilocksHash2to1(c, d),
    );
    expect(computeCommitmentHash([a, b, c, d])).toBe(expected);
  });
});

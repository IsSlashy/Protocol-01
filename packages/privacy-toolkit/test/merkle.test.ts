import { describe, it, expect } from 'vitest';
import { poseidon2 } from 'poseidon-lite';
import { computeZeroHashes, getZeroHashes } from '../src/merkle/incrementalTree';
import { computeRootAndProofFromSubtrees, computeRootFromSubtrees } from '../src/merkle/proofFromSubtrees';

describe('Merkle Tree', () => {
  const DEPTH = 15;
  const ZERO = BigInt('21663839004416932945382355908790599225266501822907911457504978515578255421292');

  it('computes zero hashes correctly', () => {
    const zeros = computeZeroHashes(DEPTH, ZERO);
    expect(zeros).toHaveLength(DEPTH + 1);
    expect(zeros[0]).toBe(ZERO);
    expect(zeros[1]).toBe(poseidon2([ZERO, ZERO]));
    expect(zeros[2]).toBe(poseidon2([zeros[1], zeros[1]]));
  });

  it('caches zero hashes', () => {
    const z1 = getZeroHashes(20);
    const z2 = getZeroHashes(20);
    expect(z1).toBe(z2); // same reference
  });

  it('computes root and proof from empty subtrees', () => {
    const zeros = computeZeroHashes(DEPTH, ZERO);
    const subtrees = new Array(DEPTH).fill(ZERO);
    const leaf = 12345n;

    const result = computeRootAndProofFromSubtrees(leaf, 0, subtrees, DEPTH, ZERO);

    expect(result.pathElements).toHaveLength(DEPTH);
    expect(result.pathIndices).toHaveLength(DEPTH);
    expect(result.pathIndices[0]).toBe(0); // first leaf goes left
    expect(result.newRoot).toBeTruthy();
  });

  it('computes consistent root for sequential inserts', () => {
    const subtrees = new Array(DEPTH).fill(ZERO);
    const leaf1 = 111n;
    const leaf2 = 222n;

    const r1 = computeRootAndProofFromSubtrees(leaf1, 0, subtrees, DEPTH, ZERO);
    const r2 = computeRootAndProofFromSubtrees(leaf2, 1, r1.updatedSubtrees, DEPTH, ZERO);

    expect(r1.newRoot).not.toBe(r2.newRoot);
    expect(r2.pathIndices[0]).toBe(1); // second leaf goes right
  });

  it('proof path indices match leaf index bits', () => {
    const subtrees = new Array(DEPTH).fill(ZERO);
    let currentSubtrees = subtrees;

    // Insert 5 leaves to get leafIndex=5 (binary 101)
    for (let i = 0; i < 5; i++) {
      const r = computeRootAndProofFromSubtrees(BigInt(i + 1), i, currentSubtrees, DEPTH, ZERO);
      currentSubtrees = r.updatedSubtrees;
    }

    const result = computeRootAndProofFromSubtrees(999n, 5, currentSubtrees, DEPTH, ZERO);
    // 5 = 0b101 -> indices should be [1, 0, 1, 0, 0, ...]
    expect(result.pathIndices[0]).toBe(1);
    expect(result.pathIndices[1]).toBe(0);
    expect(result.pathIndices[2]).toBe(1);
  });
});

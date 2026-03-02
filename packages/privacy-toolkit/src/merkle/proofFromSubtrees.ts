import { poseidon2 } from 'poseidon-lite';
import { computeZeroHashes } from './incrementalTree';
import type { IncrementalTreeUpdate } from './types';

/**
 * Compute a new Merkle root and proof from on-chain filledSubtrees.
 *
 * This is a key optimization: instead of maintaining a full local Merkle tree
 * (which diverges from on-chain state), we read the minimal `filledSubtrees`
 * array from the on-chain account and compute both the new root AND the
 * Merkle proof in a single pass.
 *
 * How it works:
 * - `filledSubtrees[i]` stores the last node inserted at level i
 * - When inserting a new leaf at `leafIndex`, we walk up the tree:
 *   - If the bit at this level is 0 (left child), the sibling is the zero hash
 *   - If the bit is 1 (right child), the sibling is filledSubtrees[level]
 *
 * This gives us the proof elements AND computes the new root simultaneously.
 *
 * @param leaf - The new leaf to insert
 * @param leafIndex - The index where the leaf will be inserted (= current tree size)
 * @param filledSubtrees - The filledSubtrees array from the on-chain account
 * @param depth - Tree depth (default 20)
 * @param zeroValue - The zero value for empty leaves
 */
export function computeRootAndProofFromSubtrees(
  leaf: bigint,
  leafIndex: number,
  filledSubtrees: bigint[],
  depth: number = 20,
  zeroValue?: bigint,
): IncrementalTreeUpdate {
  const zeros = computeZeroHashes(depth, zeroValue);
  const subtrees = [...filledSubtrees];
  const pathElements: bigint[] = [];
  const pathIndices: number[] = [];

  let current = leaf;
  let idx = leafIndex;

  for (let level = 0; level < depth; level++) {
    const isRight = idx & 1;
    pathIndices.push(isRight);

    if (isRight === 0) {
      pathElements.push(zeros[level]);
      subtrees[level] = current;
      current = poseidon2([current, zeros[level]]);
    } else {
      pathElements.push(subtrees[level]);
      current = poseidon2([subtrees[level], current]);
    }

    idx >>= 1;
  }

  return { newRoot: current, updatedSubtrees: subtrees, pathElements, pathIndices };
}

/**
 * Compute just the Merkle root from filledSubtrees (without proof).
 * Useful for verification only.
 */
export function computeRootFromSubtrees(
  filledSubtrees: bigint[],
  nextLeafIndex: number,
  depth: number = 20,
  zeroValue?: bigint,
): bigint {
  const zeros = computeZeroHashes(depth, zeroValue);
  let current = zeros[0]; // empty leaf
  let idx = nextLeafIndex;

  for (let level = 0; level < depth; level++) {
    const isRight = idx & 1;
    if (isRight === 0) {
      current = poseidon2([current, zeros[level]]);
    } else {
      current = poseidon2([filledSubtrees[level], current]);
    }
    idx >>= 1;
  }

  return current;
}

/**
 * Merkle tree utilities for note commitment storage
 * Implements a sparse Merkle tree with Poseidon hashing
 */

import { getPoseidon, poseidonHashSync } from '../circuits';
import { MERKLE_TREE_DEPTH, ZERO_VALUE, MAX_TREE_LEAVES } from '../constants';
import type { MerkleProofData } from '../types';

/**
 * Sparse Merkle tree implementation
 */
export class MerkleTree {
  private depth: number;
  private leaves: Map<number, bigint>;
  private nodes: Map<string, bigint>;
  private zeroValues: bigint[];
  private poseidon: any;
  private _root: bigint | null = null;

  constructor(depth: number = MERKLE_TREE_DEPTH) {
    this.depth = depth;
    this.leaves = new Map();
    this.nodes = new Map();
    this.zeroValues = [];
    this.poseidon = null;
  }

  /**
   * Initialize the tree (must be called before use)
   */
  async initialize(): Promise<void> {
    this.poseidon = await getPoseidon();

    // Pre-compute zero values for each level
    let current = ZERO_VALUE;
    this.zeroValues = [current];

    for (let i = 0; i < this.depth; i++) {
      current = poseidonHashSync(this.poseidon, [current, current]);
      this.zeroValues.push(current);
    }

    this._root = this.zeroValues[this.depth];
  }

  /**
   * Get current root
   */
  get root(): bigint {
    if (this._root === null) {
      throw new Error('Tree not initialized');
    }
    return this._root;
  }

  /**
   * Get number of leaves
   */
  get leafCount(): number {
    return this.leaves.size;
  }

  /**
   * Insert a leaf at the next available index
   */
  insert(leaf: bigint): number {
    const index = this.leaves.size;
    if (index >= MAX_TREE_LEAVES) {
      throw new Error('Tree is full');
    }

    this.leaves.set(index, leaf);
    this.updatePath(index, leaf);

    return index;
  }

  /**
   * Insert a leaf at a specific index (for reconstruction)
   */
  insertAt(index: number, leaf: bigint): void {
    if (index >= MAX_TREE_LEAVES) {
      throw new Error('Index out of bounds');
    }

    this.leaves.set(index, leaf);
    this.updatePath(index, leaf);
  }

  /**
   * Get leaf at index
   */
  getLeaf(index: number): bigint | undefined {
    return this.leaves.get(index);
  }

  /**
   * Update the path from leaf to root
   */
  private updatePath(leafIndex: number, leafValue: bigint): void {
    let currentHash = leafValue;
    let currentIndex = leafIndex;

    for (let level = 0; level < this.depth; level++) {
      const isLeft = currentIndex % 2 === 0;
      const siblingIndex = isLeft ? currentIndex + 1 : currentIndex - 1;

      // Get sibling hash
      let sibling: bigint;
      if (level === 0) {
        sibling = this.leaves.get(siblingIndex) ?? ZERO_VALUE;
      } else {
        const siblingKey = `${level - 1}:${siblingIndex}`;
        sibling = this.nodes.get(siblingKey) ?? this.zeroValues[level];
      }

      // Compute parent hash
      const [left, right] = isLeft ? [currentHash, sibling] : [sibling, currentHash];
      currentHash = poseidonHashSync(this.poseidon, [left, right]);

      // Store in nodes map
      const parentIndex = Math.floor(currentIndex / 2);
      this.nodes.set(`${level}:${parentIndex}`, currentHash);

      currentIndex = parentIndex;
    }

    this._root = currentHash;
  }

  /**
   * Generate Merkle proof for a leaf
   */
  generateProof(leafIndex: number): MerkleProofData {
    const pathIndices: number[] = [];
    const pathElements: bigint[] = [];

    let currentIndex = leafIndex;

    for (let level = 0; level < this.depth; level++) {
      const isLeft = currentIndex % 2 === 0;
      const siblingIndex = isLeft ? currentIndex + 1 : currentIndex - 1;

      pathIndices.push(isLeft ? 0 : 1);

      // Get sibling
      let sibling: bigint;
      if (level === 0) {
        sibling = this.leaves.get(siblingIndex) ?? ZERO_VALUE;
      } else {
        const siblingKey = `${level - 1}:${siblingIndex}`;
        sibling = this.nodes.get(siblingKey) ?? this.zeroValues[level];
      }

      pathElements.push(sibling);
      currentIndex = Math.floor(currentIndex / 2);
    }

    return {
      pathIndices,
      pathElements,
      leafIndex,
    };
  }

  /**
   * Verify a Merkle proof
   */
  verifyProof(proof: MerkleProofData, leaf: bigint, root: bigint): boolean {
    let currentHash = leaf;

    for (let i = 0; i < proof.pathElements.length; i++) {
      const isLeft = proof.pathIndices[i] === 0;
      const [left, right] = isLeft
        ? [currentHash, proof.pathElements[i]]
        : [proof.pathElements[i], currentHash];

      currentHash = poseidonHashSync(this.poseidon, [left, right]);
    }

    return currentHash === root;
  }

  /**
   * Export tree state for serialization
   */
  export(): { leaves: [number, string][]; depth: number } {
    const leaves: [number, string][] = [];
    this.leaves.forEach((value, index) => {
      leaves.push([index, value.toString()]);
    });

    return { leaves, depth: this.depth };
  }

  /**
   * Import tree state
   */
  async import(state: { leaves: [number, string][]; depth: number }): Promise<void> {
    this.depth = state.depth;
    this.leaves.clear();
    this.nodes.clear();

    await this.initialize();

    // Sort leaves by index and insert
    const sortedLeaves = [...state.leaves].sort((a, b) => a[0] - b[0]);
    for (const [index, value] of sortedLeaves) {
      this.insertAt(index, BigInt(value));
    }
  }
}

/**
 * Generate Merkle proof for a leaf index
 */
export async function generateMerkleProof(
  tree: MerkleTree,
  leafIndex: number
): Promise<MerkleProofData> {
  return tree.generateProof(leafIndex);
}

/**
 * Verify a Merkle proof
 */
export async function verifyMerkleProof(
  proof: MerkleProofData,
  leaf: bigint,
  root: bigint
): Promise<boolean> {
  const tree = new MerkleTree(proof.pathElements.length);
  await tree.initialize();
  return tree.verifyProof(proof, leaf, root);
}

// Re-export types
export type { MerkleProofData as MerkleProof } from '../types';

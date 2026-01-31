/**
 * Unit tests for Merkle tree module
 * Tests tree construction, leaf insertion, proof generation, and proof verification
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ----- Mock external dependencies -----

// Track poseidon calls for verification
let poseidonCallCount = 0;

// Deterministic mock poseidon: H(a, b) = (a * 7 + b * 13 + 37) mod 2^64
// This ensures consistent behavior across tests while being simple to reason about.
function fakePoseidonHash(inputs: bigint[]): bigint {
  let acc = BigInt(37);
  for (let i = 0; i < inputs.length; i++) {
    acc = acc + inputs[i] * BigInt(7 + i * 6);
  }
  // Keep values manageable but large enough to avoid collisions
  return acc % BigInt('18446744073709551616'); // mod 2^64
}

const mockPoseidonInstance = Object.assign(
  (inputs: (bigint | number)[]) => {
    poseidonCallCount++;
    const bigInputs = inputs.map((x) => BigInt(x));
    const result = fakePoseidonHash(bigInputs);
    // Wrap in an object with the F.toObject pattern used by circomlibjs
    return result;
  },
  {
    F: {
      toObject: (val: any) => val,
    },
  }
);

vi.mock('../circuits', () => ({
  getPoseidon: vi.fn(async () => mockPoseidonInstance),
  poseidonHashSync: vi.fn(
    (_poseidon: any, inputs: (bigint | number)[]) => {
      const bigInputs = inputs.map((x) => BigInt(x));
      return fakePoseidonHash(bigInputs);
    }
  ),
}));

// ----- Imports (after mocks) -----

import { MerkleTree, generateMerkleProof, verifyMerkleProof } from './index';
import { ZERO_VALUE, MAX_TREE_LEAVES } from '../constants';

// ----- Helpers -----

async function createTree(depth: number = 3): Promise<MerkleTree> {
  const tree = new MerkleTree(depth);
  await tree.initialize();
  return tree;
}

// ----- Tests -----

describe('MerkleTree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    poseidonCallCount = 0;
  });

  describe('constructor', () => {
    it('should create a tree with default depth when none provided', () => {
      const tree = new MerkleTree();
      expect(tree.leafCount).toBe(0);
    });

    it('should create a tree with custom depth', () => {
      const tree = new MerkleTree(5);
      expect(tree.leafCount).toBe(0);
    });
  });

  describe('initialize', () => {
    it('should compute zero values and initial root', async () => {
      const tree = await createTree(3);

      // After initialization, the root should be defined
      expect(tree.root).toBeDefined();
      expect(typeof tree.root).toBe('bigint');
    });

    it('should set leafCount to 0 after initialization', async () => {
      const tree = await createTree(3);
      expect(tree.leafCount).toBe(0);
    });

    it('should throw when accessing root before initialization', () => {
      const tree = new MerkleTree(3);
      expect(() => tree.root).toThrow('Tree not initialized');
    });
  });

  describe('insert', () => {
    it('should insert a leaf and return index 0 for first insert', async () => {
      const tree = await createTree(3);

      const index = tree.insert(BigInt(100));

      expect(index).toBe(0);
      expect(tree.leafCount).toBe(1);
    });

    it('should return incrementing indices for sequential inserts', async () => {
      const tree = await createTree(3);

      const i0 = tree.insert(BigInt(100));
      const i1 = tree.insert(BigInt(200));
      const i2 = tree.insert(BigInt(300));

      expect(i0).toBe(0);
      expect(i1).toBe(1);
      expect(i2).toBe(2);
      expect(tree.leafCount).toBe(3);
    });

    it('should change the root after insertion', async () => {
      const tree = await createTree(3);
      const rootBefore = tree.root;

      tree.insert(BigInt(42));
      const rootAfter = tree.root;

      expect(rootAfter).not.toBe(rootBefore);
    });

    it('should produce different roots for different leaf values', async () => {
      const tree1 = await createTree(3);
      const tree2 = await createTree(3);

      tree1.insert(BigInt(100));
      tree2.insert(BigInt(200));

      expect(tree1.root).not.toBe(tree2.root);
    });

    it('should produce same root for same sequence of inserts', async () => {
      const tree1 = await createTree(3);
      const tree2 = await createTree(3);

      tree1.insert(BigInt(10));
      tree1.insert(BigInt(20));

      tree2.insert(BigInt(10));
      tree2.insert(BigInt(20));

      expect(tree1.root).toBe(tree2.root);
    });
  });

  describe('insertAt', () => {
    it('should insert at a specific index', async () => {
      const tree = await createTree(3);

      tree.insertAt(5, BigInt(500));

      expect(tree.getLeaf(5)).toBe(BigInt(500));
    });

    it('should change the root', async () => {
      const tree = await createTree(3);
      const rootBefore = tree.root;

      tree.insertAt(0, BigInt(123));

      expect(tree.root).not.toBe(rootBefore);
    });

    it('should throw if index is out of bounds', async () => {
      const tree = await createTree(3);

      expect(() => tree.insertAt(MAX_TREE_LEAVES, BigInt(1))).toThrow('Index out of bounds');
    });
  });

  describe('getLeaf', () => {
    it('should return the inserted leaf value', async () => {
      const tree = await createTree(3);

      tree.insert(BigInt(777));

      expect(tree.getLeaf(0)).toBe(BigInt(777));
    });

    it('should return undefined for non-existent leaves', async () => {
      const tree = await createTree(3);

      expect(tree.getLeaf(0)).toBeUndefined();
      expect(tree.getLeaf(99)).toBeUndefined();
    });

    it('should return correct values for multiple leaves', async () => {
      const tree = await createTree(3);

      tree.insert(BigInt(10));
      tree.insert(BigInt(20));
      tree.insert(BigInt(30));

      expect(tree.getLeaf(0)).toBe(BigInt(10));
      expect(tree.getLeaf(1)).toBe(BigInt(20));
      expect(tree.getLeaf(2)).toBe(BigInt(30));
    });
  });

  describe('generateProof', () => {
    it('should produce a proof with correct path length', async () => {
      const depth = 4;
      const tree = await createTree(depth);
      tree.insert(BigInt(100));

      const proof = tree.generateProof(0);

      expect(proof.pathIndices.length).toBe(depth);
      expect(proof.pathElements.length).toBe(depth);
      expect(proof.leafIndex).toBe(0);
    });

    it('should produce path indices of only 0s and 1s', async () => {
      const tree = await createTree(4);
      tree.insert(BigInt(100));
      tree.insert(BigInt(200));
      tree.insert(BigInt(300));

      const proof = tree.generateProof(1);

      for (const idx of proof.pathIndices) {
        expect(idx === 0 || idx === 1).toBe(true);
      }
    });

    it('should indicate left (0) for leaf at even index at level 0', async () => {
      const tree = await createTree(3);
      tree.insert(BigInt(10)); // index 0 (even)

      const proof = tree.generateProof(0);

      expect(proof.pathIndices[0]).toBe(0); // 0 = left
    });

    it('should indicate right (1) for leaf at odd index at level 0', async () => {
      const tree = await createTree(3);
      tree.insert(BigInt(10)); // index 0
      tree.insert(BigInt(20)); // index 1 (odd)

      const proof = tree.generateProof(1);

      expect(proof.pathIndices[0]).toBe(1); // 1 = right
    });

    it('should include sibling values in pathElements', async () => {
      const tree = await createTree(3);
      tree.insert(BigInt(10));
      tree.insert(BigInt(20));

      const proof = tree.generateProof(0);

      // The sibling of leaf 0 at level 0 is leaf 1
      expect(proof.pathElements[0]).toBe(BigInt(20));
    });

    it('should use ZERO_VALUE for empty sibling at level 0', async () => {
      const tree = await createTree(3);
      tree.insert(BigInt(10));

      const proof = tree.generateProof(0);

      // The sibling of leaf 0 is leaf 1, which is empty => ZERO_VALUE
      expect(proof.pathElements[0]).toBe(ZERO_VALUE);
    });
  });

  describe('verifyProof', () => {
    it('should verify a valid proof returns true', async () => {
      const tree = await createTree(3);
      tree.insert(BigInt(100));

      const leaf = BigInt(100);
      const proof = tree.generateProof(0);
      const root = tree.root;

      const valid = tree.verifyProof(proof, leaf, root);

      expect(valid).toBe(true);
    });

    it('should reject a proof with wrong leaf', async () => {
      const tree = await createTree(3);
      tree.insert(BigInt(100));

      const wrongLeaf = BigInt(999);
      const proof = tree.generateProof(0);
      const root = tree.root;

      const valid = tree.verifyProof(proof, wrongLeaf, root);

      expect(valid).toBe(false);
    });

    it('should reject a proof with wrong root', async () => {
      const tree = await createTree(3);
      tree.insert(BigInt(100));

      const leaf = BigInt(100);
      const proof = tree.generateProof(0);
      const wrongRoot = BigInt(12345);

      const valid = tree.verifyProof(proof, leaf, wrongRoot);

      expect(valid).toBe(false);
    });

    it('should verify proofs for multiple leaves', async () => {
      const tree = await createTree(3);
      const leaves = [BigInt(10), BigInt(20), BigInt(30), BigInt(40)];

      for (const leaf of leaves) {
        tree.insert(leaf);
      }

      const root = tree.root;

      for (let i = 0; i < leaves.length; i++) {
        const proof = tree.generateProof(i);
        expect(tree.verifyProof(proof, leaves[i], root)).toBe(true);
      }
    });

    it('should reject proof after tree state changes', async () => {
      const tree = await createTree(3);
      tree.insert(BigInt(100));

      const leaf = BigInt(100);
      const proof = tree.generateProof(0);
      const oldRoot = tree.root;

      // Insert another leaf, changing the root
      tree.insert(BigInt(200));
      const newRoot = tree.root;

      // Old proof should not verify against new root
      expect(tree.verifyProof(proof, leaf, newRoot)).toBe(false);

      // But should still verify against old root
      expect(tree.verifyProof(proof, leaf, oldRoot)).toBe(true);
    });
  });

  describe('export / import', () => {
    it('should export tree state', async () => {
      const tree = await createTree(3);
      tree.insert(BigInt(100));
      tree.insert(BigInt(200));

      const exported = tree.export();

      expect(exported.depth).toBe(3);
      expect(exported.leaves.length).toBe(2);
      expect(exported.leaves).toContainEqual([0, '100']);
      expect(exported.leaves).toContainEqual([1, '200']);
    });

    it('should export empty tree', async () => {
      const tree = await createTree(3);
      const exported = tree.export();

      expect(exported.depth).toBe(3);
      expect(exported.leaves.length).toBe(0);
    });

    it('should import and reconstruct identical tree', async () => {
      const original = await createTree(3);
      original.insert(BigInt(100));
      original.insert(BigInt(200));
      original.insert(BigInt(300));

      const exported = original.export();
      const originalRoot = original.root;

      const restored = new MerkleTree();
      await restored.import(exported);

      expect(restored.root).toBe(originalRoot);
      expect(restored.leafCount).toBe(3);
      expect(restored.getLeaf(0)).toBe(BigInt(100));
      expect(restored.getLeaf(1)).toBe(BigInt(200));
      expect(restored.getLeaf(2)).toBe(BigInt(300));
    });

    it('should produce valid proofs after import', async () => {
      const original = await createTree(3);
      original.insert(BigInt(10));
      original.insert(BigInt(20));

      const exported = original.export();

      const restored = new MerkleTree();
      await restored.import(exported);

      const proof = restored.generateProof(0);
      expect(restored.verifyProof(proof, BigInt(10), restored.root)).toBe(true);
    });
  });
});

describe('generateMerkleProof (standalone)', () => {
  it('should delegate to tree.generateProof', async () => {
    const tree = await createTree(3);
    tree.insert(BigInt(100));

    const proof = await generateMerkleProof(tree, 0);

    expect(proof.leafIndex).toBe(0);
    expect(proof.pathIndices.length).toBe(3);
    expect(proof.pathElements.length).toBe(3);
  });
});

describe('verifyMerkleProof (standalone)', () => {
  it('should verify a valid proof', async () => {
    const tree = await createTree(3);
    tree.insert(BigInt(100));

    const proof = tree.generateProof(0);
    const root = tree.root;

    const valid = await verifyMerkleProof(proof, BigInt(100), root);
    expect(valid).toBe(true);
  });

  it('should reject an invalid proof', async () => {
    const tree = await createTree(3);
    tree.insert(BigInt(100));

    const proof = tree.generateProof(0);

    const valid = await verifyMerkleProof(proof, BigInt(999), tree.root);
    expect(valid).toBe(false);
  });
});

describe('Edge cases', () => {
  it('should handle tree with depth 1', async () => {
    const tree = await createTree(1);
    tree.insert(BigInt(10));

    const proof = tree.generateProof(0);
    expect(proof.pathIndices.length).toBe(1);
    expect(tree.verifyProof(proof, BigInt(10), tree.root)).toBe(true);
  });

  it('should handle inserting leaves with value 0', async () => {
    const tree = await createTree(3);
    tree.insert(BigInt(0));

    expect(tree.getLeaf(0)).toBe(BigInt(0));
    expect(tree.leafCount).toBe(1);

    const proof = tree.generateProof(0);
    expect(tree.verifyProof(proof, BigInt(0), tree.root)).toBe(true);
  });

  it('should handle inserting very large field elements', async () => {
    const tree = await createTree(3);
    const largeVal = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495616');
    tree.insert(largeVal);

    expect(tree.getLeaf(0)).toBe(largeVal);

    const proof = tree.generateProof(0);
    expect(tree.verifyProof(proof, largeVal, tree.root)).toBe(true);
  });

  it('should handle adjacent leaf proofs correctly', async () => {
    const tree = await createTree(3);
    tree.insert(BigInt(10));
    tree.insert(BigInt(20));

    const proof0 = tree.generateProof(0);
    const proof1 = tree.generateProof(1);

    // Leaf 0's sibling at level 0 should be leaf 1's value
    expect(proof0.pathElements[0]).toBe(BigInt(20));
    // Leaf 1's sibling at level 0 should be leaf 0's value
    expect(proof1.pathElements[0]).toBe(BigInt(10));

    expect(tree.verifyProof(proof0, BigInt(10), tree.root)).toBe(true);
    expect(tree.verifyProof(proof1, BigInt(20), tree.root)).toBe(true);
  });
});

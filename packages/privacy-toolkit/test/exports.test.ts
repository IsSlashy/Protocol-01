import { describe, it, expect } from 'vitest';

// Import every documented export from the README
import {
  // Merkle
  computeZeroHashes,
  getZeroHashes,
  computeRootAndProofFromSubtrees,
  computeRootFromSubtrees,
  // Commitment
  createCommitment,
  computeNullifier,
  createBalanceCommitment,
  deriveOwnerPubkey,
  // Amount hash
  createAmountHash,
  zeroAmountHash,
  // Proof format
  proofToOnChainBytes,
  publicInputsToLE,
  publicInputsToBE,
  // Utils
  bigintToLeBytes32,
  bigintToBeBytes32,
  hexToBigint,
  bigintToHex,
  leBytesToBigint,
  beBytesToBigint,
  // Random
  randomFieldElement,
  generateSecret,
  generateNullifierPreimage,
} from '../src/index';

describe('All documented exports exist and are functions', () => {
  const exports = {
    // Merkle
    computeZeroHashes,
    getZeroHashes,
    computeRootAndProofFromSubtrees,
    computeRootFromSubtrees,
    // Commitment
    createCommitment,
    computeNullifier,
    createBalanceCommitment,
    deriveOwnerPubkey,
    // Amount hash
    createAmountHash,
    zeroAmountHash,
    // Proof format
    proofToOnChainBytes,
    publicInputsToLE,
    publicInputsToBE,
    // Utils
    bigintToLeBytes32,
    bigintToBeBytes32,
    hexToBigint,
    bigintToHex,
    leBytesToBigint,
    beBytesToBigint,
    // Random
    randomFieldElement,
    generateSecret,
    generateNullifierPreimage,
  };

  for (const [name, fn] of Object.entries(exports)) {
    it(`${name} is exported and is a function`, () => {
      expect(fn).toBeDefined();
      expect(typeof fn).toBe('function');
    });
  }
});

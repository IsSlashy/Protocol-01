import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { computeZeroHashes, createCommitment, computeNullifier } from '../src/index';

/**
 * The README must describe the hash this package actually runs.
 *
 * Audit v1, round 4 (axis 3, "the hash"): the README said the package's
 * "Goldilocks-Poseidon primitives (Merkle, commitment, nullifier) are still the
 * foundation for the current STARK path". The code imports poseidon2/poseidon4
 * from `poseidon-lite`, which is Poseidon over the BN254 scalar field. Its
 * outputs are 254-bit values that the Styx circuits, the on-chain verifier and
 * zk_shielded never produce, so a note or a root built with this package can
 * never be used in the pool. These tests pin the facts first, then hold the
 * README to them.
 */

/** Goldilocks prime p = 2^64 - 2^32 + 1, the field of the Styx STARK path. */
const GOLDILOCKS_P = (1n << 64n) - (1n << 32n) + 1n;

/** BN254 scalar field modulus, the field of poseidon-lite. */
const BN254_R =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** On-chain ZEROS[1] of the pool tree: programs/zk_shielded/src/state/merkle_tree_v3.rs:95. */
const POOL_ZEROS_1 = 18051734659105196655n;

const README = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');

describe('the hash this package runs is BN254 Poseidon, not the pool hash', () => {
  it('produces field elements above the Goldilocks prime (so not Goldilocks Poseidon)', () => {
    const zeros = computeZeroHashes(2);
    expect(zeros[1] > GOLDILOCKS_P).toBe(true);
    expect(zeros[1] < BN254_R).toBe(true);
    expect(createCommitment(1n, 2n, 3n, 4n) > GOLDILOCKS_P).toBe(true);
    expect(computeNullifier(1n, 2n) > GOLDILOCKS_P).toBe(true);
  });

  it('does not reproduce the pool tree, even from the pool zero leaf', () => {
    // The pool tree starts from ZEROS[0] = 0 (merkle_tree_v3.rs:94).
    const zeros = computeZeroHashes(1, 0n);
    expect(zeros[1]).not.toBe(POOL_ZEROS_1);
  });
});

describe('README claims match the hash', () => {
  it('does not present these primitives as Goldilocks Poseidon or as the STARK-path foundation', () => {
    expect(README).not.toMatch(/Goldilocks-Poseidon primitives/i);
    expect(README).not.toMatch(/foundation for the current STARK path/i);
    expect(README).not.toMatch(/foundation layer/i);
    expect(README).not.toMatch(/every higher-level SDK depends on/i);
  });

  it('states up front that the hash is BN254 Poseidon and that its outputs are not accepted by the Styx pool', () => {
    // The warning must sit before the first code sample, where a reader decides.
    const firstCodeBlock = README.indexOf('```');
    const head = README.slice(0, firstCodeBlock);
    expect(head).toMatch(/BN254/);
    expect(head).toMatch(/poseidon-lite/);
    expect(head).toMatch(/not compatible with the Styx pool/i);
  });

  it('does not map its functions to circom templates that no longer exist in the repository', () => {
    // circuits/ holds only ZKSPL.md at HEAD: transfer.circom, confidential_balance.circom
    // and poseidon.circom are gone.
    expect(README).not.toMatch(/map directly to the circom circuit templates/i);
    expect(README).not.toMatch(/circuits\/transfer\.circom/);
  });
});

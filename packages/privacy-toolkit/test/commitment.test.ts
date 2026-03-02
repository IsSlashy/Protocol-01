import { describe, it, expect } from 'vitest';
import { createCommitment, computeNullifier, createBalanceCommitment } from '../src/commitment/poseidon';

describe('Poseidon Commitments', () => {
  it('creates deterministic commitments', () => {
    const c1 = createCommitment(1n, 2n, 3n, 4n);
    const c2 = createCommitment(1n, 2n, 3n, 4n);
    expect(c1).toBe(c2);
  });

  it('different inputs produce different commitments', () => {
    const c1 = createCommitment(1n, 2n, 3n, 4n);
    const c2 = createCommitment(1n, 2n, 3n, 5n);
    expect(c1).not.toBe(c2);
  });

  it('computes deterministic nullifiers', () => {
    const n1 = computeNullifier(123n, 456n);
    const n2 = computeNullifier(123n, 456n);
    expect(n1).toBe(n2);
  });

  it('different secrets produce different nullifiers', () => {
    const n1 = computeNullifier(123n, 456n);
    const n2 = computeNullifier(123n, 789n);
    expect(n1).not.toBe(n2);
  });

  it('commitment and nullifier are different', () => {
    const c = createCommitment(1n, 2n, 3n, 4n);
    const n = computeNullifier(1n, 2n);
    expect(c).not.toBe(n);
  });

  it('creates balance commitments', () => {
    const c = createBalanceCommitment(1000n, 42n, 100n, 200n);
    expect(typeof c).toBe('bigint');
    expect(c).toBeGreaterThan(0n);
  });
});

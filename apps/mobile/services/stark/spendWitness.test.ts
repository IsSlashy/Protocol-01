/**
 * The arity guard is the whole point of the module, so it is the whole point of
 * this test: `stark/src/air/spend.rs` parses the CSV path with
 * `filter_map(|s| s.parse().ok())` and SILENTLY DROPS what it cannot read. An
 * 11-element path therefore produces a valid proof of an 11-deep tree — which
 * uploads, verifies, and settles nothing. Nothing downstream fails loudly.
 */

import { describe, it, expect } from 'vitest';
import { C7_SUBTREE_DEPTH } from '../denominatedPool';
import {
  assertSpendWitness,
  C7_BENCH_WITNESS,
  C7_EXPECTED_PROOF_SIZE,
  CIRCUIT_SPEND,
  SPEND_SUBTREE_DEPTH,
  SPEND_RECIPIENT_HASH_LIMBS,
  type SpendWitness,
} from './spendWitness';

const clone = (over: Partial<SpendWitness> = {}): SpendWitness => ({
  ...C7_BENCH_WITNESS,
  pathElements: [...C7_BENCH_WITNESS.pathElements],
  pathIndices: [...C7_BENCH_WITNESS.pathIndices],
  recipientHash: [...C7_BENCH_WITNESS.recipientHash],
  ...over,
});

describe('circuit-7 witness constants', () => {
  it('pins the circuit id the pool dispatches on', () => {
    expect(CIRCUIT_SPEND).toBe(7);
  });

  it('uses C7 subtree depth 11, NOT the pool 15', () => {
    // The two are different trees. Swapping them costs a full 78-chunk upload
    // and the buffer rent to find out.
    expect(SPEND_SUBTREE_DEPTH).toBe(11);
  });

  it('splits the recipient hash into four u64 limbs', () => {
    expect(SPEND_RECIPIENT_HASH_LIMBS).toBe(4);
  });

  /**
   * The depth is declared twice on purpose: this module must stay free of the
   * denominatedPool import graph so it can run in a bare vm (webviewSpend.test)
   * and under tsx (scripts/c7-bench-node). Duplication without a tie is how the
   * two silently diverge, so they are tied here instead.
   */
  it('agrees with C7_SUBTREE_DEPTH in services/denominatedPool', () => {
    expect(SPEND_SUBTREE_DEPTH).toBe(C7_SUBTREE_DEPTH);
  });

  it('pins the measured proof size, which is one upload buffer', () => {
    // 77,965 until the 2026-08-31 lift-column reship; C7 grew to 79,405.
    // Measured on both sides: the Rust RECORDED table and the wire pin that
    // GENERATES bytes from the shipped blob agree exactly.
    expect(C7_EXPECTED_PROOF_SIZE).toBe(79_405);
    // MAX_CHUNK_SIZE is 1000 in services/stark/index.ts. 78 chunks against the
    // v3 pair's 148 across two buffers — the win C7 actually delivers.
    expect(Math.ceil(C7_EXPECTED_PROOF_SIZE / 1000)).toBe(80);
  });
});

describe('C7_BENCH_WITNESS is comparable to the desktop measurement', () => {
  /**
   * ⛔ These values are copied from
   * `packages/stark-prover/scripts/c7-live-proof.ts`. If they drift, a number
   * measured on a phone stops being comparable to a number measured on a
   * desktop and nothing else in the tree notices.
   */
  it('reproduces the witness c7-live-proof.ts proves against', () => {
    expect(C7_BENCH_WITNESS.nullifierPreimage).toBe('11');
    expect(C7_BENCH_WITNESS.secret).toBe('22');
    expect(C7_BENCH_WITNESS.blinding).toBe('33');
    expect(C7_BENCH_WITNESS.tokenMint).toBe('44');
    expect(C7_BENCH_WITNESS.pathElements).toEqual(
      ['1000', '1007', '1014', '1021', '1028', '1035', '1042', '1049', '1056', '1063', '1070'],
    );
    expect(C7_BENCH_WITNESS.pathIndices).toEqual([0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0]);
    expect(C7_BENCH_WITNESS.recipientHash).toEqual(
      ['111111111', '222222222', '333333333', '444444444'],
    );
  });

  it('passes its own guard', () => {
    expect(() => assertSpendWitness(C7_BENCH_WITNESS)).not.toThrow();
  });
});

describe('assertSpendWitness', () => {
  it('refuses a path one element short — the failure the Rust cannot report', () => {
    const w = clone();
    w.pathElements.pop();
    expect(() => assertSpendWitness(w)).toThrow(/exactly 11 path elements/);
  });

  it('refuses a path one element long', () => {
    const w = clone();
    w.pathElements.push('9999');
    expect(() => assertSpendWitness(w)).toThrow(/Got 12 and 11/);
  });

  it('refuses the 15-deep pool path, which is the easy mistake', () => {
    const w = clone({
      pathElements: Array.from({ length: 15 }, (_, i) => String(i)),
      pathIndices: Array.from({ length: 15 }, () => 0),
    });
    expect(() => assertSpendWitness(w)).toThrow(/NOT the pool/);
  });

  it('refuses mismatched elements and indices', () => {
    const w = clone();
    w.pathIndices.pop();
    expect(() => assertSpendWitness(w)).toThrow(/Got 11 and 10/);
  });

  it('refuses a recipient hash that is not four limbs', () => {
    expect(() => assertSpendWitness(clone({ recipientHash: ['1', '2', '3'] })))
      .toThrow(/4 recipientHash limbs, got 3/);
    expect(() => assertSpendWitness(clone({ recipientHash: [] })))
      .toThrow(/got 0/);
  });

  it('says which number was wrong, so the error is actionable', () => {
    const w = clone({ pathElements: [], pathIndices: [] });
    expect(() => assertSpendWitness(w)).toThrow(/Got 0 and 0/);
  });
});

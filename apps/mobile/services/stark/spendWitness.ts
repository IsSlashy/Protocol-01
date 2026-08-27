/**
 * spendWitness.ts — the shape of a circuit-7 witness, and the one synthetic
 * witness the benchmark uses.
 *
 * # Why the arity guards are here and not left to the Rust
 *
 * `stark/src/air/spend.rs` parses the CSV path with
 * `filter_map(|s| s.parse().ok())`, which SILENTLY DROPS every entry it cannot
 * read. A truncated path and a malformed one are therefore indistinguishable by
 * the time the prover sees them — and an 11-deep proof is a perfectly valid
 * proof of a tree nobody uses. It would upload, verify, and settle nothing.
 *
 * ⛔ C7's subtree depth is 12, NOT the pool's 15. C3 takes 15. They are
 * different numbers for different trees and swapping them produces a proof that
 * fails only after the whole ~78-chunk upload has been paid for.
 *
 * # Why this module has no React and no react-native import
 *
 * So it can be exercised in Node — by `services/stark/spendWitness.test.ts` and
 * by `scripts/c7-bench-node.ts`, which drives mobile's OWN wasm blob and OWN
 * glue outside a WebView. A guard that can only run on a phone is a guard that
 * runs the week before a demo.
 */

/** `zk_shielded`'s circuit id for the spend proof. */
export const CIRCUIT_SPEND = 7;

/** `stark/src/air/spend.rs` CANONICAL_DEPTH. Not the pool's 15. */
export const SPEND_SUBTREE_DEPTH = 12;

/** sha256(recipient) split into four u64 limbs. */
export const SPEND_RECIPIENT_HASH_LIMBS = 4;

/**
 * Measured, not assumed: `packages/stark-prover/scripts/c7-live-proof.ts
 * --dry-run` on the shipped blob (sha256 72a8c700…) reports exactly this.
 * The upload splits it at MAX_CHUNK_SIZE = 1000 into 78 chunks, against the
 * v3 pair's 148 across two buffers.
 */
export const C7_EXPECTED_PROOF_SIZE = 77_965;

export interface SpendWitness {
  nullifierPreimage: string;
  secret: string;
  blinding: string;
  tokenMint: string;
  pathElements: string[];
  pathIndices: number[];
  recipientHash: string[];
}

/**
 * Throws with the same diagnostics the extension worker posts, before a single
 * byte crosses into the wasm.
 *
 * ⚠️ This checks ARITY ONLY. It cannot tell you the path is the right path, or
 * that the recipient hash is the recipient you meant — only the chain can, and
 * only after the upload.
 */
export function assertSpendWitness(w: SpendWitness): void {
  if (w.pathElements.length !== SPEND_SUBTREE_DEPTH || w.pathIndices.length !== SPEND_SUBTREE_DEPTH) {
    throw new Error(
      `Circuit 7 needs exactly ${SPEND_SUBTREE_DEPTH} path elements and ${SPEND_SUBTREE_DEPTH} indices `
      + `(its subtree depth is ${SPEND_SUBTREE_DEPTH}, NOT the pool's 15). `
      + `Got ${w.pathElements.length} and ${w.pathIndices.length}.`,
    );
  }
  if (w.recipientHash.length !== SPEND_RECIPIENT_HASH_LIMBS) {
    throw new Error(
      `Circuit 7 needs ${SPEND_RECIPIENT_HASH_LIMBS} recipientHash limbs, got ${w.recipientHash.length}.`,
    );
  }
}

/**
 * The witness `packages/stark-prover/scripts/c7-live-proof.ts` uses, copied
 * felt for felt so a number measured on a phone is comparable to the number
 * measured on a desktop.
 *
 * 🎯 C7 DERIVES the subtree root from the path rather than checking it against
 * a fixed value, so any self-consistent path yields a valid proof. That is what
 * makes a synthetic witness legitimate here: no pool, no RPC, no note, no SOL.
 *
 * ⛔ Do not "clean up" these values. Changing one breaks comparability with
 * every number recorded against this witness, and nothing will fail to compile.
 */
export const C7_BENCH_WITNESS: SpendWitness = {
  nullifierPreimage: '11',
  secret: '22',
  blinding: '33',
  tokenMint: '44',
  pathElements: Array.from({ length: SPEND_SUBTREE_DEPTH }, (_, i) => String(1000 + i * 7)),
  pathIndices: Array.from({ length: SPEND_SUBTREE_DEPTH }, (_, i) => i % 2),
  recipientHash: ['111111111', '222222222', '333333333', '444444444'],
};

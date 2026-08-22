/**
 * The prover blob this package ships is the one the deployed verifier accepts.
 *
 * 🚨 WHY THIS TEST EXISTS, AND WHAT IT ALREADY COST
 * ─────────────────────────────────────────────────
 * There are two prover blobs in this repository and they are not
 * interchangeable:
 *
 *   229,640 bytes  sha256 51a947e3…  the COSET build — accepted on chain
 *   192,732 bytes  sha256 4ace8913…  the 2026-05-06 pre-coset build — REJECTED
 *
 * MEASURED 2026-08-21: the web app carried the first while the extension AND
 * the mobile app carried the second, so both produced proofs the deployed
 * verifier refused. Fixed by exchanging the value (`33a50625`).
 *
 * MEASURED 2026-08-22: the rejected blob was still **tracked in git**, at
 * `stark/wasm-out/p01_stark_bg.wasm` — a directory named like the place you
 * fetch a build from. It is now gitignored, but nothing stopped a future
 * `wasm-pack` run from overwriting the good file with a rebuild, and nothing
 * would have said so.
 *
 * ⚠️ THE FAILURE MODE IS WHY A SIZE CHECK IS NOT ENOUGH. A rejected proof does
 * not fail fast: the client uploads ~150 proof-buffer transactions first and the
 * refusal lands at the very END, after roughly a SOL of buffer rent. Nobody
 * debugging that starts by hashing a wasm file.
 *
 * ⛔ IF THIS TEST FAILS, DO NOT UPDATE THE CONSTANT TO MAKE IT PASS. The
 * constant is the thing the chain agrees with. A changed hash means either the
 * shipped blob was overwritten (restore it) or the prover was deliberately
 * rebuilt — and a deliberate rebuild needs the verifier redeployed and this
 * value re-measured against a proof that actually landed, not against the build
 * that produced it.
 *
 * 🧠 HEAD CANNOT REBUILD THIS FILE. Building the `stark` crate on master emits
 * the 192,732-byte shape; the coset prover's source lives on
 * `b7-drop-aligned-checks`. That divergence is recorded in
 * `head-b7-divergence-mapped-2026-08-21` and is not something this test can fix
 * — it can only make sure the artefact we ship does not silently change.
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const BLOB = join(here, '..', 'wasm', 'p01_stark_bg.wasm');

/** The coset build the deployed verifier accepts. Measured, not chosen. */
const SHIPPED_SHA256 = '51a947e30441';
const SHIPPED_BYTES = 229_640;

/** The 2026-05-06 build the deployed verifier rejects. Must never be shipped. */
const REJECTED_SHA256 = '4ace8913067d';
const REJECTED_BYTES = 192_732;

function sha12(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 12);
}

describe('the shipped STARK prover blob', () => {
  it('is exactly the coset build the chain accepts', () => {
    const actual = sha12(BLOB);
    expect(
      actual,
      `The prover blob shipped by @protocol-01/stark-prover changed.\n\n` +
        `  expected ${SHIPPED_SHA256} (${SHIPPED_BYTES} bytes, coset, ACCEPTED on devnet)\n` +
        `  found    ${actual} (${statSync(BLOB).size} bytes)\n\n` +
        `If this is the 4ace8913 / 192,732-byte build, a wasm-pack run overwrote the shipped\n` +
        `prover with the pre-coset one. Every proof it makes is refused — and the refusal\n` +
        `arrives only after ~150 buffer-upload transactions and about a SOL of rent.\n\n` +
        `Do NOT update this constant to go green. Restore the blob.`,
    ).toBe(SHIPPED_SHA256);
  });

  it('is the expected size, so a truncated copy is caught too', () => {
    // A partial copy can hash to something unexpected and also just be short.
    // Both are worth naming separately: the hash says "different", the size
    // says "incomplete", and they send a reader to different places.
    expect(statSync(BLOB).size).toBe(SHIPPED_BYTES);
  });

  it('is not the build the deployed verifier rejects', () => {
    // Stated as its own assertion rather than implied by the one above, because
    // this is the specific mistake that has actually been made twice.
    const actual = sha12(BLOB);
    expect(actual).not.toBe(REJECTED_SHA256);
    expect(statSync(BLOB).size).not.toBe(REJECTED_BYTES);
  });
});

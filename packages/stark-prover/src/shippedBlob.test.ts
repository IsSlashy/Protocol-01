/**
 * The prover blob this package ships is the one the deployed verifier accepts.
 *
 * 🚨 WHY THIS TEST EXISTS, AND WHAT IT ALREADY COST
 * ─────────────────────────────────────────────────
 * There are THREE prover blobs in this repository's history and they are not
 * interchangeable:
 *
 *   267,610 bytes  sha256 72a8c700…  the CIRCUIT-7 coset build — shipped now
 *   229,640 bytes  sha256 51a947e3…  the pre-C7 coset build — accepted, but has
 *                                    no circuit 7, so spends fall back to v3
 *   192,732 bytes  sha256 4ace8913…  the 2026-05-06 pre-coset build — REJECTED
 *
 * MEASURED 2026-08-21: the web app carried the coset build while the extension
 * AND the mobile app carried the pre-coset one, so both produced proofs the
 * deployed verifier refused. Fixed by exchanging the value (`33a50625`).
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
 * 🧠 THE "HEAD CANNOT REBUILD THIS FILE" NOTE THAT USED TO SIT HERE IS RETIRED.
 * It said master emits the 192,732-byte shape and the coset source lives only on
 * `b7-drop-aligned-checks`. That divergence was reconciled (`140dcb3e`), and on
 * 2026-08-25 this tree rebuilt the blob from `stark/` directly:
 *
 *   wasm-pack build stark --target web --out-dir wasm-out -- --features wasm
 *
 * ⛔ `-- --features wasm` is NOT optional. `mod wasm_api` is cfg-gated; without
 * it the blob compiles and exports no proof function at all.
 * ⛔ NEVER pass `--features test-probes`. It compiles the fails-closed forgery
 * knobs into the shipping prover.
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const BLOB = join(here, '..', 'wasm', 'p01_stark_bg.wasm');

/**
 * The circuit-7 coset build. Measured, not chosen.
 *
 * ⛔ THE PREVIOUS VALUE WAS 51a947e30441 / 229,640 B AND IT WAS CORRECT AT THE
 * TIME. It was replaced on 2026-08-25 under the exact conditions the header
 * above demands, and not one of them was assumed:
 *
 *   the verifier was redeployed  the devnet dump of DGY37k3J… is byte-identical
 *                                to the local artifact carrying circuit 7
 *                                (725,673 B after stripping zero padding)
 *   a proof actually landed      tx 4yKg4gGmaDobC9xdBSKoxKwA6knEarNX4zhLUkdMc2KC
 *                                GYUGvY4e5tMwHHA2pii3MvEPhtoy6A3mMssqyWjEoLkb
 *                                slot 487960436, phase 2 (DEEP-ALI) consumed
 *                                192,462 CU, program logged success. Read back
 *                                off the chain with `solana confirm`, not taken
 *                                from the client that sent it.
 *
 * Reproduce with `npx tsx packages/stark-prover/scripts/c7-live-proof.ts`.
 *
 * The seven circuits the old blob carried all still produce byte-identical
 * proofs under this one — same lengths, same digests in `wireFormat.test.ts`.
 * The reship ADDED circuit 7 and moved nothing else.
 */
const SHIPPED_SHA256 = '72a8c700c466';
const SHIPPED_BYTES = 267_610;

/**
 * The pre-C7 coset build. NOT "rejected": it was the shipped artifact until
 * 2026-08-25 and the chain still accepts everything it makes. It is named here
 * because shipping it again would take circuit 7 away SILENTLY.
 */
const PRE_C7_SHA256 = '51a947e30441';
const PRE_C7_BYTES = 229_640;

/** The 2026-05-06 build the deployed verifier rejects. Must never be shipped. */
const REJECTED_SHA256 = '4ace8913067d';
const REJECTED_BYTES = 192_732;

/**
 * Versions ALREADY ON npm that carry a blob other than the one in `wasm/`.
 *
 * A version string is a promise about bytes. `0.1.3` was published on
 * 2026-08-11 carrying the pre-C7 blob; the blob in this repository changed on
 * 2026-08-25 and the version did not, so for two weeks
 * `@protocol-01/stark-prover@0.1.3` meant two different artifacts depending on
 * where you got it. A consumer resolving it from the registry gets a build with
 * no `generate_spend_stark_proof` and hits the C7 guard in `index.ts` — while
 * every workspace consumer resolves `workspace:*` and sees circuit 7 fine, so
 * nothing here would have shown it.
 *
 * This repository has paid for exactly this twice: `stark-prover@0.1.2` shipped
 * the pre-coset blob that the deployed verifier REJECTS, and the same wave took
 * the web build and the APK with it.
 *
 * Add a row whenever a published version's blob is superseded. Never remove
 * one: npm does not forget, so neither does this table.
 */
const PUBLISHED_CARRYING_ANOTHER_BLOB: Readonly<Record<string, string>> = Object.freeze({
  '0.1.2': 'the pre-coset blob (4ace8913067d), which the deployed verifier REJECTS',
  '0.1.3': `the pre-C7 blob (${PRE_C7_SHA256} / ${PRE_C7_BYTES} B), which has no circuit 7`,
});

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

  it('has not regressed to the pre-C7 build', () => {
    // Kept apart from the two assertions above because it fails DIFFERENTLY.
    // The pre-C7 blob is not refused by the chain, so nothing breaks loudly:
    // every spend just quietly falls back to `unshield_denominated_stark_v3`,
    // which publishes the note commitment as a public input. That is the exact
    // linkage circuit 7 exists to remove — a silent loss of privacy, not a
    // failed transaction, and nothing else in this repository would notice.
    expect(
      sha12(BLOB),
      'the pre-C7 blob is back; spends would silently return to the linkable v3 path',
    ).not.toBe(PRE_C7_SHA256);
    expect(statSync(BLOB).size).not.toBe(PRE_C7_BYTES);
  });

  it('does not reuse a version number npm already gave to another blob', () => {
    // The four assertions above all check the BYTES. This one checks the NAME
    // for those bytes, which nothing else in this repository does, and which is
    // the half that actually reaches a consumer.
    //
    // Every workspace consumer resolves `workspace:*`, so the local blob is
    // what apps/web, apps/extension, apps/mobile and the four SDKs all see. A
    // stale version number is therefore invisible from inside: the whole suite
    // is green, the demo works, and only somebody installing from the registry
    // gets the wrong artifact under the right name.
    const version = JSON.parse(
      readFileSync(join(here, '..', 'package.json'), 'utf8'),
    ).version as string;

    const clash = PUBLISHED_CARRYING_ANOTHER_BLOB[version];
    expect(
      clash,
      `package.json still says ${version}, but npm already published ${version} carrying
` +
        `  ${clash}

` +
        `  The blob in wasm/ is now ${SHIPPED_SHA256} (${SHIPPED_BYTES} B). Publishing under
` +
        `  the same version is impossible, and leaving it means one version string names two
` +
        `  different artifacts depending on where you resolve it from.

` +
        `  Bump the version. Do NOT delete the row above to go green — npm does not forget.`,
    ).toBeUndefined();
  });
});

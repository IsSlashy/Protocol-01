/**
 * PROBE-LEAK GATE for the checked-in WASM prover.
 *
 * # Why this file exists
 *
 * `stark/src/compact.rs` carries fails-closed probe knobs — real attack code
 * that builds internally consistent FORGERIES so the on-chain verifier can be
 * shown rejecting them:
 *
 *   OodForgery::Coordinated   perturb one OOD trace claim, then RE-SOLVE
 *                             `ood_quotient` from the AIR so the phase-2
 *                             identity still closes
 *   TerminalPoly::AliasedFold publish `p_m = c_m + c_{m+8}`, which clears the
 *                             FRI terminal degree bound while still agreeing
 *                             with the true final layer at 8 of 16 indices
 *   TraceLeaf::LegacyRowLeaf  build a complete PRE-Route-C proof
 *   PairIndexing::*           build a complete proof under a pair indexing the
 *                             verifier does not use
 *
 * A comment above `OodForgery` used to assert this code was "`cfg`-gated so it
 * cannot ship inside the WASM prover". MEASURED, it was neither: there was no
 * `cfg` gate on any probe in the 6,447-line file, and the panic/assert text of
 * the probes was physically present in the tracked blob and in all four inlined
 * base64 twins. `grep -a -c` on the pre-gate 219,219-byte blob:
 *
 *   OodForgery 1 · Coordinated 1 · AliasedFold 1 · LegacyRowLeaf 1
 *   "forgery column " 1 · "ood_quotient solve" 1
 *
 * The knob was not REACHABLE from JS — the module exports 8 proof functions and
 * none of them takes a probe argument — so this was leaked attack-code text and
 * dead weight, not an exploitable path. It is still exactly the kind of claim
 * that must be true or deleted, so the probes are now behind the `test-probes`
 * cargo feature (off in `default`) and this file is the gate that keeps them
 * there.
 *
 * # What this proves
 *
 * A byte scan is deliberately crude. It cannot prove the probe LOGIC is absent
 * — Rust string literals reach code through pointer tables, so a reference scan
 * over the code section cannot separate live from dead here (MEASURED: control
 * strings known to be live, `proof_hex` and `{"commitment":"`, score zero
 * references by that method too). What it CAN prove, cheaply and without false
 * negatives, is that no probe identifier survives in the shipped bytes — which
 * is a necessary condition for the gate having worked, and is the single check
 * that would have caught the original defect by itself.
 *
 * # Four banned strings were deleted, because they could never fire
 *
 * This list used to ban ten identifiers. Four of them — `SwappedHalves`,
 * `RotatedSlot`, `measure_aliased` and `test-probes` — scored zero not only in
 * the shipped blob but in every blob they were ever run against, including the
 * pre-gate blob that DID leak the probes. A banned string that cannot fire
 * proves nothing and pads the list with reassurance, which in a security gate is
 * the same defect as a false comment.
 *
 * They were given the fairest possible chance to fire, MEASURED 2026-07-30:
 *
 *   wasm-pack build stark --target web --out-dir <tmp> -- --features wasm,test-probes
 *   → 229,459 B, sha256 73df0362b3d2af1609cf3c07b7439688c8a5b12159dd24783dc4001e37b3d544
 *
 * That is the exact regression this file exists to catch. The six retained
 * needles all fire in it once each. The four dropped ones still score zero, and
 * there are structural reasons why:
 *
 *   test-probes      appears only in `#[cfg]` / `#[cfg_attr]` attributes and
 *                    comments. It is consumed by the compiler and is never a
 *                    runtime string, so it can never reach the data section.
 *   measure_aliased  is a function name (`measure_aliased_terminal_agreement`),
 *                    not a string literal, and it is not `#[wasm_bindgen]`, so
 *                    it is not in the export section either.
 *   SwappedHalves    are `PairIndexing` variant names. The enum derives `Debug`,
 *   RotatedSlot      but nothing ever formats a `PairIndexing`, so the variant
 *                    name table is never instantiated. Corroborated by the
 *                    probe build's actual Debug table, which reads
 *                    "CanonicalLegacyRowLeafLegacyGenericCircuit1Circuit2Circuit3
 *                    depthCircuit4Circuit5Circuit6" — `TraceLeaf`'s variants are
 *                    in it, `PairIndexing`'s are not.
 *
 * # What the remaining six cover, and what they do not
 *
 * Sufficient for the regression this gate is for: `test-probes` is ONE cargo
 * feature, so a build that turns it on compiles every probe family at once, and
 * the six fire on such a build (measured above). The gate detects the feature
 * being on; it does not detect probes one at a time.
 *
 * The six are not six independent witnesses. `OodForgery`, `Coordinated` and
 * `ood_quotient solve` are all substrings of ONE panic literal,
 * "OodForgery::Coordinated has no ood_quotient solve for ". Counting distinct
 * literals, the probe build carries four: that one, "forgery column ",
 * "AliasedFold assumes the bound is exactly half the published size (fps ", and
 * the `TraceLeaf` Debug table that contains `LegacyRowLeaf`.
 *
 * NOT COVERED: the `PairIndexing` probe family. Its non-canonical variants are
 * pure control flow — `match` arms returning an index or a swapped tuple — with
 * no string literal anywhere, so a byte scan has nothing to find. It is covered
 * today only transitively, by sharing the `test-probes` feature with the probes
 * that do leave strings. If `PairIndexing` is ever moved to its own feature, or
 * a new probe family lands with no literals in it, this scan stops covering it
 * and something other than a byte scan is needed. Do not add a hopeful string
 * here to paper over that; add it only once it is measured firing.
 *
 * # Reading a failure
 *
 * A red here means someone built the blob with `--features test-probes`, or
 * added a new probe without gating it. Rebuild WITHOUT the feature:
 *
 *   wasm-pack build stark --target web --out-dir wasm-out -- --features wasm
 *   cp stark/wasm-out/p01_stark_bg.wasm packages/stark-prover/wasm/
 *   cp stark/wasm-out/p01_stark.js      packages/stark-prover/wasm/
 *   node packages/stark-prover/scripts/stark-wasm-twins.mjs --write
 *
 * Do NOT add the failing identifier to an allowlist.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

// this file lives at <repo>/packages/stark-prover/src/
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const CANONICAL = 'packages/stark-prover/wasm/p01_stark_bg.wasm';

/** The four inlined base64 copies, in the order `stark-wasm-twins.mjs` lists them. */
const TWINS = [
  'apps/web/lib/privacy/pool/starkWasmData.ts',
  'apps/extension/src/shared/services/starkWasmData.ts',
  'apps/mobile/services/stark/wasmData.ts',
  'packages/react-native-zk/src/wasmData.ts',
];

/**
 * Identifiers that exist ONLY inside `#[cfg(any(test, feature = "test-probes"))]`
 * code in `stark/src/compact.rs`, AND that have been shown to actually appear in
 * a blob built with the probes on. Each entry names where it comes from, so a
 * failure points at the probe rather than at a mystery string.
 *
 * Every one of these was measured firing in two independent blobs:
 *
 *   the real regression   the pre-gate 219,219 B blob at commit 766ef07f
 *                         (sha256 f4f2cb09...), which shipped the probes
 *   a constructed control `wasm-pack build stark --target web --
 *                          --features wasm,test-probes`, 229,459 B
 *                         (sha256 73df0362...), built 2026-07-30
 *
 * counts in both: OodForgery 1, Coordinated 1, AliasedFold 1, "forgery column "
 * 1, "ood_quotient solve" 1, LegacyRowLeaf 1. In the shipped blob, 0 each.
 * `LegacyRowLeaf` additionally fires on the tracked pre-B1 blob 5fe610c9
 * (194,540 B, commit 4b375d7c), so it discriminates on real history twice.
 */
const BANNED: ReadonlyArray<readonly [string, string]> = [
  ['OodForgery', 'enum name — the coordinated OOD forgery knob'],
  ['Coordinated', 'OodForgery::Coordinated variant / its panic text'],
  ['AliasedFold', 'TerminalPoly::AliasedFold — the terminal degree-bound play'],
  ['forgery column ', 'assert! inside the coordinated-forgery branch'],
  ['ood_quotient solve', 'panic when solve_ood_quotient_for_spec has no arm'],
  ['LegacyRowLeaf', 'TraceLeaf::LegacyRowLeaf — pre-Route-C trace commitment'],
];

/**
 * POSITIVE CONTROL. This is the prover-side degree assert on the HONEST path
 * (`stark/src/compact.rs`, both pipelines) — a real production invariant that
 * fails at proof time instead of on chain, so it SHOULD ship. Asserting it is
 * present is what stops this whole file from passing green against an empty,
 * truncated or absent blob: a scan that finds nothing because there is nothing
 * to find would be worthless.
 */
const MUST_BE_PRESENT = 'B1 TERMINAL DEGREE BOUND VIOLATED';

const countOccurrences = (haystack: Buffer, needle: string): number => {
  const pat = Buffer.from(needle, 'latin1');
  let n = 0;
  let at = haystack.indexOf(pat, 0);
  while (at !== -1) {
    n += 1;
    at = haystack.indexOf(pat, at + 1);
  }
  return n;
};

const readCanonical = (): Buffer => readFileSync(resolve(REPO, CANONICAL));

const readTwin = (rel: string): Buffer => {
  const text = readFileSync(resolve(REPO, rel), 'utf8');
  const m = text.match(/[A-Za-z0-9+/=]{1000,}/);
  if (m === null) throw new Error(`no base64 literal in ${rel}`);
  return Buffer.from(m[0], 'base64');
};

describe('checked-in WASM prover — no fails-closed probe code', () => {
  it('the scan is looking at a real prover blob (positive control)', () => {
    const wasm = readCanonical();
    expect(wasm.length).toBeGreaterThan(100_000);
    // Both pipelines carry the assert, so this is 2 today. Pinning ">= 1" keeps
    // the control honest without pinning a number that a refactor would move.
    expect(countOccurrences(wasm, MUST_BE_PRESENT)).toBeGreaterThanOrEqual(1);
  });

  for (const [needle, origin] of BANNED) {
    it(`canonical blob carries no "${needle}" (${origin})`, () => {
      expect(countOccurrences(readCanonical(), needle)).toBe(0);
    });
  }

  // The twins are what clients actually load (extension service worker, mobile
  // WebView, Metro bundle). `stark-wasm-twins.mjs --check` proves they equal the
  // canonical blob, but it runs as a separate script and a scan that only ever
  // looked at `packages/` would miss a hand-edited twin.
  for (const twin of TWINS) {
    it(`${twin} decodes to a blob with no probe identifiers`, () => {
      const bytes = readTwin(twin);
      expect(countOccurrences(bytes, MUST_BE_PRESENT)).toBeGreaterThanOrEqual(1);
      const found = BANNED.filter(([needle]) => countOccurrences(bytes, needle) > 0).map(
        ([needle]) => needle,
      );
      expect(found).toEqual([]);
    });
  }
});

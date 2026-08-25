/**
 * `dist/` is not allowed to be a generation behind `src/`.
 *
 * 🚨 WHAT THIS COST, MEASURED 2026-08-25
 * ──────────────────────────────────────
 * Both app workers were migrated off their hand-rolled wasm-bindgen ABI onto
 * this package's loader. Every test here passed. The live devnet harness then
 * died with:
 *
 *   WASM init failed: WebAssembly.Instance(): Import #0 "./p01_stark_bg.js"
 *   "__wbg_crypto_38df2bab126b63dc": function import requires a callable
 *
 * — the EXACT failure the migration existed to remove. The source was fine.
 * `dist/` was eleven days old and still carried the hand-rolled loader with its
 * one-entry import object, and `package.json` `exports` points every consumer
 * at `dist/`, not `src/`. The suites in this package import `src/` directly, so
 * they were all green against a build nobody was running.
 *
 * ⛔ `dist/` IS GITIGNORED, SO NOTHING ELSE WATCHES IT. A stale one is invisible
 * to git status, to CI (which builds fresh) and to every test that imports
 * source. It is visible only to whoever is running the app — which on this path
 * means the failure arrives at proof time, and on a real spend that is after
 * ~78 chunk-upload transactions.
 *
 * WHAT IT CHECKS
 * ──────────────
 * Not freshness by timestamp — that is noisy and says nothing about content.
 * It checks the one property that separates the two generations: the built
 * loader must delegate instantiation to the generated glue's `initSync` rather
 * than hand-building an import object.
 *
 * Skipped when `dist/` is absent, because a clean checkout has not built yet
 * and that is not a defect.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const DIST = join(here, '..', 'dist');
const LOADER = join(DIST, 'wasm-loader.mjs');

const built = existsSync(LOADER);

describe.skipIf(!built)('the built loader in dist/', () => {
  const src = readFileSync(LOADER, 'utf8');

  it('delegates instantiation to the generated glue', () => {
    expect(
      src,
      'dist/wasm-loader.mjs does not call initSync — it is the pre-glue build.\n'
      + 'Rebuild with `pnpm -C packages/stark-prover build`.\n\n'
      + 'Nothing else catches this: dist/ is gitignored, CI builds fresh, and every\n'
      + 'test in this package imports src/. The only place a stale dist shows up is\n'
      + 'a running app, where it fails at proof time — after the whole upload.',
    ).toContain('initSync');
  });

  it('no longer exports the hand-rolled marshalling helpers', () => {
    // ⚠️ THE OBVIOUS FINGERPRINT DOES NOT WORK, and the first version of this
    // test used it and failed on a FRESH build. `'./p01_stark_bg.js':` appears
    // in both generations: the pre-glue loader hand-built an import object
    // under that key, and the generated glue — which the fresh build inlines —
    // builds its own under the same key. The string does not separate them.
    //
    // The export list does. `passStringToWasm` and `readStringReturn` were
    // PUBLIC exports of this module and were deleted with the ABI; a build that
    // still exports them predates the glue no matter what else it contains.
    const exportBlocks = src.match(/export\s*\{[^}]*\}/g) ?? [];
    const exported = exportBlocks.join(' ');
    for (const dead of ['passStringToWasm', 'readStringReturn', 'WasmStringHandle']) {
      expect(
        exported,
        `dist/wasm-loader.mjs still exports ${dead} — it is the pre-glue build, whose `
        + 'import object had ONE entry where the circuit-7 blob needs twenty-five. '
        + 'Rebuild the package.',
      ).not.toContain(dead);
    }
  });

  it('the built index carries the circuit-7 dispatch', () => {
    const index = join(DIST, 'index.mjs');
    if (!existsSync(index)) return;
    expect(
      readFileSync(index, 'utf8'),
      'dist/index.mjs has no circuit-7 case — it predates the spend circuit.',
    ).toContain('generate_spend_stark_proof');
  });
});

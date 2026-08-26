/**
 * wasm-artifacts.mjs — the ONE list of files that carry the STARK prover blob.
 *
 * There are five: the canonical `.wasm` plus four base64 twins inlined into
 * client source so the prover can ship inside a JS bundle (service worker,
 * WebView, Metro bundle). Two gates walk this list and they must walk the SAME
 * list, so it lives here instead of being duplicated:
 *
 *   scripts/stark-wasm-twins.mjs        every twin carries the canonical bytes
 *   scripts/deployed-verifier-check.mjs those bytes match the DEPLOYED program
 *
 * `stark-wasm-twins.mjs` keeps its own array (it also owns the generated
 * banners) but asserts its path set equals `TWIN_PATHS` below, so adding a
 * sixth copy to one gate and not the other fails loudly instead of silently
 * leaving a client unchecked.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/** this file lives at <repo>/packages/stark-prover/scripts/ */
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** The one true blob. Every twin must decode to exactly these bytes. */
export const CANONICAL = 'packages/stark-prover/wasm/p01_stark_bg.wasm';

/** wasm-bindgen glue, generated alongside the blob; its API surface must match. */
export const GLUE = 'packages/stark-prover/wasm/p01_stark.js';

/**
 * Repo-relative paths of the inlined twins, each a TS module exporting one
 * `STARK_WASM_BASE64` literal. These are what apps/web, apps/extension,
 * apps/mobile and packages/react-native-zk actually import at runtime — none of
 * them reads the canonical `.wasm` — so a gate that only checks the canonical
 * blob checks a file no client ships.
 */
export const TWIN_PATHS = [
  'apps/web/lib/privacy/pool/starkWasmData.ts',
  'apps/extension/src/shared/services/starkWasmData.ts',
  'apps/mobile/services/stark/wasmData.ts',
  'packages/react-native-zk/src/wasmData.ts',
];

/** The binding a twin module exports, and the only literal a client ever loads. */
export const TWIN_EXPORT = 'STARK_WASM_BASE64';

/**
 * Pull the base64 a twin module ACTUALLY EXPORTS.
 *
 * This used to be `text.match(/[A-Za-z0-9+/=]{1000,}/)` — the FIRST long base64
 * run anywhere in the file — and both gates that walk these files used it. That
 * is not the same string the client imports, and the gap is trivially reachable.
 * MEASURED 2026-07-31: putting the canonical base64 in an unused `const` above
 * the export and a different blob in `export const STARK_WASM_BASE64` made
 *
 *   stark-wasm-twins.mjs --check      "PASS — 4 twins", exit 0
 *   deployed-verifier-check.mjs       "ok  apps/web/lib/privacy/pool/starkWasmData.ts"
 *
 * while apps/web shipped a prover neither gate had hashed. Both gates claim to
 * check "what the clients actually import", so they have to read the export.
 *
 * Returns `{ base64, problem }`. `problem` is a human sentence and non-null
 * exactly when `base64` is null; callers must treat it as a hard failure.
 */
export function extractBase64(text) {
  const runs = text.match(/[A-Za-z0-9+/=]{1000,}/g) ?? [];
  const m = text.match(
    new RegExp(`export\\s+const\\s+${TWIN_EXPORT}\\s*(?::[^=]*)?=\\s*['"\`]([A-Za-z0-9+/=]{1000,})['"\`]`),
  );
  if (m === null) {
    return {
      base64: null,
      problem:
        runs.length > 0
          ? `has ${runs.length} long base64 literal(s) but none of them is \`export const ${TWIN_EXPORT} = '…'\`; ` +
            'this gate only vouches for the string the client imports'
          : 'has no base64 prover literal at all — this client ships no prover, or the file was hand-edited',
    };
  }
  if (runs.length !== 1) {
    return {
      base64: null,
      problem:
        `carries ${runs.length} long base64 literals. Exactly one is allowed: a second one is how a twin ` +
        `passes this gate on a decoy while exporting something else (MEASURED — see wasm-artifacts.mjs)`,
    };
  }
  return { base64: m[1], problem: null };
}

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

/** Pull the single long base64 literal out of a twin module. */
export function extractBase64(text) {
  const m = text.match(/[A-Za-z0-9+/=]{1000,}/);
  return m ? m[0] : null;
}

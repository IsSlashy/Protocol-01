/**
 * WASM loader for `@protocol-01/stark-prover`.
 *
 * Loads the `p01_stark` module across three runtimes:
 *
 *   - Node 22+        — read the .wasm file from `wasm/p01_stark_bg.wasm`
 *                       relative to this module (works in both ESM and CJS
 *                       builds via `import.meta.url` or `__dirname`).
 *   - Modern browsers — fetch the .wasm via the URL helper or accept a
 *                       caller-provided ArrayBuffer / base64 string.
 *   - Service workers — accept a base64 blob (caller-provided, see the
 *                       extension's `STARK_WASM_BASE64` pattern).
 *
 * The loader does NOT bundle the WASM bytes inline — they ship as a sibling
 * `wasm/p01_stark_bg.wasm` (~125 KB raw) and consumers load them on-demand.
 * This keeps the JS bundle size flat and avoids the 256 KB base64 penalty
 * for users who don't need the WASM at all (typecheck-only, or callers that
 * supply their own bytes).
 *
 * The exported `StarkExports` interface mirrors the wasm-bindgen surface
 * area used by `apps/extension/src/shared/workers/starkProver.worker.ts`.
 */

// The wasm-bindgen glue, generated alongside the blob by `wasm-pack` and
// shipped verbatim under this package's `files`. It owns the 25 imports the
// circuit-7 blob requires and the (ptr,len) marshalling this file used to
// hand-roll. `scripts/wasm-artifacts.mjs` tracks it as GLUE precisely because
// its API surface has to match the blob it was generated with.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — the generated glue ships as untyped JS. `wasm-pack` emits a
// `p01_stark.d.ts` beside it, but `.gitignore:197` ignores `**/*.d.ts` (a rule
// meant for EMITTED declarations), so that file cannot be tracked and the shape
// is declared below instead. Keep `GlueModule` in step with the blob: a wrong
// signature here is a silent argument mismatch at the ABI boundary.
import * as glueUntyped from '../wasm/p01_stark.js';

/**
 * The subset of the generated glue this loader uses.
 *
 * ⛔ `generate_spend_stark_proof` is absent ON PURPOSE — the shipped blob
 * (229,640 B / 51a947e3) does not export it. `initStarkWasm` reads it off the
 * module defensively so the loader works against both blobs, and
 * `index.test.ts` pins that it is currently unbound.
 */
interface GlueModule {
  initSync(module: { module: WebAssembly.Module }): unknown;
  compute_stark_commitment(secret: bigint): string;
  generate_stark_proof(secret: bigint): string;
  generate_pool_commitment_stark_proof(a: bigint, b: bigint, c: bigint, d: bigint): string;
  generate_balance_stark_proof(a: bigint, b: bigint, c: bigint, d: bigint): string;
  generate_merkle_path_stark_proof(leaf: bigint, elemsCsv: string, idxCsv: string): string;
  generate_confidential_balance_stark_proof(
    a: bigint, b: bigint, c: bigint, d: bigint, e: bigint, f: bigint, g: bigint, h: bigint,
  ): string;
  generate_transfer_stark_proof(
    a: bigint, b: bigint, c: bigint, d: bigint, e: bigint, f: bigint, g: bigint,
    h: bigint, i: bigint, j: bigint, k: bigint, l: bigint, m: bigint,
  ): string;
  generate_merkle_update_stark_proof(
    oldLeaf: bigint, newLeaf: bigint, elemsCsv: string, idxCsv: string,
  ): string;
}

const glue = glueUntyped as unknown as GlueModule;

// ---------------------------------------------------------------------------
// wasm-bindgen exports (subset we actually call)
// ---------------------------------------------------------------------------

export interface StarkExports {
  compute_stark_commitment(secret: bigint): string;
  generate_stark_proof(secret: bigint): string;
  generate_pool_commitment_stark_proof(
    nullifierPreimage: bigint, secret: bigint, depositEpoch: bigint, tokenMint: bigint,
  ): string;
  generate_balance_stark_proof(
    spendingKey: bigint, balance: bigint, salt: bigint, tokenMint: bigint,
  ): string;
  generate_merkle_path_stark_proof(
    leaf: bigint, pathElementsCsv: string, pathIndicesCsv: string,
  ): string;
  generate_confidential_balance_stark_proof(
    a: bigint, b: bigint, c: bigint, d: bigint,
    e: bigint, f: bigint, g: bigint, h: bigint,
  ): string;
  generate_transfer_stark_proof(
    a: bigint, b: bigint, c: bigint, d: bigint, e: bigint, f: bigint,
    g: bigint, h: bigint, i: bigint, j: bigint, k: bigint, l: bigint, m: bigint,
  ): string;
  generate_merkle_update_stark_proof(
    oldLeaf: bigint, newLeaf: bigint, pathElementsCsv: string, pathIndicesCsv: string,
  ): string;
  /**
   * [C7] Present only once the circuit-7 blob ships. Optional on purpose: the
   * loader must work against both blobs, and a caller reaching for it too early
   * should get `undefined` rather than a LinkError from a half-loaded module.
   *
   * ⛔ The mask is drawn INSIDE the wasm from a real CSPRNG and the Rust refuses
   * to build a proof without one. Do not add a parameter that lets a caller
   * supply it.
   */
  generate_spend_stark_proof?: (
    nullifierPreimage: bigint, secret: bigint, blinding: bigint, tokenMint: bigint,
    pathElementsCsv: string, pathIndicesCsv: string, recipientHashCsv: string,
  ) => string;
}

/**
 * Source from which the WASM bytes can be obtained. In order of preference:
 *
 *   - Provide raw bytes via `bytes`.
 *   - Provide a base64 string via `base64` (extension / RN WebView pattern).
 *   - Provide a URL or fs path via `url`.
 *   - Pass nothing — the loader will resolve the bundled `wasm/p01_stark_bg.wasm`.
 */
export interface WasmSource {
  bytes?: Uint8Array | ArrayBuffer;
  base64?: string;
  url?: string | URL;
}

// ---------------------------------------------------------------------------
// Module-level cache (one WASM instance per process — proofs are stateless)
// ---------------------------------------------------------------------------

let cachedExports: StarkExports | null = null;
let pendingInit: Promise<StarkExports> | null = null;

// ---------------------------------------------------------------------------
// WASM bytes resolution
// ---------------------------------------------------------------------------

function base64ToBytes(b64: string): Uint8Array {
  // Browser path
  if (typeof atob === 'function') {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  // Node path — Buffer is global in Node 22.
  const Buf = (globalThis as { Buffer?: { from: (s: string, enc: string) => Uint8Array } }).Buffer;
  if (Buf) return Buf.from(b64, 'base64');
  throw new Error('Cannot decode base64: no atob() and no Buffer available.');
}

/** True when running inside Node (any version that exposes `process.versions.node`). */
function isNode(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proc = (globalThis as any).process;
  return Boolean(proc && proc.versions && proc.versions.node);
}

async function readFileUrl(url: string | URL): Promise<Uint8Array> {
  const fs = await import('node:fs/promises');
  let pathStr: string;
  if (typeof url === 'string') {
    pathStr = url.startsWith('file://') ? new URL(url).pathname : url;
  } else {
    pathStr = url.pathname;
  }
  // Windows: strip the leading slash from `/C:/...`
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proc = (globalThis as any).process;
  if (proc?.platform === 'win32' && /^\/[A-Za-z]:/.test(pathStr)) {
    pathStr = pathStr.slice(1);
  }
  // Decode percent-encoded characters (URL pathnames encode them).
  pathStr = decodeURIComponent(pathStr);
  const buf = await fs.readFile(pathStr);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

async function fetchWasmBytes(url: string | URL): Promise<Uint8Array> {
  // Prefer `node:fs` for file:// URLs — Node 22's `fetch` does NOT support
  // them and throws a useless "fetch failed" without further info.
  const isFile =
    (typeof url === 'string' && url.startsWith('file:'))
    || (url instanceof URL && url.protocol === 'file:');
  if (isFile && isNode()) {
    return await readFileUrl(url);
  }
  if (typeof fetch === 'function') {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Failed to fetch WASM (${res.status}): ${url.toString()}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      // Some Node configs reject file:// in fetch — fall back to fs.readFile.
      if (isNode() && (typeof url === 'string' || url instanceof URL)) {
        return await readFileUrl(url);
      }
      throw err;
    }
  }
  if (isNode()) return await readFileUrl(url);
  throw new Error(`Cannot fetch WASM from ${url.toString()}: no fetch() and not running on Node.`);
}

/**
 * Compile-time-defined module URL. tsup replaces `import.meta.url` in the
 * ESM build with the actual URL token, and replaces it with `undefined` in
 * the CJS build. We additionally guard with a try/catch so the CJS build
 * doesn't crash if the replacement is incomplete.
 *
 * In the test runtime (vitest, Node ESM), `import.meta.url` resolves to the
 * source file path under `src/`, so the relative `../wasm/...` walk lands
 * at the package's `wasm/` directory. In the dist ESM build, the file is
 * `dist/wasm-loader.mjs` — also one level above `wasm/`. Both work.
 */
function getModuleUrl(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — `import.meta` is invalid in CJS, replaced by tsup.
    if (typeof import.meta !== 'undefined' && import.meta.url) {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      return import.meta.url as string;
    }
  } catch {
    // CJS build path — fall through.
  }
  return undefined;
}

/**
 * Best-effort resolution of the bundled `wasm/p01_stark_bg.wasm`. Tries (in
 * order):
 *   1. `import.meta.url`-based URL resolution (ESM Node + browsers).
 *   2. `require.resolve('@protocol-01/stark-prover/wasm/p01_stark_bg.wasm')`
 *      for CJS Node.
 *   3. Falls back to `__dirname`-relative resolution (also CJS Node).
 *   4. Throws — caller must provide bytes/base64/url explicitly.
 */
async function resolveBundledWasm(): Promise<Uint8Array> {
  // Path 1: ESM — `import.meta.url`.
  const metaUrl = getModuleUrl();
  if (metaUrl) {
    try {
      const wasmUrl = new URL('../wasm/p01_stark_bg.wasm', metaUrl);
      return await fetchWasmBytes(wasmUrl);
    } catch {
      // Fall through to CJS paths.
    }
  }

  // Path 2: CJS — `require.resolve` against the package's wasm subpath export.
  // `require` is undefined in ESM, so we probe via `globalThis`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const req = (globalThis as any).require as NodeRequire | undefined;
  if (req && typeof req.resolve === 'function') {
    try {
      const resolved = req.resolve('@protocol-01/stark-prover/wasm/p01_stark_bg.wasm');
      const fs = await import('node:fs/promises');
      const buf = await fs.readFile(resolved);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch {
      // Fall through to __dirname path.
    }
  }

  // Path 3: CJS — resolve via __dirname (only set when bundled as CJS).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dirname = (globalThis as any).__dirname as string | undefined;
  if (dirname) {
    try {
      const path = await import('node:path');
      // dist/wasm-loader.js → ../wasm/p01_stark_bg.wasm
      const resolved = path.resolve(dirname, '..', 'wasm', 'p01_stark_bg.wasm');
      const fs = await import('node:fs/promises');
      const buf = await fs.readFile(resolved);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch {
      // Fall through.
    }
  }

  throw new Error(
    'Could not resolve bundled p01_stark_bg.wasm automatically. ' +
    'Pass an explicit `WasmSource` (bytes / base64 / url) to `initStarkWasm()`.',
  );
}

async function resolveWasmBytes(source?: WasmSource): Promise<Uint8Array> {
  if (source?.bytes) {
    return source.bytes instanceof Uint8Array
      ? source.bytes
      : new Uint8Array(source.bytes);
  }
  if (source?.base64) return base64ToBytes(source.base64);
  if (source?.url) return await fetchWasmBytes(source.url);
  return await resolveBundledWasm();
}

// ---------------------------------------------------------------------------
// WASM instantiation
// ---------------------------------------------------------------------------

/**
 * Initialize (or return the cached) WASM instance. Safe to call repeatedly —
 * subsequent calls return the same exports object. Pass a `WasmSource` to
 * override the default bundled-bytes resolution (extension service workers,
 * RN WebView, custom CDNs, etc).
 */
export async function initStarkWasm(source?: WasmSource): Promise<StarkExports> {
  if (cachedExports) return cachedExports;
  if (pendingInit) return pendingInit;

  pendingInit = (async () => {
    const bytes = await resolveWasmBytes(source);

    // 🚨 THE HAND-BUILT IMPORT OBJECT IS GONE, AND IT HAD TO GO.
    //
    // It supplied exactly ONE import, `__wbindgen_init_externref_table`, which
    // was all the pre-C7 blob needed: pure computation, no randomness, no JS
    // interop. MEASURED 2026-08-25 on the circuit-7 build: the blob now needs
    // TWENTY-FIVE, because `generate_spend_stark_proof` draws a 1,280-element
    // CSPRNG mask (`stark/src/lib.rs` draw_spend_mask) and that pulls in
    // getrandom -> crypto -> the whole wasm-bindgen shim surface. Loading it
    // here failed with:
    //
    //   LinkError: Import #0 "./p01_stark_bg.js"
    //   "__wbg_crypto_38df2bab126b63dc": function import requires a callable
    //
    // ⛔ AND THE NAMES ARE CONTENT-HASHED, so hand-writing them is work that has
    // to be redone on every rebuild. The generated glue owns them instead.
    //
    // ⛔ WHY NOT BORROW ONLY `__wbg_get_imports()`: MEASURED, it does not work.
    // It is module-private (the glue's whole export surface is
    // `export { initSync, __wbg_init as default }`), and hoisting it still
    // fails — every closure it returns reads the glue's own `wasm` binding,
    // which only `__wbg_finalize_init` assigns. Borrowing it dies on
    // `TypeError: Cannot read properties of undefined (reading
    // '__wbindgen_externrefs')`.
    //
    // ⚠️ `initSync` sniffs its argument with
    // `Object.getPrototypeOf(module) === Object.prototype`. Across a realm
    // boundary that comparison fails and the glue does NOT throw — it warns and
    // silently takes the deprecated branch. The options object is therefore
    // built HERE, in the glue's own realm. Never forward one through
    // postMessage or structuredClone.
    //
    // What this file still owns, and the reason it exists at all, is WHERE the
    // bytes come from: base64 for MV3 and the RN WebView, raw bytes, a URL, or
    // Node's filesystem. None of that changes.
    glue.initSync({ module: new WebAssembly.Module(bytes as unknown as BufferSource) });

    // The callable wrappers live on the GLUE MODULE, not on the object
    // `initSync` returns — that one is the raw instance exports. The wrappers
    // are what do the (ptr,len) marshalling this file used to do by hand, which
    // is why `StarkExports` now describes functions that take and return real
    // JS values.
    const exports = {
      compute_stark_commitment: glue.compute_stark_commitment,
      generate_stark_proof: glue.generate_stark_proof,
      generate_pool_commitment_stark_proof: glue.generate_pool_commitment_stark_proof,
      generate_balance_stark_proof: glue.generate_balance_stark_proof,
      generate_merkle_path_stark_proof: glue.generate_merkle_path_stark_proof,
      generate_confidential_balance_stark_proof: glue.generate_confidential_balance_stark_proof,
      generate_transfer_stark_proof: glue.generate_transfer_stark_proof,
      generate_merkle_update_stark_proof: glue.generate_merkle_update_stark_proof,
      // Present only once the circuit-7 blob ships; optional so this loader
      // works against both, and so a caller that reaches for it before the
      // reship gets `undefined` rather than a confusing LinkError.
      generate_spend_stark_proof: (
        glue as unknown as { generate_spend_stark_proof?: StarkExports['generate_spend_stark_proof'] }
      ).generate_spend_stark_proof,
    } as StarkExports;

    cachedExports = exports;
    return exports;
  })();

  try {
    return await pendingInit;
  } finally {
    pendingInit = null;
  }
}

/**
 * Drop the cached WASM instance. Useful for tests; production callers should
 * never need this — proofs are stateless and one instance per process is fine.
 *
 * ⚠️ It clears THIS module's cache, not the glue's. `initSync` is idempotent
 * (`if (wasm !== undefined) return wasm;`), so a reset followed by a fresh
 * `initStarkWasm()` re-wraps the SAME instance rather than building a new one.
 * That is fine for the stateless prover and it is why `wireFormat.test.ts`
 * warns against a second `beforeAll` calling this — MEASURED there as a JSON
 * parse starting partway into a proof_hex value.
 */
export function resetStarkWasm(): void {
  cachedExports = null;
  pendingInit = null;
}

/**
 * ⛔ THE HAND-ROLLED wasm-bindgen ABI USED TO LIVE HERE AND IS GONE.
 *
 * `readStringReturn`, `passStringToWasm`, `WasmStringHandle`, `getMem` and the
 * module-level `cachedMem` re-implemented, by hand, what the generated glue
 * already does: (ptr,len) decoding over `exports.memory`, UTF-8 encoding into
 * `__wbindgen_malloc` space, and `__wbindgen_free`.
 *
 * They were removed with the import object, for the same reason. `StarkExports`
 * now describes the GLUE's wrappers, which take and return real JS values, so
 * `exports.memory`, `__wbindgen_malloc`, `__wbindgen_realloc` and
 * `__wbindgen_free` are no longer part of this package's surface -- and code
 * that reached for them would be reading a module the glue owns.
 *
 * ⚠️ They were EXPORTED, so this is a breaking change for any outside consumer
 * that imported them. Nothing in this repository did: the five client copies of
 * the ABI (apps/web, apps/extension, apps/mobile, packages/react-native-zk and
 * this file) are each self-contained, which is the deeper problem and is not
 * fixed here.
 */

/**
 * Kept as a no-op for API compatibility.
 *
 * It used to null a local `cachedMem` view of `exports.memory`, invalidated on
 * every `passStringToWasm` because `__wbindgen_realloc` can move the heap. The
 * glue owns that cache now (`cachedUint8ArrayMemory0`) and invalidates it
 * itself, so there is nothing here to reset — but the function was EXPORTED, so
 * removing it would break a consumer for no gain. It does nothing, and says so.
 */
export function invalidateMemoryCache(): void {
  /* the glue owns the memory view; see the note above */
}

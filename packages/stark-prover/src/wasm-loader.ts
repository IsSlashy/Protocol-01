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

// ---------------------------------------------------------------------------
// wasm-bindgen exports (subset we actually call)
// ---------------------------------------------------------------------------

export interface StarkExports {
  memory: WebAssembly.Memory;
  compute_stark_commitment(secret: bigint): [number, number];
  generate_stark_proof(secret: bigint): [number, number];
  generate_pool_commitment_stark_proof(
    a: bigint, b: bigint, c: bigint, d: bigint,
  ): [number, number];
  generate_balance_stark_proof(
    a: bigint, b: bigint, c: bigint, d: bigint,
  ): [number, number];
  generate_merkle_path_stark_proof(
    leaf: bigint,
    elemsPtr: number, elemsLen: number,
    idxPtr: number, idxLen: number,
  ): [number, number];
  generate_confidential_balance_stark_proof(
    a: bigint, b: bigint, c: bigint, d: bigint,
    e: bigint, f: bigint, g: bigint, h: bigint,
  ): [number, number];
  generate_transfer_stark_proof(
    a: bigint, b: bigint, c: bigint, d: bigint, e: bigint, f: bigint,
    g: bigint, h: bigint, i: bigint, j: bigint, k: bigint, l: bigint, m: bigint,
  ): [number, number];
  // MEASURED: the bundled blob DOES export `generate_merkle_update_stark_proof`
  // (14 exports, unchanged across the Route C reship) and
  // `src/wireFormat.test.ts` drives it. The comment here used to claim the
  // opposite. Kept optional so the loader still works against an older blob a
  // consumer may have pinned, and so `generateProofBytes` can throw a named
  // error instead of a `TypeError` inside a worker.
  generate_merkle_update_stark_proof?: (
    oldLeaf: bigint, newLeaf: bigint,
    elemsPtr: number, elemsLen: number,
    idxPtr: number, idxLen: number,
  ) => [number, number];
  __wbindgen_externrefs: WebAssembly.Table;
  __wbindgen_malloc(a: number, b: number): number;
  __wbindgen_realloc(a: number, b: number, c: number, d: number): number;
  __wbindgen_free(a: number, b: number, c: number): void;
  __wbindgen_start(): void;
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
    let exports: StarkExports | null = null;
    const imports = {
      './p01_stark_bg.js': {
        __wbindgen_init_externref_table: () => {
          if (!exports) throw new Error('WASM exports not yet bound');
          const table = exports.__wbindgen_externrefs;
          const offset = table.grow(4);
          table.set(0, undefined);
          table.set(offset + 0, undefined);
          table.set(offset + 1, null);
          table.set(offset + 2, true);
          table.set(offset + 3, false);
        },
      },
    };
    const result = await WebAssembly.instantiate(bytes as BufferSource, imports);
    // `WebAssembly.instantiate` returns either an `Instance` (when given a
    // compiled `Module`) or a `{ instance, module }` source (when given raw
    // bytes — our path). Narrow via the discriminating `instance` field.
    const instance: WebAssembly.Instance =
      'instance' in result ? result.instance : (result as WebAssembly.Instance);
    exports = instance.exports as unknown as StarkExports;
    exports.__wbindgen_start();
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
 */
export function resetStarkWasm(): void {
  cachedExports = null;
  pendingInit = null;
}

// ---------------------------------------------------------------------------
// String marshalling helpers (mirror the worker's `passStringToWasm`)
// ---------------------------------------------------------------------------

const decoder = (() => {
  const d = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
  d.decode();
  return d;
})();

const encoder = new TextEncoder();

let cachedMem: Uint8Array | null = null;

function getMem(exports: StarkExports): Uint8Array {
  if (cachedMem === null || cachedMem.byteLength === 0) {
    cachedMem = new Uint8Array(exports.memory.buffer);
  }
  return cachedMem;
}

/**
 * Read a wasm-bindgen `(ptr, len)` return tuple, decode UTF-8, free the
 * buffer. Mirrors the pattern emitted by wasm-bindgen.
 */
export function readStringReturn(exports: StarkExports, ret: [number, number]): string {
  const [ptr, len] = ret;
  const adjusted = ptr >>> 0;
  const str = decoder.decode(getMem(exports).subarray(adjusted, adjusted + len));
  exports.__wbindgen_free(ptr, len, 1);
  return str;
}

/** State carried alongside `passStringToWasm` calls — wasm-bindgen quirk. */
export interface WasmStringHandle {
  ptr: number;
  len: number;
}

/**
 * Push a JS string into the WASM heap. Returns `{ ptr, len }`. Call sites
 * must NOT free explicitly — the WASM function takes ownership.
 */
export function passStringToWasm(exports: StarkExports, arg: string): WasmStringHandle {
  const malloc = exports.__wbindgen_malloc;
  const realloc = exports.__wbindgen_realloc;
  let len = arg.length;
  let ptr = malloc(len, 1) >>> 0;
  let mem = getMem(exports);
  let offset = 0;
  for (; offset < len; offset++) {
    const code = arg.charCodeAt(offset);
    if (code > 0x7f) break;
    mem[ptr + offset] = code;
  }
  if (offset !== len) {
    let sliced = arg;
    if (offset !== 0) sliced = arg.slice(offset);
    const newLen = offset + sliced.length * 3;
    ptr = realloc(ptr, len, newLen, 1) >>> 0;
    len = newLen;
    mem = getMem(exports);
    const view = mem.subarray(ptr + offset, ptr + len);
    const { written } = encoder.encodeInto(sliced, view);
    offset += written;
    ptr = realloc(ptr, len, offset, 1) >>> 0;
  }
  // Memory may have grown — invalidate the cached view defensively.
  cachedMem = null;
  return { ptr, len: offset };
}

/**
 * Reset the cached memory view. The wasm-bindgen heap can be re-allocated by
 * `__wbindgen_realloc` calls; our local cache must be invalidated whenever
 * the caller suspects growth (we already do this internally on every
 * `passStringToWasm`, but expose it for safety).
 */
export function invalidateMemoryCache(): void {
  cachedMem = null;
}

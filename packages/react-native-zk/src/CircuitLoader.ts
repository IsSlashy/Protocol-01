/**
 * Circuit Asset Loader (v2 — STARK).
 *
 * In v2 the package ships the prover WASM inlined as base64 (see
 * `wasmData.ts`), so most callers never need this file. The loaders are
 * retained for two scenarios:
 *
 *   1. Ship a custom WASM build (e.g. one that exports
 *      `generate_merkle_update_stark_proof` for circuit 6).
 *   2. Defer the WASM bytes to runtime (smaller JS bundle, but adds an
 *      asset round-trip on first proof).
 *
 * STARK proofs have NO proving key — the corresponding `.zkey` half from
 * v1 is gone. The result type is now `{ wasmBase64 }` only.
 *
 * @example
 * ```ts
 * import { loadFromApkAssets, loadCircuitAssets } from '@protocol-01/react-native-zk';
 *
 * const result = await loadCircuitAssets('p01_stark', () =>
 *   loadFromApkAssets('p01_stark_bg.wasm'),
 * );
 * console.log(result.wasmBase64.length); // ~165_000
 * ```
 */

import type { CircuitLoadResult } from './types';

// ---------------------------------------------------------------------------
// In-memory cache (keyed by user-supplied name)
// ---------------------------------------------------------------------------

const cache: Partial<Record<string, CircuitLoadResult>> = {};
const loadPromises: Partial<Record<string, Promise<CircuitLoadResult>>> = {};

/**
 * Convert ArrayBuffer to base64 string. Chunked to avoid call-stack
 * blow-ups on large buffers (`String.fromCharCode(...bytes)` overflows
 * around 100 KB on JavaScriptCore).
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  // `btoa` is available in React Native via JavaScriptCore / Hermes >= 0.71.
  return btoa(binary);
}

/**
 * Load STARK WASM from the Expo Asset system.
 *
 * Requires `expo-asset` and `expo-file-system` (declared as optional peer
 * dependencies). Use this when you ship a custom WASM build via Expo's
 * native asset registry.
 *
 * @param wasmModule - `require()` result for the `.wasm` file
 * @returns Object with `wasmBase64` only
 * @throws Error if the asset cannot be downloaded or has no `localUri`
 *
 * @example
 * ```ts
 * const wasmModule = require('./assets/p01_stark_bg.wasm');
 * const { wasmBase64 } = await loadFromExpoAsset(wasmModule);
 * ```
 */
export async function loadFromExpoAsset(
  wasmModule: number,
): Promise<CircuitLoadResult> {
  // Dynamic imports — these are optional peer deps so they may not exist.
  const { Asset } = await import('expo-asset');
  const FileSystem = await import('expo-file-system');

  const wasmAsset = await Asset.fromModule(wasmModule).downloadAsync();

  if (!wasmAsset.localUri) {
    throw new Error('Failed to download STARK WASM asset via Expo (no localUri).');
  }

  const wasmBase64 = await FileSystem.readAsStringAsync(wasmAsset.localUri, {
    encoding: 'base64' as 'base64',
  });

  return { wasmBase64 };
}

/**
 * Load STARK WASM from Android APK assets via `fetch('file:///android_asset/...')`.
 *
 * Used by the bundled `tools/inject-apk.py` workflow for fast dev cycles.
 *
 * @param wasmPath - Asset filename (e.g. 'p01_stark_bg.wasm')
 * @returns Object with `wasmBase64` only
 * @throws Error if the asset is not found
 *
 * @example
 * ```ts
 * const { wasmBase64 } = await loadFromApkAssets('p01_stark_bg.wasm');
 * ```
 */
export async function loadFromApkAssets(
  wasmPath: string,
): Promise<CircuitLoadResult> {
  const wasmResponse = await fetch(`file:///android_asset/${wasmPath}`);

  if (!wasmResponse.ok) {
    throw new Error(`APK asset fetch failed for ${wasmPath}: status ${wasmResponse.status}`);
  }

  const wasmBuf = await wasmResponse.arrayBuffer();
  return { wasmBase64: arrayBufferToBase64(wasmBuf) };
}

/**
 * Load STARK WASM with caching. Uses the provided loader function on the
 * first call for a given name, then returns the cached result on
 * subsequent calls.
 *
 * @param name - Cache key (typically `'p01_stark'`)
 * @param loader - Async function that returns `CircuitLoadResult`
 * @returns Cached or freshly-loaded `CircuitLoadResult`
 *
 * @example
 * ```ts
 * const result = await loadCircuitAssets('p01_stark', () =>
 *   loadFromApkAssets('p01_stark_bg.wasm'),
 * );
 * // Subsequent calls are instant
 * const cached = await loadCircuitAssets('p01_stark', () => {
 *   throw new Error('never reached');
 * });
 * ```
 */
export async function loadCircuitAssets(
  name: string,
  loader: () => Promise<CircuitLoadResult>,
): Promise<CircuitLoadResult> {
  const hit = cache[name];
  if (hit) return hit;

  const inFlight = loadPromises[name];
  if (inFlight) return inFlight;

  const promise = (async () => {
    const result = await loader();
    cache[name] = result;
    return result;
  })();

  loadPromises[name] = promise;
  return promise;
}

/**
 * Check if WASM bytes for `name` are cached in memory.
 */
export function isCircuitCached(name: string): boolean {
  return !!cache[name];
}

/**
 * Clear cached WASM bytes to free memory.
 *
 * @param name - Specific cache key. If omitted, clears all entries.
 */
export function clearCircuitCache(name?: string): void {
  if (name) {
    delete cache[name];
    delete loadPromises[name];
    return;
  }
  for (const key of Object.keys(cache)) delete cache[key];
  for (const key of Object.keys(loadPromises)) delete loadPromises[key];
}

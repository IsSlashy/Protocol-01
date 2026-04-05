/**
 * Circuit Asset Loader
 *
 * Loads .wasm and .zkey files for ZK proof generation in React Native.
 * Provides multiple loading strategies with built-in caching.
 *
 * Strategy:
 *   1. Try Expo Asset system (works with native builds / EAS)
 *   2. Fallback: read directly from APK assets via fetch
 *
 * @example
 * ```ts
 * import { loadCircuitAssets, loadFromExpoAsset, isCircuitCached } from '@protocol-01/react-native-zk';
 *
 * // Expo workflow
 * const assets = await loadFromExpoAsset(require('./circuit.wasm'), require('./circuit.zkey'));
 *
 * // Cached loading
 * const result = await loadCircuitAssets('transfer', () => loadFromApkAssets('transfer.wasm', 'transfer.zkey'));
 * console.log(isCircuitCached('transfer')); // true
 * ```
 */

import { Platform } from 'react-native';
import type { CircuitLoadResult } from './types';

// Cache loaded base64 data
const cache: Partial<Record<string, CircuitLoadResult>> = {};
const loadPromises: Partial<Record<string, Promise<CircuitLoadResult>>> = {};

/**
 * Convert ArrayBuffer to base64 string.
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/**
 * Load circuit assets from Expo Asset system.
 * Requires `expo-asset` and `expo-file-system` to be installed (optional peer dependencies).
 *
 * @param wasmModule - `require()` result for the .wasm file
 * @param zkeyModule - `require()` result for the .zkey file
 * @returns Base64-encoded wasm and zkey data
 * @throws Error if asset download fails or localUri is missing
 *
 * @example
 * ```ts
 * const wasmModule = require('./assets/transfer.wasm');
 * const zkeyModule = require('./assets/transfer_final.zkey');
 * const { wasmBase64, zkeyBase64 } = await loadFromExpoAsset(wasmModule, zkeyModule);
 * ```
 */
export async function loadFromExpoAsset(
  wasmModule: number,
  zkeyModule: number,
): Promise<CircuitLoadResult> {
  const { Asset } = await import('expo-asset');
  const FileSystem = await import('expo-file-system');

  const [wasmAsset, zkeyAsset] = await Promise.all([
    Asset.fromModule(wasmModule).downloadAsync(),
    Asset.fromModule(zkeyModule).downloadAsync(),
  ]);

  if (!wasmAsset.localUri || !zkeyAsset.localUri) {
    throw new Error('Failed to download circuit assets via Expo');
  }

  const [wasmB64, zkeyB64] = await Promise.all([
    FileSystem.readAsStringAsync(wasmAsset.localUri, { encoding: 'base64' as any }),
    FileSystem.readAsStringAsync(zkeyAsset.localUri, { encoding: 'base64' as any }),
  ]);

  return { wasmBase64: wasmB64, zkeyBase64: zkeyB64 };
}

/**
 * Load circuit assets directly from Android APK assets via fetch.
 * Works with APK injection where Expo's native asset registry may not reflect injected files.
 *
 * @param wasmPath - Asset filename (e.g. 'my_circuit.wasm')
 * @param zkeyPath - Asset filename (e.g. 'my_circuit_final.zkey')
 * @returns Base64-encoded wasm and zkey data
 * @throws Error if asset files are not found at `file:///android_asset/{path}`
 *
 * @example
 * ```ts
 * const { wasmBase64, zkeyBase64 } = await loadFromApkAssets('transfer.wasm', 'transfer_final.zkey');
 * ```
 */
export async function loadFromApkAssets(
  wasmPath: string,
  zkeyPath: string,
): Promise<CircuitLoadResult> {
  const [wasmResponse, zkeyResponse] = await Promise.all([
    fetch(`file:///android_asset/${wasmPath}`),
    fetch(`file:///android_asset/${zkeyPath}`),
  ]);

  if (!wasmResponse.ok || !zkeyResponse.ok) {
    throw new Error(`APK asset fetch failed: wasm=${wasmResponse.status}, zkey=${zkeyResponse.status}`);
  }

  const [wasmBuf, zkeyBuf] = await Promise.all([
    wasmResponse.arrayBuffer(),
    zkeyResponse.arrayBuffer(),
  ]);

  return {
    wasmBase64: arrayBufferToBase64(wasmBuf),
    zkeyBase64: arrayBufferToBase64(zkeyBuf),
  };
}

/**
 * Load circuit assets with caching. Uses the provided loader function on first
 * call for a given name, then returns cached data on subsequent calls.
 *
 * @param name - Circuit name (used as cache key)
 * @param loader - Async function that returns CircuitLoadResult
 * @returns Cached or freshly loaded CircuitLoadResult
 *
 * @example
 * ```ts
 * const result = await loadCircuitAssets('transfer', () =>
 *   loadFromApkAssets('transfer.wasm', 'transfer_final.zkey')
 * );
 * // Second call returns cached data instantly
 * const cached = await loadCircuitAssets('transfer', () => { throw new Error('never called'); });
 * ```
 */
export async function loadCircuitAssets(
  name: string,
  loader: () => Promise<CircuitLoadResult>,
): Promise<CircuitLoadResult> {
  if (cache[name]) return cache[name];
  if (loadPromises[name]) return loadPromises[name]!;

  loadPromises[name] = (async () => {
    const result = await loader();
    cache[name] = result;
    return result;
  })();

  return loadPromises[name];
}

/**
 * Check if circuit assets are cached in memory.
 *
 * @param name - Circuit name to check
 * @returns true if the circuit's base64 data is cached
 *
 * @example
 * ```ts
 * if (!isCircuitCached('transfer')) {
 *   await loadCircuitAssets('transfer', myLoader);
 * }
 * ```
 */
export function isCircuitCached(name: string): boolean {
  return !!cache[name];
}

/**
 * Clear cached circuit data to free memory.
 *
 * @param name - Specific circuit to clear. If omitted, clears all cached circuits.
 *
 * @example
 * ```ts
 * clearCircuitCache('transfer');  // Clear one circuit
 * clearCircuitCache();            // Clear all circuits
 * ```
 */
export function clearCircuitCache(name?: string): void {
  if (name) {
    delete cache[name];
    delete loadPromises[name];
  } else {
    for (const key of Object.keys(cache)) delete cache[key];
    for (const key of Object.keys(loadPromises)) delete loadPromises[key];
  }
}

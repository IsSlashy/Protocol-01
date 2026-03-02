/**
 * Circuit Asset Loader
 *
 * Loads .wasm and .zkey files for ZK proof generation in React Native.
 *
 * Strategy:
 *   1. Try Expo Asset system (works with native builds / EAS)
 *   2. Fallback: read directly from APK assets via fetch
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
 * Requires expo-asset and expo-file-system to be installed.
 *
 * @param wasmModule - require() result for the .wasm file
 * @param zkeyModule - require() result for the .zkey file
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
 * Load circuit assets with caching.
 * Uses the provided loader function, caches the result.
 *
 * @param name - Circuit name (cache key)
 * @param loader - Async function that returns CircuitLoadResult
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
 * Check if circuit assets are cached.
 */
export function isCircuitCached(name: string): boolean {
  return !!cache[name];
}

/**
 * Clear cached circuit data.
 * @param name - Specific circuit to clear. If omitted, clears all.
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

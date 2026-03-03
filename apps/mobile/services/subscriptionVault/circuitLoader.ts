/**
 * Circuit Asset Loader for Subscription Vault
 *
 * Loads .wasm and .zkey files for ZK proof generation.
 * Circuit: 'subscriber_ownership' — proves knowledge of subscriber secret
 *
 * Strategy:
 *   1. Try Expo Asset system (works with native builds / EAS)
 *   2. Fallback: read directly from APK assets via fetch (works with APK injection)
 *
 * The inject_apk.py script adds circuit files with predictable names:
 *   assets/subscriber_ownership_circuit.wasm / .zkey
 */

import { Platform } from 'react-native';
import { Asset } from 'expo-asset';

// Asset references — Metro bundles these because .wasm and .zkey are in assetExts
// eslint-disable-next-line @typescript-eslint/no-var-requires
const WASM_ASSET = require('../../assets/circuits/subscriber_ownership/subscriber_ownership.wasm');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ZKEY_ASSET = require('../../assets/circuits/subscriber_ownership/subscriber_ownership_final.zkey');

const APK_NAMES = {
  wasm: 'subscriber_ownership_circuit.wasm',
  zkey: 'subscriber_ownership_circuit.zkey',
};

// Cache loaded base64 data
let _cache: { wasmBase64: string; zkeyBase64: string } | null = null;
let _loadPromise: Promise<{ wasmBase64: string; zkeyBase64: string }> | null = null;

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
 * Read a local file URI as base64 via fetch + arrayBuffer.
 * Works with both file:// URIs and content:// URIs.
 */
async function readFileAsBase64(uri: string): Promise<string> {
  const response = await fetch(uri);
  if (!response.ok) throw new Error(`fetch failed for ${uri}: ${response.status}`);
  const buf = await response.arrayBuffer();
  return arrayBufferToBase64(buf);
}

/**
 * Try loading via Expo Asset system (works with native builds).
 */
async function loadViaExpoAsset(): Promise<{ wasmBase64: string; zkeyBase64: string }> {
  const [wasmAsset, zkeyAsset] = await Promise.all([
    Asset.fromModule(WASM_ASSET).downloadAsync(),
    Asset.fromModule(ZKEY_ASSET).downloadAsync(),
  ]);

  if (!wasmAsset.localUri || !zkeyAsset.localUri) {
    throw new Error('Failed to download subscriber_ownership circuit assets via Expo');
  }

  console.log(`[CircuitLoader] Expo assets: wasm=${wasmAsset.localUri}, zkey=${zkeyAsset.localUri}`);

  const [wasmB64, zkeyB64] = await Promise.all([
    readFileAsBase64(wasmAsset.localUri),
    readFileAsBase64(zkeyAsset.localUri),
  ]);

  return { wasmBase64: wasmB64, zkeyBase64: zkeyB64 };
}

/**
 * Fallback: load directly from APK assets via fetch.
 * Works with APK injection where Expo's native asset registry is outdated.
 */
async function loadFromApkAssets(): Promise<{ wasmBase64: string; zkeyBase64: string }> {
  console.log('[CircuitLoader] Trying direct APK asset loading for subscriber_ownership...');

  const [wasmResponse, zkeyResponse] = await Promise.all([
    fetch(`file:///android_asset/${APK_NAMES.wasm}`),
    fetch(`file:///android_asset/${APK_NAMES.zkey}`),
  ]);

  if (!wasmResponse.ok || !zkeyResponse.ok) {
    throw new Error(`APK asset fetch failed: wasm=${wasmResponse.status}, zkey=${zkeyResponse.status}`);
  }

  const [wasmBuf, zkeyBuf] = await Promise.all([
    wasmResponse.arrayBuffer(),
    zkeyResponse.arrayBuffer(),
  ]);

  console.log(`[CircuitLoader] APK assets loaded: wasm=${wasmBuf.byteLength}, zkey=${zkeyBuf.byteLength}`);

  return {
    wasmBase64: arrayBufferToBase64(wasmBuf),
    zkeyBase64: arrayBufferToBase64(zkeyBuf),
  };
}

/**
 * Load circuit files as base64 strings.
 * Results are cached — subsequent calls return immediately.
 */
export async function loadCircuitAssets(): Promise<{
  wasmBase64: string;
  zkeyBase64: string;
}> {
  if (_cache) {
    return _cache;
  }

  if (_loadPromise) return _loadPromise;

  _loadPromise = (async () => {
    console.log('[CircuitLoader] Loading subscriber_ownership circuit assets...');
    const startTime = Date.now();

    let result: { wasmBase64: string; zkeyBase64: string };

    if (Platform.OS === 'android') {
      // On Android, try Expo Asset first, fall back to direct APK loading
      try {
        result = await loadViaExpoAsset();
      } catch (expoErr: any) {
        console.warn('[CircuitLoader] Expo Asset failed, trying direct APK load:', expoErr.message);
        result = await loadFromApkAssets();
      }
    } else {
      // iOS: use Expo Asset (should always work)
      result = await loadViaExpoAsset();
    }

    const elapsed = Date.now() - startTime;
    console.log(
      `[CircuitLoader] Loaded subscriber_ownership in ${elapsed}ms — wasm: ${(result.wasmBase64.length / 1024).toFixed(0)}KB b64, zkey: ${(result.zkeyBase64.length / 1024).toFixed(0)}KB b64`,
    );

    _cache = result;

    return result;
  })();

  return _loadPromise;
}

/**
 * Check if circuit assets are already loaded in memory.
 */
export function isCircuitLoaded(): boolean {
  return !!_cache;
}

/**
 * Clear cached circuit data (free memory).
 */
export function clearCircuitCache(): void {
  _cache = null;
  _loadPromise = null;
}

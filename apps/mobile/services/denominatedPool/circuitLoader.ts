/**
 * Circuit Asset Loader for Denominated Pool
 *
 * Loads .wasm and .zkey files for ZK proof generation.
 * Supports TWO circuits:
 *   - 'pool' (denominated_pool) — for shield/unshield
 *   - 'transfer' (denominated_transfer) — for ZK→ZK transfers
 *
 * Strategy:
 *   1. Try Expo Asset system (works with native builds / EAS)
 *   2. Fallback: read directly from APK assets via fetch (works with APK injection)
 *
 * The inject_apk.py script adds circuit files with predictable names:
 *   assets/denominated_pool_circuit.wasm / .zkey
 *   assets/denominated_transfer_circuit.wasm / .zkey
 */

import { Platform } from 'react-native';
import { Asset } from 'expo-asset';

export type CircuitType = 'pool' | 'transfer';

// Asset references — Metro bundles these because .wasm and .zkey are in assetExts
// eslint-disable-next-line @typescript-eslint/no-var-requires
const POOL_WASM_ASSET = require('../../assets/circuits/denominated_pool/denominated_pool.wasm');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const POOL_ZKEY_ASSET = require('../../assets/circuits/denominated_pool/denominated_pool_final.zkey');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const TRANSFER_WASM_ASSET = require('../../assets/circuits/denominated_pool/denominated_transfer.wasm');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const TRANSFER_ZKEY_ASSET = require('../../assets/circuits/denominated_pool/denominated_transfer_final.zkey');

const ASSET_MAP = {
  pool: { wasm: POOL_WASM_ASSET, zkey: POOL_ZKEY_ASSET },
  transfer: { wasm: TRANSFER_WASM_ASSET, zkey: TRANSFER_ZKEY_ASSET },
};

const APK_NAMES = {
  pool: { wasm: 'denominated_pool_circuit.wasm', zkey: 'denominated_pool_circuit.zkey' },
  transfer: { wasm: 'denominated_transfer_circuit.wasm', zkey: 'denominated_transfer_circuit.zkey' },
};

// Cache loaded base64 data per circuit type
const _cache: Record<string, { wasmBase64: string; zkeyBase64: string }> = {};
const _loadPromises: Record<string, Promise<{ wasmBase64: string; zkeyBase64: string }>> = {};

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
async function loadViaExpoAsset(circuit: CircuitType): Promise<{ wasmBase64: string; zkeyBase64: string }> {
  const assets = ASSET_MAP[circuit];
  const [wasmAsset, zkeyAsset] = await Promise.all([
    Asset.fromModule(assets.wasm).downloadAsync(),
    Asset.fromModule(assets.zkey).downloadAsync(),
  ]);

  if (!wasmAsset.localUri || !zkeyAsset.localUri) {
    throw new Error(`Failed to download ${circuit} circuit assets via Expo`);
  }

  console.log(`[CircuitLoader] Expo assets (${circuit}): wasm=${wasmAsset.localUri}, zkey=${zkeyAsset.localUri}`);

  // Use fetch instead of deprecated FileSystem.readAsStringAsync
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
async function loadFromApkAssets(circuit: CircuitType): Promise<{ wasmBase64: string; zkeyBase64: string }> {
  const names = APK_NAMES[circuit];
  console.log(`[CircuitLoader] Trying direct APK asset loading for ${circuit}...`);

  const [wasmResponse, zkeyResponse] = await Promise.all([
    fetch(`file:///android_asset/${names.wasm}`),
    fetch(`file:///android_asset/${names.zkey}`),
  ]);

  if (!wasmResponse.ok || !zkeyResponse.ok) {
    throw new Error(`APK asset fetch failed (${circuit}): wasm=${wasmResponse.status}, zkey=${zkeyResponse.status}`);
  }

  const [wasmBuf, zkeyBuf] = await Promise.all([
    wasmResponse.arrayBuffer(),
    zkeyResponse.arrayBuffer(),
  ]);

  console.log(`[CircuitLoader] APK assets loaded (${circuit}): wasm=${wasmBuf.byteLength}, zkey=${zkeyBuf.byteLength}`);

  return {
    wasmBase64: arrayBufferToBase64(wasmBuf),
    zkeyBase64: arrayBufferToBase64(zkeyBuf),
  };
}

/**
 * Load circuit files as base64 strings.
 * Results are cached per circuit type — subsequent calls return immediately.
 */
export async function loadCircuitAssets(circuit: CircuitType = 'pool'): Promise<{
  wasmBase64: string;
  zkeyBase64: string;
}> {
  if (_cache[circuit]) {
    return _cache[circuit];
  }

  if (_loadPromises[circuit]) return _loadPromises[circuit];

  _loadPromises[circuit] = (async () => {
    console.log(`[CircuitLoader] Loading ${circuit} circuit assets...`);
    const startTime = Date.now();

    let result: { wasmBase64: string; zkeyBase64: string };

    if (Platform.OS === 'android') {
      // On Android, try Expo Asset first, fall back to direct APK loading
      try {
        result = await loadViaExpoAsset(circuit);
      } catch (expoErr: any) {
        console.warn(`[CircuitLoader] Expo Asset failed for ${circuit}, trying direct APK load:`, expoErr.message);
        result = await loadFromApkAssets(circuit);
      }
    } else {
      // iOS: use Expo Asset (should always work)
      result = await loadViaExpoAsset(circuit);
    }

    const elapsed = Date.now() - startTime;
    console.log(
      `[CircuitLoader] Loaded ${circuit} in ${elapsed}ms — wasm: ${(result.wasmBase64.length / 1024).toFixed(0)}KB b64, zkey: ${(result.zkeyBase64.length / 1024).toFixed(0)}KB b64`,
    );

    _cache[circuit] = result;

    return result;
  })();

  return _loadPromises[circuit];
}

/**
 * Check if circuit assets are already loaded in memory.
 */
export function isCircuitLoaded(circuit: CircuitType = 'pool'): boolean {
  return !!_cache[circuit];
}

/**
 * Clear cached circuit data (free memory).
 * If no circuit specified, clears all cached circuits.
 */
export function clearCircuitCache(circuit?: CircuitType): void {
  if (circuit) {
    delete _cache[circuit];
    delete _loadPromises[circuit];
  } else {
    for (const key of Object.keys(_cache)) delete _cache[key];
    for (const key of Object.keys(_loadPromises)) delete _loadPromises[key];
  }
}

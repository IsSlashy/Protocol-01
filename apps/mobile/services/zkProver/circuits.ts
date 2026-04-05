/**
 * Circuit Registry
 *
 * Maps circuit names to their WASM and zkey asset paths.
 * Circuit files are bundled in apps/extension/public/circuits/ and must be
 * copied into the Android APK assets or loaded via expo-file-system at runtime.
 *
 * Loading strategy:
 *   1. expo-asset: require() the files if bundled via metro asset plugin
 *   2. expo-file-system: read from a known path on device (downloaded or side-loaded)
 *   3. APK assets: file:///android_asset/ path (Android only, requires prebuild injection)
 *
 * For now this module provides the metadata and a helper to resolve circuit files
 * to base64 strings that the WebView prover can consume.
 */

import {
  documentDirectory,
  getInfoAsync,
  makeDirectoryAsync,
  readAsStringAsync,
  EncodingType,
} from 'expo-file-system/legacy';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported circuit names */
export type CircuitName =
  | 'transfer'
  | 'confidential_balance'
  | 'balance_proof'
  | 'denominated_pool'
  | 'denominated_transfer'
  | 'subscriber_ownership';

/** Metadata for a single circuit */
export interface CircuitMeta {
  /** Human-readable name */
  name: CircuitName;
  /** WASM filename (relative to circuits directory) */
  wasmFile: string;
  /** Zkey filename (relative to circuits directory) */
  zkeyFile: string;
  /** Approximate WASM size in bytes (for progress estimation) */
  wasmSizeApprox: number;
  /** Approximate zkey size in bytes (for progress estimation) */
  zkeySizeApprox: number;
}

/** Resolved circuit data ready for the WebView prover */
export interface CircuitData {
  wasmBase64: string;
  zkeyBase64: string;
}

// ---------------------------------------------------------------------------
// Circuit registry
// ---------------------------------------------------------------------------

export const CIRCUIT_REGISTRY: Record<CircuitName, CircuitMeta> = {
  transfer: {
    name: 'transfer',
    wasmFile: 'transfer.wasm',
    zkeyFile: 'transfer_final.zkey',
    wasmSizeApprox: 2_738_964,
    zkeySizeApprox: 11_487_984,
  },
  confidential_balance: {
    name: 'confidential_balance',
    wasmFile: 'confidential_balance.wasm',
    zkeyFile: 'confidential_balance_final.zkey',
    wasmSizeApprox: 2_556_084,
    zkeySizeApprox: 1_276_488,
  },
  balance_proof: {
    name: 'balance_proof',
    wasmFile: 'balance_proof.wasm',
    zkeyFile: 'balance_proof_final.zkey',
    wasmSizeApprox: 2_220_219,
    zkeySizeApprox: 606_800,
  },
  denominated_pool: {
    name: 'denominated_pool',
    wasmFile: 'denominated_pool.wasm',
    zkeyFile: 'denominated_pool_final.zkey',
    wasmSizeApprox: 2_379_140,
    zkeySizeApprox: 4_347_992,
  },
  denominated_transfer: {
    name: 'denominated_transfer',
    wasmFile: 'denominated_transfer.wasm',
    zkeyFile: 'denominated_transfer_final.zkey',
    wasmSizeApprox: 2_383_724,
    zkeySizeApprox: 4_610_012,
  },
  subscriber_ownership: {
    name: 'subscriber_ownership',
    wasmFile: 'subscriber_ownership.wasm',
    zkeyFile: 'subscriber_ownership_final.zkey',
    wasmSizeApprox: 1_634_000,
    zkeySizeApprox: 187_032,
  },
};

/** All supported circuit names */
export const ALL_CIRCUIT_NAMES: CircuitName[] = Object.keys(CIRCUIT_REGISTRY) as CircuitName[];

// ---------------------------------------------------------------------------
// Circuit directory on device
// ---------------------------------------------------------------------------

/**
 * Base directory where circuit files are stored on the device filesystem.
 * Files should be placed here during app setup or downloaded on first use.
 */
const CIRCUITS_DIR = `${documentDirectory}circuits/`;

/**
 * Ensure the circuits directory exists.
 */
async function ensureCircuitsDir(): Promise<void> {
  const info = await getInfoAsync(CIRCUITS_DIR);
  if (!info.exists) {
    await makeDirectoryAsync(CIRCUITS_DIR, { intermediates: true });
  }
}

// ---------------------------------------------------------------------------
// Base64 loading cache
// ---------------------------------------------------------------------------

const circuitDataCache = new Map<CircuitName, CircuitData>();

/**
 * Check whether a circuit's files exist on the device filesystem.
 */
export async function isCircuitAvailable(circuit: CircuitName): Promise<boolean> {
  const meta = CIRCUIT_REGISTRY[circuit];
  if (!meta) return false;

  const [wasmInfo, zkeyInfo] = await Promise.all([
    getInfoAsync(CIRCUITS_DIR + meta.wasmFile),
    getInfoAsync(CIRCUITS_DIR + meta.zkeyFile),
  ]);

  return wasmInfo.exists && zkeyInfo.exists;
}

/**
 * Load a circuit's WASM and zkey as base64 strings for injection into the WebView.
 *
 * Reads from the device filesystem (expo-file-system documentDirectory).
 * Circuit files must be present at `${documentDirectory}circuits/<filename>`.
 *
 * Results are cached in memory to avoid re-reading large files.
 *
 * @throws Error if the circuit files are not found on the device
 */
export async function loadCircuitData(circuit: CircuitName): Promise<CircuitData> {
  // Return cached if available
  const cached = circuitDataCache.get(circuit);
  if (cached) return cached;

  const meta = CIRCUIT_REGISTRY[circuit];
  if (!meta) {
    throw new Error(`Unknown circuit: "${circuit}". Known circuits: ${ALL_CIRCUIT_NAMES.join(', ')}`);
  }

  const wasmPath = CIRCUITS_DIR + meta.wasmFile;
  const zkeyPath = CIRCUITS_DIR + meta.zkeyFile;

  // Verify files exist
  const [wasmInfo, zkeyInfo] = await Promise.all([
    getInfoAsync(wasmPath),
    getInfoAsync(zkeyPath),
  ]);

  if (!wasmInfo.exists) {
    throw new Error(
      `Circuit WASM not found: ${wasmPath}. ` +
      `Copy ${meta.wasmFile} to the circuits directory first.`,
    );
  }

  if (!zkeyInfo.exists) {
    throw new Error(
      `Circuit zkey not found: ${zkeyPath}. ` +
      `Copy ${meta.zkeyFile} to the circuits directory first.`,
    );
  }

  // Read as base64
  const [wasmBase64, zkeyBase64] = await Promise.all([
    readAsStringAsync(wasmPath, { encoding: EncodingType.Base64 }),
    readAsStringAsync(zkeyPath, { encoding: EncodingType.Base64 }),
  ]);

  const data: CircuitData = { wasmBase64, zkeyBase64 };
  circuitDataCache.set(circuit, data);
  return data;
}

/**
 * Get the expected filesystem path for a circuit file.
 * Useful for downloading or copying files to the correct location.
 */
export function getCircuitFilePath(circuit: CircuitName, type: 'wasm' | 'zkey'): string {
  const meta = CIRCUIT_REGISTRY[circuit];
  if (!meta) {
    throw new Error(`Unknown circuit: "${circuit}"`);
  }
  return CIRCUITS_DIR + (type === 'wasm' ? meta.wasmFile : meta.zkeyFile);
}

/**
 * Get the circuits directory path.
 */
export function getCircuitsDirectory(): string {
  return CIRCUITS_DIR;
}

/**
 * Clear the in-memory circuit data cache.
 * Does NOT delete files from the filesystem.
 *
 * @param circuit - Specific circuit to evict, or omit to clear all
 */
export function clearCircuitCache(circuit?: CircuitName): void {
  if (circuit) {
    circuitDataCache.delete(circuit);
  } else {
    circuitDataCache.clear();
  }
}

/**
 * Ensure the circuits directory exists. Exposed for setup/download flows.
 */
export { ensureCircuitsDir };

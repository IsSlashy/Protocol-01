/**
 * ZK Prover Service — Singleton
 *
 * Manages the WebView-based Groth16 prover lifecycle:
 *   - Initializes the hidden WebView and injects snarkjs
 *   - Loads circuit files (WASM + zkey) on demand
 *   - Queues proof requests (one at a time inside the WebView)
 *   - Provides a simple async API: prove(circuitName, inputs)
 *
 * Usage:
 *   1. Render <ZkProverGate /> once in your app root layout
 *   2. Import the singleton anywhere:
 *        import { zkProverService } from '@/services/zkProver';
 *        const result = await zkProverService.prove('transfer', inputs);
 *
 * Architecture:
 *   ZkProverGate (React component, renders in root layout)
 *     └─ WebViewProver (hidden WebView, ref-based)
 *     └─ Calls zkProverService.attach(handle) on mount
 *     └─ Forwards onMessage to zkProverService.handleMessage()
 *
 *   Any code that needs a proof:
 *     └─ zkProverService.prove('transfer', { ... })
 *     └─ Internally: ensure ready → load circuit if needed → enqueue → return result
 *
 * SECURITY: All proving happens on-device. Spending keys never leave the phone.
 */

import React, { useRef, useCallback, useEffect } from 'react';
import {
  documentDirectory,
  getInfoAsync,
  readAsStringAsync,
  writeAsStringAsync,
  EncodingType,
} from 'expo-file-system/legacy';

import {
  WebViewProver,
  type WebViewProverHandle,
  type WebViewIncomingMessage,
} from './WebViewProver';

import {
  type CircuitName,
  type CircuitData,
  CIRCUIT_REGISTRY,
  ALL_CIRCUIT_NAMES,
  loadCircuitData,
} from './circuits';

// Re-export types and utilities for convenience
export { type CircuitName, ALL_CIRCUIT_NAMES, CIRCUIT_REGISTRY } from './circuits';
export {
  isCircuitAvailable,
  loadCircuitData,
  getCircuitFilePath,
  getCircuitsDirectory,
  clearCircuitCache,
  ensureCircuitsDir,
} from './circuits';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a proof generation call */
export interface ProofResult {
  proof: {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: string;
    curve: string;
  };
  publicSignals: string[];
  durationMs: number;
}

/** Groth16 proof in byte-array format (for Solana on-chain verification) */
export interface Groth16ProofBytes {
  pi_a: Uint8Array;
  pi_b: Uint8Array;
  pi_c: Uint8Array;
}

/** Internal queue item */
interface QueueItem {
  id: string;
  circuit: CircuitName;
  inputs: Record<string, string>;
  resolve: (result: ProofResult) => void;
  reject: (error: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max time to wait for a single proof (ms) */
const PROOF_TIMEOUT_MS = 120_000;

/** Max time to wait for WebView readiness (ms) */
const READY_TIMEOUT_MS = 30_000;

/** Max time to wait for snarkjs injection (ms) */
const SNARKJS_TIMEOUT_MS = 30_000;

/** Max time to wait for a circuit to load (ms) */
const CIRCUIT_LOAD_TIMEOUT_MS = 60_000;

/** Path to the bundled snarkjs.min.js on the device filesystem */
const SNARKJS_PATH = `${documentDirectory}snarkjs.min.js`;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class ZkProverService {
  // -- WebView handle --
  private handle: WebViewProverHandle | null = null;

  // -- State flags --
  private _webViewReady = false;
  private _snarkjsReady = false;

  // -- Circuit tracking --
  private loadedCircuits = new Set<string>();
  private circuitLoadingPromises = new Map<string, Promise<boolean>>();

  // -- Proof queue --
  private pendingProofs = new Map<string, QueueItem>();
  private queue: QueueItem[] = [];
  private processing = false;

  // -- Init sequencing --
  private readyResolvers: Array<() => void> = [];
  private readyRejecters: Array<(err: Error) => void> = [];
  private snarkjsResolvers: Array<() => void> = [];
  private snarkjsRejecters: Array<(err: Error) => void> = [];
  private circuitResolvers = new Map<string, Array<(success: boolean) => void>>();

  // -- snarkjs source cache --
  private snarkjsSource: string | null = null;

  // -----------------------------------------------------------------------
  // Lifecycle — called by ZkProverGate
  // -----------------------------------------------------------------------

  /**
   * Register the WebView imperative handle and kick off initialization.
   * Called by ZkProverGate when the WebView mounts.
   */
  attach(webViewHandle: WebViewProverHandle): void {
    this.handle = webViewHandle;
  }

  /**
   * Clean up when the WebView is unmounted.
   * Rejects all pending operations.
   */
  detach(): void {
    this.handle = null;
    this._webViewReady = false;
    this._snarkjsReady = false;
    this.loadedCircuits.clear();
    this.circuitLoadingPromises.clear();

    // Reject all pending proofs
    for (const [, item] of this.pendingProofs) {
      clearTimeout(item.timeoutHandle);
      item.reject(new Error('WebView prover detached'));
    }
    this.pendingProofs.clear();
    this.queue = [];
    this.processing = false;

    // Reject readiness waiters
    const readyErr = new Error('WebView prover detached');
    for (const rej of this.readyRejecters.splice(0)) rej(readyErr);
    for (const rej of this.snarkjsRejecters.splice(0)) rej(readyErr);
    this.readyResolvers.splice(0);
    this.snarkjsResolvers.splice(0);

    // Resolve circuit waiters with false
    for (const [, resolvers] of this.circuitResolvers) {
      for (const r of resolvers) r(false);
    }
    this.circuitResolvers.clear();
  }

  // -----------------------------------------------------------------------
  // Message handling — called by ZkProverGate
  // -----------------------------------------------------------------------

  handleMessage(msg: WebViewIncomingMessage): void {
    switch (msg.type) {
      case 'ready':
        this._webViewReady = true;
        this.flushResolvers(this.readyResolvers);
        this.readyRejecters.splice(0);
        // Auto-inject snarkjs once WebView is ready
        this.autoInjectSnarkjs();
        break;

      case 'snarkjsLoaded':
        this._snarkjsReady = true;
        this.flushResolvers(this.snarkjsResolvers);
        this.snarkjsRejecters.splice(0);
        console.log('[ZkProver] snarkjs loaded successfully');
        break;

      case 'snarkjsError':
        console.error('[ZkProver] snarkjs injection failed:', msg.error);
        this.flushRejecters(
          this.snarkjsRejecters,
          new Error(`snarkjs injection failed: ${msg.error}`),
        );
        this.snarkjsResolvers.splice(0);
        break;

      case 'circuitLoaded': {
        const name = msg.name ?? '';
        if (msg.success) {
          this.loadedCircuits.add(name);
          console.log(
            `[ZkProver] Circuit "${name}" loaded: ` +
            `wasm=${((msg.wasmSize ?? 0) / 1024).toFixed(0)}KB, ` +
            `zkey=${((msg.zkeySize ?? 0) / 1024).toFixed(0)}KB`,
          );
        } else {
          console.error(`[ZkProver] Circuit "${name}" load failed:`, msg.error);
        }
        this.flushCircuitResolvers(name, !!msg.success);
        break;
      }

      case 'circuitLoadFailed': {
        const name = msg.name ?? '';
        console.error(`[ZkProver] Circuit "${name}" load failed:`, msg.error);
        this.flushCircuitResolvers(name, false);
        break;
      }

      case 'proof': {
        const item = msg.id ? this.pendingProofs.get(msg.id) : undefined;
        if (item) {
          clearTimeout(item.timeoutHandle);
          this.pendingProofs.delete(msg.id!);
          item.resolve({
            proof: msg.proof!,
            publicSignals: msg.publicSignals!,
            durationMs: msg.durationMs ?? 0,
          });
        }
        this.processing = false;
        this.processQueue();
        break;
      }

      case 'error': {
        const item = msg.id ? this.pendingProofs.get(msg.id) : undefined;
        if (item) {
          clearTimeout(item.timeoutHandle);
          this.pendingProofs.delete(msg.id!);
          item.reject(new Error(msg.error ?? 'Proof generation failed'));
        }
        this.processing = false;
        this.processQueue();
        break;
      }

      case 'log':
        console.log('[ZkProver:WebView]', msg.message);
        break;

      default:
        break;
    }
  }

  // -----------------------------------------------------------------------
  // Public API — state queries
  // -----------------------------------------------------------------------

  /** Whether the WebView is ready and snarkjs is loaded */
  isReady(): boolean {
    return this._webViewReady && this._snarkjsReady;
  }

  /** Whether a specific circuit is loaded in the WebView */
  isCircuitLoaded(circuit: CircuitName): boolean {
    return this.loadedCircuits.has(circuit);
  }

  /** Number of proof requests in the queue (including currently processing) */
  get queueLength(): number {
    return this.queue.length + (this.processing ? 1 : 0);
  }

  // -----------------------------------------------------------------------
  // Public API — initialization
  // -----------------------------------------------------------------------

  /**
   * Wait until the prover is fully ready (WebView + snarkjs).
   * Call this before prove() if you want to handle init errors explicitly.
   */
  async waitForReady(): Promise<void> {
    await this.waitForWebView();
    await this.waitForSnarkjs();
  }

  /**
   * Ensure snarkjs.min.js is available on the device filesystem.
   * Must be called once during app setup (e.g., at first launch or after update).
   *
   * The snarkjs source is read from the Expo asset system. If not bundled,
   * you must manually copy snarkjs.min.js to the document directory.
   *
   * @param source - The snarkjs.min.js source code as a string.
   *                 If provided, writes it to the filesystem for future use.
   */
  async ensureSnarkjs(source?: string): Promise<void> {
    if (source) {
      await writeAsStringAsync(SNARKJS_PATH, source, {
        encoding: EncodingType.UTF8,
      });
      this.snarkjsSource = source;
      return;
    }

    // Check if already cached in memory
    if (this.snarkjsSource) return;

    // Check if on disk
    const info = await getInfoAsync(SNARKJS_PATH);
    if (info.exists) {
      this.snarkjsSource = await readAsStringAsync(SNARKJS_PATH, {
        encoding: EncodingType.UTF8,
      });
      return;
    }

    throw new Error(
      'snarkjs.min.js not found on device. Call ensureSnarkjs(source) with the ' +
      'snarkjs source code, or copy snarkjs.min.js to: ' + SNARKJS_PATH,
    );
  }

  // -----------------------------------------------------------------------
  // Public API — circuit loading
  // -----------------------------------------------------------------------

  /**
   * Load a circuit into the WebView prover.
   *
   * Reads the WASM and zkey from the device filesystem (via circuits.ts),
   * sends them as base64 to the WebView, and waits for confirmation.
   *
   * @param circuit - Circuit name (must be in CIRCUIT_REGISTRY)
   * @returns true if the circuit loaded successfully
   */
  async loadCircuit(circuit: CircuitName): Promise<boolean> {
    // Already loaded
    if (this.loadedCircuits.has(circuit)) return true;

    // Deduplicate concurrent loads for the same circuit
    const existing = this.circuitLoadingPromises.get(circuit);
    if (existing) return existing;

    const promise = this._loadCircuitImpl(circuit);
    this.circuitLoadingPromises.set(circuit, promise);

    try {
      return await promise;
    } finally {
      this.circuitLoadingPromises.delete(circuit);
    }
  }

  /**
   * Load a circuit from pre-resolved base64 data.
   * Useful when you already have the circuit data in memory.
   */
  async loadCircuitFromData(
    circuit: CircuitName,
    data: CircuitData,
  ): Promise<boolean> {
    if (this.loadedCircuits.has(circuit)) return true;

    await this.waitForReady();

    if (!this.handle?.isMounted()) {
      throw new Error('WebView not mounted — cannot load circuit');
    }

    const loadPromise = this.waitForCircuitLoad(circuit);
    this.handle.loadCircuit(circuit, data.wasmBase64, data.zkeyBase64);
    return loadPromise;
  }

  // -----------------------------------------------------------------------
  // Public API — proof generation
  // -----------------------------------------------------------------------

  /**
   * Generate a Groth16 proof.
   *
   * This is the primary entry point. It will:
   *   1. Wait for the WebView + snarkjs to be ready
   *   2. Load the circuit if not already loaded
   *   3. Enqueue the proof request (one proof at a time)
   *   4. Return { proof, publicSignals, durationMs }
   *
   * @param circuit - Circuit name
   * @param inputs  - Circuit inputs as string key-value pairs.
   *                  Array inputs should be JSON-stringified: '["1","2","3"]'
   * @returns ProofResult with snarkjs proof format
   * @throws Error on timeout (120s), circuit load failure, or proof failure
   */
  async prove(
    circuit: CircuitName,
    inputs: Record<string, string>,
  ): Promise<ProofResult> {
    // Ensure everything is ready
    await this.waitForReady();

    // Auto-load circuit if not loaded
    if (!this.loadedCircuits.has(circuit)) {
      const loaded = await this.loadCircuit(circuit);
      if (!loaded) {
        throw new Error(
          `Failed to load circuit "${circuit}". ` +
          `Ensure circuit files are available on the device filesystem.`,
        );
      }
    }

    if (!this.handle?.isMounted()) {
      throw new Error('WebView not mounted — cannot generate proof');
    }

    const id = generateId();

    return new Promise<ProofResult>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        if (this.pendingProofs.has(id)) {
          this.pendingProofs.delete(id);
          this.processing = false;
          this.processQueue();
          reject(
            new Error(
              `Proof generation timed out after ${PROOF_TIMEOUT_MS / 1000}s ` +
              `for circuit "${circuit}"`,
            ),
          );
        }
      }, PROOF_TIMEOUT_MS);

      const item: QueueItem = {
        id,
        circuit,
        inputs,
        resolve,
        reject,
        timeoutHandle,
      };

      this.queue.push(item);
      this.processQueue();
    });
  }

  /**
   * Generate a proof and convert to byte arrays for Solana on-chain verification.
   * Same as prove() but returns Uint8Array fields.
   */
  async proveBytes(
    circuit: CircuitName,
    inputs: Record<string, string>,
  ): Promise<{ proof: Groth16ProofBytes; publicSignals: string[] }> {
    const result = await this.prove(circuit, inputs);
    return {
      proof: convertProofToBytes(result.proof),
      publicSignals: result.publicSignals,
    };
  }

  // -----------------------------------------------------------------------
  // Queue processing
  // -----------------------------------------------------------------------

  private processQueue(): void {
    if (this.processing || this.queue.length === 0) return;

    const item = this.queue.shift()!;
    this.processing = true;
    this.pendingProofs.set(item.id, item);

    // Serialize: arrays stay as JSON strings, scalars as plain strings
    const serialized: Record<string, string> = {};
    for (const [k, v] of Object.entries(item.inputs)) {
      serialized[k] = v;
    }

    this.handle?.requestProof(item.id, item.circuit, serialized);
  }

  // -----------------------------------------------------------------------
  // Internal: snarkjs auto-injection
  // -----------------------------------------------------------------------

  private async autoInjectSnarkjs(): Promise<void> {
    try {
      // Try to load snarkjs source if not already cached
      if (!this.snarkjsSource) {
        const info = await getInfoAsync(SNARKJS_PATH);
        if (info.exists) {
          this.snarkjsSource = await readAsStringAsync(SNARKJS_PATH, {
            encoding: EncodingType.UTF8,
          });
        }
      }

      if (this.snarkjsSource && this.handle?.isMounted()) {
        this.handle.injectSnarkjs(this.snarkjsSource);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.warn('[ZkProver] Auto-inject snarkjs failed:', message);
    }
  }

  // -----------------------------------------------------------------------
  // Internal: circuit loading implementation
  // -----------------------------------------------------------------------

  private async _loadCircuitImpl(circuit: CircuitName): Promise<boolean> {
    await this.waitForReady();

    if (!this.handle?.isMounted()) {
      throw new Error('WebView not mounted — cannot load circuit');
    }

    // Read circuit files from device filesystem
    let data: CircuitData;
    try {
      data = await loadCircuitData(circuit);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      throw new Error(`Failed to read circuit files for "${circuit}": ${message}`);
    }

    // Set up listener before sending to avoid race
    const loadPromise = this.waitForCircuitLoad(circuit);

    // Send to WebView
    this.handle.loadCircuit(circuit, data.wasmBase64, data.zkeyBase64);

    return loadPromise;
  }

  // -----------------------------------------------------------------------
  // Internal: waiting helpers
  // -----------------------------------------------------------------------

  private waitForWebView(): Promise<void> {
    if (this._webViewReady) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.readyResolvers.push(resolve);
      this.readyRejecters.push(reject);
      setTimeout(() => {
        const idx = this.readyResolvers.indexOf(resolve);
        if (idx !== -1) {
          this.readyResolvers.splice(idx, 1);
          const rIdx = this.readyRejecters.indexOf(reject);
          if (rIdx !== -1) this.readyRejecters.splice(rIdx, 1);
          reject(new Error(`WebView initialization timed out after ${READY_TIMEOUT_MS / 1000}s`));
        }
      }, READY_TIMEOUT_MS);
    });
  }

  private waitForSnarkjs(): Promise<void> {
    if (this._snarkjsReady) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.snarkjsResolvers.push(resolve);
      this.snarkjsRejecters.push(reject);
      setTimeout(() => {
        const idx = this.snarkjsResolvers.indexOf(resolve);
        if (idx !== -1) {
          this.snarkjsResolvers.splice(idx, 1);
          const rIdx = this.snarkjsRejecters.indexOf(reject);
          if (rIdx !== -1) this.snarkjsRejecters.splice(rIdx, 1);
          reject(new Error(`snarkjs loading timed out after ${SNARKJS_TIMEOUT_MS / 1000}s`));
        }
      }, SNARKJS_TIMEOUT_MS);
    });
  }

  private waitForCircuitLoad(circuit: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (!this.circuitResolvers.has(circuit)) {
        this.circuitResolvers.set(circuit, []);
      }
      this.circuitResolvers.get(circuit)!.push(resolve);

      setTimeout(() => {
        const resolvers = this.circuitResolvers.get(circuit);
        if (resolvers) {
          const idx = resolvers.indexOf(resolve);
          if (idx !== -1) {
            resolvers.splice(idx, 1);
            resolve(false);
            console.error(
              `[ZkProver] Circuit "${circuit}" load timed out after ${CIRCUIT_LOAD_TIMEOUT_MS / 1000}s`,
            );
          }
        }
      }, CIRCUIT_LOAD_TIMEOUT_MS);
    });
  }

  // -----------------------------------------------------------------------
  // Internal: resolver helpers
  // -----------------------------------------------------------------------

  private flushResolvers(resolvers: Array<() => void>): void {
    const batch = resolvers.splice(0);
    for (const r of batch) r();
  }

  private flushRejecters(rejecters: Array<(err: Error) => void>, err: Error): void {
    const batch = rejecters.splice(0);
    for (const r of batch) r(err);
  }

  private flushCircuitResolvers(circuit: string, success: boolean): void {
    const resolvers = this.circuitResolvers.get(circuit);
    if (resolvers) {
      this.circuitResolvers.delete(circuit);
      for (const r of resolvers) r(success);
    }
  }
}

// ---------------------------------------------------------------------------
// Utility: convert snarkjs proof to Solana byte arrays
// ---------------------------------------------------------------------------

/**
 * Convert a snarkjs proof (string arrays) to Uint8Array format.
 * Solana's alt_bn128 precompile expects big-endian encoding.
 */
export function convertProofToBytes(proof: ProofResult['proof']): Groth16ProofBytes {
  const fieldToBytesBE = (value: bigint): Uint8Array => {
    const bytes = new Uint8Array(32);
    let temp = value;
    for (let i = 31; i >= 0; i--) {
      bytes[i] = Number(temp & 0xffn);
      temp >>= 8n;
    }
    return bytes;
  };

  // G1 point: [x, y] -> 64 bytes
  const g1ToBytes = (point: string[]): Uint8Array => {
    const out = new Uint8Array(64);
    out.set(fieldToBytesBE(BigInt(point[0])), 0);
    out.set(fieldToBytesBE(BigInt(point[1])), 32);
    return out;
  };

  // G2 point: [[x0, x1], [y0, y1]] -> 128 bytes
  // alt_bn128 Fp2 stored in (c1, c0) order
  const g2ToBytes = (point: string[][]): Uint8Array => {
    const out = new Uint8Array(128);
    out.set(fieldToBytesBE(BigInt(point[0][1])), 0);   // x1
    out.set(fieldToBytesBE(BigInt(point[0][0])), 32);   // x0
    out.set(fieldToBytesBE(BigInt(point[1][1])), 64);   // y1
    out.set(fieldToBytesBE(BigInt(point[1][0])), 96);   // y0
    return out;
  };

  return {
    pi_a: g1ToBytes(proof.pi_a.slice(0, 2)),
    pi_b: g2ToBytes(proof.pi_b.slice(0, 2)),
    pi_c: g1ToBytes(proof.pi_c.slice(0, 2)),
  };
}

// ---------------------------------------------------------------------------
// Utility: ID generation
// ---------------------------------------------------------------------------

function generateId(): string {
  return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const zkProverService = new ZkProverService();

// ---------------------------------------------------------------------------
// React component: ZkProverGate
// ---------------------------------------------------------------------------

/**
 * ZkProverGate — Drop-in React component that renders the hidden WebView prover.
 *
 * Mount this once in your app's root layout (e.g., _layout.tsx):
 *
 *   import { ZkProverGate } from '@/services/zkProver';
 *
 *   export default function RootLayout() {
 *     return (
 *       <>
 *         <ZkProverGate />
 *         <Stack />
 *       </>
 *     );
 *   }
 *
 * The component automatically:
 *   - Renders the hidden WebView
 *   - Attaches to the singleton zkProverService
 *   - Injects snarkjs when the WebView is ready
 *   - Cleans up on unmount
 */
export function ZkProverGate(): React.JSX.Element {
  const handleRef = useRef<WebViewProverHandle>(null);

  const onMessage = useCallback((msg: WebViewIncomingMessage) => {
    zkProverService.handleMessage(msg);
  }, []);

  const onError = useCallback((error: string) => {
    console.error('[ZkProverGate] WebView error:', error);
  }, []);

  useEffect(() => {
    if (handleRef.current) {
      zkProverService.attach(handleRef.current);
    }
    return () => {
      zkProverService.detach();
    };
  }, []);

  return React.createElement(WebViewProver, {
    ref: handleRef,
    onMessage,
    onError,
  });
}

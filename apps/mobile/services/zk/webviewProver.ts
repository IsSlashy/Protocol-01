/**
 * WebView Prover Service
 *
 * Manages the lifecycle of the hidden WebView prover: circuit loading,
 * proof request queuing, and timeout handling.
 *
 * This service is a singleton — it holds state but does NOT own the WebView
 * component. The WebView component lives in the React tree (via ZkProverProvider)
 * and registers its handle here via `attachWebView()`.
 *
 * Architecture:
 *   ZkProverProvider
 *     └─ renders <WebViewProver ref={...} onMessage={...} />
 *     └─ calls webviewProverService.attachWebView(handle)
 *     └─ calls webviewProverService.handleMessage(msg) from onMessage
 *
 *   Any code that needs a proof:
 *     import { webviewProverService } from './webviewProver';
 *     const { proof, publicSignals } = await webviewProverService.generateProof('transfer', inputs);
 *
 * SECURITY: All proving happens on-device. Spending keys never leave the phone.
 */

import type { WebViewProverHandle, WebViewProverMessage } from '../../components/zk/WebViewProver';

// -----------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------

/** Circuit identifiers supported by the prover */
export type CircuitName = 'transfer' | 'pool' | 'denominated_transfer' | string;

/** Raw snarkjs proof format (string arrays, not byte arrays) */
export interface SnarkjsProof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
}

/** Result of a proof generation call */
export interface ProofResult {
  proof: SnarkjsProof;
  publicSignals: string[];
  durationMs: number;
}

/** Groth16 proof in byte-array format (for Solana on-chain verification) */
export interface Groth16Proof {
  pi_a: Uint8Array;
  pi_b: Uint8Array;
  pi_c: Uint8Array;
}

// -----------------------------------------------------------------------
// Internal queue item
// -----------------------------------------------------------------------

interface QueueItem {
  id: string;
  circuit: CircuitName;
  inputs: Record<string, string>;
  resolve: (result: ProofResult) => void;
  reject: (error: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

// -----------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------

/** Maximum time to wait for a single proof (ms) */
const PROOF_TIMEOUT_MS = 60_000;

/** Maximum time to wait for WebView + snarkjs to be ready (ms) */
const READY_TIMEOUT_MS = 30_000;

/** Maximum time to wait for a circuit to load (ms) */
const CIRCUIT_LOAD_TIMEOUT_MS = 30_000;

// -----------------------------------------------------------------------
// Service class
// -----------------------------------------------------------------------

class WebViewProverService {
  // WebView handle (set by ZkProverProvider after mount)
  private handle: WebViewProverHandle | null = null;

  // State flags
  private _webViewReady = false;
  private _snarkjsReady = false;

  // Loaded circuit tracking
  private loadedCircuits = new Set<string>();

  // Pending proof requests by id
  private pendingProofs = new Map<string, QueueItem>();

  // Proof queue — only one proof runs at a time inside the WebView
  private queue: QueueItem[] = [];
  private isProcessing = false;

  // Promises for init sequencing
  private readyResolvers: Array<() => void> = [];
  private snarkjsResolvers: Array<() => void> = [];
  private circuitResolvers = new Map<string, Array<(success: boolean) => void>>();

  // -----------------------------------------------------------------------
  // Lifecycle — called by ZkProverProvider
  // -----------------------------------------------------------------------

  /** Register the WebView imperative handle */
  attachWebView(webViewHandle: WebViewProverHandle): void {
    this.handle = webViewHandle;
  }

  /** Unregister (e.g. when provider unmounts) */
  detachWebView(): void {
    this.handle = null;
    this._webViewReady = false;
    this._snarkjsReady = false;
    this.loadedCircuits.clear();
    // Reject all pending proofs
    for (const [, item] of this.pendingProofs) {
      clearTimeout(item.timeoutHandle);
      item.reject(new Error('WebView detached'));
    }
    this.pendingProofs.clear();
    this.queue = [];
    this.isProcessing = false;
  }

  // -----------------------------------------------------------------------
  // Message handler — called by ZkProverProvider's onMessage
  // -----------------------------------------------------------------------

  handleMessage(msg: WebViewProverMessage): void {
    switch (msg.type) {
      case 'ready':
        this._webViewReady = true;
        this.flushResolvers(this.readyResolvers);
        break;

      case 'snarkjsLoaded':
        this._snarkjsReady = true;
        this.flushResolvers(this.snarkjsResolvers);
        break;

      case 'circuitLoaded': {
        const circuit = msg.circuit;
        if (msg.success) {
          this.loadedCircuits.add(circuit);
          console.log(
            `[WebViewProver] Circuit "${circuit}" loaded (${msg.source}): ` +
            `wasm=${((msg.wasmSize ?? 0) / 1024).toFixed(0)}KB, zkey=${((msg.zkeySize ?? 0) / 1024).toFixed(0)}KB`,
          );
        } else {
          console.error(`[WebViewProver] Circuit "${circuit}" load failed:`, msg.error);
        }
        this.flushCircuitResolvers(circuit, msg.success);
        break;
      }

      case 'circuitLoadFailed': {
        console.warn(`[WebViewProver] Asset load failed for "${msg.circuit}":`, msg.error);
        this.flushCircuitResolvers(msg.circuit, false);
        break;
      }

      case 'proof': {
        const item = this.pendingProofs.get(msg.id);
        if (item) {
          clearTimeout(item.timeoutHandle);
          this.pendingProofs.delete(msg.id);
          item.resolve({
            proof: msg.proof,
            publicSignals: msg.publicSignals,
            durationMs: msg.durationMs,
          });
        }
        this.isProcessing = false;
        this.processQueue();
        break;
      }

      case 'error': {
        const item = this.pendingProofs.get(msg.id);
        if (item) {
          clearTimeout(item.timeoutHandle);
          this.pendingProofs.delete(msg.id);
          item.reject(new Error(msg.error));
        }
        this.isProcessing = false;
        this.processQueue();
        break;
      }

      case 'pong':
        // Health-check response, useful for debugging
        console.log('[WebViewProver] pong:', msg);
        break;

      default:
        break;
    }
  }

  // -----------------------------------------------------------------------
  // Public API — state queries
  // -----------------------------------------------------------------------

  get isReady(): boolean {
    return this._webViewReady && this._snarkjsReady;
  }

  get isWebViewReady(): boolean {
    return this._webViewReady;
  }

  get isSnarkjsReady(): boolean {
    return this._snarkjsReady;
  }

  isCircuitLoaded(circuit: CircuitName): boolean {
    return this.loadedCircuits.has(circuit);
  }

  get queueLength(): number {
    return this.queue.length + (this.isProcessing ? 1 : 0);
  }

  // -----------------------------------------------------------------------
  // Public API — wait for readiness
  // -----------------------------------------------------------------------

  /** Wait until the WebView DOM is ready */
  waitForWebView(): Promise<void> {
    if (this._webViewReady) return Promise.resolve();
    return this.waitWithTimeout(this.readyResolvers, READY_TIMEOUT_MS, 'WebView initialization timed out');
  }

  /** Wait until snarkjs is loaded inside the WebView */
  waitForSnarkjs(): Promise<void> {
    if (this._snarkjsReady) return Promise.resolve();
    return this.waitWithTimeout(this.snarkjsResolvers, READY_TIMEOUT_MS, 'snarkjs loading timed out');
  }

  /** Wait for both WebView and snarkjs to be ready */
  async waitForReady(): Promise<void> {
    await this.waitForWebView();
    await this.waitForSnarkjs();
  }

  // -----------------------------------------------------------------------
  // Public API — circuit loading
  // -----------------------------------------------------------------------

  /**
   * Load a circuit into the WebView by sending base64-encoded wasm + zkey.
   * Returns true if the circuit loaded successfully.
   */
  async loadCircuit(circuit: CircuitName, wasmBase64: string, zkeyBase64: string): Promise<boolean> {
    if (this.loadedCircuits.has(circuit)) return true;

    if (!this.handle?.isMounted()) {
      throw new Error('WebView not mounted — cannot load circuit');
    }

    // Ensure snarkjs is ready before loading
    await this.waitForSnarkjs();

    // Set up promise before sending message to avoid race
    const loadPromise = this.waitForCircuitLoad(circuit);

    this.handle.postMessage({
      type: 'loadCircuit',
      circuit,
      wasm: wasmBase64,
      zkey: zkeyBase64,
    });

    return loadPromise;
  }

  /**
   * Ask the WebView to load a circuit directly from APK assets.
   * Falls back gracefully — use loadCircuit() with base64 as a secondary strategy.
   */
  async loadCircuitFromAssets(circuit: CircuitName): Promise<boolean> {
    if (this.loadedCircuits.has(circuit)) return true;

    if (!this.handle?.isMounted()) {
      throw new Error('WebView not mounted — cannot load circuit from assets');
    }

    await this.waitForSnarkjs();

    const loadPromise = this.waitForCircuitLoad(circuit);

    this.handle.postMessage({
      type: 'loadFromAssets',
      circuit,
    });

    return loadPromise;
  }

  // -----------------------------------------------------------------------
  // Public API — proof generation
  // -----------------------------------------------------------------------

  /**
   * Generate a Groth16 proof using the WebView prover.
   *
   * This is the primary entry point. It:
   *   1. Waits for the WebView + snarkjs to be ready
   *   2. Ensures the requested circuit is loaded
   *   3. Enqueues the proof request (only one runs at a time)
   *   4. Returns { proof, publicSignals, durationMs }
   *
   * @param circuit  - Circuit name ('transfer', 'pool', etc.)
   * @param inputs   - Circuit inputs as string key-value pairs
   * @returns ProofResult with raw snarkjs proof format
   */
  async generateProof(circuit: CircuitName, inputs: Record<string, string>): Promise<ProofResult> {
    // Ensure everything is ready
    await this.waitForReady();

    if (!this.loadedCircuits.has(circuit)) {
      throw new Error(
        `Circuit "${circuit}" is not loaded. Call loadCircuit() or loadCircuitFromAssets() first.`,
      );
    }

    if (!this.handle?.isMounted()) {
      throw new Error('WebView not mounted');
    }

    const id = generateId();

    return new Promise<ProofResult>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        if (this.pendingProofs.has(id)) {
          this.pendingProofs.delete(id);
          this.isProcessing = false;
          this.processQueue();
          reject(new Error(`Proof generation timed out after ${PROOF_TIMEOUT_MS / 1000}s`));
        }
      }, PROOF_TIMEOUT_MS);

      const item: QueueItem = { id, circuit, inputs, resolve, reject, timeoutHandle };

      // Add to queue and kick off processing
      this.queue.push(item);
      this.processQueue();
    });
  }

  /**
   * Convenience: generate proof and convert to byte arrays for Solana.
   * Same as generateProof() but returns Groth16Proof with Uint8Array fields.
   */
  async generateProofBytes(circuit: CircuitName, inputs: Record<string, string>): Promise<{
    proof: Groth16Proof;
    publicSignals: string[];
  }> {
    const result = await this.generateProof(circuit, inputs);
    return {
      proof: convertSnarkjsProofToBytes(result.proof),
      publicSignals: result.publicSignals,
    };
  }

  // -----------------------------------------------------------------------
  // Queue processing
  // -----------------------------------------------------------------------

  private processQueue(): void {
    if (this.isProcessing || this.queue.length === 0) return;

    const item = this.queue.shift()!;
    this.isProcessing = true;
    this.pendingProofs.set(item.id, item);

    // Serialize inputs: arrays stay as JSON strings, scalars as plain strings
    const serialized: Record<string, string> = {};
    for (const [k, v] of Object.entries(item.inputs)) {
      serialized[k] = v;
    }

    this.handle?.postMessage({
      type: 'prove',
      id: item.id,
      circuit: item.circuit,
      inputs: serialized,
    });
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private flushResolvers(resolvers: Array<() => void>): void {
    const copy = resolvers.splice(0);
    for (const r of copy) r();
  }

  private flushCircuitResolvers(circuit: string, success: boolean): void {
    const resolvers = this.circuitResolvers.get(circuit);
    if (resolvers) {
      this.circuitResolvers.delete(circuit);
      for (const r of resolvers) r(success);
    }
  }

  private waitWithTimeout(resolvers: Array<() => void>, timeoutMs: number, errorMsg: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      resolvers.push(resolve);
      setTimeout(() => {
        // Remove this resolver if still pending
        const idx = resolvers.indexOf(resolve);
        if (idx !== -1) {
          resolvers.splice(idx, 1);
          reject(new Error(errorMsg));
        }
      }, timeoutMs);
    });
  }

  private waitForCircuitLoad(circuit: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (!this.circuitResolvers.has(circuit)) {
        this.circuitResolvers.set(circuit, []);
      }
      this.circuitResolvers.get(circuit)!.push(resolve);

      // Timeout — don't wait forever
      setTimeout(() => {
        const resolvers = this.circuitResolvers.get(circuit);
        if (resolvers) {
          const idx = resolvers.indexOf(resolve);
          if (idx !== -1) {
            resolvers.splice(idx, 1);
            resolve(false);
          }
        }
      }, CIRCUIT_LOAD_TIMEOUT_MS);
    });
  }
}

// -----------------------------------------------------------------------
// Utility: convert snarkjs proof to Solana byte arrays
// -----------------------------------------------------------------------

/**
 * Convert snarkjs proof (string arrays) to Uint8Array format.
 * Solana's alt_bn128 precompile expects BIG-ENDIAN encoding.
 */
export function convertSnarkjsProofToBytes(snarkjsProof: SnarkjsProof): Groth16Proof {
  const fieldToBytesBE = (value: bigint): Uint8Array => {
    const bytes = new Uint8Array(32);
    let temp = value;
    for (let i = 31; i >= 0; i--) {
      bytes[i] = Number(temp & BigInt(0xff));
      temp = temp >> BigInt(8);
    }
    return bytes;
  };

  // G1 point: [x, y] -> 64 bytes
  const pointToBytes = (point: string[]): Uint8Array => {
    const bytes = new Uint8Array(64);
    bytes.set(fieldToBytesBE(BigInt(point[0])), 0);
    bytes.set(fieldToBytesBE(BigInt(point[1])), 32);
    return bytes;
  };

  // G2 point: [[x0, x1], [y0, y1]] -> 128 bytes
  // alt_bn128 Fp2 stored as (c1, c0) order
  const point2ToBytes = (point: string[][]): Uint8Array => {
    const bytes = new Uint8Array(128);
    bytes.set(fieldToBytesBE(BigInt(point[0][1])), 0);   // x1
    bytes.set(fieldToBytesBE(BigInt(point[0][0])), 32);  // x0
    bytes.set(fieldToBytesBE(BigInt(point[1][1])), 64);  // y1
    bytes.set(fieldToBytesBE(BigInt(point[1][0])), 96);  // y0
    return bytes;
  };

  return {
    pi_a: pointToBytes(snarkjsProof.pi_a.slice(0, 2)),
    pi_b: point2ToBytes(snarkjsProof.pi_b.slice(0, 2)),
    pi_c: pointToBytes(snarkjsProof.pi_c.slice(0, 2)),
  };
}

// -----------------------------------------------------------------------
// Utility: generate unique ID
// -----------------------------------------------------------------------

function generateId(): string {
  return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// -----------------------------------------------------------------------
// Singleton export
// -----------------------------------------------------------------------

export const webviewProverService = new WebViewProverService();

/**
 * StarkProver — singleton that owns the STARK Web Worker.
 *
 * Browser-extension twin of `apps/mobile/providers/StarkProverProvider.tsx`.
 * The provider/context abstraction does not fit the extension cleanly because
 * the prover is used by non-React call sites (background service worker,
 * programmatic zk.ts flows), so we expose a plain singleton instead.
 *
 * Responsibilities:
 *  - Spawn the worker lazily on first use (keeps popup cold-start fast).
 *  - Track a `ready` promise so callers can `await starkProver.ready` before
 *    submitting proof requests.
 *  - Multiplex multiple proof requests onto the single worker via an id-keyed
 *    pending-request map, with a 60s timeout per request.
 *  - Mirror the mobile StarkProverProvider public API 1:1 so `zk.ts` can be
 *    refactored by swapping imports, not logic.
 */

import type { StarkWorkerOutMessage } from './starkProver.worker';

// ---------------------------------------------------------------------------
// Public types — mirrors StarkProverProvider
// ---------------------------------------------------------------------------

export interface StarkProofResult {
  commitment: string;
  proofHex: string;
  proofSize: number;
  durationMs: number;
}

export interface GenericStarkProofResult {
  circuitId: number;
  publicInputs: string[];
  proofHex: string;
  proofSize: number;
  durationMs: number;
}

interface PendingRequest {
  resolve: (msg: Extract<StarkWorkerOutMessage, { type: 'proof' }>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Re-armed on every worker message for this request, so only real silence
   *  — no ack, no progress, no result — ever trips the watchdog. */
  rearm: () => void;
}

/**
 * Silence watchdog for proof generation, the same pattern as
 * POOL_SILENCE_TIMEOUT_MS in lib/privacy/workerClient.ts: the timer re-arms on
 * every message the worker emits for a request, so it measures SILENCE, not
 * duration. The hard 60 s deadline it replaces killed live jobs on slow
 * machines while proving nothing about dead ones. The worker acks each request
 * before entering the (blocking, heartbeat-less) WASM call; proofs measure
 * 100-500 ms in this worker, so three minutes of true silence after that ack
 * is a wedged worker, not a slow proof. 180 s matches the proven pool value.
 */
export const PROVER_SILENCE_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

class StarkProverService {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<string, PendingRequest>();
  private counter = 0;

  private ensureWorker(): Promise<void> {
    if (this.ready) return this.ready;

    this.ready = new Promise<void>((resolve, reject) => {
      // Turbopack (Next 16), Vite (@crxjs) and Vitest all accept this
      // module-worker shape. The URL is relative to THIS file: in apps/web the
      // prover worker is a sibling in `lib/privacy/pool/` (the extension kept it
      // under `../workers/`), and a wrong specifier here fails only at runtime.
      const worker = new Worker(
        new URL('./starkProver.worker.ts', import.meta.url),
        { type: 'module' },
      );

      worker.onmessage = (event: MessageEvent<StarkWorkerOutMessage>) => {
        const msg = event.data;
        switch (msg.type) {
          case 'wasmLoaded':
            resolve();
            break;
          case 'wasmError':
            reject(new Error(msg.error));
            break;
          case 'proof': {
            const pending = this.pending.get(msg.id);
            if (pending) {
              clearTimeout(pending.timer);
              this.pending.delete(msg.id);
              pending.resolve(msg);
            }
            break;
          }
          case 'error': {
            const pending = this.pending.get(msg.id);
            if (pending) {
              clearTimeout(pending.timer);
              this.pending.delete(msg.id);
              pending.reject(new Error(msg.error));
            }
            break;
          }
          case 'progress':
            // Worker activity for this request — re-arm its silence watchdog.
            this.pending.get(msg.id)?.rearm();
            break;
          case 'log':
            console.log('[StarkProver/worker]', msg.message);
            break;
          case 'ready':
            // Worker script has loaded; WASM init still pending.
            break;
        }
      };

      worker.onerror = (err) => {
        reject(new Error(`STARK worker error: ${err.message}`));
      };

      this.worker = worker;
    });

    return this.ready;
  }

  /**
   * Eagerly spin up the worker. Safe to call multiple times — subsequent calls
   * return the same `ready` promise.
   */
  async start(): Promise<void> {
    return this.ensureWorker();
  }

  /**
   * Tear down the worker (tests / extension update). Subsequent `start()` will
   * spawn a fresh one.
   */
  shutdown(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.ready = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('STARK worker shutdown'));
    }
    this.pending.clear();
  }

  private async sendRequest(
    send: (id: string, worker: Worker) => void,
  ): Promise<Extract<StarkWorkerOutMessage, { type: 'proof' }>> {
    await this.ensureWorker();
    if (!this.worker) throw new Error('STARK worker not available');
    const worker = this.worker;

    return new Promise((resolve, reject) => {
      const id = `stark_${++this.counter}`;
      const fire = () => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(
            new Error(
              'STARK proof generation stalled: no worker activity for ' +
                `${PROVER_SILENCE_TIMEOUT_MS / 1000}s`,
            ),
          );
        }
      };
      const entry: PendingRequest = {
        resolve,
        reject,
        timer: setTimeout(fire, PROVER_SILENCE_TIMEOUT_MS),
        rearm: () => {
          clearTimeout(entry.timer);
          entry.timer = setTimeout(fire, PROVER_SILENCE_TIMEOUT_MS);
        },
      };
      this.pending.set(id, entry);
      send(id, worker);
    });
  }

  // -------------------------------------------------------------------------
  // Public proof API — mirrors StarkProverProvider
  // -------------------------------------------------------------------------

  async generateProof(subscriberSecret: string): Promise<StarkProofResult> {
    const msg = await this.sendRequest((id, worker) => {
      worker.postMessage({ type: 'generateProof', id, secret: subscriberSecret });
    });
    return {
      commitment: msg.commitment!,
      proofHex: msg.proofHex!,
      proofSize: msg.proofSize!,
      durationMs: msg.durationMs!,
    };
  }

  async computeCommitment(subscriberSecret: string): Promise<string> {
    const msg = await this.sendRequest((id, worker) => {
      worker.postMessage({ type: 'computeCommitment', id, secret: subscriberSecret });
    });
    return msg.commitment!;
  }

  async generatePoolCommitmentProof(
    np: string, secret: string, epoch: string, mint: string,
  ): Promise<GenericStarkProofResult> {
    const msg = await this.sendRequest((id, worker) => {
      worker.postMessage({ type: 'generatePoolProof', id, args: [np, secret, epoch, mint] });
    });
    return {
      circuitId: msg.circuitId ?? 1,
      publicInputs: msg.publicInputs ?? [],
      proofHex: msg.proofHex!,
      proofSize: msg.proofSize!,
      durationMs: msg.durationMs!,
    };
  }

  async generateBalanceProof(
    sk: string, balance: string, salt: string, mint: string,
  ): Promise<GenericStarkProofResult> {
    const msg = await this.sendRequest((id, worker) => {
      worker.postMessage({ type: 'generateBalanceProof', id, args: [sk, balance, salt, mint] });
    });
    return {
      circuitId: msg.circuitId ?? 2,
      publicInputs: msg.publicInputs ?? [],
      proofHex: msg.proofHex!,
      proofSize: msg.proofSize!,
      durationMs: msg.durationMs!,
    };
  }

  async generateConfidentialBalanceProof(
    spendingKey: string, oldBalance: string, oldSalt: string,
    newBalance: string, newSalt: string,
    amount: string, amountSalt: string, tokenMint: string,
  ): Promise<GenericStarkProofResult> {
    const msg = await this.sendRequest((id, worker) => {
      worker.postMessage({
        type: 'generateConfidentialBalanceProof', id,
        spendingKey, oldBalance, oldSalt, newBalance, newSalt,
        amount, amountSalt, tokenMint,
      });
    });
    return {
      circuitId: msg.circuitId ?? 4,
      publicInputs: msg.publicInputs ?? [],
      proofHex: msg.proofHex!,
      proofSize: msg.proofSize!,
      durationMs: msg.durationMs!,
    };
  }

  async generateTransferProof(
    spendingKey: string, tokenMint: string,
    inAmount1: string, inRand1: string,
    inAmount2: string, inRand2: string,
    outAmount1: string, outRand1: string, outRecipient1: string,
    outAmount2: string, outRand2: string, outRecipient2: string,
    publicAmount: string,
  ): Promise<GenericStarkProofResult> {
    const msg = await this.sendRequest((id, worker) => {
      worker.postMessage({
        type: 'generateTransferProof', id,
        spendingKey, tokenMint,
        inAmount1, inRand1, inAmount2, inRand2,
        outAmount1, outRand1, outRecipient1,
        outAmount2, outRand2, outRecipient2,
        publicAmount,
      });
    });
    return {
      circuitId: msg.circuitId ?? 5,
      publicInputs: msg.publicInputs ?? [],
      proofHex: msg.proofHex!,
      proofSize: msg.proofSize!,
      durationMs: msg.durationMs!,
    };
  }

  async generateMerkleUpdateProof(
    oldLeaf: string, newLeaf: string,
    pathElements: string[], pathIndices: number[],
  ): Promise<GenericStarkProofResult> {
    const msg = await this.sendRequest((id, worker) => {
      worker.postMessage({
        type: 'generateMerkleUpdateProof', id,
        oldLeaf, newLeaf, pathElements, pathIndices,
      });
    });
    return {
      circuitId: msg.circuitId ?? 6,
      publicInputs: msg.publicInputs ?? [],
      proofHex: msg.proofHex!,
      proofSize: msg.proofSize!,
      durationMs: msg.durationMs!,
    };
  }

  /** Circuit 3 (merkle_path) — proves `leaf` is at the position given by
   * pathElements/pathIndices, yielding the tree root. Used by unshield/transfer.
   * publicInputs layout: [leaf, root, depth]. depth is bound on-chain (=15). */
  async generateMerklePathProof(
    leaf: string,
    pathElements: string[], pathIndices: number[],
  ): Promise<GenericStarkProofResult> {
    const msg = await this.sendRequest((id, worker) => {
      worker.postMessage({
        type: 'generateMerklePathProof', id,
        leaf, pathElements, pathIndices,
      });
    });
    return {
      circuitId: msg.circuitId ?? 3,
      publicInputs: msg.publicInputs ?? [],
      proofHex: msg.proofHex!,
      proofSize: msg.proofSize!,
      durationMs: msg.durationMs!,
    };
  }
}

export const starkProver = new StarkProverService();

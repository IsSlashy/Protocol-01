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

import type { StarkWorkerOutMessage } from '../workers/starkProver.worker';

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
}

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
      // Vite (@crxjs) and Vitest both accept this module-worker shape.
      const worker = new Worker(
        new URL('../workers/starkProver.worker.ts', import.meta.url),
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
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('STARK proof generation timed out'));
        }
      }, 60_000);
      this.pending.set(id, { resolve, reject, timer });
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
  /**
   * [C7] Generate the spend proof.
   *
   * ⛔ `recipientHash` means the proof CANNOT be built without knowing who is
   * being paid. That is deliberate: sha256(recipient) is in the transcript, so
   * a proof made for A cannot be replayed to pay B. It is also why the
   * recipient has to be known at PREPARE time and not only at execution.
   */
  async generateSpendProof(
    nullifierPreimage: string,
    secret: string,
    blinding: string,
    tokenMint: string,
    pathElements: string[],
    pathIndices: number[],
    recipientHash: string[],
  ): Promise<GenericStarkProofResult> {
    const msg = await this.sendRequest((id, worker) => {
      worker.postMessage({
        type: 'generateSpendProof', id,
        nullifierPreimage, secret, blinding, tokenMint,
        pathElements, pathIndices, recipientHash,
      });
    });
    return {
      circuitId: msg.circuitId ?? 7,
      publicInputs: msg.publicInputs ?? [],
      proofHex: msg.proofHex!,
      proofSize: msg.proofSize!,
      durationMs: msg.durationMs!,
    };
  }
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

/// <reference lib="webworker" />
/**
 * Stealth worker entry — the ONLY place stealth secrets live in apps/web.
 *
 * Thin pipe around @protocol-01/pay-core's workerCore: Buffer polyfill for
 * @solana/web3.js, one `config` message wiring the RPC endpoint, then a
 * request/response envelope keyed by `id` so the main-thread client can
 * correlate concurrent calls. No crypto and no secret handling happen here.
 */
// FIRST import on purpose: installs the global Buffer before the pay-core /
// web3.js module graph evaluates (ESM hoisting would defeat an inline guard).
import './bufferPolyfill';

import { configureWorkerCore, handleWorkerRequest } from '@protocol-01/pay-core/worker/workerCore';
import type {
  SolanaWorkerConfig,
  WorkerRequest,
  WorkerResponse,
} from '@protocol-01/pay-core/worker/messages';
import {
  clearPoolState,
  configurePoolHandlers,
  handlePoolRequest,
  setPoolSeed,
  type PoolRequest,
  type PoolResponse,
} from './poolHandlers';

/** Main thread -> worker. */
export type StealthWorkerIn =
  | { id: number; type: 'config'; cfg: SolanaWorkerConfig }
  | { id: number; type: 'request'; req: WorkerRequest }
  | { id: number; type: 'pool'; req: PoolRequest };

/** Worker -> main thread. */
export type StealthWorkerOut =
  | { id: number; ok: true; res: WorkerResponse | PoolResponse | null }
  | { id: number; ok: false; error: string }
  /** Intermediate step of a long pool job; never terminal. */
  | { id: number; progress: string };

function post(msg: StealthWorkerOut): void {
  (self as unknown as Worker).postMessage(msg);
}

self.onmessage = async (e: MessageEvent<StealthWorkerIn>) => {
  const msg = e.data;
  try {
    if (msg.type === 'config') {
      configureWorkerCore(msg.cfg);
      configurePoolHandlers(msg.cfg.rpcUrl);
      post({ id: msg.id, ok: true, res: null });
      return;
    }

    if (msg.type === 'pool') {
      const res = await handlePoolRequest(msg.req, (step) => post({ id: msg.id, progress: step }));
      post({ id: msg.id, ok: true, res });
      return;
    }

    const res = await handleWorkerRequest(msg.req);

    // The pool's note secrets derive from the same wallet signature as the
    // stealth keys, so the seed is derived here, in the worker, at the moment
    // the signature arrives — it is never sent as a separate message and never
    // returns to the main thread.
    if (msg.req.kind === 'deriveMeta' && res.kind === 'deriveMeta') {
      setPoolSeed(res.identity.meta, msg.req.signature);
    }
    if (msg.req.kind === 'clearSessions') {
      clearPoolState();
    }

    post({ id: msg.id, ok: true, res });
  } catch (err) {
    post({ id: msg.id, ok: false, error: (err as Error).message || String(err) });
  }
};

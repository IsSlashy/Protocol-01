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

/** Main thread -> worker. */
export type StealthWorkerIn =
  | { id: number; type: 'config'; cfg: SolanaWorkerConfig }
  | { id: number; type: 'request'; req: WorkerRequest };

/** Worker -> main thread. */
export type StealthWorkerOut =
  | { id: number; ok: true; res: WorkerResponse | null }
  | { id: number; ok: false; error: string };

self.onmessage = async (e: MessageEvent<StealthWorkerIn>) => {
  const msg = e.data;
  try {
    if (msg.type === 'config') {
      configureWorkerCore(msg.cfg);
      (self as unknown as Worker).postMessage({ id: msg.id, ok: true, res: null } satisfies StealthWorkerOut);
      return;
    }
    const res = await handleWorkerRequest(msg.req);
    (self as unknown as Worker).postMessage({ id: msg.id, ok: true, res } satisfies StealthWorkerOut);
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id: msg.id,
      ok: false,
      error: (err as Error).message || String(err),
    } satisfies StealthWorkerOut);
  }
};

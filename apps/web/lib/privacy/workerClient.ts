/**
 * Main-thread bridge to the stealth Web Worker.
 *
 * `initStealthWorker(cfg)` boots the worker (idempotent), configures its RPC
 * connection and injects a postMessage-backed `SolanaWorkerClient` into the
 * pay-core Solana adapter — from then on every deriveMeta/scan/claim runs
 * inside the worker and secrets never touch the main thread.
 *
 * Failure model: if the worker crashes, all in-flight requests reject, the dead
 * instance is terminated, and the NEXT request boots a fresh worker with the
 * last known config (secret sessions are lost — the user just re-derives).
 * Every request also carries a timeout so a hung worker can never strand the
 * UI on an infinite spinner.
 */
import {
  setSolanaWorkerClient,
  type SolanaWorkerConfig,
  type WorkerRequest,
  type ResponseFor,
} from '@protocol-01/pay-core';
import type { StealthWorkerIn, StealthWorkerOut } from './worker/stealth.worker';

interface Pending {
  resolve: (res: never) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Claims submit + confirm a transaction from inside the worker — allow for slow devnet. */
const REQUEST_TIMEOUT_MS = 120_000;

let worker: Worker | null = null;
let lastCfg: SolanaWorkerConfig | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function failAll(error: Error): void {
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(error);
  }
  pending.clear();
}

function destroyWorker(reason: Error): void {
  worker?.terminate();
  worker = null;
  failAll(reason);
}

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./worker/stealth.worker.ts', import.meta.url), {
    type: 'module',
    name: 'p01-stealth',
  });
  worker.onmessage = (e: MessageEvent<StealthWorkerOut>) => {
    const out = e.data;
    const p = pending.get(out.id);
    if (!p) return;
    pending.delete(out.id);
    clearTimeout(p.timer);
    if (out.ok) (p.resolve as (res: unknown) => void)(out.res);
    else p.reject(new Error(out.error));
  };
  worker.onerror = (e) => {
    console.warn('[stealth] worker crashed:', e.message || e);
    destroyWorker(new Error(e.message || 'Stealth worker crashed. Please retry.'));
  };
  if (lastCfg) {
    void post({ type: 'config', cfg: lastCfg }).catch((err) => {
      console.warn('[stealth] worker config failed:', err);
    });
  }
  return worker;
}

function post<T>(msg: DistributiveOmit<StealthWorkerIn, 'id'>): Promise<T> {
  const w = ensureWorker();
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('The private-payment worker timed out. Please retry.'));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve: resolve as Pending['resolve'], reject, timer });
    w.postMessage({ ...msg, id } as StealthWorkerIn);
  });
}

/**
 * Boot the stealth worker and route the Solana adapter through it. Safe to call
 * on every render — the worker is created once (or recreated after a crash) and
 * later calls only reconfigure the RPC connection.
 */
export function initStealthWorker(cfg: SolanaWorkerConfig): void {
  if (typeof window === 'undefined') return;
  lastCfg = cfg;
  ensureWorker();

  setSolanaWorkerClient({
    request<R extends WorkerRequest>(req: R): Promise<ResponseFor<R>> {
      return post<ResponseFor<R>>({ type: 'request', req });
    },
  });

  void post({ type: 'config', cfg }).then(
    () => {
      if (process.env.NODE_ENV !== 'production') console.log('[stealth] worker configured');
    },
    (e) => console.warn('[stealth] worker config failed:', e),
  );
}

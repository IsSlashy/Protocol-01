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
import type { PoolRequest, PoolResponseFor } from './worker/poolHandlers';

interface Pending {
  resolve: (res: never) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Re-armed on every progress message so a long job never trips the timeout. */
  rearm?: () => void;
  onProgress?: (step: string) => void;
  /** Partial results of a long pool job (today: `poolScan`'s blinded pass).
   *  Each payload marks itself `complete: false`; the promise still resolves
   *  with the terminal, complete response. */
  onInterim?: (partial: never) => void;
}

/** Claims submit + confirm a transaction from inside the worker — allow for slow devnet. */
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * Pool jobs upload ~150 proof chunks and can legitimately run for minutes, so
 * they use a WATCHDOG instead of a deadline: the timer resets on every progress
 * message, and only real silence from the worker is treated as a hang.
 */
const POOL_SILENCE_TIMEOUT_MS = 180_000;

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
    if ('progress' in out) {
      p.onProgress?.(out.progress);
      p.rearm?.();
      return;
    }
    if ('interim' in out) {
      // A partial result is activity, so it re-arms the silence watchdog
      // exactly like a progress step. Never terminal: the entry stays pending.
      (p.onInterim as ((partial: unknown) => void) | undefined)?.(out.interim);
      p.rearm?.();
      return;
    }
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

function post<T>(
  msg: DistributiveOmit<StealthWorkerIn, 'id'>,
  opts: {
    timeoutMs?: number;
    onProgress?: (step: string) => void;
    onInterim?: (partial: never) => void;
  } = {},
): Promise<T> {
  const w = ensureWorker();
  const id = nextId++;
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  return new Promise<T>((resolve, reject) => {
    const fire = () => {
      pending.delete(id);
      reject(new Error('The private-payment worker timed out. Please retry.'));
    };
    const entry: Pending = {
      resolve: resolve as Pending['resolve'],
      reject,
      timer: setTimeout(fire, timeoutMs),
      onProgress: opts.onProgress,
      onInterim: opts.onInterim,
    };
    entry.rearm = () => {
      clearTimeout(entry.timer);
      entry.timer = setTimeout(fire, timeoutMs);
    };
    pending.set(id, entry);
    w.postMessage({ ...msg, id } as StealthWorkerIn);
  });
}

/**
 * Run a denominated-pool job in the worker. Long by nature (proof upload), so
 * it streams progress and uses a silence watchdog rather than a hard deadline.
 *
 * `onInterim` receives partial RESULTS where the job can honestly produce them
 * — today only `poolScan`, whose blinded pass paints tens of seconds before
 * the legacy epoch search finishes. Each payload marks itself incomplete; the
 * returned promise still resolves with the terminal, complete response.
 */
export function poolRequest<R extends PoolRequest>(
  req: R,
  onProgress?: (step: string) => void,
  onInterim?: (partial: PoolResponseFor<R>) => void,
): Promise<PoolResponseFor<R>> {
  return post<PoolResponseFor<R>>(
    { type: 'pool', req },
    {
      timeoutMs: POOL_SILENCE_TIMEOUT_MS,
      onProgress,
      onInterim: onInterim as ((partial: never) => void) | undefined,
    },
  );
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

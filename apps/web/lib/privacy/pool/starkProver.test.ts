/**
 * Silence-watchdog tests — starkProver.ts
 *
 * The old guard was a hard 60 s deadline: it killed live jobs on slow machines
 * and proved nothing about dead ones. The replacement is the silence watchdog
 * from lib/privacy/workerClient.ts — re-armed on every worker message for a
 * request, so only real silence trips it.
 *
 * POSITIVE CONTROL: "stays alive past 60 s while the worker emits progress" is
 * RED against the old implementation (which rejected at exactly 60 s no matter
 * what the worker said). If that test ever passes trivially, the watchdog has
 * been replaced by a deadline again.
 *
 * Environment: node (vitest.pool.config.mts). `Worker` is stubbed — no WASM,
 * no real thread; the tests drive the message protocol by hand.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { starkProver, PROVER_SILENCE_TIMEOUT_MS } from './starkProver';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((e: MessageEvent<unknown>) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  posted: Array<Record<string, unknown>> = [];
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- mirrors the real Worker(url, opts) signature
  constructor(..._args: unknown[]) {
    FakeWorker.instances.push(this);
  }
  postMessage(msg: Record<string, unknown>) {
    this.posted.push(msg);
  }
  terminate() {}
  emit(data: unknown) {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }
}

/** Boot the singleton against the stubbed Worker and ack WASM load. */
async function boot(): Promise<FakeWorker> {
  const ready = starkProver.start();
  const w = FakeWorker.instances.at(-1)!;
  w.emit({ type: 'wasmLoaded' });
  await ready;
  return w;
}

/** Issue a generateProof request and return its worker-side message. */
async function request(w: FakeWorker) {
  const state = { done: false, failed: false, value: undefined as unknown, error: undefined as unknown };
  starkProver.generateProof('12345').then(
    (v) => { state.done = true; state.value = v; },
    (e) => { state.done = true; state.failed = true; state.error = e; },
  );
  // Let sendRequest's `await ensureWorker()` resolve and post the message.
  await vi.advanceTimersByTimeAsync(0);
  const msg = w.posted.find((m) => m.type === 'generateProof') as { id: string };
  expect(msg).toBeDefined();
  return { state, id: msg.id };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
});

afterEach(() => {
  starkProver.shutdown();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('StarkProver silence watchdog', () => {
  it('rejects after the silence window when the worker never answers (the guard can go red)', async () => {
    const w = await boot();
    const { state } = await request(w);

    await vi.advanceTimersByTimeAsync(PROVER_SILENCE_TIMEOUT_MS - 1_000);
    expect(state.done).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(state.done).toBe(true);
    expect(state.failed).toBe(true);
    expect(String(state.error)).toMatch(/stalled: no worker activity/);
  });

  it('POSITIVE CONTROL: stays alive well past 60 s while the worker emits progress (RED on the old hard deadline)', async () => {
    const w = await boot();
    const { state, id } = await request(w);

    // 7 × 30 s = 210 s of wall time with activity every 30 s. The old
    // implementation rejected at 60 s regardless; the watchdog must not.
    for (let i = 0; i < 7; i++) {
      w.emit({ type: 'progress', id, step: 'proving' });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(state.done).toBe(false);
    }

    w.emit({ type: 'proof', id, commitment: '42', proofHex: 'abcd', proofSize: 2, durationMs: 7 });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.done).toBe(true);
    expect(state.failed).toBe(false);
    expect(state.value).toMatchObject({ commitment: '42', proofHex: 'abcd' });
  });

  it('re-arms on the ack, then still fires on true silence after it', async () => {
    const w = await boot();
    const { state, id } = await request(w);

    // 100 s in, the worker acks — silence restarts from here.
    await vi.advanceTimersByTimeAsync(100_000);
    w.emit({ type: 'progress', id, step: 'generateProof started' });

    await vi.advanceTimersByTimeAsync(PROVER_SILENCE_TIMEOUT_MS - 5_000);
    expect(state.done).toBe(false);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.done).toBe(true);
    expect(state.failed).toBe(true);
    expect(String(state.error)).toMatch(/stalled/);
  });

  it('propagates worker errors immediately, without waiting out the watchdog', async () => {
    const w = await boot();
    const { state, id } = await request(w);

    w.emit({ type: 'error', id, error: 'proof rejected' });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.done).toBe(true);
    expect(state.failed).toBe(true);
    expect(String(state.error)).toMatch(/proof rejected/);
  });
});

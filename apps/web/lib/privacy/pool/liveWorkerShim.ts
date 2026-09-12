/**
 * The in-process Worker the live devnet harnesses need, in ONE place.
 *
 * ⛔ EXTRACTED 2026-08-27, NOT COPIED. It was written for the v4 withdrawal
 * harness and the v4 subscribe harness needs exactly the same thing. A second
 * copy would drift, and this shim has already cost one live run: see the note
 * on `crypto` below, which is the kind of detail a copy loses first.
 *
 * ⚠️ Not named *.test.ts on purpose — it must not be collected as a suite.
 */
/**
 * `Worker` does not exist in Node, and `starkProver` needs one.
 *
 * ⛔ NOT A STUBBED PROVER. A fake proof would make this harness worthless: the
 * transaction would be refused on chain and the failure would read as a v4 bug.
 * This runs the REAL `starkProver.worker` module in-process over the same WASM
 * bytes, by giving it the two browser globals it uses. Only the thread boundary
 * is removed.
 */
class InProcessStarkWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  private inbox: unknown[] = [];
  private shim: {
    onmessage: ((e: { data: unknown }) => void) | null;
    postMessage: (m: unknown) => void;
    crypto: Crypto;
  };

  constructor() {
    const outer = this;
    this.shim = {
      onmessage: null,
      postMessage(m: unknown) { outer.onmessage?.({ data: m }); },
      // 🚨 `crypto` IS NOT OPTIONAL HERE, and leaving it out cost a live run.
      //
      // In a real Web Worker `self` IS the global, so `self.crypto` is the Web
      // Crypto API. This shim REPLACES `self` with a bare two-property object,
      // and the wasm-bindgen glue resolves the CSPRNG through `self.crypto`.
      // Circuit 7 draws a 1,280-element mask from it and REFUSES to build
      // without one, so the run died with:
      //
      //   Circuit 7 prover refused: no CSPRNG available, refusing to build a
      //   C7 proof: Web Crypto API is unavailable
      //
      // The prover was right and the harness was wrong. Nothing caught it
      // earlier because the existing shield harness only proves C6, which needs
      // no randomness at all — the impoverished `self` was invisible until a
      // masked circuit ran through it.
      crypto: globalThis.crypto,
    };
    (globalThis as unknown as { self: unknown }).self = this.shim;
    void import('./starkProver.worker').then(() => {
      for (const m of this.inbox) this.shim.onmessage?.({ data: m });
      this.inbox = [];
    });
  }

  postMessage(m: unknown) {
    if (this.shim.onmessage) this.shim.onmessage({ data: m });
    else this.inbox.push(m);
  }

  terminate() {}
}

if (typeof (globalThis as unknown as { Worker?: unknown }).Worker === 'undefined') {
  (globalThis as unknown as { Worker: unknown }).Worker = InProcessStarkWorker;
}

/**
 * [HISTORY-CACHE] Persist the pool-history cache to a JSON file across live
 * runs when `P01_LIVE_HISTORY_CACHE` names one, so a SECOND run measures the
 * incremental walk. Off by default: a first run must measure the cold walk.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { setPoolHistoryStore, type PoolHistorySnapshot } from './poolHistoryCache';

const historyFile = process.env.P01_LIVE_HISTORY_CACHE;
if (historyFile) {
  const readAll = (): Record<string, PoolHistorySnapshot> =>
    existsSync(historyFile) ? (JSON.parse(readFileSync(historyFile, 'utf8')) as Record<string, PoolHistorySnapshot>) : {};
  setPoolHistoryStore({
    async load(key) {
      return readAll()[key] ?? null;
    },
    async save(snapshot) {
      const all = readAll();
      all[snapshot.key] = snapshot;
      writeFileSync(historyFile, JSON.stringify(all));
    },
    async clear(key) {
      const all = readAll();
      delete all[key];
      writeFileSync(historyFile, JSON.stringify(all));
    },
  });
}

/**
 * [BENCH] Prefix every console line with the seconds since the harness loaded
 * when `P01_LIVE_TIMESTAMPS=1`, so a live log can be read as a timeline.
 */
if (process.env.P01_LIVE_TIMESTAMPS === '1') {
  const t0 = Date.now();
  const orig = console.log.bind(console);
  console.log = (...a: unknown[]) => orig(`[+${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
}

/**
 * pacedFetch — a rate-limited `fetch` for the pool's Connection.
 *
 * A single shield uploads a ~140 KB STARK proof as ~150 one-kilobyte chunk
 * transactions, plus buffer init/resize/verify and status polling. Fired at
 * full speed from a browser, public devnet RPC answers most of that with 429
 * and the upload dies half-finished — observed 2026-07-24, with the ephemeral's
 * float left to be swept back.
 *
 * Rather than pace each call site (which would mean editing the extracted,
 * byte-faithful proof code), we serialize and space requests at the transport.
 * Every RPC call the pool makes goes through here, so throughput is bounded
 * regardless of which code path is running.
 *
 * Two 429 dialects are handled: a real HTTP 429, and the Helius devnet quirk
 * where the body is HTTP 200 carrying a JSON-RPC error with code -32429.
 *
 * [shield-speed D 2026-09-23] TWO FLOORS, ONE LANE. MEASURED 2026-09-22
 * (shield-speed MEASURE.md, rpc.jsonl): every gap between two paced requests
 * was 120-139 ms; the sends got 24/46 and 21/43 HTTP 429s while the paced
 * reads got 0 of about 95. The provider throttles sends, not these reads, so a
 * short allow-list of plain reads waits 25 ms after the previous request and
 * everything else keeps 120 ms. Still ONE request in flight, in submission
 * order, with the same retry ladder: the pinned request logs (RPC-1,
 * RECOVER-1) stay byte-identical, only the idle time before a read shrinks.
 *
 * The method peek FAILS CLOSED: a batch, a body that is not a JSON string, a
 * Request object, an unknown method or a history walk (whose sustained rate
 * this does not change) all keep 120 ms. The peek reads `method` and nothing
 * else; the body is never logged or kept (it names accounts).
 *
 * What it opens, written down rather than assumed (privacy skeptic D 1): the
 * gap between a response and the next read now follows the client's own
 * compute time between 25 and 120 ms instead of hiding it behind the floor.
 * Nothing that runs in that range depends on a secret (proving takes minutes;
 * the nullifier checks run locally after a full-set read).
 */

/** Minimum gap between two RPC requests. ~8 requests/second. */
const MIN_INTERVAL_MS = 120;

/** Minimum gap before a request on the read allow-list. */
const READ_INTERVAL_MS = 25;

/**
 * The reads the shield path makes that measured 0 throttling behind the pacer.
 * History walks (`getSignaturesForAddress`, `getTransaction`) and scans are NOT
 * here: an import or Recover walk issues them back to back for minutes, and
 * their sustained rate was never measured at 25 ms (correctness skeptic D,
 * remaining risk 1).
 */
const FAST_READ_METHODS: ReadonlySet<string> = new Set([
  'getAccountInfo',
  'getBalance',
  'getBlockHeight',
  'getLatestBlockhash',
  'getMinimumBalanceForRentExemption',
  'getSignatureStatuses',
]);

/** Attempts per request before giving up (exponential backoff between). */
const MAX_ATTEMPTS = 6;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The floor before this request: the read floor only for a plain JSON-RPC call
 * whose method is on the allow-list, the full floor for anything else.
 */
function isFastRead(input: RequestInfo | URL, init?: RequestInit): boolean {
  if (typeof Request !== 'undefined' && input instanceof Request) return false;
  const body = init?.body;
  if (typeof body !== 'string') return false;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const method = (parsed as { method?: unknown }).method;
    return typeof method === 'string' && FAST_READ_METHODS.has(method);
  } catch {
    return false;
  }
}

export function createPacedFetch(minIntervalMs = MIN_INTERVAL_MS): typeof fetch {
  // Requests queue on this chain, so at most one is in flight. Each waits the
  // floor of ITS OWN class, counted from the moment the previous request (its
  // retries included) finished.
  let chain: Promise<unknown> = Promise.resolve();
  let lastEnd = Number.NEGATIVE_INFINITY;
  const readInterval = Math.min(READ_INTERVAL_MS, minIntervalMs);

  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const gap = isFastRead(input, init) ? readInterval : minIntervalMs;

    const run = async (): Promise<Response> => {
      const wait = lastEnd + gap - Date.now();
      if (wait > 0) await sleep(wait);
      let lastError: unknown;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (attempt > 0) await sleep(300 * 2 ** (attempt - 1));
        try {
          const res = await fetch(input, init);
          if (res.status === 429) {
            lastError = new Error('RPC rate limit (429)');
            continue;
          }
          // Helius devnet answers 200 with a JSON-RPC -32429. Peek at the body
          // via a clone so the original stays readable by the caller.
          if (res.ok) {
            try {
              const peek = await res.clone().json();
              const code = peek?.error?.code;
              if (code === -32429 || code === 429) {
                lastError = new Error('RPC rate limit (JSON-RPC 429)');
                continue;
              }
            } catch {
              // Not JSON, or already consumed — nothing to inspect.
            }
          }
          return res;
        } catch (err) {
          lastError = err;
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new Error('RPC request failed after retries');
    };

    const timed = async (): Promise<Response> => {
      try {
        return await run();
      } finally {
        // Space the NEXT request regardless of how this one ended.
        lastEnd = Date.now();
      }
    };

    const result = chain.then(timed, timed);
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }) as typeof fetch;
}

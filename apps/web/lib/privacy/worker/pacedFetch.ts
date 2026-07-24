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
 */

/** Minimum gap between two RPC requests. ~8 requests/second. */
const MIN_INTERVAL_MS = 120;

/** Attempts per request before giving up (exponential backoff between). */
const MAX_ATTEMPTS = 6;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createPacedFetch(minIntervalMs = MIN_INTERVAL_MS): typeof fetch {
  // Requests queue on this chain, so at most one is in flight and each waits
  // `minIntervalMs` after the previous finishes.
  let chain: Promise<unknown> = Promise.resolve();

  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const run = async (): Promise<Response> => {
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

    const result = chain.then(run, run);
    // Space the NEXT request regardless of how this one ended.
    chain = result.then(
      () => sleep(minIntervalMs),
      () => sleep(minIntervalMs),
    );
    return result;
  }) as typeof fetch;
}

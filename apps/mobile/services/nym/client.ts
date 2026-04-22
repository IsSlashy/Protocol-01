/**
 * Nym mixnet — mobile client (MVP scaffolding).
 *
 * The Nym TypeScript SDK (`@nymproject/mix-fetch-full-fat`) is browser-only:
 * it depends on WebSockets + a WASM Web Worker and does not run natively in
 * React Native. On mobile we plan to wrap it inside a hidden WebView (same
 * pattern as `services/stark/StarkProver.tsx`). That implementation is
 * tracked in `./WebViewPlan.md` and is NOT live yet.
 *
 * In the meantime this module:
 *   - Exposes the exact same API surface we intend to ship (so call sites
 *     can already be written against it).
 *   - Reports `state: 'unsupported'` and `strategy: 'none'`.
 *   - Always falls back to the global `fetch` for `nymFetch`, returning
 *     `viaMixnet: false`. Callers can use this flag to warn users.
 *
 * Do NOT claim privacy you don't have — UX surfaces should read the
 * metadata and degrade honestly.
 */

import type {
  NymFetchOptions,
  NymFetchResult,
  NymMetadata,
  NymStateListener,
} from './types';

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const DEFAULT_METADATA: NymMetadata = {
  state: 'unsupported',
  strategy: 'none',
};

let metadata: NymMetadata = { ...DEFAULT_METADATA };
const listeners = new Set<NymStateListener>();

function setMetadata(next: Partial<NymMetadata>): void {
  metadata = { ...metadata, ...next };
  for (const listener of listeners) {
    try {
      listener(metadata);
    } catch (err: unknown) {
      // Listeners must not throw — swallow so one bad subscriber does not
      // break the others.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[nym] state listener threw:', msg);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Snapshot of the current Nym client metadata. */
export function getNymState(): NymMetadata {
  return metadata;
}

/**
 * Subscribe to Nym state transitions. Returns an unsubscribe function.
 * The listener is NOT invoked synchronously on subscription — call
 * `getNymState()` if you need an initial value.
 */
export function onNymStateChange(listener: NymStateListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Attempt to initialize the Nym client.
 *
 * Current MVP: there is no on-device Nym transport, so this rejects after
 * transitioning through `initializing` -> `error`. The function is still
 * defensively coded so a future WebView-backed implementation can swap
 * this body out without changing callers.
 */
export async function initNym(): Promise<NymMetadata> {
  if (metadata.state === 'initializing') {
    return metadata;
  }

  setMetadata({ state: 'initializing', error: undefined });

  console.warn(
    '[nym] Nym on mobile requires WebView WASM wrapper — not yet implemented. Falling back to plain fetch.',
  );

  const errorMessage =
    'Nym WebView mixnet not yet available on mobile — see Phase 2 roadmap.';

  setMetadata({
    state: 'unsupported',
    strategy: 'none',
    error: errorMessage,
  });

  throw new Error(errorMessage);
}

/**
 * Issue an HTTP request that WOULD go through the Nym mixnet once the
 * WebView transport lands. For now this unconditionally falls back to
 * the platform `fetch` and reports `viaMixnet: false`.
 */
export async function nymFetch<T = unknown>(
  url: string,
  options: NymFetchOptions = {},
): Promise<NymFetchResult<T>> {
  const {
    method = 'GET',
    headers = {},
    body,
    signal,
    parseJson = true,
  } = options;

  const startedAt = Date.now();

  const response = await fetch(url, {
    method,
    headers,
    body,
    signal,
  });

  const rawBody = await response.text();

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  let data: unknown = rawBody;
  if (parseJson) {
    const contentType = responseHeaders['content-type'] ?? '';
    if (contentType.includes('application/json') && rawBody.length > 0) {
      try {
        data = JSON.parse(rawBody);
      } catch {
        // Leave as raw string if JSON parsing fails.
        data = rawBody;
      }
    }
  }

  return {
    status: response.status,
    headers: responseHeaders,
    data: data as T,
    rawBody,
    viaMixnet: false,
    latencyMs: Date.now() - startedAt,
    strategy: 'none',
  };
}

/**
 * Reset the client back to its default `unsupported` state.
 * Useful for tests and for the future WebView implementation which will
 * need to tear down its WebView on backgrounding.
 */
export function resetNym(): void {
  metadata = { ...DEFAULT_METADATA };
  for (const listener of listeners) {
    try {
      listener(metadata);
    } catch {
      // Intentionally ignored — see setMetadata.
    }
  }
}

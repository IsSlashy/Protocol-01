/**
 * Nym mixnet client wrapper — Layer 0 of the Mugen privacy stack.
 *
 * Uses @nymproject/mix-fetch-full-fat, which inlines the WASM workers so the
 * package works out-of-the-box with Next.js 16 / Turbopack without extra
 * webpack or turbopack WASM loader configuration.
 *
 * NOTES ON BUNDLING:
 * - The "-full-fat" variant is several MB. We dynamic-import it lazily the first
 *   time `initNym` or `nymFetch` is called, so the bundle isn't pulled into the
 *   initial page load.
 * - If Turbopack ever fails to resolve the package's inlined workers, the
 *   fallback plan is to switch to `@nymproject/mix-fetch-node-tester` or to
 *   configure Turbopack's `experimental.turbo.rules` for `.wasm?worker`. As of
 *   Next.js 16.1, the full-fat variant works without additional config.
 *
 * BROWSER ONLY:
 * - All mixnet-sensitive code lives inside functions and checks for `window`.
 *   Calling any API during SSR is a no-op / throws with a clear message.
 */

export type NymInitState = 'uninitialized' | 'initializing' | 'ready' | 'error';

export interface NymMetadata {
  state: NymInitState;
  entryGatewayId?: string;
  error?: string;
}

export interface NymFetchResult<T = unknown> {
  response: Response;
  data: T;
  viaMixnet: boolean;
  latencyMs: number;
  hops: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// State management
// ─────────────────────────────────────────────────────────────────────────────

const NYM_EXPECTED_HOPS = 5;
const INIT_TIMEOUT_MS = 60_000;

let metadata: NymMetadata = { state: 'uninitialized' };
const listeners = new Set<(meta: NymMetadata) => void>();

function setMetadata(patch: Partial<NymMetadata>): void {
  metadata = { ...metadata, ...patch };
  for (const l of listeners) {
    try {
      l(metadata);
    } catch {
      /* ignore listener errors */
    }
  }
}

export function onNymStateChange(listener: (meta: NymMetadata) => void): () => void {
  listeners.add(listener);
  // Fire immediately so subscribers get the current state.
  try {
    listener(metadata);
  } catch {
    /* ignore */
  }
  return () => {
    listeners.delete(listener);
  };
}

export function getNymState(): NymMetadata {
  return metadata;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic import handles
// ─────────────────────────────────────────────────────────────────────────────

interface MixFetchOptions {
  mixFetchOverride?: {
    preferredGateway?: string;
    preferredNetworkRequester?: string;
  };
}

interface MixFetchModule {
  mixFetch: (url: string, options?: RequestInit) => Promise<Response>;
  disconnectMixFetch?: () => Promise<void>;
  setupMixFetch?: (opts?: MixFetchOptions) => Promise<void>;
}

let modulePromise: Promise<MixFetchModule> | null = null;
let initPromise: Promise<string> | null = null;

async function loadModule(): Promise<MixFetchModule> {
  if (typeof window === 'undefined') {
    throw new Error('Nym mixnet is browser-only — cannot load during SSR.');
  }
  if (!modulePromise) {
    modulePromise = import('@nymproject/mix-fetch-full-fat') as unknown as Promise<MixFetchModule>;
  }
  return modulePromise;
}

// ─────────────────────────────────────────────────────────────────────────────
// Initialization
// ─────────────────────────────────────────────────────────────────────────────

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export async function initNym(): Promise<string> {
  if (typeof window === 'undefined') {
    throw new Error('Nym mixnet is browser-only — cannot initialize during SSR.');
  }
  if (metadata.state === 'ready' && metadata.entryGatewayId) {
    return metadata.entryGatewayId;
  }
  if (initPromise) {
    return initPromise;
  }

  setMetadata({ state: 'initializing', error: undefined });

  initPromise = (async () => {
    try {
      const mod = await loadModule();
      // Some versions of mix-fetch expose an explicit `setupMixFetch`. If it
      // doesn't, the first call to `mixFetch` performs lazy bootstrapping —
      // either path is fine.
      if (typeof mod.setupMixFetch === 'function') {
        await withTimeout(mod.setupMixFetch(), INIT_TIMEOUT_MS, 'Nym setupMixFetch');
      }
      // The SDK does not publicly expose the chosen entry gateway in a stable
      // field, so we report a synthetic identifier. When upstream adds a stable
      // accessor, swap this for the real pubkey.
      const entryGatewayId = deriveEntryGatewayId();
      setMetadata({ state: 'ready', entryGatewayId, error: undefined });
      return entryGatewayId;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setMetadata({ state: 'error', error: message });
      // Reset so a later call can retry.
      initPromise = null;
      throw err;
    }
  })();

  return initPromise;
}

function deriveEntryGatewayId(): string {
  // Synthetic 8-byte identifier; the real SDK picks a gateway from the
  // validator API, but the pubkey is not exposed yet.
  const bytes = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  }
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch
// ─────────────────────────────────────────────────────────────────────────────

async function parseResponse<T>(res: Response): Promise<T> {
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return (await res.json()) as T;
  }
  const text = await res.text();
  // Try opportunistic JSON parse.
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

export async function nymFetch<T = unknown>(
  url: string,
  options?: RequestInit & { disableFallback?: boolean },
): Promise<NymFetchResult<T>> {
  const { disableFallback, ...init } = options ?? {};

  if (typeof window === 'undefined') {
    if (disableFallback) {
      throw new Error('Nym mixnet is browser-only and fallback is disabled.');
    }
    // Server-side: no mixnet, just straight fetch.
    const start = Date.now();
    const response = await fetch(url, init);
    const clone = response.clone();
    const data = await parseResponse<T>(clone);
    return {
      response,
      data,
      viaMixnet: false,
      latencyMs: Date.now() - start,
      hops: 0,
    };
  }

  // Try mixnet first.
  try {
    await initNym();
    const mod = await loadModule();
    const start = Date.now();
    const response = await mod.mixFetch(url, init);
    const latencyMs = Date.now() - start;
    const clone = response.clone();
    const data = await parseResponse<T>(clone);
    return {
      response,
      data,
      viaMixnet: true,
      latencyMs,
      hops: NYM_EXPECTED_HOPS,
    };
  } catch (err: unknown) {
    if (disableFallback) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    // Fallback — plain fetch.
    const start = Date.now();
    const response = await fetch(url, init);
    const clone = response.clone();
    const data = await parseResponse<T>(clone);
    return {
      response,
      data,
      viaMixnet: false,
      latencyMs: Date.now() - start,
      hops: 0,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shutdown
// ─────────────────────────────────────────────────────────────────────────────

export async function resetNym(): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    if (modulePromise) {
      const mod = await modulePromise;
      if (typeof mod.disconnectMixFetch === 'function') {
        await mod.disconnectMixFetch();
      }
    }
  } catch {
    /* ignore shutdown errors */
  } finally {
    modulePromise = null;
    initPromise = null;
    setMetadata({ state: 'uninitialized', entryGatewayId: undefined, error: undefined });
  }
}

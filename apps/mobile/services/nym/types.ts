/**
 * Nym mixnet — mobile types.
 *
 * Mirrors the shape the removed P2P exchange web app used, so future call sites can share
 * expectations across platforms. On mobile, the current MVP keeps the client
 * in `unsupported` state and always falls back to plain fetch.
 *
 * See `./WebViewPlan.md` for the Phase 2 implementation plan.
 */

/** Lifecycle state of the Nym client. */
export type NymInitState =
  | 'uninitialized'
  | 'initializing'
  | 'ready'
  | 'error'
  | 'unsupported';

/** Strategy used to ferry an HTTP request. */
export type NymStrategy = 'webview-wasm' | 'relay-proxy' | 'none';

/** Metadata describing the current Nym client status. */
export interface NymMetadata {
  state: NymInitState;
  /** Identity of the entry gateway we're connected to, if known. */
  entryGatewayId?: string;
  /** Last initialization / runtime error, if any. */
  error?: string;
  /** Transport strategy currently in use. */
  strategy: NymStrategy;
}

/** Listener for NymMetadata changes. */
export type NymStateListener = (meta: NymMetadata) => void;

/** Subset of the Fetch API options we actually need on the mobile path. */
export interface NymFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Abort signal forwarded to the underlying fetch when available. */
  signal?: AbortSignal;
  /** When true (default), parse the response body as JSON if the content-type allows. */
  parseJson?: boolean;
}

/**
 * Result of a `nymFetch` call.
 * Callers should branch on `viaMixnet` / `strategy` to surface privacy state
 * to users — be honest: on mobile today this is always `false` / `'none'`.
 */
export interface NymFetchResult<T = unknown> {
  status: number;
  headers: Record<string, string>;
  data: T;
  rawBody: string;
  viaMixnet: boolean;
  latencyMs: number;
  strategy: NymStrategy;
}

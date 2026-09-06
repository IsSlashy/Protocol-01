/**
 * poolLeavesClient — the fast path for `fetchPoolLeavesByIndex`.
 *
 * One HTTP GET to the leaf indexer (`/api/pool-leaves/[pool]`, served by
 * apps/web) returns the pool's dense leaf array; the RPC scan it replaces did
 * one `getTransaction` per pool signature at 120 ms each.
 *
 * ── TRUST MODEL ─────────────────────────────────────────────────────────────
 * Nothing here is trusted. The caller rebuilds the Merkle path from these
 * leaves and checks the rebuilt root against the pool's own on-chain root ring
 * BEFORE any proof rent is spent (`prepareUnshieldV4`, `prepareSubscribeV4`,
 * `prepareUnshield`). A lying, stale, or hostile indexer can therefore only
 * produce a refused spend — never a wrong path that verifies, and never a
 * stolen note. It also learns nothing about WHICH leaf is being spent: the
 * request names the pool, not the note.
 *
 * ── FAILURE = null ──────────────────────────────────────────────────────────
 * Every failure mode (unreachable, non-2xx, malformed JSON, timeout, a leaf
 * that is not a decimal u64, an array shorter than the caller needs) returns
 * `null`, and the caller falls back to the RPC scan unchanged. The indexer is
 * an accelerator, not a dependency.
 *
 * This file is copied verbatim on the extension and mobile surfaces (their own
 * `poolLeavesClient.ts`); only `resolvePoolLeavesBaseUrl` differs per surface.
 */

export interface IndexerLeaves {
  leavesByIndex: bigint[];
  scannedLeafCount: number;
  missing: number[];
  source: 'indexer';
  /** Server-side timestamp (ms) of the snapshot that answered. */
  updatedAt: number;
}

export interface FetchIndexerOptions {
  /** Base URL of the route, WITHOUT the trailing `/<pool>`. */
  baseUrl: string;
  /** Per-request abort timeout. Default 4 000 ms. */
  timeoutMs?: number;
  /** Ask the server to re-read the chain before answering. */
  fresh?: boolean;
  /**
   * The answer must hold at least this many leaves (the caller's
   * `leafIndex + 1`). Shorter ⇒ one forced refresh, then `null`.
   */
  minLeafCount?: number;
  /** Leaves per page. Default 65 536 (≈1.4 MB of JSON). */
  pageSize?: number;
  /** Injectable for tests. Default `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

/** The wire shape `/api/pool-leaves/[pool]` answers with. */
export interface PoolLeavesResponse {
  pool: string;
  leafCount: number;
  from: number;
  leaves: string[];
  lastSignature: string | null;
  updatedAt: number;
  source: string;
}

const DEFAULT_TIMEOUT_MS = 4_000;
const DEFAULT_PAGE_SIZE = 65_536;
const DECIMAL_U64 = /^(0|[1-9][0-9]{0,19})$/;

/**
 * Where the indexer lives for THIS surface.
 *
 * - `NEXT_PUBLIC_P01_POOL_LEAVES_URL` wins when set (a full base URL).
 * - Otherwise same-origin `/api/pool-leaves` (works from the page and from the
 *   pool worker, whose `location.origin` is the page's).
 * - `null` under vitest unless the env var is set, so unit tests never reach
 *   for a network they do not have; and `null` when no origin is known (Node).
 */
export function resolvePoolLeavesBaseUrl(): string | null {
  const explicit = process.env.NEXT_PUBLIC_P01_POOL_LEAVES_URL;
  if (explicit) return explicit.replace(/\/$/, '');
  if (process.env.VITEST) return null;
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
  if (!origin || !/^https?:/.test(origin)) return null;
  return `${origin}/api/pool-leaves`;
}

async function getJson(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<PoolLeavesResponse | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    if (!body || typeof body !== 'object') return null;
    const r = body as Partial<PoolLeavesResponse>;
    if (
      typeof r.leafCount !== 'number' || !Number.isInteger(r.leafCount) || r.leafCount < 0 ||
      typeof r.from !== 'number' || !Array.isArray(r.leaves) ||
      typeof r.updatedAt !== 'number'
    ) {
      return null;
    }
    return r as PoolLeavesResponse;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the dense leaf array for `pool` from the indexer, paging as needed.
 * Returns `null` on ANY failure so the caller can fall back to the RPC scan.
 */
export async function fetchLeavesFromIndexer(
  pool: string,
  opts: FetchIndexerOptions,
): Promise<IndexerLeaves | null> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return null;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const base = opts.baseUrl.replace(/\/$/, '');

  const attempt = async (fresh: boolean): Promise<IndexerLeaves | null> => {
    const leaves: bigint[] = [];
    let leafCount = -1;
    let updatedAt = 0;
    let from = 0;
    // First page carries the refresh flag; later pages read what it wrote.
    for (let page = 0; ; page++) {
      const q = `from=${from}&limit=${pageSize}${fresh && page === 0 ? '&refresh=1' : ''}`;
      const r = await getJson(`${base}/${encodeURIComponent(pool)}?${q}`, timeoutMs, fetchImpl);
      if (!r) return null;
      if (r.from !== from) return null;
      if (page === 0) {
        leafCount = r.leafCount;
        updatedAt = r.updatedAt;
      } else if (r.leafCount < leafCount) {
        // The array shrank between pages: a snapshot changed underneath us.
        return null;
      }
      for (const s of r.leaves) {
        if (typeof s !== 'string' || !DECIMAL_U64.test(s)) return null;
        leaves.push(BigInt(s));
      }
      from = leaves.length;
      if (from >= leafCount) break;
      if (r.leaves.length === 0) return null; // no progress: refuse to spin
      if (page > 64) return null; // 64 × 65 536 > any depth this program walks
    }
    if (leaves.length !== leafCount) return null;
    const missing: number[] = [];
    for (let i = 0; i < leaves.length; i++) if (leaves[i] === 0n) missing.push(i);
    return { leavesByIndex: leaves, scannedLeafCount: leaves.length, missing, source: 'indexer', updatedAt };
  };

  let out = await attempt(opts.fresh === true);
  if (out && opts.minLeafCount !== undefined && out.scannedLeafCount < opts.minLeafCount) {
    // Behind the chain for the leaf we need: one forced re-read, then give up
    // to the scan. The scan reads the RPC directly and cannot be behind it.
    out = opts.fresh ? null : await attempt(true);
    if (out && out.scannedLeafCount < opts.minLeafCount) out = null;
  }
  return out;
}

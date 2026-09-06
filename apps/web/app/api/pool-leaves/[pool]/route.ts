/**
 * GET /api/pool-leaves/[pool]?from=0&limit=65536[&refresh=1]
 * POST /api/pool-leaves/[pool]            (force a refresh, e.g. from a webhook)
 *
 * The leaf indexer. Answers a pool's dense array of leaf commitments — index →
 * decimal u64 string, "0" for a gap — so a spend or subscribe rebuilds its
 * Merkle path from ONE request instead of one `getTransaction` per pool
 * signature (see `docs/PERF-AND-CAPACITY-PLAN-2026-09-06.md`, levier L4).
 *
 * What this route is NOT: an oracle. Every client pre-flights the rebuilt
 * root against the pool's on-chain root ring before spending proof rent; a
 * wrong answer here is a refused spend, not a lost note. And it is not an RPC
 * proxy: only the pools this app is configured with are served.
 *
 * Freshness: served from KV; re-read from the chain when older than
 * `STALE_AFTER_MS` or when asked (`refresh=1` / POST), one refresh per pool at
 * a time, forced ones rate-limited. A refresh is incremental (signatures newer
 * than the cursor only), so it is cheap enough to run inline.
 */

import { NextRequest, NextResponse } from 'next/server';
import { Connection, PublicKey } from '@solana/web3.js';

import { ALL_POOLS_V3 } from '@/lib/privacy/pool/denominatedPool';
import {
  STALE_AFTER_MS,
  chooseServerRpc,
  claimForcedRefresh,
  getLeafStore,
  readPoolLeavesMeta,
  readPoolLeavesRange,
  refreshPoolLeaves,
  withRefreshLock,
  type PoolLeavesMeta,
} from '@/lib/privacy/pool/poolLeavesIndex';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_PAGE = 65_536;

// Public chain data, read cross-origin by the extension (chrome-extension://)
// and the mobile app (native fetch). Same reasoning as /api/pair/[id].
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
};

const KNOWN_POOLS = new Set(ALL_POOLS_V3.map((p) => p.poolPDA.toBase58()));

function bad(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: { ...CORS, 'Cache-Control': 'no-store' } });
}

function parsePool(raw: string): PublicKey | null {
  if (!KNOWN_POOLS.has(raw)) return null;
  try {
    return new PublicKey(raw);
  } catch {
    return null;
  }
}

function intParam(v: string | null, dflt: number, min: number, max: number): number {
  if (v === null) return dflt;
  const n = Number(v);
  if (!Number.isInteger(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

async function serve(pool: PublicKey, from: number, limit: number, forced: boolean) {
  const poolStr = pool.toBase58();
  const store = getLeafStore();
  let meta: PoolLeavesMeta | null = await readPoolLeavesMeta(store, poolStr);
  const now = Date.now();
  const stale = !meta || now - meta.updatedAt > STALE_AFTER_MS;
  const wantRefresh = stale || (forced && (await claimForcedRefresh(store, poolStr)));

  let refreshed = false;
  let refreshError: string | null = null;
  if (wantRefresh) {
    try {
      const rpc = new Connection(chooseServerRpc(), 'confirmed');
      const r = await withRefreshLock(store, poolStr, () => refreshPoolLeaves(store, rpc, pool));
      if (r) {
        meta = r.meta;
        refreshed = true;
      } else if (!meta) {
        // Someone else is filling the cache right now and we have nothing to
        // serve yet: a short retry is the honest answer.
        return NextResponse.json(
          { error: 'indexing in progress, retry shortly' },
          { status: 503, headers: { ...CORS, 'Cache-Control': 'no-store', 'Retry-After': '2' } },
        );
      }
    } catch (e) {
      refreshError = e instanceof Error ? e.message : String(e);
      if (!meta) return bad(502, `indexer could not read the chain: ${refreshError}`);
      // Stale-but-present beats nothing: the client's root pre-flight decides.
    }
  }

  const leaves = await readPoolLeavesRange(store, poolStr, meta!, from, limit);
  return NextResponse.json(
    {
      pool: poolStr,
      leafCount: meta!.leafCount,
      from,
      leaves,
      lastSignature: meta!.lastSignature,
      updatedAt: meta!.updatedAt,
      source: meta!.source,
      refreshed,
      ...(refreshError ? { stale: true, refreshError } : {}),
    },
    {
      headers: {
        ...CORS,
        'Cache-Control': 'public, max-age=5, stale-while-revalidate=60',
      },
    },
  );
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ pool: string }> }) {
  const { pool: raw } = await ctx.params;
  const pool = parsePool(raw);
  if (!pool) return bad(404, 'unknown pool');
  const q = req.nextUrl.searchParams;
  const from = intParam(q.get('from'), 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = intParam(q.get('limit'), MAX_PAGE, 1, MAX_PAGE);
  const forced = q.get('refresh') === '1';
  return serve(pool, from, limit, forced);
}

export async function POST(_req: NextRequest, ctx: { params: Promise<{ pool: string }> }) {
  const { pool: raw } = await ctx.params;
  const pool = parsePool(raw);
  if (!pool) return bad(404, 'unknown pool');
  return serve(pool, 0, 1, true);
}

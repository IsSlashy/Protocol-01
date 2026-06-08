import { NextResponse } from 'next/server';
import { createClient, type VercelKV } from '@vercel/kv';
import { readNetworkMetrics } from '@/lib/metrics/onchain';
import type { NetworkMetrics } from '@/lib/metrics/types';

/**
 * Aggregate, privacy-safe network metrics for the /explorer page.
 *
 * On-chain reads are cached in KV for 60s. This is deliberate: a real-time
 * counter that ticks per transaction would let an observer correlate a deposit
 * with its increment (a timing leak). A coarse 60s snapshot breaks that link
 * while still feeling "live" to the client (which polls every ~30s).
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
const kv: VercelKV | null = url && token ? createClient({ url, token }) : null;

const CACHE_KEY = 'metrics:network:v1';
const TTL_SEC = 60;

export async function GET() {
  if (kv) {
    const cached = await kv.get<NetworkMetrics>(CACHE_KEY);
    if (cached) {
      return NextResponse.json(cached, {
        headers: { 'Cache-Control': 'public, max-age=30' },
      });
    }
  }

  const metrics = await readNetworkMetrics();

  // Only cache real reads; never pin an honest-zero fallback for a full minute.
  if (kv && metrics.live) {
    await kv.set(CACHE_KEY, metrics, { ex: TTL_SEC });
  }

  return NextResponse.json(metrics, {
    headers: { 'Cache-Control': 'public, max-age=30' },
  });
}

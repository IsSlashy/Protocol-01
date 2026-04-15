/**
 * GET /api/noise/stats
 *
 * Public, read-only stats on the Layer 3 distributed noise engine.
 * Returns wallet-pool size, totals, and pending decoy count.
 *
 * Decoy dispatch is driven by the Vercel cron /api/cron/noise-tick (see
 * vercel.json) — this route no longer boots any background loop.
 */
import { NextResponse } from 'next/server';
import { getNoiseStats } from '@/lib/noise-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(await getNoiseStats());
}

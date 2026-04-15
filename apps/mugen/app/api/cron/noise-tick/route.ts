/**
 * POST /api/cron/noise-tick
 *
 * Vercel Cron endpoint — runs ONE tick of the distributed noise engine:
 * fires any scheduled decoys whose `scheduledFor` is due through the same
 * FROST + Arcium MPC path a real submit uses.
 *
 * Replaces the old `setInterval(..., 5_000)` in lib/noise-engine-runner,
 * which does not survive Vercel Fluid Compute's per-request lifecycle.
 * Vercel Cron's minimum cadence is 1 minute, so the effective decoy
 * dispatch window coarsens vs. dev, but the scheduling window inside
 * `scheduleDecoys()` (30s) still provides visible jitter across requests.
 *
 * Auth: Vercel attaches the `x-vercel-cron` header for all cron invocations.
 * Manual/debug triggers may use `Authorization: Bearer $CRON_SECRET`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { runNoiseEngineTick } from '@/lib/noise-engine-runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function isAuthorized(request: NextRequest): boolean {
  if (request.headers.get('x-vercel-cron')) return true;
  const auth = request.headers.get('authorization');
  const secret = process.env.CRON_SECRET;
  if (auth && secret && auth === `Bearer ${secret}`) return true;
  return false;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const result = await runNoiseEngineTick();
  const status = result.error ? 500 : 200;
  return NextResponse.json(result, { status });
}

// Vercel Cron dispatches as GET by default — accept both to be robust and
// to allow manual curl testing with either verb.
export const GET = POST;

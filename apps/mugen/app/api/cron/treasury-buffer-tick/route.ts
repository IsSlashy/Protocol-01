/**
 * POST /api/cron/treasury-buffer-tick
 *
 * Vercel Cron endpoint — runs ONE tick of the treasury buffer runner:
 *   1. Polls the buffer wallet's recent signatures for incoming on-ramp SOL
 *      and marks matching `pending` routes as `funded`.
 *   2. Dispatches payouts for any `funded` routes whose scheduledPayoutAt
 *      is due, forwarding SOL to the final stealth recipient.
 *
 * Replaces the old `setInterval(..., 15_000)` in lib/treasury-buffer-runner,
 * which does not survive Vercel Fluid Compute's per-request lifecycle.
 *
 * Auth: Vercel attaches the `x-vercel-cron` header for all cron invocations.
 * Manual/debug triggers may use `Authorization: Bearer $CRON_SECRET`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { runTreasuryBufferTick } from '@/lib/treasury-buffer-runner';

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
  const result = await runTreasuryBufferTick();
  const status = result.error ? 500 : 200;
  return NextResponse.json(result, { status });
}

// Vercel Cron dispatches as GET by default — accept both to be robust and
// to allow manual curl testing with either verb.
export const GET = POST;

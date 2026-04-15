/**
 * GET /api/noise/queue  (dev-only)
 *
 * Returns the full Layer 3 decoy queue for debugging. Guarded on
 * NODE_ENV !== 'production' so the queue (which contains wallet indices +
 * random seeds) is not exposed on Vercel production deployments.
 */
import { NextResponse } from 'next/server';
import { listQueue } from '@/lib/noise-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return NextResponse.json({ queue: await listQueue() });
}

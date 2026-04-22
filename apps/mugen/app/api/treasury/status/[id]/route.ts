import { NextRequest, NextResponse } from 'next/server';
import { getCohortInfoForRoute, getRouteById } from '@/lib/treasury-buffer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/treasury/status/:id
 *
 * Look up a single routing entry by id. Returns 404 if unknown (either
 * never registered or already evicted on server restart — the registry is
 * in-process only).
 */

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  if (!id || typeof id !== 'string') {
    return NextResponse.json({ error: 'missing route id' }, { status: 400 });
  }
  const entry = await getRouteById(id);
  if (!entry) {
    return NextResponse.json({ error: 'route not found' }, { status: 404 });
  }
  // Inline cohort context: tells the mobile UI whether this route is being
  // held by the k-anonymity gate vs. genuinely waiting on its own delay.
  const cohort = await getCohortInfoForRoute(entry);
  return NextResponse.json({ route: { ...entry, cohort } });
}

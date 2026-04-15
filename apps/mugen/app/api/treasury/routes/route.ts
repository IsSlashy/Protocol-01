import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import {
  getBufferWalletPubkey,
  listRoutes,
  type RouteStatus,
} from '@/lib/treasury-buffer';

/**
 * GET /api/treasury/routes — Dev-only dump of the current routing registry.
 *
 * Gated on NODE_ENV !== 'production' so it can never be used to enumerate
 * live user routes in prod. Useful for local verification and demos.
 *
 * Query params:
 *   ?status=pending|funded|paid|failed|expired
 *   ?limit=<int>
 */

const ALLOWED_STATUSES: ReadonlyArray<RouteStatus> = [
  'pending',
  'funded',
  'paid',
  'failed',
  'expired',
];

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'disabled in production' }, { status: 403 });
  }
  const url = new URL(request.url);
  const statusParam = url.searchParams.get('status');
  const limitParam = url.searchParams.get('limit');

  let status: RouteStatus | undefined;
  if (statusParam) {
    if (!ALLOWED_STATUSES.includes(statusParam as RouteStatus)) {
      return NextResponse.json(
        { error: `invalid status; must be one of ${ALLOWED_STATUSES.join(',')}` },
        { status: 400 },
      );
    }
    status = statusParam as RouteStatus;
  }
  let limit: number | undefined;
  if (limitParam) {
    const parsed = Number.parseInt(limitParam, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return NextResponse.json({ error: 'limit must be a positive integer' }, { status: 400 });
    }
    limit = parsed;
  }

  const routes = await listRoutes({ status, limit });
  return NextResponse.json({
    bufferAddress: getBufferWalletPubkey().toBase58(),
    count: routes.length,
    routes,
  });
}

import { NextResponse } from 'next/server';
import { fetchPriceSnapshot } from '@/lib/prices';

/**
 * GET /api/prices — Live crypto prices from CoinGecko.
 * Cached for 30 seconds via the shared `fetchPriceSnapshot` helper.
 */

export const dynamic = 'force-dynamic';

export async function GET() {
  const snapshot = await fetchPriceSnapshot();
  return NextResponse.json(snapshot);
}

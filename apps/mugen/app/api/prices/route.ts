import { NextResponse } from 'next/server';

/**
 * GET /api/prices — Live crypto prices from CoinGecko
 * Cached for 30 seconds.
 */

let cachedPrices: any = null;
let cacheTime = 0;
const CACHE_TTL = 30_000;

export async function GET() {
  const now = Date.now();

  if (cachedPrices && now - cacheTime < CACHE_TTL) {
    return NextResponse.json(cachedPrices);
  }

  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana,usd-coin,tether&vs_currencies=usd,eur,gbp',
      { signal: AbortSignal.timeout(8000), next: { revalidate: 30 } },
    );

    if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
    const data = await res.json();

    const prices = {
      SOL: { usd: data.solana?.usd || 0, eur: data.solana?.eur || 0, gbp: data.solana?.gbp || 0 },
      USDC: { usd: data['usd-coin']?.usd || 1, eur: data['usd-coin']?.eur || 0.92, gbp: data['usd-coin']?.gbp || 0.79 },
      USDT: { usd: data.tether?.usd || 1, eur: data.tether?.eur || 0.92, gbp: data.tether?.gbp || 0.79 },
      updatedAt: now,
    };

    cachedPrices = prices;
    cacheTime = now;

    return NextResponse.json(prices);
  } catch (error: any) {
    if (cachedPrices) return NextResponse.json({ ...cachedPrices, stale: true });
    return NextResponse.json(
      { SOL: { usd: 148, eur: 136 }, USDC: { usd: 1, eur: 0.92 }, USDT: { usd: 1, eur: 0.92 }, updatedAt: now, fallback: true },
    );
  }
}

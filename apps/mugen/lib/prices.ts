/**
 * Shared price helper — fetches spot prices from CoinGecko with a soft in-memory cache.
 *
 * Used by:
 *   - GET  /api/prices              (consumer UI: live price strip)
 *   - POST /api/denomination/plan   (Layer 1: fiat → SOL denomination splitter)
 *
 * Keeping one cache across routes prevents hammering CoinGecko when several
 * endpoints run back-to-back on the same request.
 */

export interface PriceSnapshot {
  SOL: { usd: number; eur: number; gbp: number };
  USDC: { usd: number; eur: number; gbp: number };
  USDT: { usd: number; eur: number; gbp: number };
  updatedAt: number;
  stale?: boolean;
  fallback?: boolean;
}

const CACHE_TTL = 30_000;
const COINGECKO_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=solana,usd-coin,tether&vs_currencies=usd,eur,gbp';

let cached: PriceSnapshot | null = null;
let cacheTime = 0;

/**
 * Fetch the current price snapshot. Returns cached snapshot when fresh.
 * On upstream failure:
 *   - returns the previous snapshot with `stale: true` when available
 *   - otherwise returns a hard-coded fallback with `fallback: true`
 */
export async function fetchPriceSnapshot(): Promise<PriceSnapshot> {
  const now = Date.now();

  if (cached && now - cacheTime < CACHE_TTL) {
    return cached;
  }

  try {
    const res = await fetch(COINGECKO_URL, {
      signal: AbortSignal.timeout(8000),
      next: { revalidate: 30 },
    });

    if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
    const data = await res.json();

    const snapshot: PriceSnapshot = {
      SOL: {
        usd: data.solana?.usd || 0,
        eur: data.solana?.eur || 0,
        gbp: data.solana?.gbp || 0,
      },
      USDC: {
        usd: data['usd-coin']?.usd || 1,
        eur: data['usd-coin']?.eur || 0.92,
        gbp: data['usd-coin']?.gbp || 0.79,
      },
      USDT: {
        usd: data.tether?.usd || 1,
        eur: data.tether?.eur || 0.92,
        gbp: data.tether?.gbp || 0.79,
      },
      updatedAt: now,
    };

    cached = snapshot;
    cacheTime = now;
    return snapshot;
  } catch {
    if (cached) return { ...cached, stale: true };
    return {
      SOL: { usd: 148, eur: 136, gbp: 117 },
      USDC: { usd: 1, eur: 0.92, gbp: 0.79 },
      USDT: { usd: 1, eur: 0.92, gbp: 0.79 },
      updatedAt: now,
      fallback: true,
    };
  }
}

/**
 * Get SOL price in a specific fiat currency. Returns 0 if the price is
 * unavailable (callers should treat 0 as "unable to fetch" and surface 503).
 */
export async function getSolPriceInFiat(
  currency: 'EUR' | 'USD',
): Promise<number> {
  const snapshot = await fetchPriceSnapshot();
  return currency === 'EUR' ? snapshot.SOL.eur : snapshot.SOL.usd;
}

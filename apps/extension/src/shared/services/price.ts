// Price service - fetches real-time SOL price from CoinGecko

interface PriceCache {
  price: number;
  timestamp: number;
}

const CACHE_DURATION = 60 * 1000; // 1 minute cache
let priceCache: PriceCache | null = null;

export async function getSolPrice(): Promise<number> {
  // Return cached price if still valid
  if (priceCache && Date.now() - priceCache.timestamp < CACHE_DURATION) {
    return priceCache.price;
  }

  try {
    const response = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      }
    );

    if (!response.ok) {
      throw new Error('Failed to fetch price');
    }

    const data = await response.json();
    const price = data.solana?.usd;

    if (typeof price === 'number') {
      priceCache = { price, timestamp: Date.now() };
      return price;
    }

    throw new Error('Invalid price data');
  } catch (error) {
    console.error('[PriceService] Failed to fetch SOL price:', error);
    // Return cached price if available, otherwise return 0
    return priceCache?.price ?? 0;
  }
}

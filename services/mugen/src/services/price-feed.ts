import { CONFIG } from '../config.js';

interface PriceData {
  symbol: string;
  usd: number;
  eur: number;
  gbp: number;
  updatedAt: number;
}

const COINGECKO_IDS: Record<string, string> = {
  SOL: 'solana',
  USDC: 'usd-coin',
  USDT: 'tether',
};

export class PriceFeed {
  private cache: Map<string, PriceData> = new Map();
  private intervalId: ReturnType<typeof setInterval> | null = null;

  async start(): Promise<void> {
    console.log(`[price-feed] Starting — TTL ${CONFIG.priceCacheTtlMs}ms`);
    await this.refresh();
    this.intervalId = setInterval(() => this.refresh(), CONFIG.priceCacheTtlMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  getPrice(symbol: string): PriceData | undefined {
    return this.cache.get(symbol.toUpperCase());
  }

  getAllPrices(): PriceData[] {
    return Array.from(this.cache.values());
  }

  private async refresh(): Promise<void> {
    try {
      const ids = Object.values(COINGECKO_IDS).join(',');
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd,eur,gbp`;

      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        console.warn(`[price-feed] CoinGecko returned ${res.status}`);
        return;
      }

      const data = await res.json();
      const now = Date.now();

      for (const [symbol, cgId] of Object.entries(COINGECKO_IDS)) {
        const prices = data[cgId];
        if (prices) {
          this.cache.set(symbol, {
            symbol,
            usd: prices.usd ?? 0,
            eur: prices.eur ?? 0,
            gbp: prices.gbp ?? 0,
            updatedAt: now,
          });
        }
      }

      console.log(
        `[price-feed] Updated: SOL=$${this.cache.get('SOL')?.usd ?? '?'}, USDC=$${this.cache.get('USDC')?.usd ?? '?'}`,
      );
    } catch (err) {
      console.error('[price-feed] Refresh error:', (err as Error).message);
    }
  }
}

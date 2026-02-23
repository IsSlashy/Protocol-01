/**
 * Market Data Service for Chrome Extension
 * Fetches Fear & Greed Index and token prices for AI context.
 * Free APIs, no keys required.
 */

// ============== Fear & Greed Index ==============

export interface FearGreedData {
  value: number;
  classification: string;
  timestamp: number;
}

let fearGreedCache: { data: FearGreedData; fetchedAt: number } | null = null;
const FEAR_GREED_CACHE_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Fetch the current Crypto Fear & Greed Index
 */
export async function getFearGreedIndex(): Promise<FearGreedData | null> {
  if (fearGreedCache && Date.now() - fearGreedCache.fetchedAt < FEAR_GREED_CACHE_TTL) {
    return fearGreedCache.data;
  }

  try {
    const response = await fetch('https://api.alternative.me/fng/?limit=1');
    if (!response.ok) return fearGreedCache?.data ?? null;

    const json = await response.json();
    const entry = json.data?.[0];
    if (!entry) return fearGreedCache?.data ?? null;

    const data: FearGreedData = {
      value: parseInt(entry.value, 10),
      classification: entry.value_classification,
      timestamp: parseInt(entry.timestamp, 10) * 1000,
    };

    fearGreedCache = { data, fetchedAt: Date.now() };
    return data;
  } catch (error) {
    console.warn('[MarketData] Fear & Greed fetch failed:', error);
    return fearGreedCache?.data ?? null;
  }
}

// ============== Token Prices ==============

const PRICE_TOKEN_IDS = [
  'So11111111111111111111111111111111111111112',  // SOL
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', // WBTC
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', // WETH
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',   // JUP
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
].join(',');

const SYMBOL_MAP: Record<string, string> = {
  'So11111111111111111111111111111111111111112': 'SOL',
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh': 'WBTC',
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': 'WETH',
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': 'JUP',
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 'BONK',
};

async function getTokenPrices(): Promise<Record<string, number>> {
  try {
    const response = await fetch(`https://price.jup.ag/v6/price?ids=${PRICE_TOKEN_IDS}`);
    if (!response.ok) return {};

    const data = await response.json();
    const prices: Record<string, number> = {};

    for (const [mint, info] of Object.entries(data.data || {})) {
      const symbol = SYMBOL_MAP[mint];
      if (symbol && (info as any).price) {
        prices[symbol] = (info as any).price;
      }
    }

    return prices;
  } catch (error) {
    console.warn('[MarketData] Token prices fetch failed:', error);
    return {};
  }
}

// ============== Market Summary ==============

export interface MarketSummary {
  fearGreed: FearGreedData | null;
  prices: Record<string, number>;
  fetchedAt: number;
}

let marketSummaryCache: MarketSummary | null = null;
const MARKET_SUMMARY_CACHE_TTL = 30_000; // 30s

/**
 * Get combined market summary (prices + Fear & Greed)
 */
export async function getMarketSummary(): Promise<MarketSummary> {
  if (marketSummaryCache && Date.now() - marketSummaryCache.fetchedAt < MARKET_SUMMARY_CACHE_TTL) {
    return marketSummaryCache;
  }

  const [fearGreed, prices] = await Promise.all([
    getFearGreedIndex(),
    getTokenPrices().catch(() => ({})),
  ]);

  const summary: MarketSummary = {
    fearGreed,
    prices,
    fetchedAt: Date.now(),
  };

  marketSummaryCache = summary;
  return summary;
}

/**
 * Format market data as context string for AI system prompt
 */
export function formatMarketContext(summary: MarketSummary): string {
  const lines: string[] = [];

  if (summary.fearGreed) {
    lines.push(`Fear & Greed Index: ${summary.fearGreed.value}/100 (${summary.fearGreed.classification})`);
  }

  const priceEntries = Object.entries(summary.prices);
  if (priceEntries.length > 0) {
    lines.push('');
    lines.push('Current prices (USD):');
    const priority = ['SOL', 'WBTC', 'WETH', 'JUP', 'BONK'];
    for (const symbol of priority) {
      const price = summary.prices[symbol];
      if (price !== undefined) {
        lines.push(`  ${symbol}: $${formatPrice(price)}`);
      }
    }
  }

  return lines.join('\n');
}

function formatPrice(price: number): string {
  if (price >= 1000) return price.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (price >= 1) return price.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (price >= 0.001) return price.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return price.toLocaleString('en-US', { maximumFractionDigits: 8 });
}

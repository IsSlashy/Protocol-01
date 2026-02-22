/**
 * Market Data Service
 * Fetches Fear & Greed Index and token prices for AI context.
 * Free APIs, no keys required.
 */

import { getTokenPrices } from '../jupiter/index';

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
 * Source: alternative.me (free, no API key)
 */
export async function getFearGreedIndex(): Promise<FearGreedData | null> {
  // Check cache
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

// ============== Market Summary ==============

export interface MarketSummary {
  fearGreed: FearGreedData | null;
  prices: Record<string, number>;
  fetchedAt: number;
}

let marketSummaryCache: MarketSummary | null = null;
const MARKET_SUMMARY_CACHE_TTL = 30_000; // 30s (prices change fast)

/**
 * Get a combined market summary (prices + Fear & Greed)
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
 * Format market data as a context string for the AI system prompt
 */
export function formatMarketContext(summary: MarketSummary): string {
  const lines: string[] = [];

  // Fear & Greed
  if (summary.fearGreed) {
    lines.push(`Fear & Greed Index: ${summary.fearGreed.value}/100 (${summary.fearGreed.classification})`);
  }

  // Top prices
  const priceEntries = Object.entries(summary.prices);
  if (priceEntries.length > 0) {
    lines.push('');
    lines.push('Current prices (USD):');
    // Show key tokens first
    const priority = ['SOL', 'WBTC', 'WETH', 'JUP', 'BONK', 'WIF', 'PYTH', 'RAY', 'ORCA', 'HNT', 'RENDER', 'JitoSOL', 'mSOL'];
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

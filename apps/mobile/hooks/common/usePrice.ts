/**
 * usePrice - Token price fetching with caching
 * @module hooks/common/usePrice
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useAsyncStorage, ASYNC_KEYS } from '../storage/useAsyncStorage';
import { useNetwork } from './useNetwork';

export interface TokenPrice {
  id: string;
  symbol: string;
  name: string;
  current_price: number;
  price_change_24h: number;
  price_change_percentage_24h: number;
  market_cap: number;
  volume_24h: number;
  last_updated: number;
}

export interface PriceCache {
  prices: Record<string, TokenPrice>;
  lastFetched: number;
}

// Common token IDs for CoinGecko API
export const TOKEN_IDS: Record<string, string> = {
  ETH: 'ethereum',
  BTC: 'bitcoin',
  USDC: 'usd-coin',
  USDT: 'tether',
  DAI: 'dai',
  MATIC: 'matic-network',
  ARB: 'arbitrum',
  OP: 'optimism',
  LINK: 'chainlink',
  UNI: 'uniswap',
};

interface UsePriceOptions {
  symbols?: string[];
  refreshInterval?: number; // ms
  cacheTime?: number; // ms
  currency?: string;
}

interface UsePriceReturn {
  prices: Record<string, TokenPrice>;
  isLoading: boolean;
  isRefreshing: boolean;
  error: Error | null;
  getPrice: (symbol: string) => TokenPrice | null;
  formatPrice: (symbol: string, options?: FormatOptions) => string;
  formatValue: (symbol: string, amount: number, options?: FormatOptions) => string;
  refresh: () => Promise<void>;
  lastUpdated: number | null;
}

interface FormatOptions {
  currency?: string;
  locale?: string;
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
}

const DEFAULT_SYMBOLS = ['ETH', 'USDC', 'USDT', 'DAI'];
const DEFAULT_REFRESH_INTERVAL = 60000; // 1 minute
const DEFAULT_CACHE_TIME = 300000; // 5 minutes
const DEFAULT_CURRENCY = 'usd';

export function usePrice(options: UsePriceOptions = {}): UsePriceReturn {
  const {
    symbols = DEFAULT_SYMBOLS,
    refreshInterval = DEFAULT_REFRESH_INTERVAL,
    cacheTime = DEFAULT_CACHE_TIME,
    currency = DEFAULT_CURRENCY,
  } = options;

  const [prices, setPrices] = useState<Record<string, TokenPrice>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const { isConnected } = useNetwork();

  const {
    value: priceCache,
    setValue: setPriceCache,
  } = useAsyncStorage<PriceCache>({
    key: ASYNC_KEYS.PRICE_CACHE,
    defaultValue: { prices: {}, lastFetched: 0 },
  });

  // Check if cache is valid
  const isCacheValid = useMemo(() => {
    if (!priceCache) return false;
    const now = Date.now();
    return now - priceCache.lastFetched < cacheTime;
  }, [priceCache, cacheTime]);

  // Fetch prices from API
  const fetchPrices = useCallback(async (isRefresh = false) => {
    if (!isConnected) {
      // Use cached prices when offline
      if (priceCache?.prices) {
        setPrices(priceCache.prices);
      }
      setIsLoading(false);
      return;
    }

    if (isRefresh) {
      setIsRefreshing(true);
    } else {
      setIsLoading(true);
    }
    setError(null);

    try {
      // Get CoinGecko IDs for requested symbols
      const ids = symbols
        .map(s => TOKEN_IDS[s.toUpperCase()])
        .filter(Boolean)
        .join(',');

      // In real implementation, fetch from CoinGecko or similar API
      // const response = await fetch(
      //   `https://api.coingecko.com/api/v3/coins/markets?vs_currency=${currency}&ids=${ids}`
      // );
      // const data = await response.json();

      // Placeholder prices
      const now = Date.now();
      const mockPrices: Record<string, TokenPrice> = {
        ETH: {
          id: 'ethereum',
          symbol: 'ETH',
          name: 'Ethereum',
          current_price: 2500 + Math.random() * 100,
          price_change_24h: 50,
          price_change_percentage_24h: 2.1,
          market_cap: 300000000000,
          volume_24h: 15000000000,
          last_updated: now,
        },
        BTC: {
          id: 'bitcoin',
          symbol: 'BTC',
          name: 'Bitcoin',
          current_price: 42000 + Math.random() * 1000,
          price_change_24h: 800,
          price_change_percentage_24h: 1.9,
          market_cap: 820000000000,
          volume_24h: 25000000000,
          last_updated: now,
        },
        USDC: {
          id: 'usd-coin',
          symbol: 'USDC',
          name: 'USD Coin',
          current_price: 1.0,
          price_change_24h: 0,
          price_change_percentage_24h: 0,
          market_cap: 25000000000,
          volume_24h: 5000000000,
          last_updated: now,
        },
        USDT: {
          id: 'tether',
          symbol: 'USDT',
          name: 'Tether',
          current_price: 1.0,
          price_change_24h: 0,
          price_change_percentage_24h: 0,
          market_cap: 90000000000,
          volume_24h: 50000000000,
          last_updated: now,
        },
        DAI: {
          id: 'dai',
          symbol: 'DAI',
          name: 'Dai',
          current_price: 1.0,
          price_change_24h: 0,
          price_change_percentage_24h: 0.01,
          market_cap: 5000000000,
          volume_24h: 300000000,
          last_updated: now,
        },
        MATIC: {
          id: 'matic-network',
          symbol: 'MATIC',
          name: 'Polygon',
          current_price: 0.85 + Math.random() * 0.1,
          price_change_24h: 0.02,
          price_change_percentage_24h: 2.5,
          market_cap: 8000000000,
          volume_24h: 400000000,
          last_updated: now,
        },
      };

      // Filter to requested symbols
      const filteredPrices: Record<string, TokenPrice> = {};
      for (const symbol of symbols) {
        const upperSymbol = symbol.toUpperCase();
        if (mockPrices[upperSymbol]) {
          filteredPrices[upperSymbol] = mockPrices[upperSymbol];
        }
      }

      setPrices(filteredPrices);
      setLastUpdated(now);

      // Update cache
      await setPriceCache({
        prices: { ...priceCache?.prices, ...filteredPrices },
        lastFetched: now,
      });
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to fetch prices'));

      // Fall back to cache on error
      if (priceCache?.prices) {
        setPrices(priceCache.prices);
      }
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [isConnected, symbols, currency, priceCache, setPriceCache]);

  // Load from cache first, then fetch
  useEffect(() => {
    if (isCacheValid && priceCache?.prices) {
      setPrices(priceCache.prices);
      setLastUpdated(priceCache.lastFetched);
      setIsLoading(false);
    } else {
      fetchPrices();
    }
  }, [isCacheValid, priceCache, fetchPrices]);

  // Set up refresh interval
  useEffect(() => {
    if (refreshInterval > 0) {
      intervalRef.current = setInterval(() => {
        fetchPrices(true);
      }, refreshInterval);

      return () => {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
        }
      };
    }
  }, [refreshInterval, fetchPrices]);

  const getPrice = useCallback((symbol: string): TokenPrice | null => {
    return prices[symbol.toUpperCase()] ?? null;
  }, [prices]);

  const formatPrice = useCallback((
    symbol: string,
    options: FormatOptions = {}
  ): string => {
    const price = getPrice(symbol);
    if (!price) return '--';

    const {
      currency: curr = 'USD',
      locale = 'en-US',
      minimumFractionDigits = 2,
      maximumFractionDigits = 2,
    } = options;

    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: curr,
      minimumFractionDigits,
      maximumFractionDigits,
    }).format(price.current_price);
  }, [getPrice]);

  const formatValue = useCallback((
    symbol: string,
    amount: number,
    options: FormatOptions = {}
  ): string => {
    const price = getPrice(symbol);
    if (!price) return '--';

    const value = amount * price.current_price;

    const {
      currency: curr = 'USD',
      locale = 'en-US',
      minimumFractionDigits = 2,
      maximumFractionDigits = 2,
    } = options;

    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: curr,
      minimumFractionDigits,
      maximumFractionDigits,
    }).format(value);
  }, [getPrice]);

  const refresh = useCallback(async () => {
    await fetchPrices(true);
  }, [fetchPrices]);

  return {
    prices,
    isLoading,
    isRefreshing,
    error,
    getPrice,
    formatPrice,
    formatValue,
    refresh,
    lastUpdated,
  };
}

// Single token price hook
export function useTokenPrice(symbol: string): {
  price: TokenPrice | null;
  isLoading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
} {
  const { getPrice, isLoading, error, refresh } = usePrice({
    symbols: [symbol],
  });

  return {
    price: getPrice(symbol),
    isLoading,
    error,
    refresh,
  };
}

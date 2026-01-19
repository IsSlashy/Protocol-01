/**
 * useBalance - Fetch and manage wallet balance with refresh
 * @module hooks/wallet/useBalance
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useNetwork } from '../common/useNetwork';

export interface TokenBalance {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  balance: bigint;
  balanceFormatted: string;
  usdValue: number;
  logoUri?: string;
  priceChange24h?: number;
}

export interface WalletBalance {
  native: bigint;
  nativeFormatted: string;
  nativeUsdValue: number;
  nativePriceChange24h: number;
  tokens: TokenBalance[];
  totalUsdValue: number;
  lastUpdated: number;
}

interface UseBalanceOptions {
  address: string | null;
  refreshInterval?: number; // ms
  includeTokens?: boolean;
  tokenAddresses?: string[];
}

interface UseBalanceReturn {
  balance: WalletBalance | null;
  isLoading: boolean;
  isRefreshing: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  getTokenBalance: (tokenAddress: string) => TokenBalance | undefined;
}

const DEFAULT_REFRESH_INTERVAL = 30000; // 30 seconds

// Format balance with decimals
function formatBalance(balance: bigint, decimals: number): string {
  const divisor = BigInt(10 ** decimals);
  const integerPart = balance / divisor;
  const fractionalPart = balance % divisor;

  const fractionalStr = fractionalPart.toString().padStart(decimals, '0');
  const trimmedFractional = fractionalStr.slice(0, 4).replace(/0+$/, '');

  if (trimmedFractional === '') {
    return integerPart.toString();
  }

  return `${integerPart}.${trimmedFractional}`;
}

export function useBalance({
  address,
  refreshInterval = DEFAULT_REFRESH_INTERVAL,
  includeTokens = true,
  tokenAddresses = [],
}: UseBalanceOptions): UseBalanceReturn {
  const [balance, setBalance] = useState<WalletBalance | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const { isConnected, provider } = useNetwork();

  const fetchBalance = useCallback(async (isRefresh = false) => {
    if (!address || !isConnected) {
      setBalance(null);
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
      // Fetch native balance
      // In real implementation, use provider.getBalance(address)
      const nativeBalance = BigInt('1000000000000000000'); // 1 ETH placeholder

      // Fetch token balances if enabled
      const tokens: TokenBalance[] = [];

      if (includeTokens) {
        // Common tokens to check (or use provided list)
        const tokensToCheck = tokenAddresses.length > 0
          ? tokenAddresses
          : [
              '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
              '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
              '0x6B175474E89094C44Da98b954EescdeCB5BE5F0e', // DAI
            ];

        // Fetch each token balance
        for (const tokenAddress of tokensToCheck) {
          try {
            // In real implementation, call ERC20 balanceOf
            const tokenBalance: TokenBalance = {
              address: tokenAddress,
              symbol: 'TOKEN',
              name: 'Token',
              decimals: 18,
              balance: BigInt('500000000000000000000'), // 500 placeholder
              balanceFormatted: '500',
              usdValue: 500,
              priceChange24h: 2.5,
            };
            tokens.push(tokenBalance);
          } catch {
            // Skip failed token fetches
          }
        }
      }

      // Calculate total USD value
      const nativeUsdValue = 2500; // Placeholder ETH price
      const tokensUsdValue = tokens.reduce((sum, t) => sum + t.usdValue, 0);
      const totalUsdValue = nativeUsdValue + tokensUsdValue;

      const newBalance: WalletBalance = {
        native: nativeBalance,
        nativeFormatted: formatBalance(nativeBalance, 18),
        nativeUsdValue,
        nativePriceChange24h: 1.5,
        tokens,
        totalUsdValue,
        lastUpdated: Date.now(),
      };

      setBalance(newBalance);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to fetch balance'));
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [address, isConnected, includeTokens, tokenAddresses, provider]);

  // Initial fetch
  useEffect(() => {
    fetchBalance();
  }, [fetchBalance]);

  // Set up refresh interval
  useEffect(() => {
    if (refreshInterval > 0 && address) {
      intervalRef.current = setInterval(() => {
        fetchBalance(true);
      }, refreshInterval);

      return () => {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
        }
      };
    }
  }, [refreshInterval, address, fetchBalance]);

  const refresh = useCallback(async () => {
    await fetchBalance(true);
  }, [fetchBalance]);

  const getTokenBalance = useCallback((tokenAddress: string): TokenBalance | undefined => {
    return balance?.tokens.find(
      t => t.address.toLowerCase() === tokenAddress.toLowerCase()
    );
  }, [balance]);

  return {
    balance,
    isLoading,
    isRefreshing,
    error,
    refresh,
    getTokenBalance,
  };
}

// Utility hook for single token balance
export function useTokenBalance(
  walletAddress: string | null,
  tokenAddress: string
): {
  balance: TokenBalance | null;
  isLoading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
} {
  const { balance, isLoading, error, refresh } = useBalance({
    address: walletAddress,
    tokenAddresses: [tokenAddress],
  });

  return {
    balance: balance?.tokens[0] ?? null,
    isLoading,
    error,
    refresh,
  };
}

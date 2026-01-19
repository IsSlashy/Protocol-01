/**
 * useStreams - List and manage payment streams
 * @module hooks/streams/useStreams
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNetwork } from '../common/useNetwork';
import { useWallet } from '../wallet/useWallet';
import { useAsyncStorage, ASYNC_KEYS } from '../storage/useAsyncStorage';

export type StreamStatus =
  | 'pending'      // Created but not started
  | 'active'       // Currently streaming
  | 'paused'       // Temporarily paused
  | 'cancelled'    // Cancelled before completion
  | 'completed'    // Fully streamed
  | 'depleted';    // Funds fully withdrawn

export type StreamDirection = 'incoming' | 'outgoing';

export interface Stream {
  id: string;
  contractAddress: string;
  sender: string;
  recipient: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  depositAmount: bigint;
  depositAmountFormatted: string;
  withdrawnAmount: bigint;
  withdrawnAmountFormatted: string;
  remainingAmount: bigint;
  remainingAmountFormatted: string;
  streamedAmount: bigint;
  streamedAmountFormatted: string;
  claimableAmount: bigint;
  claimableAmountFormatted: string;
  ratePerSecond: bigint;
  startTime: number;
  endTime: number;
  duration: number; // seconds
  status: StreamStatus;
  direction: StreamDirection;
  // Stealth support
  isStealth: boolean;
  stealthAddress?: string;
  // Metadata
  note?: string;
  createdAt: number;
  lastUpdatedAt: number;
}

export interface StreamStats {
  totalIncoming: number;
  totalOutgoing: number;
  activeStreams: number;
  totalStreamedValue: bigint;
  totalClaimableValue: bigint;
}

interface UseStreamsOptions {
  address?: string | null;
  filter?: {
    status?: StreamStatus[];
    direction?: StreamDirection;
    tokenAddress?: string;
  };
  autoRefresh?: boolean;
  refreshInterval?: number;
}

interface UseStreamsReturn {
  streams: Stream[];
  incomingStreams: Stream[];
  outgoingStreams: Stream[];
  activeStreams: Stream[];
  stats: StreamStats;
  isLoading: boolean;
  isRefreshing: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  getStream: (streamId: string) => Stream | undefined;
}

const DEFAULT_REFRESH_INTERVAL = 10000; // 10 seconds for real-time feel

export function useStreams(options: UseStreamsOptions = {}): UseStreamsReturn {
  const {
    filter,
    autoRefresh = true,
    refreshInterval = DEFAULT_REFRESH_INTERVAL,
  } = options;

  const [streams, setStreams] = useState<Stream[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const { wallet } = useWallet();
  const { isConnected, chainId } = useNetwork();

  const address = options.address ?? wallet?.address ?? null;

  const {
    value: cachedStreams,
    setValue: setCachedStreams,
  } = useAsyncStorage<Stream[]>({
    key: `${ASYNC_KEYS.STREAM_CACHE}_${chainId}`,
    defaultValue: [],
  });

  const fetchStreams = useCallback(async (isRefresh = false) => {
    if (!address || !isConnected) {
      setStreams([]);
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
      // In real implementation:
      // 1. Query P-01 streaming contract for sender's streams
      // 2. Query for recipient's streams
      // 3. Calculate current streamed amounts based on time

      const now = Date.now();
      const currentTime = Math.floor(now / 1000);

      // Placeholder streams
      const fetchedStreams: Stream[] = [
        {
          id: '1',
          contractAddress: '0x' + 'a'.repeat(40),
          sender: address,
          recipient: '0x' + 'b'.repeat(40),
          tokenAddress: '0x' + 'c'.repeat(40),
          tokenSymbol: 'USDC',
          tokenDecimals: 6,
          depositAmount: BigInt('1000000000'), // 1000 USDC
          depositAmountFormatted: '1000',
          withdrawnAmount: BigInt('200000000'),
          withdrawnAmountFormatted: '200',
          remainingAmount: BigInt('800000000'),
          remainingAmountFormatted: '800',
          streamedAmount: BigInt('500000000'),
          streamedAmountFormatted: '500',
          claimableAmount: BigInt('300000000'),
          claimableAmountFormatted: '300',
          ratePerSecond: BigInt('115740'), // ~10 USDC/day
          startTime: currentTime - 86400 * 5, // Started 5 days ago
          endTime: currentTime + 86400 * 5, // 5 days remaining
          duration: 86400 * 10, // 10 days total
          status: 'active',
          direction: 'outgoing',
          isStealth: false,
          createdAt: now - 86400 * 5 * 1000,
          lastUpdatedAt: now,
        },
        {
          id: '2',
          contractAddress: '0x' + 'd'.repeat(40),
          sender: '0x' + 'e'.repeat(40),
          recipient: address,
          tokenAddress: '0x' + 'c'.repeat(40),
          tokenSymbol: 'USDC',
          tokenDecimals: 6,
          depositAmount: BigInt('5000000000'), // 5000 USDC
          depositAmountFormatted: '5000',
          withdrawnAmount: BigInt('1000000000'),
          withdrawnAmountFormatted: '1000',
          remainingAmount: BigInt('4000000000'),
          remainingAmountFormatted: '4000',
          streamedAmount: BigInt('2500000000'),
          streamedAmountFormatted: '2500',
          claimableAmount: BigInt('1500000000'),
          claimableAmountFormatted: '1500',
          ratePerSecond: BigInt('578703'), // ~50 USDC/day
          startTime: currentTime - 86400 * 25, // Started 25 days ago
          endTime: currentTime + 86400 * 5, // 5 days remaining
          duration: 86400 * 30, // 30 days total (monthly salary)
          status: 'active',
          direction: 'incoming',
          isStealth: true,
          stealthAddress: '0x' + 'f'.repeat(40),
          note: 'Monthly salary',
          createdAt: now - 86400 * 25 * 1000,
          lastUpdatedAt: now,
        },
      ];

      setStreams(fetchedStreams);

      // Cache for offline access
      await setCachedStreams(fetchedStreams);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to fetch streams'));

      // Use cached data as fallback
      if (cachedStreams) {
        setStreams(cachedStreams);
      }
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [address, isConnected, cachedStreams, setCachedStreams]);

  // Initial fetch
  useEffect(() => {
    fetchStreams();
  }, [fetchStreams]);

  // Auto refresh
  useEffect(() => {
    if (!autoRefresh || !address) return;

    const interval = setInterval(() => {
      fetchStreams(true);
    }, refreshInterval);

    return () => clearInterval(interval);
  }, [autoRefresh, refreshInterval, address, fetchStreams]);

  // Apply filters
  const filteredStreams = useMemo(() => {
    let result = streams;

    if (filter?.status) {
      result = result.filter(s => filter.status!.includes(s.status));
    }

    if (filter?.direction) {
      result = result.filter(s => s.direction === filter.direction);
    }

    if (filter?.tokenAddress) {
      result = result.filter(
        s => s.tokenAddress.toLowerCase() === filter.tokenAddress!.toLowerCase()
      );
    }

    return result;
  }, [streams, filter]);

  // Derived data
  const incomingStreams = useMemo(
    () => filteredStreams.filter(s => s.direction === 'incoming'),
    [filteredStreams]
  );

  const outgoingStreams = useMemo(
    () => filteredStreams.filter(s => s.direction === 'outgoing'),
    [filteredStreams]
  );

  const activeStreams = useMemo(
    () => filteredStreams.filter(s => s.status === 'active'),
    [filteredStreams]
  );

  // Calculate stats
  const stats = useMemo((): StreamStats => {
    let totalStreamedValue = BigInt(0);
    let totalClaimableValue = BigInt(0);

    for (const stream of filteredStreams) {
      totalStreamedValue += stream.streamedAmount;
      if (stream.direction === 'incoming') {
        totalClaimableValue += stream.claimableAmount;
      }
    }

    return {
      totalIncoming: incomingStreams.length,
      totalOutgoing: outgoingStreams.length,
      activeStreams: activeStreams.length,
      totalStreamedValue,
      totalClaimableValue,
    };
  }, [filteredStreams, incomingStreams, outgoingStreams, activeStreams]);

  const refresh = useCallback(async () => {
    await fetchStreams(true);
  }, [fetchStreams]);

  const getStream = useCallback((streamId: string): Stream | undefined => {
    return streams.find(s => s.id === streamId);
  }, [streams]);

  return {
    streams: filteredStreams,
    incomingStreams,
    outgoingStreams,
    activeStreams,
    stats,
    isLoading,
    isRefreshing,
    error,
    refresh,
    getStream,
  };
}

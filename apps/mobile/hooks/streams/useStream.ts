/**
 * useStream - Single stream with real-time updates
 * @module hooks/streams/useStream
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Stream, StreamStatus } from './useStreams';
import { useNetwork } from '../common/useNetwork';
import { useWallet } from '../wallet/useWallet';
import { useHaptics } from '../common/useHaptics';

export interface StreamActions {
  pause: () => Promise<string | null>;
  resume: () => Promise<string | null>;
  cancel: () => Promise<string | null>;
  withdraw: (amount?: bigint) => Promise<string | null>;
  withdrawAll: () => Promise<string | null>;
}

interface UseStreamOptions {
  streamId: string;
  realTimeUpdate?: boolean;
  updateInterval?: number; // ms
}

interface UseStreamReturn {
  stream: Stream | null;
  isLoading: boolean;
  error: Error | null;
  isOwner: boolean;
  isRecipient: boolean;
  canPause: boolean;
  canResume: boolean;
  canCancel: boolean;
  canWithdraw: boolean;
  actions: StreamActions;
  refresh: () => Promise<void>;
}

const DEFAULT_UPDATE_INTERVAL = 1000; // 1 second for smooth progress

export function useStream({
  streamId,
  realTimeUpdate = true,
  updateInterval = DEFAULT_UPDATE_INTERVAL,
}: UseStreamOptions): UseStreamReturn {
  const [stream, setStream] = useState<Stream | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const { wallet } = useWallet();
  const { isConnected } = useNetwork();
  const { trigger } = useHaptics();

  const fetchStream = useCallback(async () => {
    if (!streamId || !isConnected) {
      setStream(null);
      setIsLoading(false);
      return;
    }

    try {
      // In real implementation:
      // 1. Fetch stream data from contract
      // 2. Calculate current streamed amount based on time

      const now = Date.now();
      const currentTime = Math.floor(now / 1000);

      // Placeholder stream data
      const fetchedStream: Stream = {
        id: streamId,
        contractAddress: '0x' + 'a'.repeat(40),
        sender: wallet?.address ?? '0x' + 'b'.repeat(40),
        recipient: '0x' + 'c'.repeat(40),
        tokenAddress: '0x' + 'd'.repeat(40),
        tokenSymbol: 'USDC',
        tokenDecimals: 6,
        depositAmount: BigInt('1000000000'),
        depositAmountFormatted: '1000',
        withdrawnAmount: BigInt('200000000'),
        withdrawnAmountFormatted: '200',
        remainingAmount: BigInt('800000000'),
        remainingAmountFormatted: '800',
        streamedAmount: BigInt('500000000'),
        streamedAmountFormatted: '500',
        claimableAmount: BigInt('300000000'),
        claimableAmountFormatted: '300',
        ratePerSecond: BigInt('115740'),
        startTime: currentTime - 86400 * 5,
        endTime: currentTime + 86400 * 5,
        duration: 86400 * 10,
        status: 'active',
        direction: 'outgoing',
        isStealth: false,
        createdAt: now - 86400 * 5 * 1000,
        lastUpdatedAt: now,
      };

      setStream(fetchedStream);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to fetch stream'));
    } finally {
      setIsLoading(false);
    }
  }, [streamId, isConnected, wallet?.address]);

  // Update streamed amounts in real-time
  const updateStreamedAmounts = useCallback(() => {
    if (!stream || stream.status !== 'active') return;

    const now = Math.floor(Date.now() / 1000);
    const elapsed = BigInt(Math.min(now, stream.endTime) - stream.startTime);
    const newStreamedAmount = elapsed * stream.ratePerSecond;

    // Clamp to deposit amount
    const clampedStreamed = newStreamedAmount > stream.depositAmount
      ? stream.depositAmount
      : newStreamedAmount;

    const newClaimable = clampedStreamed - stream.withdrawnAmount;
    const newRemaining = stream.depositAmount - clampedStreamed;

    setStream(prev => {
      if (!prev) return null;
      return {
        ...prev,
        streamedAmount: clampedStreamed,
        streamedAmountFormatted: formatAmount(clampedStreamed, prev.tokenDecimals),
        claimableAmount: newClaimable > BigInt(0) ? newClaimable : BigInt(0),
        claimableAmountFormatted: formatAmount(newClaimable > BigInt(0) ? newClaimable : BigInt(0), prev.tokenDecimals),
        remainingAmount: newRemaining > BigInt(0) ? newRemaining : BigInt(0),
        remainingAmountFormatted: formatAmount(newRemaining > BigInt(0) ? newRemaining : BigInt(0), prev.tokenDecimals),
        lastUpdatedAt: Date.now(),
      };
    });
  }, [stream]);

  // Initial fetch
  useEffect(() => {
    fetchStream();
  }, [fetchStream]);

  // Real-time updates
  useEffect(() => {
    if (!realTimeUpdate || !stream || stream.status !== 'active') {
      return;
    }

    intervalRef.current = setInterval(updateStreamedAmounts, updateInterval);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [realTimeUpdate, stream, updateInterval, updateStreamedAmounts]);

  // Permissions
  const isOwner = useMemo(() => {
    if (!wallet || !stream) return false;
    return stream.sender.toLowerCase() === wallet.address.toLowerCase();
  }, [wallet, stream]);

  const isRecipient = useMemo(() => {
    if (!wallet || !stream) return false;
    return stream.recipient.toLowerCase() === wallet.address.toLowerCase();
  }, [wallet, stream]);

  const canPause = useMemo(() => {
    return isOwner && stream?.status === 'active';
  }, [isOwner, stream]);

  const canResume = useMemo(() => {
    return isOwner && stream?.status === 'paused';
  }, [isOwner, stream]);

  const canCancel = useMemo(() => {
    return isOwner && ['active', 'paused', 'pending'].includes(stream?.status ?? '');
  }, [isOwner, stream]);

  const canWithdraw = useMemo(() => {
    return isRecipient && stream?.claimableAmount && stream.claimableAmount > BigInt(0);
  }, [isRecipient, stream]);

  // Actions
  const pause = useCallback(async (): Promise<string | null> => {
    if (!canPause || !stream) return null;

    try {
      // In real implementation: Call contract pause function
      await new Promise(resolve => setTimeout(resolve, 1000));

      const txHash = '0x' + Math.random().toString(16).slice(2).padEnd(64, '0');

      setStream(prev => prev ? { ...prev, status: 'paused' } : null);
      trigger('success');

      return txHash;
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to pause stream'));
      trigger('error');
      return null;
    }
  }, [canPause, stream, trigger]);

  const resume = useCallback(async (): Promise<string | null> => {
    if (!canResume || !stream) return null;

    try {
      // In real implementation: Call contract resume function
      await new Promise(resolve => setTimeout(resolve, 1000));

      const txHash = '0x' + Math.random().toString(16).slice(2).padEnd(64, '0');

      setStream(prev => prev ? { ...prev, status: 'active' } : null);
      trigger('success');

      return txHash;
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to resume stream'));
      trigger('error');
      return null;
    }
  }, [canResume, stream, trigger]);

  const cancel = useCallback(async (): Promise<string | null> => {
    if (!canCancel || !stream) return null;

    try {
      // In real implementation: Call contract cancel function
      await new Promise(resolve => setTimeout(resolve, 1000));

      const txHash = '0x' + Math.random().toString(16).slice(2).padEnd(64, '0');

      setStream(prev => prev ? { ...prev, status: 'cancelled' } : null);
      trigger('warning');

      return txHash;
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to cancel stream'));
      trigger('error');
      return null;
    }
  }, [canCancel, stream, trigger]);

  const withdraw = useCallback(async (amount?: bigint): Promise<string | null> => {
    if (!canWithdraw || !stream) return null;

    const withdrawAmount = amount ?? stream.claimableAmount;

    if (withdrawAmount <= BigInt(0)) {
      setError(new Error('Nothing to withdraw'));
      return null;
    }

    try {
      // In real implementation: Call contract withdraw function
      await new Promise(resolve => setTimeout(resolve, 1000));

      const txHash = '0x' + Math.random().toString(16).slice(2).padEnd(64, '0');

      setStream(prev => {
        if (!prev) return null;
        const newWithdrawn = prev.withdrawnAmount + withdrawAmount;
        const newClaimable = prev.claimableAmount - withdrawAmount;
        return {
          ...prev,
          withdrawnAmount: newWithdrawn,
          withdrawnAmountFormatted: formatAmount(newWithdrawn, prev.tokenDecimals),
          claimableAmount: newClaimable > BigInt(0) ? newClaimable : BigInt(0),
          claimableAmountFormatted: formatAmount(newClaimable > BigInt(0) ? newClaimable : BigInt(0), prev.tokenDecimals),
        };
      });

      trigger('success');
      return txHash;
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to withdraw'));
      trigger('error');
      return null;
    }
  }, [canWithdraw, stream, trigger]);

  const withdrawAll = useCallback(async (): Promise<string | null> => {
    return withdraw(stream?.claimableAmount);
  }, [withdraw, stream]);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    await fetchStream();
  }, [fetchStream]);

  return {
    stream,
    isLoading,
    error,
    isOwner,
    isRecipient,
    canPause,
    canResume,
    canCancel,
    canWithdraw,
    actions: {
      pause,
      resume,
      cancel,
      withdraw,
      withdrawAll,
    },
    refresh,
  };
}

// Helper function to format amounts
function formatAmount(amount: bigint, decimals: number): string {
  const divisor = BigInt(10 ** decimals);
  const integer = amount / divisor;
  const fractional = amount % divisor;
  const fractionalStr = fractional.toString().padStart(decimals, '0').slice(0, 2);
  return `${integer}.${fractionalStr}`;
}

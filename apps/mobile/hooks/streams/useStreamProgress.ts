/**
 * useStreamProgress - Calculate and track stream progress
 * @module hooks/streams/useStreamProgress
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Stream } from './useStreams';

export interface StreamProgress {
  // Percentages (0-100)
  percentStreamed: number;
  percentWithdrawn: number;
  percentClaimable: number;
  percentRemaining: number;

  // Amounts (formatted)
  streamedAmount: string;
  withdrawnAmount: string;
  claimableAmount: string;
  remainingAmount: string;

  // Time
  elapsedTime: number; // seconds
  remainingTime: number; // seconds
  elapsedTimeFormatted: string;
  remainingTimeFormatted: string;

  // Rate
  ratePerSecond: string;
  ratePerMinute: string;
  ratePerHour: string;
  ratePerDay: string;

  // Status
  isStarted: boolean;
  isEnded: boolean;
  isPaused: boolean;

  // Timestamps
  startDate: Date;
  endDate: Date;
  estimatedCompletionDate: Date;
}

interface UseStreamProgressOptions {
  stream: Stream | null;
  updateInterval?: number; // ms
}

interface UseStreamProgressReturn {
  progress: StreamProgress | null;
  isActive: boolean;
  nextMilestone: StreamMilestone | null;
  milestones: StreamMilestone[];
}

export interface StreamMilestone {
  id: string;
  name: string;
  percentage: number;
  amount: bigint;
  amountFormatted: string;
  timestamp: number;
  date: Date;
  reached: boolean;
}

const DEFAULT_UPDATE_INTERVAL = 1000;

// Standard milestone percentages
const MILESTONE_PERCENTAGES = [10, 25, 50, 75, 90, 100];

export function useStreamProgress({
  stream,
  updateInterval = DEFAULT_UPDATE_INTERVAL,
}: UseStreamProgressOptions): UseStreamProgressReturn {
  const [progress, setProgress] = useState<StreamProgress | null>(null);

  const calculateProgress = useCallback((): StreamProgress | null => {
    if (!stream) return null;

    const now = Math.floor(Date.now() / 1000);
    const { startTime, endTime, duration, depositAmount, withdrawnAmount, ratePerSecond, status } = stream;

    // Calculate time-based metrics
    const isStarted = now >= startTime;
    const isEnded = now >= endTime || status === 'completed' || status === 'cancelled';
    const isPaused = status === 'paused';

    let elapsedTime: number;
    if (!isStarted) {
      elapsedTime = 0;
    } else if (isEnded) {
      elapsedTime = duration;
    } else {
      elapsedTime = now - startTime;
    }

    const remainingTime = Math.max(0, endTime - now);

    // Calculate amounts
    let streamedAmount: bigint;
    if (isPaused) {
      // When paused, use the stored streamed amount
      streamedAmount = stream.streamedAmount;
    } else if (!isStarted) {
      streamedAmount = BigInt(0);
    } else if (isEnded) {
      streamedAmount = depositAmount;
    } else {
      streamedAmount = BigInt(elapsedTime) * ratePerSecond;
      // Clamp to deposit amount
      if (streamedAmount > depositAmount) {
        streamedAmount = depositAmount;
      }
    }

    const claimableAmount = streamedAmount > withdrawnAmount
      ? streamedAmount - withdrawnAmount
      : BigInt(0);

    const remainingAmount = depositAmount > streamedAmount
      ? depositAmount - streamedAmount
      : BigInt(0);

    // Calculate percentages
    const depositNumber = Number(depositAmount);
    const percentStreamed = depositNumber > 0
      ? (Number(streamedAmount) / depositNumber) * 100
      : 0;
    const percentWithdrawn = depositNumber > 0
      ? (Number(withdrawnAmount) / depositNumber) * 100
      : 0;
    const percentClaimable = depositNumber > 0
      ? (Number(claimableAmount) / depositNumber) * 100
      : 0;
    const percentRemaining = 100 - percentStreamed;

    // Format amounts
    const formatAmount = (amount: bigint): string => {
      const divisor = BigInt(10 ** stream.tokenDecimals);
      const integer = amount / divisor;
      const fractional = (amount % divisor).toString().padStart(stream.tokenDecimals, '0').slice(0, 4);
      return `${integer}.${fractional}`.replace(/\.?0+$/, '') || '0';
    };

    // Calculate rates
    const ratePerMinute = ratePerSecond * BigInt(60);
    const ratePerHour = ratePerSecond * BigInt(3600);
    const ratePerDay = ratePerSecond * BigInt(86400);

    return {
      percentStreamed: Math.min(100, Math.max(0, percentStreamed)),
      percentWithdrawn: Math.min(100, Math.max(0, percentWithdrawn)),
      percentClaimable: Math.min(100, Math.max(0, percentClaimable)),
      percentRemaining: Math.max(0, percentRemaining),

      streamedAmount: formatAmount(streamedAmount),
      withdrawnAmount: formatAmount(withdrawnAmount),
      claimableAmount: formatAmount(claimableAmount),
      remainingAmount: formatAmount(remainingAmount),

      elapsedTime,
      remainingTime,
      elapsedTimeFormatted: formatTime(elapsedTime),
      remainingTimeFormatted: formatTime(remainingTime),

      ratePerSecond: formatAmount(ratePerSecond),
      ratePerMinute: formatAmount(ratePerMinute),
      ratePerHour: formatAmount(ratePerHour),
      ratePerDay: formatAmount(ratePerDay),

      isStarted,
      isEnded,
      isPaused,

      startDate: new Date(startTime * 1000),
      endDate: new Date(endTime * 1000),
      estimatedCompletionDate: new Date(endTime * 1000),
    };
  }, [stream]);

  // Calculate milestones
  const milestones = useMemo((): StreamMilestone[] => {
    if (!stream) return [];

    const { startTime, duration, depositAmount, tokenDecimals } = stream;

    return MILESTONE_PERCENTAGES.map(percentage => {
      const amount = (depositAmount * BigInt(percentage)) / BigInt(100);
      const timeOffset = Math.floor((duration * percentage) / 100);
      const timestamp = startTime + timeOffset;

      const formatAmount = (amt: bigint): string => {
        const divisor = BigInt(10 ** tokenDecimals);
        const integer = amt / divisor;
        return integer.toString();
      };

      return {
        id: `milestone-${percentage}`,
        name: `${percentage}% Complete`,
        percentage,
        amount,
        amountFormatted: formatAmount(amount),
        timestamp,
        date: new Date(timestamp * 1000),
        reached: progress ? progress.percentStreamed >= percentage : false,
      };
    });
  }, [stream, progress]);

  // Find next milestone
  const nextMilestone = useMemo((): StreamMilestone | null => {
    return milestones.find(m => !m.reached) ?? null;
  }, [milestones]);

  // Is stream actively streaming
  const isActive = useMemo(() => {
    return (
      stream !== null &&
      stream.status === 'active' &&
      progress !== null &&
      progress.isStarted &&
      !progress.isEnded
    );
  }, [stream, progress]);

  // Update progress on interval
  useEffect(() => {
    if (!stream) {
      setProgress(null);
      return;
    }

    // Initial calculation
    setProgress(calculateProgress());

    // Set up interval for real-time updates
    if (stream.status === 'active') {
      const interval = setInterval(() => {
        setProgress(calculateProgress());
      }, updateInterval);

      return () => clearInterval(interval);
    }
  }, [stream, updateInterval, calculateProgress]);

  return {
    progress,
    isActive,
    nextMilestone,
    milestones,
  };
}

// Helper function to format time
function formatTime(seconds: number): string {
  if (seconds < 0) return '0s';

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts: string[] = [];

  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0 || days > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0 || hours > 0 || days > 0) {
    parts.push(`${minutes}m`);
  }
  if (parts.length === 0 || seconds < 60) {
    parts.push(`${secs}s`);
  }

  return parts.slice(0, 2).join(' ');
}

// Export utility for external use
export { formatTime as formatStreamTime };

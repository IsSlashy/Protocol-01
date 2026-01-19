/**
 * useCreateStream - Create new payment streams
 * @module hooks/streams/useCreateStream
 */

import { useState, useCallback, useMemo } from 'react';
import { useWallet } from '../wallet/useWallet';
import { useBalance } from '../wallet/useBalance';
import { useNetwork } from '../common/useNetwork';
import { useStealth } from '../stealth/useStealth';
import { useHaptics } from '../common/useHaptics';
import { Stream } from './useStreams';

export interface CreateStreamParams {
  recipient: string;
  tokenAddress: string;
  amount: string;
  duration: number; // seconds
  startTime?: number; // defaults to now
  useStealthAddress?: boolean;
  note?: string;
}

export interface StreamPreview {
  recipient: string;
  resolvedRecipient: string; // After ENS/stealth resolution
  tokenSymbol: string;
  tokenDecimals: number;
  amount: bigint;
  amountFormatted: string;
  duration: number;
  durationFormatted: string;
  ratePerSecond: bigint;
  ratePerDay: bigint;
  ratePerDayFormatted: string;
  startTime: number;
  endTime: number;
  estimatedGas: bigint;
  estimatedGasFormatted: string;
  isStealthStream: boolean;
}

export type CreateStreamStep =
  | 'idle'
  | 'validating'
  | 'resolving_recipient'
  | 'generating_stealth'
  | 'approving_token'
  | 'creating_stream'
  | 'waiting_confirmation'
  | 'completed'
  | 'failed';

interface UseCreateStreamReturn {
  step: CreateStreamStep;
  preview: StreamPreview | null;
  createdStream: Stream | null;
  error: Error | null;
  isLoading: boolean;
  canCreate: boolean;
  validateParams: (params: CreateStreamParams) => { valid: boolean; errors: string[] };
  generatePreview: (params: CreateStreamParams) => Promise<StreamPreview | null>;
  createStream: (params: CreateStreamParams) => Promise<Stream | null>;
  reset: () => void;
}

// Common durations
export const STREAM_DURATIONS = {
  HOUR: 3600,
  DAY: 86400,
  WEEK: 604800,
  MONTH: 2592000, // 30 days
  QUARTER: 7776000, // 90 days
  YEAR: 31536000, // 365 days
} as const;

export function useCreateStream(): UseCreateStreamReturn {
  const [step, setStep] = useState<CreateStreamStep>('idle');
  const [preview, setPreview] = useState<StreamPreview | null>(null);
  const [createdStream, setCreatedStream] = useState<Stream | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const { wallet, status: walletStatus } = useWallet();
  const { balance } = useBalance({ address: wallet?.address ?? null });
  const { isConnected, chainId } = useNetwork();
  const { generateStealthAddress } = useStealth();
  const { trigger } = useHaptics();

  const isLoading = useMemo(() => {
    return !['idle', 'completed', 'failed'].includes(step);
  }, [step]);

  const canCreate = useMemo(() => {
    return (
      walletStatus === 'unlocked' &&
      wallet !== null &&
      isConnected &&
      step === 'idle'
    );
  }, [walletStatus, wallet, isConnected, step]);

  const validateParams = useCallback((
    params: CreateStreamParams
  ): { valid: boolean; errors: string[] } => {
    const errors: string[] = [];

    // Validate recipient
    if (!params.recipient) {
      errors.push('Recipient address is required');
    } else if (!/^(0x[a-fA-F0-9]{40}|[a-zA-Z0-9-]+\.eth|st:eth:0x[a-fA-F0-9]+)$/.test(params.recipient)) {
      errors.push('Invalid recipient address');
    }

    // Validate token
    if (!params.tokenAddress) {
      errors.push('Token address is required');
    }

    // Validate amount
    if (!params.amount || parseFloat(params.amount) <= 0) {
      errors.push('Amount must be greater than 0');
    }

    // Check balance
    if (balance && params.tokenAddress) {
      const token = balance.tokens.find(
        t => t.address.toLowerCase() === params.tokenAddress.toLowerCase()
      );
      if (token) {
        const amountBigInt = parseAmount(params.amount, token.decimals);
        if (amountBigInt > token.balance) {
          errors.push('Insufficient token balance');
        }
      }
    }

    // Validate duration
    if (!params.duration || params.duration < 60) {
      errors.push('Duration must be at least 1 minute');
    }

    if (params.duration > STREAM_DURATIONS.YEAR * 5) {
      errors.push('Duration cannot exceed 5 years');
    }

    // Validate start time
    if (params.startTime && params.startTime < Math.floor(Date.now() / 1000)) {
      errors.push('Start time cannot be in the past');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }, [balance]);

  const generatePreview = useCallback(async (
    params: CreateStreamParams
  ): Promise<StreamPreview | null> => {
    setStep('validating');
    setError(null);

    try {
      const validation = validateParams(params);
      if (!validation.valid) {
        throw new Error(validation.errors.join(', '));
      }

      // Get token info
      const token = balance?.tokens.find(
        t => t.address.toLowerCase() === params.tokenAddress.toLowerCase()
      );

      const tokenSymbol = token?.symbol ?? 'TOKEN';
      const tokenDecimals = token?.decimals ?? 18;

      // Parse amount
      const amount = parseAmount(params.amount, tokenDecimals);

      // Resolve recipient
      setStep('resolving_recipient');
      let resolvedRecipient = params.recipient;
      let isStealthStream = params.useStealthAddress ?? false;

      if (params.recipient.endsWith('.eth')) {
        // Resolve ENS - placeholder
        resolvedRecipient = '0x' + '1'.repeat(40);
      } else if (params.recipient.startsWith('st:eth:')) {
        // Generate stealth address from meta-address
        setStep('generating_stealth');
        const stealth = await generateStealthAddress(params.recipient);
        if (stealth) {
          resolvedRecipient = stealth.stealthAddress;
          isStealthStream = true;
        } else {
          throw new Error('Failed to generate stealth address');
        }
      } else if (params.useStealthAddress) {
        // User wants stealth but provided regular address
        // They would need the recipient's stealth meta-address
        throw new Error('Stealth address requires recipient\'s stealth meta-address');
      }

      // Calculate stream parameters
      const startTime = params.startTime ?? Math.floor(Date.now() / 1000) + 60; // Start in 1 minute
      const endTime = startTime + params.duration;
      const ratePerSecond = amount / BigInt(params.duration);
      const ratePerDay = ratePerSecond * BigInt(86400);

      // Estimate gas
      const estimatedGas = BigInt(isStealthStream ? 300000 : 150000) * BigInt(30e9); // 30 gwei

      const previewData: StreamPreview = {
        recipient: params.recipient,
        resolvedRecipient,
        tokenSymbol,
        tokenDecimals,
        amount,
        amountFormatted: params.amount,
        duration: params.duration,
        durationFormatted: formatDuration(params.duration),
        ratePerSecond,
        ratePerDay,
        ratePerDayFormatted: formatAmount(ratePerDay, tokenDecimals),
        startTime,
        endTime,
        estimatedGas,
        estimatedGasFormatted: (Number(estimatedGas) / 1e18).toFixed(6),
        isStealthStream,
      };

      setPreview(previewData);
      setStep('idle');

      return previewData;
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to generate preview'));
      setStep('failed');
      return null;
    }
  }, [balance, validateParams, generateStealthAddress]);

  const createStream = useCallback(async (
    params: CreateStreamParams
  ): Promise<Stream | null> => {
    if (!canCreate || !wallet) {
      return null;
    }

    setError(null);

    try {
      // Generate preview if not already done
      const streamPreview = preview ?? await generatePreview(params);
      if (!streamPreview) {
        return null;
      }

      // Check token approval
      setStep('approving_token');
      // In real implementation: Check and request ERC20 approval
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Create stream
      setStep('creating_stream');

      // In real implementation: Call P-01 streaming contract
      await new Promise(resolve => setTimeout(resolve, 1500));

      setStep('waiting_confirmation');

      // Wait for confirmation
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Create stream object
      const now = Date.now();
      const newStream: Stream = {
        id: Math.random().toString(36).substring(7),
        contractAddress: '0x' + 'a'.repeat(40),
        sender: wallet.address,
        recipient: streamPreview.resolvedRecipient,
        tokenAddress: params.tokenAddress,
        tokenSymbol: streamPreview.tokenSymbol,
        tokenDecimals: streamPreview.tokenDecimals,
        depositAmount: streamPreview.amount,
        depositAmountFormatted: streamPreview.amountFormatted,
        withdrawnAmount: BigInt(0),
        withdrawnAmountFormatted: '0',
        remainingAmount: streamPreview.amount,
        remainingAmountFormatted: streamPreview.amountFormatted,
        streamedAmount: BigInt(0),
        streamedAmountFormatted: '0',
        claimableAmount: BigInt(0),
        claimableAmountFormatted: '0',
        ratePerSecond: streamPreview.ratePerSecond,
        startTime: streamPreview.startTime,
        endTime: streamPreview.endTime,
        duration: params.duration,
        status: streamPreview.startTime > Math.floor(now / 1000) ? 'pending' : 'active',
        direction: 'outgoing',
        isStealth: streamPreview.isStealthStream,
        stealthAddress: streamPreview.isStealthStream ? streamPreview.resolvedRecipient : undefined,
        note: params.note,
        createdAt: now,
        lastUpdatedAt: now,
      };

      setCreatedStream(newStream);
      setStep('completed');
      trigger('success');

      return newStream;
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to create stream'));
      setStep('failed');
      trigger('error');
      return null;
    }
  }, [canCreate, wallet, preview, generatePreview, trigger]);

  const reset = useCallback(() => {
    setStep('idle');
    setPreview(null);
    setCreatedStream(null);
    setError(null);
  }, []);

  return {
    step,
    preview,
    createdStream,
    error,
    isLoading,
    canCreate,
    validateParams,
    generatePreview,
    createStream,
    reset,
  };
}

// Helper functions
function parseAmount(amount: string, decimals: number): bigint {
  const [integer, decimal = ''] = amount.split('.');
  const paddedDecimal = decimal.padEnd(decimals, '0').slice(0, decimals);
  return BigInt(integer + paddedDecimal);
}

function formatAmount(amount: bigint, decimals: number): string {
  const divisor = BigInt(10 ** decimals);
  const integer = amount / divisor;
  const fractional = (amount % divisor).toString().padStart(decimals, '0').slice(0, 4);
  return `${integer}.${fractional}`.replace(/\.?0+$/, '');
}

function formatDuration(seconds: number): string {
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)} minutes`;
  } else if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)} hours`;
  } else if (seconds < 604800) {
    return `${Math.floor(seconds / 86400)} days`;
  } else if (seconds < 2592000) {
    return `${Math.floor(seconds / 604800)} weeks`;
  } else if (seconds < 31536000) {
    return `${Math.floor(seconds / 2592000)} months`;
  } else {
    return `${(seconds / 31536000).toFixed(1)} years`;
  }
}

/**
 * React Hook for x402 Payments
 *
 * Provides easy-to-use x402 payment functionality for React components.
 */

import { useState, useCallback, useMemo } from 'react';
import { Keypair } from '@solana/web3.js';
import {
  x402Fetch,
  PaymentRequirement,
  PaymentPayload,
  formatX402Amount,
  X402Network,
} from '../services/x402';
import { useWalletStore } from '../store/wallet';

// Payment status
export type PaymentStatus = 'idle' | 'pending' | 'confirming' | 'success' | 'error';

// Hook state
interface UseX402State {
  status: PaymentStatus;
  error: string | null;
  lastPayment: PaymentPayload | null;
  pendingRequirement: PaymentRequirement | null;
  totalPaid: number; // Total lamports paid in this session
}

// Hook return type
interface UseX402Return extends UseX402State {
  // Fetch with automatic payment
  fetch: (url: string, options?: RequestInit) => Promise<Response>;
  // Manual payment approval
  approvePayment: () => Promise<void>;
  rejectPayment: () => void;
  // Reset state
  reset: () => void;
  // Formatting helpers
  formatAmount: (lamports: number | string) => string;
}

// Default max payment per request (0.01 SOL)
const DEFAULT_MAX_AMOUNT = 10_000_000;

/**
 * Hook for x402 automatic payments
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { fetch, status, pendingRequirement } = useX402();
 *
 *   const loadData = async () => {
 *     const response = await fetch('https://api.example.com/data');
 *     const data = await response.json();
 *   };
 *
 *   return (
 *     <div>
 *       {pendingRequirement && (
 *         <PaymentModal
 *           amount={pendingRequirement.amount}
 *           onApprove={approvePayment}
 *           onReject={rejectPayment}
 *         />
 *       )}
 *     </div>
 *   );
 * }
 * ```
 */
export function useX402(options: {
  maxAmount?: number;
  autoApprove?: boolean;
  network?: X402Network;
} = {}): UseX402Return {
  const {
    maxAmount = DEFAULT_MAX_AMOUNT,
    autoApprove = false,
    network = 'solana:devnet',
  } = options;

  // Get keypair from wallet store
  const { _keypair, network: walletNetwork } = useWalletStore();

  // State
  const [state, setState] = useState<UseX402State>({
    status: 'idle',
    error: null,
    lastPayment: null,
    pendingRequirement: null,
    totalPaid: 0,
  });

  // Pending payment resolver
  const [paymentResolver, setPaymentResolver] = useState<{
    resolve: (value: boolean) => void;
  } | null>(null);

  // RPC endpoint based on network
  const rpcEndpoint = useMemo(() => {
    const net = walletNetwork || 'devnet';
    return net === 'mainnet-beta'
      ? 'https://api.mainnet-beta.solana.com'
      : 'https://api.devnet.solana.com';
  }, [walletNetwork]);

  // Fetch with x402 payment handling
  const fetchWithPayment = useCallback(async (
    url: string,
    fetchOptions?: RequestInit
  ): Promise<Response> => {
    if (!_keypair) {
      throw new Error('Wallet not unlocked');
    }

    setState(prev => ({ ...prev, status: 'pending', error: null }));

    try {
      const response = await x402Fetch(url, {
        ...fetchOptions,
        keypair: _keypair,
        maxAmount,
        rpcEndpoint,
        autoPay: autoApprove,
        onPaymentRequired: async (requirement) => {
          // If auto-approve, just pay
          if (autoApprove) {
            return true;
          }

          // Otherwise, show confirmation UI
          setState(prev => ({
            ...prev,
            status: 'confirming',
            pendingRequirement: requirement,
          }));

          // Wait for user decision
          return new Promise<boolean>((resolve) => {
            setPaymentResolver({ resolve });
          });
        },
        onPaymentMade: (payload) => {
          setState(prev => ({
            ...prev,
            lastPayment: payload,
            totalPaid: prev.totalPaid + parseInt(state.pendingRequirement?.amount || '0'),
          }));
        },
      });

      setState(prev => ({
        ...prev,
        status: 'success',
        pendingRequirement: null,
      }));

      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Payment failed';
      setState(prev => ({
        ...prev,
        status: 'error',
        error: message,
        pendingRequirement: null,
      }));
      throw error;
    }
  }, [_keypair, maxAmount, rpcEndpoint, autoApprove]);

  // Approve pending payment
  const approvePayment = useCallback(async () => {
    if (paymentResolver) {
      paymentResolver.resolve(true);
      setPaymentResolver(null);
    }
  }, [paymentResolver]);

  // Reject pending payment
  const rejectPayment = useCallback(() => {
    if (paymentResolver) {
      paymentResolver.resolve(false);
      setPaymentResolver(null);
      setState(prev => ({
        ...prev,
        status: 'idle',
        pendingRequirement: null,
      }));
    }
  }, [paymentResolver]);

  // Reset state
  const reset = useCallback(() => {
    setState({
      status: 'idle',
      error: null,
      lastPayment: null,
      pendingRequirement: null,
      totalPaid: 0,
    });
  }, []);

  return {
    ...state,
    fetch: fetchWithPayment,
    approvePayment,
    rejectPayment,
    reset,
    formatAmount: formatX402Amount,
  };
}

/**
 * Hook for tracking x402 payment history
 */
export function useX402History() {
  const [payments, setPayments] = useState<PaymentPayload[]>([]);

  const addPayment = useCallback((payment: PaymentPayload) => {
    setPayments(prev => [payment, ...prev]);
  }, []);

  const clearHistory = useCallback(() => {
    setPayments([]);
  }, []);

  const totalPaid = useMemo(() => {
    // Note: We'd need to track amounts separately
    // For now, just return count
    return payments.length;
  }, [payments]);

  return {
    payments,
    addPayment,
    clearHistory,
    totalPaid,
  };
}

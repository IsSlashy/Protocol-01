/**
 * usePayments - Hook for managing payment requests in chat
 * @module hooks/social/usePayments
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useWalletStore } from '@/stores/walletStore';
import {
  PaymentRequest,
  PaymentSent,
  ChatPaymentMessage,
  PaymentRequestStatus,
  SupportedToken,
  createPaymentRequest,
  payRequest,
  declineRequest,
  sendCryptoInChat,
  updateExpiredRequests,
  isRequestExpired,
  createChatPaymentMessage,
  SUPPORTED_TOKENS,
} from '@/services/payments/paymentRequest';

// Storage keys
const PAYMENT_REQUESTS_KEY = '@p01_chat_payment_requests';
const PAYMENTS_SENT_KEY = '@p01_chat_payments_sent';

export interface TokenBalance {
  symbol: string;
  balance: number;
  usdValue?: number;
}

export interface CreatePaymentRequestParams {
  recipientAddress: string;
  amount: number;
  token: SupportedToken;
  note?: string;
  expiresIn?: number;
}

export interface SendPaymentParams {
  recipientAddress: string;
  amount: number;
  token: SupportedToken;
  note?: string;
}

export interface UsePaymentsReturn {
  // State
  isLoading: boolean;
  isProcessing: boolean;
  error: string | null;

  // Payment requests
  paymentRequests: PaymentRequest[];
  pendingRequests: PaymentRequest[];
  incomingRequests: PaymentRequest[];
  outgoingRequests: PaymentRequest[];

  // Payments sent
  paymentsSent: PaymentSent[];

  // Token balances
  tokenBalances: Record<string, TokenBalance>;

  // Actions
  createRequest: (params: CreatePaymentRequestParams) => Promise<PaymentRequest | null>;
  payPaymentRequest: (request: PaymentRequest) => Promise<PaymentSent | null>;
  declinePaymentRequest: (request: PaymentRequest) => Promise<PaymentRequest | null>;
  sendPayment: (params: SendPaymentParams) => Promise<PaymentSent | null>;
  refreshPayments: () => Promise<void>;
  clearError: () => void;

  // Helpers
  getRequestById: (id: string) => PaymentRequest | undefined;
  getRequestsForPeer: (peerAddress: string) => PaymentRequest[];
  getPaymentsForPeer: (peerAddress: string) => PaymentSent[];
  getChatMessagesForPeer: (peerAddress: string) => ChatPaymentMessage[];
}

export function usePayments(): UsePaymentsReturn {
  const [isLoading, setIsLoading] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paymentRequests, setPaymentRequests] = useState<PaymentRequest[]>([]);
  const [paymentsSent, setPaymentsSent] = useState<PaymentSent[]>([]);

  const { publicKey, balance, refreshBalance } = useWalletStore();

  // Load payments from storage
  const loadPayments = useCallback(async () => {
    try {
      setIsLoading(true);

      const [requestsData, paymentsData] = await Promise.all([
        AsyncStorage.getItem(PAYMENT_REQUESTS_KEY),
        AsyncStorage.getItem(PAYMENTS_SENT_KEY),
      ]);

      let requests: PaymentRequest[] = requestsData ? JSON.parse(requestsData) : [];
      const payments: PaymentSent[] = paymentsData ? JSON.parse(paymentsData) : [];

      // Update expired requests
      requests = updateExpiredRequests(requests);

      setPaymentRequests(requests);
      setPaymentsSent(payments);

      // Save updated requests if any expired
      await AsyncStorage.setItem(PAYMENT_REQUESTS_KEY, JSON.stringify(requests));
    } catch (err) {
      console.error('Failed to load payments:', err);
      setError('Failed to load payment data');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    loadPayments();
  }, [loadPayments]);

  // Check for expired requests periodically
  useEffect(() => {
    const interval = setInterval(() => {
      setPaymentRequests((prev) => {
        const updated = updateExpiredRequests(prev);
        // Only save if something changed
        if (JSON.stringify(updated) !== JSON.stringify(prev)) {
          AsyncStorage.setItem(PAYMENT_REQUESTS_KEY, JSON.stringify(updated));
        }
        return updated;
      });
    }, 60000); // Check every minute

    return () => clearInterval(interval);
  }, []);

  // Compute token balances from wallet store
  const tokenBalances = useMemo<Record<string, TokenBalance>>(() => {
    const balances: Record<string, TokenBalance> = {};

    // SOL balance
    balances.SOL = {
      symbol: 'SOL',
      balance: balance?.sol || 0,
      usdValue: balance?.solUsd || 0,
    };

    // Token balances
    if (balance?.tokens) {
      for (const token of balance.tokens) {
        const symbol = token.symbol.toUpperCase();
        if (SUPPORTED_TOKENS.includes(symbol as SupportedToken)) {
          balances[symbol] = {
            symbol,
            balance: token.balance,
            usdValue: token.usdValue,
          };
        }
      }
    }

    // Ensure all supported tokens have an entry
    for (const token of SUPPORTED_TOKENS) {
      if (!balances[token]) {
        balances[token] = {
          symbol: token,
          balance: 0,
          usdValue: 0,
        };
      }
    }

    return balances;
  }, [balance]);

  // Filtered lists
  const pendingRequests = useMemo(
    () => paymentRequests.filter((r) => r.status === 'pending'),
    [paymentRequests]
  );

  const incomingRequests = useMemo(
    () =>
      paymentRequests.filter(
        (r) => r.recipientId === publicKey && r.status === 'pending'
      ),
    [paymentRequests, publicKey]
  );

  const outgoingRequests = useMemo(
    () =>
      paymentRequests.filter(
        (r) => r.requesterId === publicKey && r.status === 'pending'
      ),
    [paymentRequests, publicKey]
  );

  // Create a new payment request
  const createRequest = useCallback(
    async (params: CreatePaymentRequestParams): Promise<PaymentRequest | null> => {
      if (!publicKey) {
        setError('Wallet not connected');
        return null;
      }

      try {
        setIsProcessing(true);
        setError(null);

        const request = createPaymentRequest({
          requesterId: publicKey,
          recipientId: params.recipientAddress,
          amount: params.amount,
          token: params.token,
          note: params.note,
          expiresIn: params.expiresIn,
        });

        const updatedRequests = [...paymentRequests, request];
        setPaymentRequests(updatedRequests);
        await AsyncStorage.setItem(
          PAYMENT_REQUESTS_KEY,
          JSON.stringify(updatedRequests)
        );

        return request;
      } catch (err) {
        const errorMessage = (err as Error).message || 'Failed to create request';
        setError(errorMessage);
        return null;
      } finally {
        setIsProcessing(false);
      }
    },
    [publicKey, paymentRequests]
  );

  // Pay a payment request
  const payPaymentRequest = useCallback(
    async (request: PaymentRequest): Promise<PaymentSent | null> => {
      if (!publicKey) {
        setError('Wallet not connected');
        return null;
      }

      if (request.recipientId !== publicKey) {
        setError('You can only pay requests addressed to you');
        return null;
      }

      try {
        setIsProcessing(true);
        setError(null);

        // Execute payment
        const { signature, updatedRequest } = await payRequest(request);

        // Update request in storage
        const updatedRequests = paymentRequests.map((r) =>
          r.id === request.id ? updatedRequest : r
        );
        setPaymentRequests(updatedRequests);
        await AsyncStorage.setItem(
          PAYMENT_REQUESTS_KEY,
          JSON.stringify(updatedRequests)
        );

        // Create payment sent record
        const payment: PaymentSent = {
          id: `sent_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
          senderId: publicKey,
          recipientId: request.requesterId,
          amount: request.amount,
          token: request.token,
          tokenMint: request.tokenMint,
          note: request.note,
          txSignature: signature,
          timestamp: Date.now(),
        };

        const updatedPayments = [...paymentsSent, payment];
        setPaymentsSent(updatedPayments);
        await AsyncStorage.setItem(
          PAYMENTS_SENT_KEY,
          JSON.stringify(updatedPayments)
        );

        // Refresh wallet balance
        setTimeout(() => refreshBalance(), 2000);

        return payment;
      } catch (err) {
        const errorMessage = (err as Error).message || 'Payment failed';
        setError(errorMessage);
        return null;
      } finally {
        setIsProcessing(false);
      }
    },
    [publicKey, paymentRequests, paymentsSent, refreshBalance]
  );

  // Decline a payment request
  const declinePaymentRequest = useCallback(
    async (request: PaymentRequest): Promise<PaymentRequest | null> => {
      if (!publicKey) {
        setError('Wallet not connected');
        return null;
      }

      if (request.recipientId !== publicKey) {
        setError('You can only decline requests addressed to you');
        return null;
      }

      try {
        setIsProcessing(true);
        setError(null);

        const updatedRequest = declineRequest(request);

        const updatedRequests = paymentRequests.map((r) =>
          r.id === request.id ? updatedRequest : r
        );
        setPaymentRequests(updatedRequests);
        await AsyncStorage.setItem(
          PAYMENT_REQUESTS_KEY,
          JSON.stringify(updatedRequests)
        );

        return updatedRequest;
      } catch (err) {
        const errorMessage = (err as Error).message || 'Failed to decline request';
        setError(errorMessage);
        return null;
      } finally {
        setIsProcessing(false);
      }
    },
    [publicKey, paymentRequests]
  );

  // Send a payment directly (not in response to a request)
  const sendPayment = useCallback(
    async (params: SendPaymentParams): Promise<PaymentSent | null> => {
      if (!publicKey) {
        setError('Wallet not connected');
        return null;
      }

      try {
        setIsProcessing(true);
        setError(null);

        const { signature, payment } = await sendCryptoInChat({
          senderAddress: publicKey,
          recipientAddress: params.recipientAddress,
          amount: params.amount,
          token: params.token,
          note: params.note,
        });

        const updatedPayments = [...paymentsSent, payment];
        setPaymentsSent(updatedPayments);
        await AsyncStorage.setItem(
          PAYMENTS_SENT_KEY,
          JSON.stringify(updatedPayments)
        );

        // Refresh wallet balance
        setTimeout(() => refreshBalance(), 2000);

        return payment;
      } catch (err) {
        const errorMessage = (err as Error).message || 'Failed to send payment';
        setError(errorMessage);
        return null;
      } finally {
        setIsProcessing(false);
      }
    },
    [publicKey, paymentsSent, refreshBalance]
  );

  // Refresh payments from storage
  const refreshPayments = useCallback(async () => {
    await loadPayments();
  }, [loadPayments]);

  // Clear error
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // Get request by ID
  const getRequestById = useCallback(
    (id: string) => paymentRequests.find((r) => r.id === id),
    [paymentRequests]
  );

  // Get requests for a specific peer
  const getRequestsForPeer = useCallback(
    (peerAddress: string) =>
      paymentRequests.filter(
        (r) => r.requesterId === peerAddress || r.recipientId === peerAddress
      ),
    [paymentRequests]
  );

  // Get payments for a specific peer
  const getPaymentsForPeer = useCallback(
    (peerAddress: string) =>
      paymentsSent.filter(
        (p) => p.senderId === peerAddress || p.recipientId === peerAddress
      ),
    [paymentsSent]
  );

  // Get chat messages for a specific peer (combined requests and payments)
  const getChatMessagesForPeer = useCallback(
    (peerAddress: string): ChatPaymentMessage[] => {
      const messages: ChatPaymentMessage[] = [];

      // Add payment requests
      for (const request of paymentRequests) {
        if (
          request.requesterId === peerAddress ||
          request.recipientId === peerAddress
        ) {
          messages.push(createChatPaymentMessage(request, 'payment_request'));
        }
      }

      // Add payments sent
      for (const payment of paymentsSent) {
        if (
          payment.senderId === peerAddress ||
          payment.recipientId === peerAddress
        ) {
          messages.push({
            id: payment.id,
            type: 'payment_sent',
            senderId: payment.senderId,
            recipientId: payment.recipientId,
            amount: payment.amount,
            token: payment.token,
            tokenMint: payment.tokenMint,
            note: payment.note,
            status: 'paid',
            txSignature: payment.txSignature,
            timestamp: payment.timestamp,
          });
        }
      }

      // Sort by timestamp
      messages.sort((a, b) => a.timestamp - b.timestamp);

      return messages;
    },
    [paymentRequests, paymentsSent]
  );

  return {
    isLoading,
    isProcessing,
    error,
    paymentRequests,
    pendingRequests,
    incomingRequests,
    outgoingRequests,
    paymentsSent,
    tokenBalances,
    createRequest,
    payPaymentRequest,
    declinePaymentRequest,
    sendPayment,
    refreshPayments,
    clearError,
    getRequestById,
    getRequestsForPeer,
    getPaymentsForPeer,
    getChatMessagesForPeer,
  };
}

export default usePayments;

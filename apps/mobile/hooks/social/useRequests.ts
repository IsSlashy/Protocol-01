/**
 * useRequests - Manage payment requests
 * @module hooks/social/useRequests
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAsyncStorage, ASYNC_KEYS } from '../storage/useAsyncStorage';
import { useWallet } from '../wallet/useWallet';
import { useContacts } from './useContacts';

export type RequestStatus =
  | 'pending'    // Waiting for payment
  | 'paid'       // Payment received
  | 'cancelled'  // Cancelled by requester
  | 'declined'   // Declined by payer
  | 'expired';   // Past expiration date

export type RequestDirection = 'incoming' | 'outgoing';

export interface PaymentRequest {
  id: string;
  direction: RequestDirection;
  requester: string; // Address of who is requesting payment
  payer: string; // Address of who should pay
  amount: string;
  amountBigInt: bigint;
  tokenAddress?: string; // Native token if not specified
  tokenSymbol: string;
  tokenDecimals: number;
  note?: string;
  status: RequestStatus;
  createdAt: number;
  expiresAt?: number;
  paidAt?: number;
  paidTxHash?: string;
  // For stealth requests
  useStealthAddress: boolean;
  stealthMetaAddress?: string;
}

interface UseRequestsOptions {
  filterStatus?: RequestStatus[];
  filterDirection?: RequestDirection;
}

interface UseRequestsReturn {
  requests: PaymentRequest[];
  incomingRequests: PaymentRequest[];
  outgoingRequests: PaymentRequest[];
  pendingRequests: PaymentRequest[];
  isLoading: boolean;
  error: Error | null;
  createRequest: (params: CreateRequestParams) => Promise<PaymentRequest | null>;
  cancelRequest: (requestId: string) => Promise<boolean>;
  declineRequest: (requestId: string) => Promise<boolean>;
  markAsPaid: (requestId: string, txHash: string) => Promise<boolean>;
  getRequest: (requestId: string) => PaymentRequest | undefined;
  shareRequest: (request: PaymentRequest) => string;
  importRequest: (data: string) => PaymentRequest | null;
  refresh: () => Promise<void>;
}

interface CreateRequestParams {
  payer: string;
  amount: string;
  tokenAddress?: string;
  tokenSymbol?: string;
  tokenDecimals?: number;
  note?: string;
  expiresIn?: number; // seconds from now
  useStealthAddress?: boolean;
}

const REQUEST_EXPIRY_DEFAULT = 7 * 24 * 60 * 60; // 7 days

export function useRequests(options: UseRequestsOptions = {}): UseRequestsReturn {
  const { filterStatus, filterDirection } = options;

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const { wallet } = useWallet();
  const { getContactByAddress } = useContacts();

  const {
    value: requests,
    setValue: setRequests,
    refresh: refreshRequests,
  } = useAsyncStorage<PaymentRequest[]>({
    key: `${ASYNC_KEYS.CONTACTS}_payment_requests`,
    defaultValue: [],
  });

  const requestList = requests ?? [];

  // Check for expired requests
  useEffect(() => {
    const now = Date.now();
    let hasExpired = false;

    const updatedRequests = requestList.map(req => {
      if (
        req.status === 'pending' &&
        req.expiresAt &&
        req.expiresAt < now
      ) {
        hasExpired = true;
        return { ...req, status: 'expired' as RequestStatus };
      }
      return req;
    });

    if (hasExpired) {
      setRequests(updatedRequests);
    }

    setIsLoading(false);
  }, [requestList, setRequests]);

  // Apply filters
  const filteredRequests = useMemo(() => {
    let result = [...requestList];

    if (filterStatus) {
      result = result.filter(r => filterStatus.includes(r.status));
    }

    if (filterDirection) {
      result = result.filter(r => r.direction === filterDirection);
    }

    // Sort by creation date (newest first)
    result.sort((a, b) => b.createdAt - a.createdAt);

    return result;
  }, [requestList, filterStatus, filterDirection]);

  // Derived lists
  const incomingRequests = useMemo(
    () => filteredRequests.filter(r => r.direction === 'incoming'),
    [filteredRequests]
  );

  const outgoingRequests = useMemo(
    () => filteredRequests.filter(r => r.direction === 'outgoing'),
    [filteredRequests]
  );

  const pendingRequests = useMemo(
    () => filteredRequests.filter(r => r.status === 'pending'),
    [filteredRequests]
  );

  const createRequest = useCallback(async (
    params: CreateRequestParams
  ): Promise<PaymentRequest | null> => {
    if (!wallet) {
      setError(new Error('Wallet not available'));
      return null;
    }

    try {
      const now = Date.now();
      const expiresAt = params.expiresIn
        ? now + params.expiresIn * 1000
        : now + REQUEST_EXPIRY_DEFAULT * 1000;

      // Parse amount to bigint
      const decimals = params.tokenDecimals ?? 18;
      const [integer, decimal = ''] = params.amount.split('.');
      const paddedDecimal = decimal.padEnd(decimals, '0').slice(0, decimals);
      const amountBigInt = BigInt(integer + paddedDecimal);

      const newRequest: PaymentRequest = {
        id: generateRequestId(),
        direction: 'outgoing', // We are requesting payment
        requester: wallet.address,
        payer: params.payer,
        amount: params.amount,
        amountBigInt,
        tokenAddress: params.tokenAddress,
        tokenSymbol: params.tokenSymbol ?? 'ETH',
        tokenDecimals: decimals,
        note: params.note,
        status: 'pending',
        createdAt: now,
        expiresAt,
        useStealthAddress: params.useStealthAddress ?? false,
        stealthMetaAddress: params.useStealthAddress ? wallet.stealthMetaAddress : undefined,
      };

      await setRequests([newRequest, ...requestList]);

      return newRequest;
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to create request'));
      return null;
    }
  }, [wallet, requestList, setRequests]);

  const updateRequestStatus = useCallback(async (
    requestId: string,
    status: RequestStatus,
    additionalData?: Partial<PaymentRequest>
  ): Promise<boolean> => {
    try {
      const index = requestList.findIndex(r => r.id === requestId);
      if (index === -1) {
        setError(new Error('Request not found'));
        return false;
      }

      const updatedRequests = [...requestList];
      updatedRequests[index] = {
        ...updatedRequests[index],
        status,
        ...additionalData,
      };

      await setRequests(updatedRequests);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to update request'));
      return false;
    }
  }, [requestList, setRequests]);

  const cancelRequest = useCallback(async (requestId: string): Promise<boolean> => {
    const request = requestList.find(r => r.id === requestId);
    if (!request || request.direction !== 'outgoing' || request.status !== 'pending') {
      setError(new Error('Cannot cancel this request'));
      return false;
    }

    return updateRequestStatus(requestId, 'cancelled');
  }, [requestList, updateRequestStatus]);

  const declineRequest = useCallback(async (requestId: string): Promise<boolean> => {
    const request = requestList.find(r => r.id === requestId);
    if (!request || request.direction !== 'incoming' || request.status !== 'pending') {
      setError(new Error('Cannot decline this request'));
      return false;
    }

    return updateRequestStatus(requestId, 'declined');
  }, [requestList, updateRequestStatus]);

  const markAsPaid = useCallback(async (
    requestId: string,
    txHash: string
  ): Promise<boolean> => {
    return updateRequestStatus(requestId, 'paid', {
      paidAt: Date.now(),
      paidTxHash: txHash,
    });
  }, [updateRequestStatus]);

  const getRequest = useCallback((requestId: string): PaymentRequest | undefined => {
    return requestList.find(r => r.id === requestId);
  }, [requestList]);

  // Share request as encoded string
  const shareRequest = useCallback((request: PaymentRequest): string => {
    const shareData = {
      id: request.id,
      requester: request.requester,
      amount: request.amount,
      tokenAddress: request.tokenAddress,
      tokenSymbol: request.tokenSymbol,
      tokenDecimals: request.tokenDecimals,
      note: request.note,
      expiresAt: request.expiresAt,
      useStealthAddress: request.useStealthAddress,
      stealthMetaAddress: request.stealthMetaAddress,
    };

    // Create shareable link/code
    const encoded = Buffer.from(JSON.stringify(shareData)).toString('base64');
    return `p01://request/${encoded}`;
  }, []);

  // Import request from shared data
  const importRequest = useCallback((data: string): PaymentRequest | null => {
    if (!wallet) return null;

    try {
      // Parse the shared data
      const match = data.match(/p01:\/\/request\/(.+)/);
      if (!match) return null;

      const decoded = JSON.parse(Buffer.from(match[1], 'base64').toString());

      // Check if this request is for us
      // In a real app, we'd verify the payer address matches or use signatures

      const importedRequest: PaymentRequest = {
        ...decoded,
        direction: 'incoming', // We received a request to pay
        payer: wallet.address,
        amountBigInt: BigInt(0), // Would need to recalculate
        status: 'pending',
        createdAt: Date.now(),
      };

      // Add to our requests
      setRequests([importedRequest, ...requestList]);

      return importedRequest;
    } catch {
      setError(new Error('Invalid request data'));
      return null;
    }
  }, [wallet, requestList, setRequests]);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    await refreshRequests();
    setIsLoading(false);
  }, [refreshRequests]);

  return {
    requests: filteredRequests,
    incomingRequests,
    outgoingRequests,
    pendingRequests,
    isLoading,
    error,
    createRequest,
    cancelRequest,
    declineRequest,
    markAsPaid,
    getRequest,
    shareRequest,
    importRequest,
    refresh,
  };
}

function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

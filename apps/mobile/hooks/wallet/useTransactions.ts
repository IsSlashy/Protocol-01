/**
 * useTransactions - Transaction history management
 * @module hooks/wallet/useTransactions
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAsyncStorage, ASYNC_KEYS } from '../storage/useAsyncStorage';
import { useNetwork } from '../common/useNetwork';

export type TransactionType =
  | 'send'
  | 'receive'
  | 'stealth_send'
  | 'stealth_receive'
  | 'stream_create'
  | 'stream_claim'
  | 'swap'
  | 'approve'
  | 'contract_interaction';

export type TransactionStatus =
  | 'pending'
  | 'confirmed'
  | 'failed'
  | 'cancelled';

export interface Transaction {
  id: string;
  hash: string;
  type: TransactionType;
  status: TransactionStatus;
  from: string;
  to: string;
  value: bigint;
  valueFormatted: string;
  tokenAddress?: string;
  tokenSymbol?: string;
  tokenDecimals?: number;
  gasUsed?: bigint;
  gasPrice?: bigint;
  fee?: bigint;
  feeFormatted?: string;
  timestamp: number;
  blockNumber?: number;
  confirmations: number;
  nonce: number;
  data?: string;
  // Stealth-specific
  isPrivate: boolean;
  stealthAddress?: string;
  // Stream-specific
  streamId?: string;
  // Metadata
  note?: string;
  contactName?: string;
}

export interface TransactionFilter {
  types?: TransactionType[];
  status?: TransactionStatus[];
  fromDate?: number;
  toDate?: number;
  minValue?: bigint;
  maxValue?: bigint;
  tokenAddress?: string;
  isPrivate?: boolean;
  search?: string;
}

interface UseTransactionsOptions {
  address: string | null;
  limit?: number;
  filter?: TransactionFilter;
  autoRefresh?: boolean;
  refreshInterval?: number;
}

interface UseTransactionsReturn {
  transactions: Transaction[];
  isLoading: boolean;
  isRefreshing: boolean;
  error: Error | null;
  hasMore: boolean;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  getTransaction: (hash: string) => Transaction | undefined;
  addPendingTransaction: (tx: Partial<Transaction>) => void;
  updateTransaction: (hash: string, updates: Partial<Transaction>) => void;
  filterTransactions: (filter: TransactionFilter) => Transaction[];
  stats: TransactionStats;
}

interface TransactionStats {
  totalSent: bigint;
  totalReceived: bigint;
  totalFees: bigint;
  transactionCount: number;
  privateTransactionCount: number;
}

const DEFAULT_LIMIT = 50;
const DEFAULT_REFRESH_INTERVAL = 60000; // 1 minute

export function useTransactions({
  address,
  limit = DEFAULT_LIMIT,
  filter,
  autoRefresh = true,
  refreshInterval = DEFAULT_REFRESH_INTERVAL,
}: UseTransactionsOptions): UseTransactionsReturn {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [page, setPage] = useState(0);

  const { value: cachedTxs, setValue: setCachedTxs } = useAsyncStorage<Transaction[]>({
    key: ASYNC_KEYS.RECENT_TRANSACTIONS,
    defaultValue: [],
  });

  const { isConnected } = useNetwork();

  const fetchTransactions = useCallback(async (
    pageNum: number = 0,
    isRefresh = false
  ) => {
    if (!address || !isConnected) {
      setTransactions([]);
      setIsLoading(false);
      return;
    }

    if (isRefresh) {
      setIsRefreshing(true);
    } else if (pageNum === 0) {
      setIsLoading(true);
    }
    setError(null);

    try {
      // Fetch from blockchain/indexer
      // In real implementation, use Etherscan API, The Graph, or custom indexer
      const offset = pageNum * limit;

      // Placeholder transactions
      const fetchedTxs: Transaction[] = [
        {
          id: '1',
          hash: '0x' + '1'.repeat(64),
          type: 'send',
          status: 'confirmed',
          from: address,
          to: '0x' + '2'.repeat(40),
          value: BigInt('100000000000000000'),
          valueFormatted: '0.1',
          timestamp: Date.now() - 3600000,
          confirmations: 12,
          nonce: 1,
          isPrivate: false,
        },
        {
          id: '2',
          hash: '0x' + '3'.repeat(64),
          type: 'stealth_receive',
          status: 'confirmed',
          from: '0x' + '4'.repeat(40),
          to: address,
          value: BigInt('500000000000000000'),
          valueFormatted: '0.5',
          timestamp: Date.now() - 7200000,
          confirmations: 24,
          nonce: 0,
          isPrivate: true,
          stealthAddress: '0x' + '5'.repeat(40),
        },
      ];

      if (pageNum === 0) {
        setTransactions(fetchedTxs);
        // Cache for offline access
        await setCachedTxs(fetchedTxs);
      } else {
        setTransactions(prev => [...prev, ...fetchedTxs]);
      }

      setHasMore(fetchedTxs.length === limit);
      setPage(pageNum);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to fetch transactions'));

      // Use cached transactions as fallback
      if (cachedTxs && pageNum === 0) {
        setTransactions(cachedTxs);
      }
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [address, isConnected, limit, cachedTxs, setCachedTxs]);

  // Initial fetch
  useEffect(() => {
    fetchTransactions(0);
  }, [fetchTransactions]);

  // Auto refresh
  useEffect(() => {
    if (!autoRefresh || !address) return;

    const interval = setInterval(() => {
      fetchTransactions(0, true);
    }, refreshInterval);

    return () => clearInterval(interval);
  }, [autoRefresh, refreshInterval, address, fetchTransactions]);

  const refresh = useCallback(async () => {
    await fetchTransactions(0, true);
  }, [fetchTransactions]);

  const loadMore = useCallback(async () => {
    if (!hasMore || isLoading) return;
    await fetchTransactions(page + 1);
  }, [hasMore, isLoading, page, fetchTransactions]);

  const getTransaction = useCallback((hash: string): Transaction | undefined => {
    return transactions.find(tx => tx.hash.toLowerCase() === hash.toLowerCase());
  }, [transactions]);

  const addPendingTransaction = useCallback((tx: Partial<Transaction>) => {
    const pendingTx: Transaction = {
      id: tx.hash ?? `pending-${Date.now()}`,
      hash: tx.hash ?? '',
      type: tx.type ?? 'send',
      status: 'pending',
      from: tx.from ?? '',
      to: tx.to ?? '',
      value: tx.value ?? BigInt(0),
      valueFormatted: tx.valueFormatted ?? '0',
      timestamp: Date.now(),
      confirmations: 0,
      nonce: tx.nonce ?? 0,
      isPrivate: tx.isPrivate ?? false,
      ...tx,
    };

    setTransactions(prev => [pendingTx, ...prev]);
  }, []);

  const updateTransaction = useCallback((
    hash: string,
    updates: Partial<Transaction>
  ) => {
    setTransactions(prev =>
      prev.map(tx =>
        tx.hash.toLowerCase() === hash.toLowerCase()
          ? { ...tx, ...updates }
          : tx
      )
    );
  }, []);

  const filterTransactions = useCallback((
    filterCriteria: TransactionFilter
  ): Transaction[] => {
    return transactions.filter(tx => {
      if (filterCriteria.types && !filterCriteria.types.includes(tx.type)) {
        return false;
      }

      if (filterCriteria.status && !filterCriteria.status.includes(tx.status)) {
        return false;
      }

      if (filterCriteria.fromDate && tx.timestamp < filterCriteria.fromDate) {
        return false;
      }

      if (filterCriteria.toDate && tx.timestamp > filterCriteria.toDate) {
        return false;
      }

      if (filterCriteria.minValue && tx.value < filterCriteria.minValue) {
        return false;
      }

      if (filterCriteria.maxValue && tx.value > filterCriteria.maxValue) {
        return false;
      }

      if (filterCriteria.tokenAddress &&
          tx.tokenAddress?.toLowerCase() !== filterCriteria.tokenAddress.toLowerCase()) {
        return false;
      }

      if (filterCriteria.isPrivate !== undefined &&
          tx.isPrivate !== filterCriteria.isPrivate) {
        return false;
      }

      if (filterCriteria.search) {
        const searchLower = filterCriteria.search.toLowerCase();
        const matchesSearch =
          tx.hash.toLowerCase().includes(searchLower) ||
          tx.from.toLowerCase().includes(searchLower) ||
          tx.to.toLowerCase().includes(searchLower) ||
          tx.note?.toLowerCase().includes(searchLower) ||
          tx.contactName?.toLowerCase().includes(searchLower);
        if (!matchesSearch) return false;
      }

      return true;
    });
  }, [transactions]);

  // Apply filter if provided
  const filteredTransactions = useMemo(() => {
    if (!filter) return transactions;
    return filterTransactions(filter);
  }, [transactions, filter, filterTransactions]);

  // Calculate stats
  const stats = useMemo((): TransactionStats => {
    let totalSent = BigInt(0);
    let totalReceived = BigInt(0);
    let totalFees = BigInt(0);
    let privateCount = 0;

    for (const tx of transactions) {
      if (tx.status !== 'confirmed') continue;

      if (tx.type === 'send' || tx.type === 'stealth_send') {
        totalSent += tx.value;
      } else if (tx.type === 'receive' || tx.type === 'stealth_receive') {
        totalReceived += tx.value;
      }

      if (tx.fee) {
        totalFees += tx.fee;
      }

      if (tx.isPrivate) {
        privateCount++;
      }
    }

    return {
      totalSent,
      totalReceived,
      totalFees,
      transactionCount: transactions.length,
      privateTransactionCount: privateCount,
    };
  }, [transactions]);

  return {
    transactions: filteredTransactions,
    isLoading,
    isRefreshing,
    error,
    hasMore,
    refresh,
    loadMore,
    getTransaction,
    addPendingTransaction,
    updateTransaction,
    filterTransactions,
    stats,
  };
}

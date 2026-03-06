import React, { useState, useCallback, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Card } from '@/components/ui/Card';
import { formatUSD } from '@/utils/format/currency';
import { useWalletStore } from '@/stores/walletStore';
import { useStreamStore } from '@/stores/streamStore';
import { getExplorerUrl } from '@/services/solana/connection';
import { useAlert } from '@/providers/AlertProvider';

// Types
type TransactionType = 'all' | 'sent' | 'received' | 'streams' | 'scheduled';

interface ScheduledPayment {
  id: string;
  streamName: string;
  recipientAddress: string;
  amount: number;
  nextPaymentDate: Date;
  frequency: string;
  isPrivate: boolean;
}

interface Transaction {
  id: string;
  type: 'send' | 'receive' | 'stream';
  token: string;
  amount: number;
  usdValue: number;
  address: string;
  timestamp: Date;
  status: 'completed' | 'pending' | 'failed';
  isPrivate: boolean;
  txHash: string;
}

const FILTER_TABS: { id: TransactionType; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'sent', label: 'Sent' },
  { id: 'received', label: 'Received' },
  { id: 'streams', label: 'Streams' },
  { id: 'scheduled', label: 'Scheduled' },
];

// Loading state type
type LoadingState = 'idle' | 'loading' | 'error' | 'empty' | 'success';

// Helper to format address
const formatAddress = (address: string): string => {
  if (!address || address.length < 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
};

const PAGE_SIZE = 20;

/** Skeleton placeholder shown while transactions are loading */
function TransactionSkeleton() {
  return (
    <View className="gap-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <View
          key={i}
          className="bg-p01-surface rounded-2xl p-4 border border-p01-border"
        >
          <View className="flex-row items-center">
            {/* Icon placeholder */}
            <View className="w-10 h-10 rounded-full bg-p01-border mr-3 opacity-30" />
            {/* Text placeholders */}
            <View className="flex-1">
              <View className="w-24 h-4 bg-p01-border rounded opacity-30 mb-2" />
              <View className="w-36 h-3 bg-p01-border rounded opacity-20" />
            </View>
            {/* Amount placeholder */}
            <View className="items-end">
              <View className="w-20 h-4 bg-p01-border rounded opacity-30 mb-2" />
              <View className="w-14 h-3 bg-p01-border rounded opacity-20" />
            </View>
          </View>
          {/* Hash row placeholder */}
          <View className="flex-row items-center mt-3 pt-3 border-t border-p01-border">
            <View className="w-40 h-3 bg-p01-border rounded opacity-20" />
          </View>
        </View>
      ))}
    </View>
  );
}

export default function ActivityScreen() {
  const router = useRouter();
  const { showAlert } = useAlert();

  const {
    transactions: storeTransactions,
    refreshTransactions,
    refreshing: storeRefreshing,
    publicKey,
  } = useWalletStore();

  const { streams, initialize: initStreams, loading: streamsLoading } = useStreamStore();

  const [filter, setFilter] = useState<TransactionType>('all');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // Open transaction in Solana Explorer
  const openExplorer = useCallback((signature: string) => {
    const url = getExplorerUrl(signature, 'tx');
    Linking.openURL(url);
  }, []);

  // Handle transaction click
  const handleTransactionPress = useCallback((tx: Transaction) => {

    // Check if this is a valid blockchain transaction signature
    // Real Solana signatures are ~88 chars base58 (no underscores, no 'payment_' prefix)
    const isValidSignature = tx.id &&
      tx.id.length >= 80 &&
      !tx.id.includes('-') &&
      !tx.id.includes('_') &&
      !tx.id.startsWith('payment');


    if (isValidSignature) {
      openExplorer(tx.id);
    } else {
      // Stream payment without blockchain signature
      showAlert(
        'Local Transaction',
        tx.status === 'failed'
          ? 'This payment failed and was not sent to the blockchain.'
          : 'This payment was recorded locally. ZK stream payments are processed privately.',
        { icon: tx.status === 'failed' ? 'error' : 'info' }
      );
    }
  }, [openExplorer, showAlert]);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingState, setLoadingState] = useState<LoadingState>('idle');

  // Reset pagination when filter changes
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [filter]);

  // Initialize streams store (loads from cache instantly)
  useEffect(() => {
    initStreams(publicKey || undefined);
  }, [publicKey]);

  // Load transactions on mount - use cache first, refresh in background
  useEffect(() => {
    let cancelled = false;

    // If we have cached transactions, show them immediately
    if (storeTransactions.length > 0) {
      setLoadingState('success');
      // Refresh in background (don't await, don't show loading)
      refreshTransactions().catch(err => {
        console.warn('[Activity] Background refresh failed:', err?.message || err);
      });
    } else {
      // No cache, need to fetch with a safety timeout
      setLoadingState('loading');

      const safetyTimeout = setTimeout(() => {
        if (!cancelled) {
          console.warn('[Activity] Fetch timed out after 20s, showing empty state');
          setLoadingState(storeTransactions.length > 0 ? 'success' : 'error');
        }
      }, 20_000);

      refreshTransactions()
        .then(() => { if (!cancelled) setLoadingState('success'); })
        .catch(err => {
          console.error('[Activity] Failed to load transactions:', err);
          if (!cancelled) setLoadingState('error');
        })
        .finally(() => clearTimeout(safetyTimeout));
    }

    return () => { cancelled = true; };
  }, []);

  // Calculate scheduled payments from active streams
  const scheduledPayments: ScheduledPayment[] = useMemo(() => {
    return streams
      .filter((stream) => stream.status === 'active')
      .map((stream) => {
        // Calculate next payment date based on last payment or start date
        const lastPayment = stream.paymentHistory[stream.paymentHistory.length - 1];
        const lastPaymentDate = lastPayment
          ? new Date(lastPayment.timestamp)
          : new Date(stream.startDate);

        // Calculate interval based on frequency
        let intervalMs = 30 * 24 * 60 * 60 * 1000; // default monthly
        switch (stream.frequency) {
          case 'daily':
            intervalMs = 24 * 60 * 60 * 1000;
            break;
          case 'weekly':
            intervalMs = 7 * 24 * 60 * 60 * 1000;
            break;
          case 'monthly':
            intervalMs = 30 * 24 * 60 * 60 * 1000;
            break;
        }

        const nextPaymentDate = new Date(lastPaymentDate.getTime() + intervalMs);

        return {
          id: stream.id,
          streamName: stream.name,
          recipientAddress: stream.recipientAddress,
          amount: stream.amountPerPayment,
          nextPaymentDate,
          frequency: stream.frequency,
          isPrivate: stream.useStealthAddress || stream.amountNoise > 0,
        };
      })
      .sort((a, b) => a.nextPaymentDate.getTime() - b.nextPaymentDate.getTime());
  }, [streams]);

  // Transform store transactions to local format
  const allTransactions: Transaction[] = useMemo(() => {
    // Wallet transactions
    const walletTxs: Transaction[] = storeTransactions.map((tx) => ({
      id: tx.signature,
      type: tx.type === 'unknown' ? 'send' : tx.type as 'send' | 'receive',
      token: tx.token || 'SOL',
      amount: tx.amount || 0,
      usdValue: 0,
      address: formatAddress(tx.type === 'send' ? (tx.to || '') : (tx.from || '')),
      timestamp: new Date(tx.timestamp ? tx.timestamp * 1000 : Date.now()),
      status: tx.status === 'confirmed' ? 'completed' as const : tx.status as 'pending' | 'failed',
      isPrivate: false,
      txHash: formatAddress(tx.signature),
    }));

    // Stream payments
    const streamTxs: Transaction[] = streams.flatMap((stream) =>
      stream.paymentHistory.map((payment) => ({
        id: payment.id,
        type: 'stream' as const,
        token: 'SOL',
        amount: payment.amount,
        usdValue: 0,
        address: formatAddress(stream.recipientAddress),
        timestamp: new Date(payment.timestamp),
        status: payment.status === 'success' ? 'completed' as const : 'failed' as const,
        isPrivate: stream.useStealthAddress || stream.amountNoise > 0,
        txHash: formatAddress(payment.signature || payment.id),
      }))
    );

    // Combine and sort by date (newest first)
    return [...walletTxs, ...streamTxs].sort(
      (a, b) => b.timestamp.getTime() - a.timestamp.getTime()
    );
  }, [storeTransactions, streams]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      // Race against a 15s timeout so pull-to-refresh never hangs
      await Promise.race([
        refreshTransactions(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Refresh timed out')), 15_000)
        ),
      ]);
    } catch (err: any) {
      console.warn('[Activity] Refresh failed:', err?.message || err);
    } finally {
      setRefreshing(false);
    }
  }, [refreshTransactions]);

  // Filter transactions
  const filteredTransactions = allTransactions.filter((tx) => {
    switch (filter) {
      case 'sent':
        return tx.type === 'send';
      case 'received':
        return tx.type === 'receive';
      case 'streams':
        return tx.type === 'stream';
      default:
        return true;
    }
  });

  // NOTE: grouping is now done via paginatedGrouped below (after pagination slice)

  const formatTimeAgo = (date: Date): string => {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (hours < 1) return 'Just now';
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString();
  };

  const formatTimeUntil = (date: Date): string => {
    const now = new Date();
    const diff = date.getTime() - now.getTime();

    if (diff < 0) return 'Due now';

    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (hours < 1) return 'Less than 1h';
    if (hours < 24) return `In ${hours}h`;
    if (days < 7) return `In ${days}d`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed':
        return 'text-p01-cyan';
      case 'pending':
        return 'text-yellow-500';
      case 'failed':
        return 'text-red-500';
      default:
        return 'text-p01-text-muted';
    }
  };

  // Paginated slice of filtered transactions
  const paginatedTransactions = useMemo(
    () => filteredTransactions.slice(0, visibleCount),
    [filteredTransactions, visibleCount],
  );

  const hasMore = filteredTransactions.length > visibleCount;

  const handleLoadMore = useCallback(() => {
    setVisibleCount((prev) => prev + PAGE_SIZE);
  }, []);

  // Group only the paginated slice by date
  const paginatedGrouped = useMemo(() => {
    return paginatedTransactions.reduce(
      (groups, tx) => {
        const date = tx.timestamp.toLocaleDateString('en-US', {
          weekday: 'long',
          month: 'short',
          day: 'numeric',
        });
        if (!groups[date]) {
          groups[date] = [];
        }
        groups[date].push(tx);
        return groups;
      },
      {} as Record<string, Transaction[]>,
    );
  }, [paginatedTransactions]);

  // Build a flat list of renderable items (section headers + transaction rows)
  type ListItem =
    | { kind: 'header'; date: string }
    | { kind: 'tx'; tx: Transaction };

  const listData: ListItem[] = useMemo(() => {
    const items: ListItem[] = [];
    for (const [date, txs] of Object.entries(paginatedGrouped)) {
      items.push({ kind: 'header', date });
      for (const tx of txs) {
        items.push({ kind: 'tx', tx });
      }
    }
    return items;
  }, [paginatedGrouped]);

  const renderItem = useCallback(
    ({ item }: { item: ListItem }) => {
      if (item.kind === 'header') {
        return (
          <Text className="text-p01-text-muted text-sm font-medium mb-3 mt-4">
            {item.date}
          </Text>
        );
      }

      const tx = item.tx;
      return (
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={() => handleTransactionPress(tx)}
          className="mb-3"
          accessibilityRole="button"
          accessibilityLabel={`${tx.type === 'stream' ? 'Stream' : tx.type} ${tx.type === 'receive' ? 'plus' : 'minus'} ${tx.amount} ${tx.token}, ${tx.status}`}
        >
          <Card variant="default" padding="md">
            <View className="flex-row items-center justify-between">
              <View className="flex-row items-center flex-1">
                {/* Icon */}
                <View
                  className={`w-10 h-10 rounded-full items-center justify-center mr-3 ${
                    tx.type === 'receive'
                      ? 'bg-green-500/20'
                      : tx.type === 'send'
                      ? 'bg-red-500/20'
                      : 'bg-blue-500/20'
                  }`}
                >
                  <Ionicons
                    name={
                      tx.type === 'receive'
                        ? 'arrow-down'
                        : tx.type === 'send'
                        ? 'arrow-up'
                        : 'water-outline'
                    }
                    size={20}
                    color={
                      tx.type === 'receive'
                        ? '#39c5bb'
                        : tx.type === 'send'
                        ? '#ef4444'
                        : '#3b82f6'
                    }
                  />
                </View>

                {/* Details */}
                <View className="flex-1">
                  <View className="flex-row items-center">
                    <Text className="text-white font-medium capitalize">
                      {tx.type === 'stream' ? 'Stream' : tx.type}
                    </Text>
                    {tx.isPrivate && (
                      <View className="ml-2 flex-row items-center bg-p01-cyan/20 px-2 py-0.5 rounded-full">
                        <Ionicons
                          name="shield-checkmark"
                          size={10}
                          color="#39c5bb"
                        />
                        <Text className="text-p01-cyan text-xs ml-1">
                          Private
                        </Text>
                      </View>
                    )}
                  </View>
                  <View className="flex-row items-center mt-1">
                    <Text className="text-p01-text-muted text-sm">
                      {tx.address}
                    </Text>
                    <Text className="text-p01-text-dim text-xs mx-2">
                      -
                    </Text>
                    <Text className="text-p01-text-dim text-xs">
                      {formatTimeAgo(tx.timestamp)}
                    </Text>
                  </View>
                </View>
              </View>

              {/* Amount */}
              <View className="items-end">
                <Text
                  className={`font-semibold ${
                    tx.type === 'receive'
                      ? 'text-p01-cyan'
                      : 'text-white'
                  }`}
                >
                  {tx.type === 'receive' ? '+' : '-'}
                  {tx.amount.toLocaleString()} {tx.token}
                </Text>
                <View className="flex-row items-center mt-1">
                  <Text className="text-p01-text-muted text-sm mr-2">
                    {formatUSD(tx.usdValue)}
                  </Text>
                  <Text
                    className={`text-xs capitalize ${getStatusColor(
                      tx.status
                    )}`}
                  >
                    {tx.status}
                  </Text>
                </View>
              </View>
            </View>

            {/* Transaction Hash */}
            <View className="flex-row items-center mt-3 pt-3 border-t border-p01-border">
              <Ionicons
                name="document-outline"
                size={14}
                color="#666666"
              />
              <Text className="text-p01-text-dim text-xs ml-2 font-mono">
                {tx.txHash}
              </Text>
              <TouchableOpacity
                className="ml-auto p-1"
                onPress={() => handleTransactionPress(tx)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                accessibilityRole="link"
                accessibilityLabel="View transaction in explorer"
              >
                <Ionicons
                  name="open-outline"
                  size={14}
                  color="#39c5bb"
                />
              </TouchableOpacity>
            </View>
          </Card>
        </TouchableOpacity>
      );
    },
    [handleTransactionPress],
  );

  const keyExtractor = useCallback(
    (item: ListItem, index: number) =>
      item.kind === 'header' ? `hdr-${item.date}` : `tx-${item.tx.id}-${index}`,
    [],
  );

  /** Content rendered inside the FlatList depending on current state */
  const renderListContent = () => {
    // Skeleton while initial fetch is in-flight
    if (loadingState === 'loading') {
      return (
        <View className="px-5 pt-2">
          <TransactionSkeleton />
        </View>
      );
    }

    // Error state (inline, not full-screen)
    if (loadingState === 'error') {
      return (
        <View className="items-center justify-center py-20 px-6">
          <Ionicons name="warning-outline" size={64} color="#ef4444" />
          <Text className="text-white text-xl font-semibold mt-4">
            Failed to load activity
          </Text>
          <Text className="text-p01-text-muted text-center mt-2">
            Please check your connection and try again.
          </Text>
          <TouchableOpacity
            className="mt-6 bg-p01-cyan px-8 py-3 rounded-xl"
            onPress={() => {
              setLoadingState('loading');
              refreshTransactions()
                .then(() => setLoadingState('success'))
                .catch(() => setLoadingState('error'));
            }}
            accessibilityRole="button"
            accessibilityLabel="Retry loading activity"
          >
            <Text className="text-p01-void font-semibold">Retry</Text>
          </TouchableOpacity>
        </View>
      );
    }

    // Scheduled tab (uses its own layout, not the FlatList)
    if (filter === 'scheduled') {
      if (scheduledPayments.length === 0) {
        return (
          <View className="items-center justify-center py-20">
            <Ionicons name="calendar-outline" size={64} color="#666666" />
            <Text className="text-white text-lg font-semibold mt-4">
              No scheduled payments
            </Text>
            <Text className="text-p01-text-muted text-center mt-2">
              Active streams will show upcoming payments here
            </Text>
          </View>
        );
      }
      return (
        <View className="gap-3 px-5">
          <Text className="text-p01-text-muted text-sm font-medium mb-1">
            Upcoming Payments
          </Text>
          {scheduledPayments.map((payment) => (
            <TouchableOpacity
              key={payment.id}
              activeOpacity={0.7}
              onPress={() => router.push(`/(main)/(streams)/${payment.id}`)}
              accessibilityRole="button"
              accessibilityLabel={`${payment.streamName}, ${payment.amount.toFixed(4)} SOL ${payment.frequency}, ${formatTimeUntil(payment.nextPaymentDate)}`}
            >
              <Card variant="default" padding="md">
                <View className="flex-row items-center">
                  {/* Icon */}
                  <View className="w-10 h-10 rounded-full items-center justify-center mr-3 bg-blue-500/20">
                    <Ionicons name="time-outline" size={20} color="#3b82f6" />
                  </View>

                  {/* Details */}
                  <View className="flex-1 min-w-0 mr-3">
                    <View className="flex-row items-center flex-wrap">
                      <Text className="text-white font-medium" numberOfLines={1}>
                        {payment.streamName}
                      </Text>
                      {payment.isPrivate && (
                        <View className="ml-2 flex-row items-center bg-p01-cyan/20 px-2 py-0.5 rounded-full">
                          <Ionicons name="shield-checkmark" size={10} color="#39c5bb" />
                          <Text className="text-p01-cyan text-xs ml-1">Private</Text>
                        </View>
                      )}
                    </View>
                    <View className="flex-row items-center mt-1">
                      <Text className="text-p01-text-muted text-sm" numberOfLines={1}>
                        {formatAddress(payment.recipientAddress)}
                      </Text>
                      <Text className="text-p01-text-dim text-xs mx-2">-</Text>
                      <Text className="text-blue-400 text-xs font-medium">
                        {formatTimeUntil(payment.nextPaymentDate)}
                      </Text>
                    </View>
                  </View>

                  {/* Amount */}
                  <View className="items-end" style={{ minWidth: 90 }}>
                    <Text className="text-white font-semibold">
                      -{payment.amount.toFixed(4)} SOL
                    </Text>
                    <Text className="text-p01-text-muted text-xs mt-1 capitalize">
                      {payment.frequency}
                    </Text>
                  </View>
                </View>
              </Card>
            </TouchableOpacity>
          ))}
        </View>
      );
    }

    // Empty state (not loading, not error, just no transactions)
    if (filteredTransactions.length === 0) {
      return (
        <View className="items-center justify-center py-20">
          <Ionicons name="receipt-outline" size={64} color="#666666" />
          <Text className="text-white text-lg font-semibold mt-4">
            No transactions found
          </Text>
          <Text className="text-p01-text-muted text-center mt-2">
            {filter === 'all'
              ? 'Your transaction history will appear here'
              : `No ${filter} transactions yet`}
          </Text>
        </View>
      );
    }

    // Normal transaction list — render nothing here; FlatList handles it below
    return null;
  };

  // For scheduled, loading, error, and empty states we use a ScrollView wrapper
  // so pull-to-refresh still works. For the normal tx list we use FlatList.
  const usesFlatList =
    loadingState !== 'loading' &&
    loadingState !== 'error' &&
    filter !== 'scheduled' &&
    filteredTransactions.length > 0;

  return (
    <SafeAreaView className="flex-1 bg-p01-void" edges={['top']}>
      {/* Header — always visible */}
      <View className="flex-row items-center justify-between px-5 py-4">
        <TouchableOpacity
          onPress={() => router.back()}
          className="w-10 h-10 bg-p01-surface rounded-full items-center justify-center"
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="arrow-back" size={24} color="#ffffff" />
        </TouchableOpacity>
        <Text className="text-white text-lg font-semibold">Activity</Text>
        <TouchableOpacity
          className="w-10 h-10 bg-p01-surface rounded-full items-center justify-center"
          onPress={() => {
            const nextIdx = FILTER_TABS.findIndex(t => t.id === filter);
            const next = FILTER_TABS[(nextIdx + 1) % FILTER_TABS.length];
            setFilter(next.id);
          }}
          accessibilityRole="button"
          accessibilityLabel="Cycle transaction filter"
        >
          <Ionicons name="filter-outline" size={20} color="#ffffff" />
        </TouchableOpacity>
      </View>

      {/* Filter Tabs — always visible */}
      <View className="px-5 mb-4">
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8 }}
        >
          {FILTER_TABS.map((tab) => (
            <TouchableOpacity
              key={tab.id}
              onPress={() => setFilter(tab.id)}
              className={`px-4 py-2 rounded-full ${
                filter === tab.id
                  ? 'bg-p01-cyan'
                  : 'bg-p01-surface border border-p01-border'
              }`}
              accessibilityRole="button"
              accessibilityLabel={`Filter by ${tab.label}`}
              accessibilityState={{ selected: filter === tab.id }}
            >
              <Text
                className={`font-medium ${
                  filter === tab.id ? 'text-p01-void' : 'text-white'
                }`}
              >
                {tab.label}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* Main content area */}
      {usesFlatList ? (
        <FlatList
          data={listData}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          className="flex-1 px-5"
          contentContainerStyle={{ paddingBottom: 40 }}
          showsVerticalScrollIndicator={false}
          initialNumToRender={PAGE_SIZE}
          maxToRenderPerBatch={10}
          windowSize={5}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor="#39c5bb"
              colors={['#39c5bb']}
            />
          }
          ListFooterComponent={
            hasMore ? (
              <TouchableOpacity
                className="items-center py-4 mb-4"
                onPress={handleLoadMore}
                accessibilityRole="button"
                accessibilityLabel={`Load more, ${filteredTransactions.length - visibleCount} remaining`}
              >
                <View className="flex-row items-center bg-p01-surface border border-p01-border px-6 py-3 rounded-xl">
                  <Ionicons name="chevron-down" size={16} color="#39c5bb" />
                  <Text className="text-p01-cyan font-medium ml-2">
                    Load more ({filteredTransactions.length - visibleCount} remaining)
                  </Text>
                </View>
              </TouchableOpacity>
            ) : null
          }
        />
      ) : (
        <ScrollView
          className="flex-1"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 40 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor="#39c5bb"
              colors={['#39c5bb']}
            />
          }
        >
          {renderListContent()}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

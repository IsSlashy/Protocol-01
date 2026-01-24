import React, { useState, useCallback, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
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

  // Open transaction in Solana Explorer
  const openExplorer = useCallback((signature: string) => {
    const url = getExplorerUrl(signature, 'tx');
    console.log('[Activity] Opening explorer:', url);
    Linking.openURL(url);
  }, []);

  // Handle transaction click
  const handleTransactionPress = useCallback((tx: Transaction) => {
    console.log('[Activity] Transaction clicked:', tx.id, 'type:', tx.type);

    // Check if this is a valid blockchain transaction signature
    // Real Solana signatures are ~88 chars base58 (no underscores, no 'payment_' prefix)
    const isValidSignature = tx.id &&
      tx.id.length >= 80 &&
      !tx.id.includes('-') &&
      !tx.id.includes('_') &&
      !tx.id.startsWith('payment');

    console.log('[Activity] Is valid signature:', isValidSignature, 'length:', tx.id?.length);

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

  // Initialize streams store (loads from cache instantly)
  useEffect(() => {
    initStreams(publicKey || undefined);
  }, [publicKey]);

  // Load transactions on mount - use cache first, refresh in background
  useEffect(() => {
    // If we have cached transactions, show them immediately
    if (storeTransactions.length > 0) {
      setLoadingState('success');
      // Refresh in background (don't await, don't show loading)
      refreshTransactions().catch(err => {
        console.warn('[Activity] Background refresh failed:', err?.message || err);
      });
    } else {
      // No cache, need to fetch
      setLoadingState('loading');
      refreshTransactions()
        .then(() => setLoadingState('success'))
        .catch(err => {
          console.error('[Activity] Failed to load transactions:', err);
          setLoadingState('error');
        });
    }
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
    await refreshTransactions();
    setRefreshing(false);
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

  // Group by date
  const groupedTransactions = filteredTransactions.reduce(
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
    {} as Record<string, Transaction[]>
  );

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

  // Render loading state
  if (loadingState === 'loading') {
    return (
      <SafeAreaView className="flex-1 bg-p01-void">
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color="#39c5bb" />
          <Text className="text-p01-text-muted mt-4">
            Loading transactions...
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  // Render error state
  if (loadingState === 'error') {
    return (
      <SafeAreaView className="flex-1 bg-p01-void">
        <View className="flex-row items-center justify-between px-5 py-4">
          <TouchableOpacity
            onPress={() => router.back()}
            className="w-10 h-10 bg-p01-surface rounded-full items-center justify-center"
          >
            <Ionicons name="arrow-back" size={24} color="#ffffff" />
          </TouchableOpacity>
          <Text className="text-white text-lg font-semibold">Activity</Text>
          <View className="w-10" />
        </View>

        <View className="flex-1 items-center justify-center px-6">
          <Ionicons name="warning-outline" size={64} color="#ef4444" />
          <Text className="text-white text-xl font-semibold mt-4">
            Failed to load activity
          </Text>
          <Text className="text-p01-text-muted text-center mt-2">
            Please check your connection and try again.
          </Text>
          <TouchableOpacity
            className="mt-6 bg-p01-cyan px-8 py-3 rounded-xl"
            onPress={() => setLoadingState('success')}
          >
            <Text className="text-p01-void font-semibold">Retry</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-p01-void" edges={['top']}>
      {/* Header */}
      <View className="flex-row items-center justify-between px-5 py-4">
        <TouchableOpacity
          onPress={() => router.back()}
          className="w-10 h-10 bg-p01-surface rounded-full items-center justify-center"
        >
          <Ionicons name="arrow-back" size={24} color="#ffffff" />
        </TouchableOpacity>
        <Text className="text-white text-lg font-semibold">Activity</Text>
        <TouchableOpacity
          className="w-10 h-10 bg-p01-surface rounded-full items-center justify-center"
          onPress={() => {}}
        >
          <Ionicons name="filter-outline" size={20} color="#ffffff" />
        </TouchableOpacity>
      </View>

      {/* Filter Tabs */}
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

      <ScrollView
        className="flex-1 px-5"
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
        {/* Scheduled Payments View */}
        {filter === 'scheduled' ? (
          scheduledPayments.length === 0 ? (
            <View className="flex-1 items-center justify-center py-20">
              <Ionicons name="calendar-outline" size={64} color="#666666" />
              <Text className="text-white text-lg font-semibold mt-4">
                No scheduled payments
              </Text>
              <Text className="text-p01-text-muted text-center mt-2">
                Active streams will show upcoming payments here
              </Text>
            </View>
          ) : (
            <View className="gap-3">
              <Text className="text-p01-text-muted text-sm font-medium mb-1">
                Upcoming Payments
              </Text>
              {scheduledPayments.map((payment) => (
                <TouchableOpacity
                  key={payment.id}
                  activeOpacity={0.7}
                  onPress={() => router.push(`/(main)/(streams)/${payment.id}`)}
                >
                  <Card variant="default" padding="md">
                    <View className="flex-row items-center">
                      {/* Icon */}
                      <View className="w-10 h-10 rounded-full items-center justify-center mr-3 bg-blue-500/20">
                        <Ionicons name="time-outline" size={20} color="#3b82f6" />
                      </View>

                      {/* Details - flex-1 with min-w-0 for proper truncation */}
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

                      {/* Amount - fixed width to prevent overlap */}
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
          )
        ) : /* Empty State */
        filteredTransactions.length === 0 ? (
          <View className="flex-1 items-center justify-center py-20">
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
        ) : (
          /* Transaction Groups */
          Object.entries(groupedTransactions).map(([date, transactions]) => (
            <View key={date} className="mb-6">
              <Text className="text-p01-text-muted text-sm font-medium mb-3">
                {date}
              </Text>
              <View className="gap-3">
                {transactions.map((tx) => (
                  <TouchableOpacity
                    key={tx.id}
                    activeOpacity={0.7}
                    onPress={() => handleTransactionPress(tx)}
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
                ))}
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

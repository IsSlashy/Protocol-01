import React, { useState, useCallback, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Card } from '@/components/ui/Card';
import { formatUSD } from '@/utils/format/currency';
import { useWalletStore } from '@/stores/walletStore';

// Types
type TransactionType = 'all' | 'sent' | 'received' | 'streams';

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

  const {
    transactions: storeTransactions,
    refreshTransactions,
    refreshing: storeRefreshing,
  } = useWalletStore();

  const [filter, setFilter] = useState<TransactionType>('all');
  const [refreshing, setRefreshing] = useState(false);
  const [loadingState, setLoadingState] = useState<LoadingState>('success');

  // Transform store transactions to local format
  const allTransactions: Transaction[] = useMemo(() => {
    return storeTransactions.map((tx) => ({
      id: tx.signature,
      type: tx.type === 'unknown' ? 'send' : tx.type as 'send' | 'receive',
      token: tx.token || 'SOL',
      amount: tx.amount || 0,
      usdValue: 0, // TODO: Calculate USD value from price API
      address: formatAddress(tx.type === 'send' ? (tx.to || '') : (tx.from || '')),
      timestamp: new Date(tx.timestamp ? tx.timestamp * 1000 : Date.now()),
      status: tx.status === 'confirmed' ? 'completed' as const : tx.status as 'pending' | 'failed',
      isPrivate: false,
      txHash: formatAddress(tx.signature),
    }));
  }, [storeTransactions]);

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
        {/* Empty State */}
        {filteredTransactions.length === 0 ? (
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
                  <TouchableOpacity key={tx.id} activeOpacity={0.7}>
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
                        <TouchableOpacity className="ml-auto">
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

import React, { useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  Dimensions,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { formatUSD, formatPriceChange } from '@/utils/format/currency';
import { useWalletStore } from '@/stores/walletStore';

const { width } = Dimensions.get('window');

// Types
interface TokenDetail {
  id: string;
  symbol: string;
  name: string;
  balance: number;
  usdValue: number;
  price: number;
  priceChange24h: number;
  priceChange7d: number;
  marketCap: number;
  volume24h: number;
  icon: string;
  contractAddress?: string;
}

interface TokenTransaction {
  id: string;
  type: 'send' | 'receive';
  amount: number;
  usdValue: number;
  address: string;
  timestamp: Date;
  status: 'completed' | 'pending';
  isPrivate: boolean;
}

// Default token metadata (market info is placeholder until API integration)
const TOKEN_METADATA: Record<string, Partial<TokenDetail>> = {
  sol: {
    id: 'sol',
    symbol: 'SOL',
    name: 'Solana',
    price: 200.0,
    priceChange24h: 5.23,
    priceChange7d: 12.8,
    marketCap: 92500000000,
    volume24h: 3200000000,
    icon: 'logo-bitcoin',
  },
  usdc: {
    id: 'usdc',
    symbol: 'USDC',
    name: 'USD Coin',
    price: 1.0,
    priceChange24h: 0.01,
    priceChange7d: -0.02,
    marketCap: 45000000000,
    volume24h: 5800000000,
    icon: 'cash-outline',
    contractAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  },
  bonk: {
    id: 'bonk',
    symbol: 'BONK',
    name: 'Bonk',
    price: 0.00003,
    priceChange24h: -2.15,
    priceChange7d: 25.4,
    marketCap: 2100000000,
    volume24h: 180000000,
    icon: 'paw-outline',
    contractAddress: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  },
};

const MOCK_TOKEN_TRANSACTIONS: TokenTransaction[] = [
  {
    id: '1',
    type: 'receive',
    amount: 2.5,
    usdValue: 500.0,
    address: '7nxQB4...8fKm',
    timestamp: new Date(Date.now() - 3600000),
    status: 'completed',
    isPrivate: true,
  },
  {
    id: '2',
    type: 'send',
    amount: 1.0,
    usdValue: 200.0,
    address: '9mPZq4...2jNk',
    timestamp: new Date(Date.now() - 86400000),
    status: 'completed',
    isPrivate: true,
  },
  {
    id: '3',
    type: 'receive',
    amount: 5.0,
    usdValue: 1000.0,
    address: '3xTYw8...4pLr',
    timestamp: new Date(Date.now() - 172800000),
    status: 'completed',
    isPrivate: false,
  },
];

type LoadingState = 'idle' | 'loading' | 'error' | 'success';
type TimeFrame = '24h' | '7d' | '30d' | '1y';

export default function TokenDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [refreshing, setRefreshing] = useState(false);
  const [loadingState, setLoadingState] = useState<LoadingState>('success');
  const [timeFrame, setTimeFrame] = useState<TimeFrame>('24h');
  const [balanceHidden, setBalanceHidden] = useState(false);

  // Get real balance from wallet store
  const walletBalance = useWalletStore((state) => state.balance);
  const refreshBalance = useWalletStore((state) => state.refreshBalance);

  // Build token data with real balance
  const token = useMemo((): TokenDetail | null => {
    const tokenId = id?.toLowerCase() || 'sol';
    const metadata = TOKEN_METADATA[tokenId];

    if (!metadata) {
      // Unknown token - try to find in wallet tokens
      const walletToken = walletBalance?.tokens?.find(
        (t) => t.symbol?.toLowerCase() === tokenId || t.mint === id
      );
      if (walletToken) {
        return {
          id: tokenId,
          symbol: walletToken.symbol || 'Unknown',
          name: walletToken.name || walletToken.symbol || 'Unknown Token',
          balance: walletToken.balance || 0,
          usdValue: walletToken.usdValue || 0,
          price: 0,
          priceChange24h: 0,
          priceChange7d: 0,
          marketCap: 0,
          volume24h: 0,
          icon: 'cube-outline',
          contractAddress: walletToken.mint,
        };
      }
      return null;
    }

    // Get real balance
    let realBalance = 0;
    let usdValue = 0;

    if (tokenId === 'sol') {
      realBalance = walletBalance?.sol ?? 0;
      usdValue = realBalance * (metadata.price || 0);
    } else {
      // Find token in wallet balance
      const walletToken = walletBalance?.tokens?.find(
        (t) => t.symbol?.toLowerCase() === tokenId
      );
      if (walletToken) {
        realBalance = walletToken.balance || 0;
        usdValue = walletToken.usdValue || realBalance * (metadata.price || 0);
      }
    }

    return {
      ...metadata,
      id: tokenId,
      symbol: metadata.symbol || tokenId.toUpperCase(),
      name: metadata.name || tokenId,
      balance: realBalance,
      usdValue: usdValue,
      price: metadata.price || 0,
      priceChange24h: metadata.priceChange24h || 0,
      priceChange7d: metadata.priceChange7d || 0,
      marketCap: metadata.marketCap || 0,
      volume24h: metadata.volume24h || 0,
      icon: metadata.icon || 'cube-outline',
      contractAddress: metadata.contractAddress,
    } as TokenDetail;
  }, [id, walletBalance]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshBalance();
    } catch (error) {
      console.error('Failed to refresh balance:', error);
    }
    setRefreshing(false);
  }, [refreshBalance]);

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

  const formatLargeNumber = (num: number): string => {
    if (num >= 1000000000) {
      return `$${(num / 1000000000).toFixed(2)}B`;
    }
    if (num >= 1000000) {
      return `$${(num / 1000000).toFixed(2)}M`;
    }
    return formatUSD(num);
  };

  // Loading state
  if (loadingState === 'loading') {
    return (
      <SafeAreaView className="flex-1 bg-p01-void">
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color="#39c5bb" />
          <Text className="text-p01-text-muted mt-4">Loading token...</Text>
        </View>
      </SafeAreaView>
    );
  }

  // Error state
  if (loadingState === 'error' || !token) {
    return (
      <SafeAreaView className="flex-1 bg-p01-void">
        <View className="flex-row items-center justify-between px-5 py-4">
          <TouchableOpacity
            onPress={() => router.back()}
            className="w-10 h-10 bg-p01-surface rounded-full items-center justify-center"
          >
            <Ionicons name="arrow-back" size={24} color="#ffffff" />
          </TouchableOpacity>
          <Text className="text-white text-lg font-semibold">Token</Text>
          <View className="w-10" />
        </View>

        <View className="flex-1 items-center justify-center px-6">
          <Ionicons name="warning-outline" size={64} color="#ef4444" />
          <Text className="text-white text-xl font-semibold mt-4">
            Token not found
          </Text>
          <Text className="text-p01-text-muted text-center mt-2">
            This token could not be loaded.
          </Text>
          <TouchableOpacity
            className="mt-6 bg-p01-cyan px-8 py-3 rounded-xl"
            onPress={() => router.back()}
          >
            <Text className="text-p01-void font-semibold">Go Back</Text>
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
        <View className="flex-row items-center">
          <View className="w-8 h-8 bg-p01-surface-light rounded-full items-center justify-center mr-2">
            <Ionicons name={token.icon as any} size={18} color="#39c5bb" />
          </View>
          <Text className="text-white text-lg font-semibold">{token.symbol}</Text>
        </View>
        <TouchableOpacity
          onPress={() => setBalanceHidden(!balanceHidden)}
          className="w-10 h-10 bg-p01-surface rounded-full items-center justify-center"
        >
          <Ionicons
            name={balanceHidden ? 'eye-outline' : 'eye-off-outline'}
            size={20}
            color="#ffffff"
          />
        </TouchableOpacity>
      </View>

      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 100 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor="#39c5bb"
            colors={['#39c5bb']}
          />
        }
      >
        {/* Token Info */}
        <View className="px-5 mb-6">
          <Card variant="glass" padding="lg">
            <View className="items-center">
              {/* Price */}
              <Text className="text-p01-text-muted text-sm">
                {token.name} Price
              </Text>
              <Text className="text-white text-3xl font-bold mt-1">
                {token.price < 0.01
                  ? `$${token.price.toFixed(6)}`
                  : formatUSD(token.price)}
              </Text>
              <View
                className={`flex-row items-center mt-2 px-3 py-1 rounded-full ${
                  token.priceChange24h >= 0 ? 'bg-green-500/20' : 'bg-red-500/20'
                }`}
              >
                <Ionicons
                  name={
                    token.priceChange24h >= 0 ? 'trending-up' : 'trending-down'
                  }
                  size={14}
                  color={token.priceChange24h >= 0 ? '#39c5bb' : '#ef4444'}
                />
                <Text
                  className={`ml-1 font-medium ${
                    token.priceChange24h >= 0 ? 'text-p01-cyan' : 'text-red-500'
                  }`}
                >
                  {formatPriceChange(token.priceChange24h)} (24h)
                </Text>
              </View>

              {/* Balance */}
              <View className="w-full border-t border-p01-border mt-4 pt-4">
                <Text className="text-p01-text-muted text-sm text-center">
                  Your Balance
                </Text>
                <Text className="text-white text-2xl font-bold text-center mt-1">
                  {balanceHidden ? '****' : token.balance.toLocaleString()}{' '}
                  {token.symbol}
                </Text>
                <Text className="text-p01-text-muted text-center mt-1">
                  {balanceHidden ? '****' : formatUSD(token.usdValue)}
                </Text>
              </View>
            </View>
          </Card>
        </View>

        {/* Chart Placeholder */}
        <View className="px-5 mb-6">
          <Card variant="default" padding="md">
            {/* Timeframe Selector */}
            <View className="flex-row justify-center gap-2 mb-4">
              {(['24h', '7d', '30d', '1y'] as TimeFrame[]).map((tf) => (
                <TouchableOpacity
                  key={tf}
                  onPress={() => setTimeFrame(tf)}
                  className={`px-4 py-2 rounded-lg ${
                    timeFrame === tf
                      ? 'bg-p01-cyan'
                      : 'bg-p01-surface-light'
                  }`}
                >
                  <Text
                    className={`text-sm font-medium ${
                      timeFrame === tf ? 'text-p01-void' : 'text-white'
                    }`}
                  >
                    {tf}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Chart Placeholder */}
            <View
              className="h-48 bg-p01-surface-light rounded-xl items-center justify-center"
              style={{ width: width - 72 }}
            >
              <Ionicons name="analytics-outline" size={48} color="#666666" />
              <Text className="text-p01-text-muted mt-2">
                Price chart coming soon
              </Text>
            </View>
          </Card>
        </View>

        {/* Quick Actions */}
        <View className="px-5 mb-6">
          <View className="flex-row gap-3">
            <TouchableOpacity
              className="flex-1 bg-p01-cyan py-4 rounded-xl items-center flex-row justify-center"
              onPress={() =>
                router.push({
                  pathname: '/(main)/(wallet)/send',
                  params: { token: token.symbol },
                })
              }
            >
              <Ionicons name="arrow-up" size={20} color="#0a0a0a" />
              <Text className="text-p01-void font-semibold ml-2">Send</Text>
            </TouchableOpacity>

            <TouchableOpacity
              className="flex-1 bg-p01-surface border border-p01-border py-4 rounded-xl items-center flex-row justify-center"
              onPress={() => router.push('/(main)/(wallet)/receive')}
            >
              <Ionicons name="arrow-down" size={20} color="#39c5bb" />
              <Text className="text-white font-semibold ml-2">Receive</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Market Info */}
        <View className="px-5 mb-6">
          <Text className="text-white text-lg font-semibold mb-3">Market Info</Text>
          <Card variant="default" padding="md">
            <View className="gap-4">
              <View className="flex-row justify-between">
                <Text className="text-p01-text-muted">Market Cap</Text>
                <Text className="text-white font-medium">
                  {formatLargeNumber(token.marketCap)}
                </Text>
              </View>
              <View className="flex-row justify-between">
                <Text className="text-p01-text-muted">24h Volume</Text>
                <Text className="text-white font-medium">
                  {formatLargeNumber(token.volume24h)}
                </Text>
              </View>
              <View className="flex-row justify-between">
                <Text className="text-p01-text-muted">24h Change</Text>
                <Text
                  className={
                    token.priceChange24h >= 0 ? 'text-p01-cyan' : 'text-red-500'
                  }
                >
                  {formatPriceChange(token.priceChange24h)}
                </Text>
              </View>
              <View className="flex-row justify-between">
                <Text className="text-p01-text-muted">7d Change</Text>
                <Text
                  className={
                    token.priceChange7d >= 0 ? 'text-p01-cyan' : 'text-red-500'
                  }
                >
                  {formatPriceChange(token.priceChange7d)}
                </Text>
              </View>
              {token.contractAddress && (
                <View className="border-t border-p01-border pt-4">
                  <Text className="text-p01-text-muted text-sm mb-1">
                    Contract Address
                  </Text>
                  <TouchableOpacity className="flex-row items-center">
                    <Text className="text-white font-mono text-xs flex-1">
                      {token.contractAddress.slice(0, 20)}...
                      {token.contractAddress.slice(-8)}
                    </Text>
                    <Ionicons name="copy-outline" size={16} color="#39c5bb" />
                  </TouchableOpacity>
                </View>
              )}
            </View>
          </Card>
        </View>

        {/* Token Transactions */}
        <View className="px-5">
          <View className="flex-row items-center justify-between mb-3">
            <Text className="text-white text-lg font-semibold">
              {token.symbol} Transactions
            </Text>
            <TouchableOpacity
              onPress={() => router.push('/(main)/(wallet)/activity')}
            >
              <Text className="text-p01-cyan">See All</Text>
            </TouchableOpacity>
          </View>

          {MOCK_TOKEN_TRANSACTIONS.length === 0 ? (
            <Card variant="outlined" padding="lg">
              <View className="items-center py-6">
                <Ionicons name="receipt-outline" size={48} color="#666666" />
                <Text className="text-p01-text-muted text-center mt-3">
                  No {token.symbol} transactions yet
                </Text>
              </View>
            </Card>
          ) : (
            <View className="gap-3">
              {MOCK_TOKEN_TRANSACTIONS.map((tx) => (
                <TouchableOpacity key={tx.id} activeOpacity={0.7}>
                  <Card variant="default" padding="md">
                    <View className="flex-row items-center justify-between">
                      <View className="flex-row items-center flex-1">
                        <View
                          className={`w-10 h-10 rounded-full items-center justify-center mr-3 ${
                            tx.type === 'receive'
                              ? 'bg-green-500/20'
                              : 'bg-red-500/20'
                          }`}
                        >
                          <Ionicons
                            name={tx.type === 'receive' ? 'arrow-down' : 'arrow-up'}
                            size={20}
                            color={tx.type === 'receive' ? '#39c5bb' : '#ef4444'}
                          />
                        </View>
                        <View className="flex-1">
                          <View className="flex-row items-center">
                            <Text className="text-white font-medium capitalize">
                              {tx.type}
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
                          <Text className="text-p01-text-muted text-sm">
                            {tx.address} - {formatTimeAgo(tx.timestamp)}
                          </Text>
                        </View>
                      </View>
                      <View className="items-end">
                        <Text
                          className={`font-semibold ${
                            tx.type === 'receive'
                              ? 'text-p01-cyan'
                              : 'text-white'
                          }`}
                        >
                          {tx.type === 'receive' ? '+' : '-'}
                          {tx.amount} {token.symbol}
                        </Text>
                        <Text className="text-p01-text-muted text-sm">
                          {formatUSD(tx.usdValue)}
                        </Text>
                      </View>
                    </View>
                  </Card>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  Pressable,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Card } from '../../../components/ui/Card';
import { useStreamStore } from '../../../stores/streamStore';
import { useWalletStore } from '../../../stores/walletStore';
import { Stream, formatFrequency, calculateDailyRate } from '../../../services/solana/streams';

const VIOLET = '#8b5cf6';
const TAB_BAR_HEIGHT = 85;

type TabType = 'active' | 'completed';

export default function StreamsDashboard() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = useState<TabType>('active');

  const { publicKey } = useWalletStore();
  const {
    streams,
    stats,
    loading,
    refreshing,
    syncing,
    lastSyncTime,
    processingPayment,
    initialize,
    refresh,
    syncFromChain,
    pauseStream,
    resumeStream,
    cancelStream,
    processPayment,
    processAllDuePayments,
  } = useStreamStore();

  useEffect(() => {
    // Initialize with wallet address for on-chain sync
    initialize(publicKey || undefined);
  }, [publicKey]);

  const onRefresh = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // Pass wallet address to sync from blockchain
    await refresh(publicKey || undefined);
  };

  const handleManualSync = async () => {
    if (!publicKey) {
      Alert.alert('No Wallet', 'Please connect a wallet to sync from blockchain.');
      return;
    }
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      const result = await syncFromChain(publicKey);
      if (result.newStreams > 0) {
        Alert.alert('Sync Complete', `Found ${result.newStreams} new subscription(s) from blockchain.`);
      } else {
        Alert.alert('Sync Complete', 'No new subscriptions found on blockchain.');
      }
    } catch (error) {
      Alert.alert('Sync Failed', 'Failed to sync from blockchain. Please try again.');
    }
  };

  const activeStreams = streams.filter(
    (s) => s.status === 'active' || s.status === 'paused'
  );
  const completedStreams = streams.filter(
    (s) => s.status === 'completed' || s.status === 'cancelled'
  );

  const displayedStreams = activeTab === 'active' ? activeStreams : completedStreams;

  const handlePauseResume = async (stream: Stream) => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (stream.status === 'active') {
      await pauseStream(stream.id);
    } else if (stream.status === 'paused') {
      await resumeStream(stream.id);
    }
  };

  const handleCancel = (stream: Stream) => {
    Alert.alert(
      'Cancel Stream',
      `Are you sure you want to cancel "${stream.name}"? This action cannot be undone.`,
      [
        { text: 'No', style: 'cancel' },
        {
          text: 'Yes, Cancel',
          style: 'destructive',
          onPress: async () => {
            await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            await cancelStream(stream.id);
          },
        },
      ]
    );
  };

  const handlePayNow = async (stream: Stream) => {
    Alert.alert(
      'Process Payment',
      `Pay ${stream.amountPerPayment.toFixed(4)} SOL to ${stream.recipientName || stream.recipientAddress.slice(0, 8)}... now?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Pay Now',
          onPress: async () => {
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
            const payment = await processPayment(stream.id);
            if (payment?.status === 'success') {
              Alert.alert('Payment Sent!', `${stream.amountPerPayment.toFixed(4)} SOL has been sent.`);
            } else {
              Alert.alert('Payment Failed', payment?.error || 'Please try again.');
            }
          },
        },
      ]
    );
  };

  const handleProcessAllDue = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    const dueStreams = activeStreams.filter(s => s.nextPaymentDate <= Date.now());

    if (dueStreams.length === 0) {
      Alert.alert('No Due Payments', 'All payments are up to date.');
      return;
    }

    Alert.alert(
      'Process Due Payments',
      `${dueStreams.length} payment(s) are due. Process them now?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Process All',
          onPress: async () => {
            const payments = await processAllDuePayments();
            const successful = payments.filter(p => p.status === 'success').length;
            Alert.alert(
              'Payments Processed',
              `${successful}/${payments.length} payments completed successfully.`
            );
          },
        },
      ]
    );
  };

  const formatTimeUntilPayment = (timestamp: number): string => {
    const now = Date.now();
    const diff = timestamp - now;

    if (diff <= 0) return 'Due now';

    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h`;
    return 'Soon';
  };

  return (
    <View className="flex-1 bg-p01-void">
      <ScrollView
        className="flex-1"
        contentContainerStyle={{
          paddingTop: insets.top,
          paddingBottom: TAB_BAR_HEIGHT + insets.bottom + 20,
        }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={VIOLET}
            colors={[VIOLET]}
          />
        }
      >
        {/* Header */}
        <View className="px-6 py-4 flex-row items-center justify-between">
          <View className="flex-row items-center">
            <Text className="text-white text-2xl font-bold">STREAMS</Text>
            {syncing && (
              <View className="ml-2 flex-row items-center">
                <ActivityIndicator size="small" color={VIOLET} />
                <Text className="text-gray-400 text-xs ml-1">Syncing...</Text>
              </View>
            )}
          </View>
          <View className="flex-row items-center gap-2">
            {/* Sync from blockchain button */}
            <Pressable
              onPress={handleManualSync}
              disabled={syncing}
              className="w-10 h-10 rounded-full items-center justify-center"
              style={{ backgroundColor: 'rgba(139, 92, 246, 0.1)' }}
            >
              <Ionicons
                name="cloud-download-outline"
                size={20}
                color={syncing ? '#888' : VIOLET}
              />
            </Pressable>
            {/* Create new stream button */}
            <Pressable
              onPress={() => router.push('/(main)/(streams)/create')}
              className="w-10 h-10 rounded-full items-center justify-center"
              style={{ backgroundColor: 'rgba(139, 92, 246, 0.2)' }}
            >
              <Ionicons name="add" size={24} color={VIOLET} />
            </Pressable>
          </View>
        </View>

        {/* Stats Card */}
        <Animated.View
          entering={FadeInDown.delay(100).springify()}
          className="px-6 mb-6"
        >
          <Card
            variant="glass"
            style={{
              borderWidth: 1,
              borderColor: 'rgba(139, 92, 246, 0.3)',
            }}
          >
            <View className="flex-row items-center justify-between mb-4">
              <Text className="text-gray-400 text-sm">Streaming Overview</Text>
              {activeStreams.some(s => s.nextPaymentDate <= Date.now()) && (
                <TouchableOpacity
                  onPress={handleProcessAllDue}
                  className="px-3 py-1.5 rounded-full flex-row items-center"
                  style={{ backgroundColor: 'rgba(239, 68, 68, 0.2)' }}
                >
                  <Text className="text-red-400 text-xs font-semibold">
                    Payments Due
                  </Text>
                </TouchableOpacity>
              )}
            </View>

            <View className="flex-row justify-between">
              {/* Active Streams */}
              <View className="items-center flex-1">
                <Text className="text-white text-2xl font-bold">{stats.activeStreams}</Text>
                <Text className="text-gray-500 text-xs mt-1">Active</Text>
              </View>

              {/* Divider */}
              <View className="w-px bg-gray-800 mx-4" />

              {/* Monthly Outflow */}
              <View className="items-center flex-1">
                <Text className="text-red-400 text-2xl font-bold">
                  {stats.monthlyOutflow.toFixed(2)}
                </Text>
                <Text className="text-gray-500 text-xs mt-1">SOL/month</Text>
              </View>

              {/* Divider */}
              <View className="w-px bg-gray-800 mx-4" />

              {/* Total Streamed */}
              <View className="items-center flex-1">
                <Text style={{ color: VIOLET }} className="text-2xl font-bold">
                  {stats.totalOutgoing.toFixed(2)}
                </Text>
                <Text className="text-gray-500 text-xs mt-1">Total Sent</Text>
              </View>
            </View>
          </Card>
        </Animated.View>

        {/* Tabs */}
        <Animated.View
          entering={FadeInDown.delay(200).springify()}
          className="px-6 mb-4"
        >
          <View
            className="flex-row p-1 rounded-xl"
            style={{ backgroundColor: 'rgba(26, 26, 26, 1)' }}
          >
            <Pressable
              onPress={() => setActiveTab('active')}
              className="flex-1 py-3 rounded-lg items-center"
              style={
                activeTab === 'active'
                  ? { backgroundColor: 'rgba(139, 92, 246, 0.2)' }
                  : {}
              }
            >
              <Text
                className="font-semibold"
                style={{ color: activeTab === 'active' ? VIOLET : '#888888' }}
              >
                Active ({activeStreams.length})
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setActiveTab('completed')}
              className="flex-1 py-3 rounded-lg items-center"
              style={
                activeTab === 'completed'
                  ? { backgroundColor: 'rgba(139, 92, 246, 0.2)' }
                  : {}
              }
            >
              <Text
                className="font-semibold"
                style={{ color: activeTab === 'completed' ? VIOLET : '#888888' }}
              >
                History ({completedStreams.length})
              </Text>
            </Pressable>
          </View>
        </Animated.View>

        {/* Streams List */}
        <Animated.View
          entering={FadeInDown.delay(300).springify()}
          className="px-6"
        >
          {loading && streams.length === 0 ? (
            <View className="items-center py-12">
              <ActivityIndicator size="large" color={VIOLET} />
            </View>
          ) : displayedStreams.length === 0 ? (
            <View className="items-center justify-center py-12">
              <View
                className="w-16 h-16 rounded-full items-center justify-center mb-4"
                style={{ backgroundColor: 'rgba(139, 92, 246, 0.2)' }}
              >
                <Ionicons name="water-outline" size={32} color={VIOLET} />
              </View>
              <Text className="text-white font-semibold text-lg mb-2">
                {activeTab === 'active' ? 'No Active Streams' : 'No History'}
              </Text>
              <Text className="text-gray-400 text-center mb-4">
                {activeTab === 'active'
                  ? 'Set up recurring payments for subscriptions'
                  : 'Completed streams will appear here'}
              </Text>
              {activeTab === 'active' && (
                <Pressable
                  onPress={() => router.push('/(main)/(streams)/create')}
                  className="px-6 py-3 rounded-xl"
                  style={{ backgroundColor: VIOLET }}
                >
                  <Text className="text-white font-semibold">Create Stream</Text>
                </Pressable>
              )}
            </View>
          ) : (
            displayedStreams.map((stream, index) => (
              <StreamCard
                key={stream.id}
                stream={stream}
                isProcessing={processingPayment === stream.id}
                onPauseResume={() => handlePauseResume(stream)}
                onCancel={() => handleCancel(stream)}
                onPayNow={() => handlePayNow(stream)}
                formatTimeUntilPayment={formatTimeUntilPayment}
              />
            ))
          )}
        </Animated.View>
      </ScrollView>
    </View>
  );
}

// Stream Card Component
function StreamCard({
  stream,
  isProcessing,
  onPauseResume,
  onCancel,
  onPayNow,
  formatTimeUntilPayment,
}: {
  stream: Stream;
  isProcessing: boolean;
  onPauseResume: () => void;
  onCancel: () => void;
  onPayNow: () => void;
  formatTimeUntilPayment: (timestamp: number) => string;
}) {
  const progress = stream.totalPayments
    ? (stream.paymentsCompleted / stream.totalPayments) * 100
    : 0;

  const isDue = stream.status === 'active' && stream.nextPaymentDate <= Date.now();

  return (
    <View
      className="mb-4 p-4 rounded-2xl"
      style={{
        backgroundColor: 'rgba(26, 26, 26, 0.8)',
        borderWidth: 1,
        borderColor: isDue ? 'rgba(239, 68, 68, 0.5)' : 'rgba(139, 92, 246, 0.2)',
      }}
    >
      {/* Header */}
      <View className="flex-row items-center justify-between mb-3">
        <View className="flex-row items-center flex-1">
          <View
            className="w-10 h-10 rounded-full items-center justify-center mr-3"
            style={{
              backgroundColor:
                stream.status === 'active'
                  ? 'rgba(34, 197, 94, 0.2)'
                  : stream.status === 'paused'
                  ? 'rgba(234, 179, 8, 0.2)'
                  : 'rgba(107, 114, 128, 0.2)',
            }}
          >
            <Ionicons
              name={
                stream.status === 'active'
                  ? 'play'
                  : stream.status === 'paused'
                  ? 'pause'
                  : 'checkmark'
              }
              size={18}
              color={
                stream.status === 'active'
                  ? '#22c55e'
                  : stream.status === 'paused'
                  ? '#eab308'
                  : '#6b7280'
              }
            />
          </View>
          <View className="flex-1">
            <Text className="text-white font-semibold" numberOfLines={1}>
              {stream.name}
            </Text>
            <Text className="text-gray-500 text-xs">
              {stream.recipientName || `${stream.recipientAddress.slice(0, 8)}...`}
            </Text>
          </View>
        </View>

        {/* Status Badge */}
        {isDue && (
          <View
            className="px-2 py-1 rounded-full"
            style={{ backgroundColor: 'rgba(239, 68, 68, 0.2)' }}
          >
            <Text className="text-red-400 text-xs font-semibold">Due</Text>
          </View>
        )}
      </View>

      {/* Amount and Frequency */}
      <View className="flex-row items-center justify-between mb-3">
        <View>
          <Text className="text-white text-xl font-bold">
            {stream.amountPerPayment.toFixed(4)} SOL
          </Text>
          <Text className="text-gray-500 text-xs">
            {formatFrequency(stream.frequency, stream.customIntervalDays)}
          </Text>
        </View>

        {stream.status === 'active' && (
          <View className="items-end">
            <Text className="text-gray-400 text-xs">Next payment</Text>
            <Text
              className="font-semibold"
              style={{ color: isDue ? '#ef4444' : VIOLET }}
            >
              {formatTimeUntilPayment(stream.nextPaymentDate)}
            </Text>
          </View>
        )}
      </View>

      {/* Progress */}
      {stream.totalPayments && (
        <View className="mb-3">
          <View className="flex-row justify-between mb-1">
            <Text className="text-gray-500 text-xs">
              {stream.paymentsCompleted}/{stream.totalPayments} payments
            </Text>
            <Text className="text-gray-500 text-xs">
              {stream.amountStreamed.toFixed(4)} SOL sent
            </Text>
          </View>
          <View className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
            <View
              className="h-full rounded-full"
              style={{
                width: `${progress}%`,
                backgroundColor: VIOLET,
              }}
            />
          </View>
        </View>
      )}

      {/* Actions */}
      {(stream.status === 'active' || stream.status === 'paused') && (
        <View className="flex-row gap-2 mt-2">
          {isDue && (
            <TouchableOpacity
              onPress={onPayNow}
              disabled={isProcessing}
              className="flex-1 py-2.5 rounded-xl flex-row items-center justify-center"
              style={{ backgroundColor: VIOLET }}
            >
              {isProcessing ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Ionicons name="flash" size={16} color="#fff" />
                  <Text className="text-white font-semibold ml-1">Pay Now</Text>
                </>
              )}
            </TouchableOpacity>
          )}

          <TouchableOpacity
            onPress={onPauseResume}
            className="flex-1 py-2.5 rounded-xl flex-row items-center justify-center"
            style={{ backgroundColor: 'rgba(255, 255, 255, 0.1)' }}
          >
            <Ionicons
              name={stream.status === 'active' ? 'pause' : 'play'}
              size={16}
              color="#fff"
            />
            <Text className="text-white font-semibold ml-1">
              {stream.status === 'active' ? 'Pause' : 'Resume'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={onCancel}
            className="py-2.5 px-4 rounded-xl"
            style={{ backgroundColor: 'rgba(239, 68, 68, 0.2)' }}
          >
            <Ionicons name="close" size={16} color="#ef4444" />
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

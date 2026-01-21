import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  Linking,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import { Card } from '../../../components/ui/Card';
import { StreamProgress, ServiceLogo } from '../../../components/streams';
import { useStreamStore } from '../../../stores/streamStore';
import { Stream, formatFrequency } from '../../../services/solana/streams';
import { getExplorerUrl } from '../../../services/solana/connection';
import {
  getServiceById,
  CATEGORY_CONFIG,
  ServiceCategory,
} from '../../../services/subscriptions/serviceRegistry';

// Protocol 01 Color System
const P01_COLORS = {
  cyan: '#39c5bb',
  cyanDim: '#2a9d95',
  pink: '#ff77a8',
  brightCyan: '#00ffe5',
  yellow: '#ffcc00',
  red: '#ff3366',
  textMuted: '#888892',
  textDim: '#555560',
};

const ACCENT = P01_COLORS.pink;

export default function StreamDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const {
    streams,
    processingPayment,
    refresh,
    pauseStream,
    resumeStream,
    cancelStream,
    deleteStream,
    processPayment,
  } = useStreamStore();

  const [stream, setStream] = useState<Stream | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const found = streams.find((s) => s.id === id);
    setStream(found || null);
  }, [streams, id]);

  // Get service info if the stream has a serviceId
  const serviceInfo = stream?.serviceId ? getServiceById(stream.serviceId) : null;
  const serviceColor = serviceInfo?.color || stream?.serviceColor || ACCENT;
  const categoryConfig = serviceInfo?.category
    ? CATEGORY_CONFIG[serviceInfo.category]
    : stream?.serviceCategory
    ? CATEGORY_CONFIG[stream.serviceCategory as ServiceCategory]
    : null;

  if (!stream) {
    return (
      <SafeAreaView className="flex-1 bg-p01-void items-center justify-center">
        <ActivityIndicator size="large" color={ACCENT} />
        <Text className="text-gray-400 mt-4">Loading stream...</Text>
      </SafeAreaView>
    );
  }

  const isDue = stream.status === 'active' && stream.nextPaymentDate <= Date.now();
  const progress = stream.totalPayments
    ? (stream.paymentsCompleted / stream.totalPayments) * 100
    : (stream.amountStreamed / stream.totalAmount) * 100;

  const handleCopyAddress = async () => {
    await Clipboard.setStringAsync(stream.recipientAddress);
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handlePauseResume = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (stream.status === 'active') {
      await pauseStream(stream.id);
    } else if (stream.status === 'paused') {
      await resumeStream(stream.id);
    }
    await refresh();
  };

  const handleCancel = () => {
    Alert.alert(
      'Cancel Stream',
      `Are you sure you want to cancel "${stream.name}"? This will stop all future payments.`,
      [
        { text: 'No', style: 'cancel' },
        {
          text: 'Yes, Cancel',
          style: 'destructive',
          onPress: async () => {
            await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            await cancelStream(stream.id);
            router.back();
          },
        },
      ]
    );
  };

  const handleDelete = () => {
    Alert.alert(
      'Delete Stream',
      'Are you sure you want to delete this stream? This will remove it from your history.',
      [
        { text: 'No', style: 'cancel' },
        {
          text: 'Yes, Delete',
          style: 'destructive',
          onPress: async () => {
            await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            await deleteStream(stream.id);
            router.back();
          },
        },
      ]
    );
  };

  const handlePayNow = async () => {
    Alert.alert(
      'Process Payment',
      `Pay ${stream.amountPerPayment.toFixed(4)} SOL now?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Pay Now',
          onPress: async () => {
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
            const payment = await processPayment(stream.id);
            if (payment?.status === 'success') {
              Alert.alert('Payment Sent!', 'Transaction completed successfully.');
            } else {
              Alert.alert('Payment Failed', payment?.error || 'Please try again.');
            }
          },
        },
      ]
    );
  };

  const formatDate = (timestamp: number): string => {
    return new Date(timestamp).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const formatTimeUntil = (timestamp: number): string => {
    const now = Date.now();
    const diff = timestamp - now;
    if (diff <= 0) return 'Due now';

    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

    if (days > 0) return `${days}d ${hours}h`;
    return `${hours}h`;
  };

  const openExplorer = (signature: string) => {
    if (signature) {
      const url = getExplorerUrl(signature, 'tx');
      Linking.openURL(url);
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-p01-void">
      {/* Header */}
      <View className="flex-row items-center justify-between px-4 py-4">
        <TouchableOpacity
          onPress={() => router.back()}
          className="w-10 h-10 rounded-full items-center justify-center"
          style={{ backgroundColor: 'rgba(255, 119, 168, 0.2)' }}
        >
          <Ionicons name="arrow-back" size={20} color={ACCENT} />
        </TouchableOpacity>
        <Text className="text-white text-lg font-semibold">{stream.name}</Text>
        <TouchableOpacity
          onPress={handleDelete}
          className="w-10 h-10 rounded-full items-center justify-center"
          style={{ backgroundColor: 'rgba(255, 51, 102, 0.2)' }}
        >
          <Ionicons name="trash-outline" size={20} color="#ef4444" />
        </TouchableOpacity>
      </View>

      <ScrollView
        className="flex-1 px-4"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 120 }}
      >
        {/* Service Info Banner (if detected service) */}
        {serviceInfo && (
          <View
            className="flex-row items-center p-4 rounded-2xl mb-4"
            style={{
              backgroundColor: `${serviceColor}15`,
              borderWidth: 1,
              borderColor: `${serviceColor}30`,
            }}
          >
            <ServiceLogo service={serviceInfo} size={48} />
            <View className="flex-1 ml-3">
              <Text className="text-white text-lg font-semibold">
                {serviceInfo.name}
              </Text>
              {categoryConfig && (
                <View className="flex-row items-center mt-1">
                  <Ionicons
                    name={categoryConfig.icon as any}
                    size={14}
                    color={categoryConfig.color}
                  />
                  <Text className="text-sm ml-1" style={{ color: categoryConfig.color }}>
                    {categoryConfig.label}
                  </Text>
                </View>
              )}
            </View>
            <View
              className="px-3 py-1.5 rounded-lg"
              style={{ backgroundColor: `${serviceColor}25` }}
            >
              <Text className="text-xs font-semibold" style={{ color: serviceColor }}>
                Subscription
              </Text>
            </View>
          </View>
        )}

        {/* Status Banner */}
        <View className="items-center mb-6">
          <View
            className="flex-row items-center gap-2 px-4 py-2 rounded-xl"
            style={{
              backgroundColor:
                stream.status === 'active'
                  ? 'rgba(57, 197, 187, 0.2)'
                  : stream.status === 'paused'
                  ? 'rgba(255, 204, 0, 0.2)'
                  : stream.status === 'completed'
                  ? 'rgba(255, 119, 168, 0.2)'
                  : 'rgba(255, 51, 102, 0.2)',
            }}
          >
            <View
              className="w-2 h-2 rounded-full"
              style={{
                backgroundColor:
                  stream.status === 'active'
                    ? P01_COLORS.cyan
                    : stream.status === 'paused'
                    ? P01_COLORS.yellow
                    : stream.status === 'completed'
                    ? serviceColor
                    : P01_COLORS.red,
              }}
            />
            <Text
              className="font-semibold uppercase"
              style={{
                color:
                  stream.status === 'active'
                    ? P01_COLORS.cyan
                    : stream.status === 'paused'
                    ? P01_COLORS.yellow
                    : stream.status === 'completed'
                    ? serviceColor
                    : P01_COLORS.red,
              }}
            >
              {stream.status === 'active' ? 'Active' : stream.status}
            </Text>
          </View>
        </View>

        {/* Main Card */}
        <Card
          variant="glass"
          className="mb-6"
          style={{
            borderWidth: 1,
            borderColor: isDue ? 'rgba(255, 51, 102, 0.5)' : `${serviceColor}40`,
          }}
        >
          {/* Amount per Payment */}
          <View className="items-center mb-4">
            <Text className="text-gray-400 text-sm mb-1">Payment Amount</Text>
            <Text className="text-white text-4xl font-bold">
              {stream.amountPerPayment.toFixed(4)}
            </Text>
            <Text style={{ color: serviceColor }} className="text-lg font-semibold">
              SOL {formatFrequency(stream.frequency)}
            </Text>
          </View>

          {/* Progress */}
          {stream.totalPayments && (
            <View className="mb-4">
              <View className="flex-row justify-between mb-2">
                <Text className="text-gray-500 text-sm">Progress</Text>
                <Text className="text-white text-sm font-semibold">
                  {stream.paymentsCompleted}/{stream.totalPayments} payments
                </Text>
              </View>
              <StreamProgress progress={progress} height={8} showGlow={stream.status === 'active'} />
            </View>
          )}

          {/* Stats */}
          <View className="flex-row justify-between pt-4 border-t border-gray-800">
            <View className="items-center flex-1">
              <Text className="text-gray-500 text-xs">Total Sent</Text>
              <Text className="text-white font-bold text-lg">
                {stream.amountStreamed.toFixed(4)}
              </Text>
              <Text className="text-gray-500 text-xs">SOL</Text>
            </View>
            <View className="w-px bg-gray-800" />
            <View className="items-center flex-1">
              <Text className="text-gray-500 text-xs">Payments</Text>
              <Text className="text-white font-bold text-lg">
                {stream.paymentsCompleted}
              </Text>
              <Text className="text-gray-500 text-xs">completed</Text>
            </View>
          </View>
        </Card>

        {/* Next Payment Card */}
        {stream.status === 'active' && (
          <View
            className="p-4 rounded-2xl mb-6"
            style={{
              backgroundColor: isDue ? 'rgba(255, 51, 102, 0.1)' : `${serviceColor}15`,
              borderWidth: 1,
              borderColor: isDue ? 'rgba(255, 51, 102, 0.3)' : `${serviceColor}30`,
            }}
          >
            <View className="flex-row items-center justify-between">
              <View>
                <Text className="text-gray-400 text-sm">Next Payment</Text>
                <Text
                  className="text-xl font-bold"
                  style={{ color: isDue ? P01_COLORS.red : serviceColor }}
                >
                  {formatTimeUntil(stream.nextPaymentDate)}
                </Text>
              </View>
              {isDue && (
                <TouchableOpacity
                  onPress={handlePayNow}
                  disabled={processingPayment === stream.id}
                  className="px-4 py-2 rounded-xl flex-row items-center"
                  style={{ backgroundColor: serviceColor }}
                >
                  {processingPayment === stream.id ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <>
                      <Ionicons name="flash" size={16} color="#fff" />
                      <Text className="text-white font-semibold ml-1">Pay Now</Text>
                    </>
                  )}
                </TouchableOpacity>
              )}
            </View>
          </View>
        )}

        {/* Recipient Card */}
        <View
          className="p-4 rounded-2xl mb-6"
          style={{ backgroundColor: 'rgba(26, 26, 26, 0.8)' }}
        >
          <Text className="text-gray-400 text-sm mb-3">Recipient</Text>
          <TouchableOpacity
            onPress={handleCopyAddress}
            className="flex-row items-center justify-between"
          >
            <View className="flex-1">
              {stream.recipientName && (
                <Text className="text-white font-semibold mb-1">{stream.recipientName}</Text>
              )}
              <Text className="text-gray-500 font-mono text-sm" numberOfLines={1}>
                {stream.recipientAddress}
              </Text>
            </View>
            <View
              className="ml-3 p-2 rounded-lg"
              style={{ backgroundColor: `${serviceColor}20` }}
            >
              <Ionicons
                name={copied ? 'checkmark' : 'copy-outline'}
                size={18}
                color={copied ? P01_COLORS.cyan : serviceColor}
              />
            </View>
          </TouchableOpacity>
        </View>

        {/* Schedule Card */}
        <View
          className="p-4 rounded-2xl mb-6"
          style={{ backgroundColor: 'rgba(26, 26, 26, 0.8)' }}
        >
          <Text className="text-gray-400 text-sm mb-3">Schedule</Text>

          <View className="space-y-3">
            <View className="flex-row justify-between">
              <Text className="text-gray-500">Frequency</Text>
              <Text className="text-white">{formatFrequency(stream.frequency)}</Text>
            </View>
            <View className="flex-row justify-between">
              <Text className="text-gray-500">Started</Text>
              <Text className="text-white">{formatDate(stream.startDate)}</Text>
            </View>
            {stream.endDate && (
              <View className="flex-row justify-between">
                <Text className="text-gray-500">Ends</Text>
                <Text className="text-white">{formatDate(stream.endDate)}</Text>
              </View>
            )}
            <View className="flex-row justify-between">
              <Text className="text-gray-500">Created</Text>
              <Text className="text-white">{formatDate(stream.createdAt)}</Text>
            </View>
          </View>
        </View>

        {/* Payment History */}
        {stream.paymentHistory.length > 0 && (
          <View
            className="p-4 rounded-2xl mb-6"
            style={{ backgroundColor: 'rgba(26, 26, 26, 0.8)' }}
          >
            <Text className="text-gray-400 text-sm mb-3">
              Payment History ({stream.paymentHistory.length})
            </Text>

            {stream.paymentHistory.slice().reverse().map((payment, index) => (
              <TouchableOpacity
                key={payment.id}
                onPress={() => payment.signature && openExplorer(payment.signature)}
                className="flex-row items-center justify-between py-3"
                style={{
                  borderTopWidth: index > 0 ? 1 : 0,
                  borderTopColor: 'rgba(75, 85, 99, 0.3)',
                }}
                disabled={!payment.signature}
              >
                <View className="flex-row items-center flex-1">
                  <View
                    className="w-8 h-8 rounded-full items-center justify-center mr-3"
                    style={{
                      backgroundColor:
                        payment.status === 'success'
                          ? 'rgba(57, 197, 187, 0.2)'
                          : 'rgba(255, 51, 102, 0.2)',
                    }}
                  >
                    <Ionicons
                      name={payment.status === 'success' ? 'checkmark' : 'close'}
                      size={14}
                      color={payment.status === 'success' ? P01_COLORS.cyan : P01_COLORS.red}
                    />
                  </View>
                  <View className="flex-1">
                    <Text className="text-white font-semibold">
                      {payment.amount.toFixed(4)} SOL
                    </Text>
                    <Text className="text-gray-500 text-xs">
                      {formatDate(payment.timestamp)}
                    </Text>
                  </View>
                </View>
                {payment.signature && (
                  <Ionicons name="open-outline" size={16} color="#666" />
                )}
              </TouchableOpacity>
            ))}
          </View>
        )}
      </ScrollView>

      {/* Bottom Actions */}
      {(stream.status === 'active' || stream.status === 'paused') && (
        <View className="absolute bottom-0 left-0 right-0 p-4 bg-p01-void border-t border-gray-800">
          <View className="flex-row gap-3">
            <TouchableOpacity
              onPress={handlePauseResume}
              className="flex-1 py-4 rounded-xl flex-row items-center justify-center"
              style={{ backgroundColor: `${serviceColor}20` }}
            >
              <Ionicons
                name={stream.status === 'active' ? 'pause' : 'play'}
                size={20}
                color={serviceColor}
              />
              <Text className="font-semibold ml-2" style={{ color: serviceColor }}>
                {stream.status === 'active' ? 'Pause' : 'Resume'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={handleCancel}
              className="flex-1 py-4 rounded-xl flex-row items-center justify-center"
              style={{ backgroundColor: 'rgba(255, 51, 102, 0.2)' }}
            >
              <Ionicons name="close-circle" size={20} color="#ef4444" />
              <Text className="font-semibold ml-2 text-red-500">Cancel Stream</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

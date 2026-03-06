import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Linking,
  Image,
} from 'react-native';
import {
  PublicKey,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { useAlert } from '../../../providers/AlertProvider';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import { Card } from '../../../components/ui/Card';
import { StreamProgress, ServiceLogo } from '../../../components/streams';
import { useStreamStore } from '../../../stores/streamStore';
import { useDenominatedPoolStore } from '../../../stores/denominatedPoolStore';
import { Stream, StreamPayment, formatFrequency, updateStream as updateStreamRecord } from '../../../services/solana/streams';
import { getExplorerUrl, getConnection } from '../../../services/solana/connection';
import { getKeypair } from '../../../services/solana/wallet';
import {
  DenominatedPoolProverProvider,
  useDenominatedPoolProver,
} from '../../../components/privacy/DenominatedPoolProver';
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
  return (
    <DenominatedPoolProverProvider>
      <StreamDetailContent />
    </DenominatedPoolProverProvider>
  );
}

function StreamDetailContent() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { showConfirm, showAlert } = useAlert();
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
  const { generateProof } = useDenominatedPoolProver();

  const [stream, setStream] = useState<Stream | null>(null);
  const [copied, setCopied] = useState(false);
  const [zkPayProgress, setZkPayProgress] = useState<string | null>(null);
  const [isZkPaying, setIsZkPaying] = useState(false);
  const { notes: denomNotes } = useDenominatedPoolStore();

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
    const remaining = stream.totalAmount - stream.amountStreamed;
    const cancelMessage = stream.useZkPool
      ? `Are you sure you want to cancel "${stream.name}"? ${remaining > 0 ? `${remaining.toFixed(4)} SOL remains in your private balance.` : 'All payments have been processed.'}`
      : `Are you sure you want to cancel "${stream.name}"? This will stop all future payments and remove the subscription.`;

    showConfirm(
      'Cancel Stream',
      cancelMessage,
      {
        icon: 'warning',
        confirmText: 'Yes, Cancel',
        confirmStyle: 'destructive',
        cancelText: 'No',
        onConfirm: async () => {
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          await cancelStream(stream.id);
          await deleteStream(stream.id);
          router.back();
        },
      }
    );
  };

  const handleDelete = () => {
    showConfirm(
      'Delete Stream',
      'Are you sure you want to delete this stream? This will remove it from your history.',
      {
        icon: 'warning',
        confirmText: 'Yes, Delete',
        confirmStyle: 'destructive',
        cancelText: 'No',
        onConfirm: async () => {
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          await deleteStream(stream.id);
          router.back();
        },
      }
    );
  };

  const handlePayNow = async () => {
    if (!stream) return;

    if (stream.useZkPool) {
      // ZK stream: unshield a denomination pool note on-chain
      const poolStore = useDenominatedPoolStore.getState();
      const matureNotes = poolStore.getActiveNotes()
        .filter((n: any) => n.token === 'SOL' && n.status === 'mature')
        .sort((a: any, b: any) => a.denomination - b.denomination);
      const availableNote = matureNotes.find((n: any) => n.denomination >= stream.amountPerPayment);

      if (!availableNote) {
        showAlert('Insufficient Balance', 'No mature shielded notes available. Shield more SOL first.', {
          icon: 'error',
        });
        return;
      }

      showConfirm(
        'Private Payment',
        `Unshield ${availableNote.denomination} SOL note to pay ${stream.name}? This generates a ZK proof and sends a real on-chain transaction.`,
        {
          icon: 'question',
          confirmText: 'Pay with ZK Proof',
          cancelText: 'Cancel',
          onConfirm: async () => {
            try {
              setIsZkPaying(true);
              setZkPayProgress('Generating ZK proof...');
              await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);

              const sig = await poolStore.unshieldNote(
                availableNote.id,
                stream.recipientAddress,
                generateProof,
              );

              setZkPayProgress('Recording payment...');
              const now = Date.now();
              const intervalMs = stream.frequency === 'daily' ? 86400000
                : stream.frequency === 'weekly' ? 604800000
                : stream.frequency === 'biweekly' ? 1209600000
                : 2592000000; // monthly

              const payment: StreamPayment = {
                id: `payment_${now}`,
                amount: stream.amountPerPayment,
                actualAmount: availableNote.denomination,
                signature: sig,
                timestamp: now,
                status: 'success',
              };

              const newPaymentsCompleted = stream.paymentsCompleted + 1;
              let newStatus = stream.status;
              if (stream.totalPayments && newPaymentsCompleted >= stream.totalPayments) {
                newStatus = 'completed';
              }

              await updateStreamRecord(stream.id, {
                amountStreamed: stream.amountStreamed + availableNote.denomination,
                paymentsCompleted: newPaymentsCompleted,
                nextPaymentDate: now + intervalMs,
                status: newStatus,
                paymentHistory: [...stream.paymentHistory, payment],
              });
              await refresh();

              setZkPayProgress(null);
              showAlert('Payment Sent!', `${availableNote.denomination} SOL paid on-chain via ZK proof. Tx: ${sig.slice(0, 8)}...`, {
                icon: 'success',
              });
            } catch (error: any) {
              showAlert('Payment Failed', error.message || 'ZK payment failed.', {
                icon: 'error',
              });
            } finally {
              setIsZkPaying(false);
              setZkPayProgress(null);
            }
          },
        }
      );
    } else {
      // Normal wallet: real SOL transfer
      showConfirm(
        'Process Payment',
        `Send ${stream.amountPerPayment.toFixed(4)} SOL to ${stream.recipientAddress.slice(0, 8)}...?`,
        {
          icon: 'question',
          confirmText: 'Pay Now',
          cancelText: 'Cancel',
          onConfirm: async () => {
            try {
              await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
              setIsZkPaying(true);
              setZkPayProgress('Sending transaction...');

              const keypair = await getKeypair();
              if (!keypair) throw new Error('Wallet not found');

              const connection = getConnection();
              const lamports = Math.round(stream.amountPerPayment * 1_000_000_000);

              const transferIx = SystemProgram.transfer({
                fromPubkey: keypair.publicKey,
                toPubkey: new PublicKey(stream.recipientAddress),
                lamports,
              });

              const tx = new Transaction().add(transferIx);
              const sig = await sendAndConfirmTransaction(connection, tx, [keypair], {
                commitment: 'confirmed',
              });

              const now = Date.now();
              const intervalMs = stream.frequency === 'daily' ? 86400000
                : stream.frequency === 'weekly' ? 604800000
                : stream.frequency === 'biweekly' ? 1209600000
                : 2592000000;

              const payment: StreamPayment = {
                id: `payment_${now}`,
                amount: stream.amountPerPayment,
                actualAmount: stream.amountPerPayment,
                signature: sig,
                timestamp: now,
                status: 'success',
              };

              const newPaymentsCompleted = stream.paymentsCompleted + 1;
              let newStatus = stream.status;
              if (stream.totalPayments && newPaymentsCompleted >= stream.totalPayments) {
                newStatus = 'completed';
              }

              await updateStreamRecord(stream.id, {
                amountStreamed: stream.amountStreamed + stream.amountPerPayment,
                paymentsCompleted: newPaymentsCompleted,
                nextPaymentDate: now + intervalMs,
                status: newStatus,
                paymentHistory: [...stream.paymentHistory, payment],
              });
              await refresh();

              showAlert('Payment Sent!', `${stream.amountPerPayment.toFixed(4)} SOL confirmed on-chain. Tx: ${sig.slice(0, 8)}...`, {
                icon: 'success',
              });
            } catch (error: any) {
              showAlert('Payment Failed', error.message || 'Transaction failed.', {
                icon: 'error',
              });
            } finally {
              setIsZkPaying(false);
              setZkPayProgress(null);
            }
          },
        }
      );
    }
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
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="arrow-back" size={20} color={ACCENT} />
        </TouchableOpacity>
        <Text className="text-white text-lg font-semibold">{stream.name}</Text>
        {/* Empty view for header alignment */}
        <View className="w-10 h-10" />
      </View>

      <ScrollView
        className="flex-1 px-4"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 100 }}
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

        {/* Automatic Payments Info */}
        {stream.status === 'active' && (
          <View
            className="p-4 rounded-2xl mb-4"
            style={{
              backgroundColor: 'rgba(0, 255, 136, 0.08)',
              borderWidth: 1,
              borderColor: 'rgba(0, 255, 136, 0.2)',
            }}
          >
            <View className="flex-row items-center gap-3">
              <View
                className="w-10 h-10 rounded-full items-center justify-center"
                style={{ backgroundColor: 'rgba(0, 255, 136, 0.15)' }}
              >
                <Ionicons name="flash" size={20} color="#00ff88" />
              </View>
              <View className="flex-1">
                <Text className="text-white font-semibold text-sm">Automatic Payments Enabled</Text>
                <Text className="text-gray-400 text-xs mt-0.5">
                  Payments are processed automatically by the protocol
                </Text>
              </View>
            </View>
          </View>
        )}

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
                  disabled={processingPayment === stream.id || isZkPaying}
                  className="px-4 py-2 rounded-xl flex-row items-center"
                  style={{ backgroundColor: serviceColor }}
                  accessibilityRole="button"
                  accessibilityLabel={stream.useZkPool ? 'Pay now with ZK proof' : 'Pay now'}
                  accessibilityState={{ disabled: processingPayment === stream.id || isZkPaying }}
                >
                  {(processingPayment === stream.id || isZkPaying) ? (
                    <View style={{ alignItems: 'center' }}>
                      <ActivityIndicator size="small" color="#fff" />
                      {zkPayProgress && (
                        <Text style={{ color: '#fff', fontSize: 9, marginTop: 2 }}>{zkPayProgress}</Text>
                      )}
                    </View>
                  ) : (
                    <>
                      <Ionicons name={stream.useZkPool ? 'eye-off' : 'flash'} size={16} color="#fff" />
                      <Text className="text-white font-semibold ml-1">
                        {stream.useZkPool ? 'Pay (ZK)' : 'Pay Now'}
                      </Text>
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
            accessibilityRole="button"
            accessibilityLabel={copied ? 'Address copied' : 'Copy recipient address'}
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

        {/* ZK Stream Low Balance Warning */}
        {stream.useZkPool && stream.status === 'paused' && (() => {
          const lastPayment = stream.paymentHistory[stream.paymentHistory.length - 1];
          const isBalanceIssue = lastPayment?.status === 'failed' &&
            lastPayment?.error?.includes('private balance');
          if (!isBalanceIssue) return null;
          return (
            <View style={{
              backgroundColor: 'rgba(255, 204, 0, 0.12)',
              borderWidth: 1,
              borderColor: 'rgba(255, 204, 0, 0.3)',
              borderRadius: 12,
              padding: 14,
              marginBottom: 16,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
            }}>
              <Ionicons name="alert-circle" size={24} color={P01_COLORS.yellow} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: P01_COLORS.yellow, fontSize: 13, fontWeight: '600' }}>
                  Auto-paused — Insufficient Private Balance
                </Text>
                <Text style={{ color: P01_COLORS.textMuted, fontSize: 11, marginTop: 4 }}>
                  Shield more SOL in your private wallet, then resume this subscription.
                </Text>
              </View>
            </View>
          );
        })()}

        {/* Action Buttons (inside scroll, above tab bar) */}
        {(stream.status === 'active' || stream.status === 'paused') && (
          <View className="mb-6">
            <View
              style={{
                flexDirection: 'row',
                gap: 12,
              }}
            >
              <TouchableOpacity
                onPress={handlePauseResume}
                className="flex-1 py-4 rounded-xl flex-row items-center justify-center"
                style={{ backgroundColor: `${serviceColor}20` }}
                accessibilityRole="button"
                accessibilityLabel={stream.status === 'active' ? 'Pause stream' : 'Resume stream'}
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
                accessibilityRole="button"
                accessibilityLabel="Cancel stream"
              >
                <Ionicons name="close-circle" size={20} color="#ef4444" />
                <Text className="font-semibold ml-2 text-red-500">Cancel Stream</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

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
                onPress={() => {
                  if (payment.signature) {
                    openExplorer(payment.signature);
                  } else {
                    showAlert(
                      'No Transaction',
                      payment.status === 'failed'
                        ? `This payment failed: ${payment.error || 'Unknown error'}`
                        : 'This payment was recorded locally but not sent to the blockchain.',
                      { icon: payment.status === 'failed' ? 'error' : 'info' }
                    );
                  }
                }}
                accessibilityRole="button"
                accessibilityLabel={`Payment ${payment.amount.toFixed(4)} SOL, ${payment.status === 'success' ? 'successful' : 'failed'}`}
                className="flex-row items-center justify-between py-3"
                style={{
                  borderTopWidth: index > 0 ? 1 : 0,
                  borderTopColor: 'rgba(75, 85, 99, 0.3)',
                }}
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
                {payment.signature ? (
                  <Ionicons name="open-outline" size={16} color={P01_COLORS.cyan} />
                ) : (
                  <Ionicons name="alert-circle-outline" size={16} color={P01_COLORS.textMuted} />
                )}
              </TouchableOpacity>
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

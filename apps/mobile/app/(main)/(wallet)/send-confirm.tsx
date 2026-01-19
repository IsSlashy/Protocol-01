import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { formatUSD } from '@/utils/format/currency';
import { truncateAddress } from '@/utils/format/address';

// Types
type TransactionStatus = 'idle' | 'authenticating' | 'signing' | 'broadcasting' | 'confirming';

const PRIVACY_LEVELS = {
  standard: {
    name: 'Standard',
    description: 'Basic stealth address',
    decoys: 0,
  },
  enhanced: {
    name: 'Enhanced',
    description: '5 decoy transactions',
    decoys: 5,
  },
  maximum: {
    name: 'Maximum',
    description: '10 decoys + timing delay',
    decoys: 10,
  },
};

export default function SendConfirmScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    recipient: string;
    token: string;
    amount: string;
    usdValue: string;
    privacyLevel: string;
    networkFee: string;
    privacyFee: string;
  }>();

  const [status, setStatus] = useState<TransactionStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const {
    recipient = '',
    token = 'SOL',
    amount = '0',
    usdValue = '0',
    privacyLevel = 'standard',
    networkFee = '0.000005',
    privacyFee = '0.00001',
  } = params;

  const privacyInfo = PRIVACY_LEVELS[privacyLevel as keyof typeof PRIVACY_LEVELS] || PRIVACY_LEVELS.standard;
  const totalFee = parseFloat(networkFee) + parseFloat(privacyFee);

  const handleConfirm = async () => {
    try {
      setError(null);

      // Step 1: Biometric authentication
      setStatus('authenticating');
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Step 2: Sign transaction
      setStatus('signing');
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Step 3: Broadcast transaction
      setStatus('broadcasting');
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Step 4: Wait for confirmation
      setStatus('confirming');
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Navigate to success screen
      router.replace({
        pathname: '/(main)/(wallet)/send-success',
        params: {
          recipient,
          token,
          amount,
          usdValue,
          privacyLevel,
          txHash: 'mock_tx_hash_' + Date.now(),
        },
      });
    } catch (err) {
      setError('Transaction failed. Please try again.');
      setStatus('idle');
    }
  };

  const getStatusMessage = (): string => {
    switch (status) {
      case 'authenticating':
        return 'Authenticating...';
      case 'signing':
        return 'Signing transaction...';
      case 'broadcasting':
        return 'Broadcasting to network...';
      case 'confirming':
        return 'Waiting for confirmation...';
      default:
        return '';
    }
  };

  const isProcessing = status !== 'idle';

  return (
    <SafeAreaView className="flex-1 bg-p01-void" edges={['top']}>
      {/* Header */}
      <View className="flex-row items-center justify-between px-5 py-4">
        <TouchableOpacity
          onPress={() => !isProcessing && router.back()}
          className="w-10 h-10 bg-p01-surface rounded-full items-center justify-center"
          disabled={isProcessing}
        >
          <Ionicons
            name="arrow-back"
            size={24}
            color={isProcessing ? '#666666' : '#ffffff'}
          />
        </TouchableOpacity>
        <Text className="text-white text-lg font-semibold">Confirm Send</Text>
        <View className="w-10" />
      </View>

      <ScrollView
        className="flex-1 px-5"
        showsVerticalScrollIndicator={false}
      >
        {/* Amount Summary */}
        <Card variant="glass" padding="lg" className="mb-6">
          <View className="items-center">
            <Text className="text-p01-text-muted text-sm mb-2">
              YOU ARE SENDING
            </Text>
            <Text className="text-white text-4xl font-bold">
              {amount} {token}
            </Text>
            <Text className="text-p01-text-muted text-lg mt-1">
              {formatUSD(parseFloat(usdValue))}
            </Text>
          </View>
        </Card>

        {/* Recipient */}
        <Card variant="default" padding="md" className="mb-4">
          <View className="flex-row items-center justify-between">
            <Text className="text-p01-text-muted">To</Text>
            <View className="flex-row items-center">
              <View className="w-8 h-8 bg-p01-surface-light rounded-full items-center justify-center mr-2">
                <Ionicons name="person-outline" size={16} color="#39c5bb" />
              </View>
              <Text className="text-white font-mono">
                {recipient.endsWith('.sol')
                  ? recipient
                  : truncateAddress(recipient, 6)}
              </Text>
            </View>
          </View>
        </Card>

        {/* Privacy Details */}
        <Card variant="default" padding="md" className="mb-4">
          <View className="flex-row items-center mb-4">
            <Ionicons name="shield-checkmark" size={20} color="#39c5bb" />
            <Text className="text-p01-cyan font-semibold ml-2">
              Privacy Details
            </Text>
          </View>

          <View className="gap-3">
            <View className="flex-row items-center justify-between">
              <Text className="text-p01-text-muted">Privacy Level</Text>
              <View className="flex-row items-center">
                <Ionicons
                  name={
                    privacyLevel === 'standard'
                      ? 'shield-outline'
                      : privacyLevel === 'enhanced'
                      ? 'shield-half'
                      : 'shield-checkmark'
                  }
                  size={16}
                  color="#39c5bb"
                />
                <Text className="text-white ml-2">{privacyInfo.name}</Text>
              </View>
            </View>

            <View className="flex-row items-center justify-between">
              <Text className="text-p01-text-muted">Stealth Address</Text>
              <View className="flex-row items-center">
                <Ionicons name="checkmark-circle" size={16} color="#39c5bb" />
                <Text className="text-p01-cyan ml-1">Enabled</Text>
              </View>
            </View>

            {privacyInfo.decoys > 0 && (
              <View className="flex-row items-center justify-between">
                <Text className="text-p01-text-muted">Decoy Transactions</Text>
                <Text className="text-white">{privacyInfo.decoys}</Text>
              </View>
            )}

            {privacyLevel === 'maximum' && (
              <View className="flex-row items-center justify-between">
                <Text className="text-p01-text-muted">Timing Delay</Text>
                <View className="flex-row items-center">
                  <Ionicons name="checkmark-circle" size={16} color="#39c5bb" />
                  <Text className="text-p01-cyan ml-1">Active</Text>
                </View>
              </View>
            )}
          </View>
        </Card>

        {/* Fee Breakdown */}
        <Card variant="default" padding="md" className="mb-4">
          <View className="flex-row items-center mb-4">
            <Ionicons name="receipt-outline" size={20} color="#39c5bb" />
            <Text className="text-p01-cyan font-semibold ml-2">
              Fee Breakdown
            </Text>
          </View>

          <View className="gap-3">
            <View className="flex-row items-center justify-between">
              <Text className="text-p01-text-muted">Network Fee</Text>
              <Text className="text-white">{networkFee} SOL</Text>
            </View>

            <View className="flex-row items-center justify-between">
              <Text className="text-p01-text-muted">Privacy Fee</Text>
              <Text className="text-white">{privacyFee} SOL</Text>
            </View>

            <View className="border-t border-p01-border pt-3 flex-row items-center justify-between">
              <Text className="text-white font-semibold">Total Fees</Text>
              <Text className="text-p01-cyan font-semibold">
                {totalFee.toFixed(6)} SOL
              </Text>
            </View>
          </View>
        </Card>

        {/* Info Banner */}
        <View className="bg-p01-cyan/10 border border-p01-cyan/30 rounded-xl p-4 mb-6">
          <View className="flex-row items-start">
            <Ionicons name="eye-off-outline" size={20} color="#39c5bb" />
            <View className="ml-3 flex-1">
              <Text className="text-p01-cyan font-medium mb-1">
                Invisible to Chain Analysis
              </Text>
              <Text className="text-p01-text-muted text-sm">
                This transaction uses stealth addresses making it unlinkable to
                your public wallet on blockchain explorers.
              </Text>
            </View>
          </View>
        </View>

        {/* Error Message */}
        {error && (
          <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 mb-6">
            <View className="flex-row items-center">
              <Ionicons name="alert-circle" size={20} color="#ef4444" />
              <Text className="text-red-500 ml-2">{error}</Text>
            </View>
          </View>
        )}
      </ScrollView>

      {/* Bottom Buttons */}
      <View className="px-5 pb-6 pt-4">
        {isProcessing ? (
          <View className="items-center py-4">
            <ActivityIndicator size="large" color="#39c5bb" />
            <Text className="text-p01-cyan mt-3 font-medium">
              {getStatusMessage()}
            </Text>
            <View className="flex-row items-center mt-2">
              <View className="w-2 h-2 rounded-full bg-p01-cyan mr-1" />
              <View
                className={`w-2 h-2 rounded-full mr-1 ${
                  ['signing', 'broadcasting', 'confirming'].includes(status)
                    ? 'bg-p01-cyan'
                    : 'bg-p01-border'
                }`}
              />
              <View
                className={`w-2 h-2 rounded-full mr-1 ${
                  ['broadcasting', 'confirming'].includes(status)
                    ? 'bg-p01-cyan'
                    : 'bg-p01-border'
                }`}
              />
              <View
                className={`w-2 h-2 rounded-full ${
                  status === 'confirming' ? 'bg-p01-cyan' : 'bg-p01-border'
                }`}
              />
            </View>
          </View>
        ) : (
          <View className="gap-3">
            <Button onPress={handleConfirm} fullWidth size="lg">
              <View className="flex-row items-center">
                <Ionicons name="finger-print" size={20} color="#0a0a0a" />
                <Text className="text-p01-void font-semibold text-lg ml-2">
                  Confirm & Send
                </Text>
              </View>
            </Button>
            <Button
              variant="ghost"
              onPress={() => router.back()}
              fullWidth
              size="md"
            >
              Cancel
            </Button>
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

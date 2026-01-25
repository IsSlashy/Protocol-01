import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';

import { useWalletStore } from '@/stores/walletStore';
import { useSecuritySettings } from '@/hooks/useSecuritySettings';
import { isValidAddress } from '@/services/solana/transactions';
import { isDevnet, getCluster } from '@/services/solana/connection';
import { formatBalance } from '@/services/solana/balance';
import { Colors, FontFamily, BorderRadius, Spacing } from '@/constants/theme';

// P-01 Design System Colors - NO purple allowed
const P01 = {
  cyan: '#39c5bb',
  cyanDim: 'rgba(57, 197, 187, 0.15)',
  pink: '#ff77a8',
  pinkDim: 'rgba(255, 119, 168, 0.15)',
};

export default function SendScreen() {
  const router = useRouter();
  const {
    balance,
    sendTransaction,
    loading,
  } = useWalletStore();
  const { authenticateForSend } = useSecuritySettings();

  // Compute formatted balance locally (Zustand getters don't trigger re-renders)
  const formattedSolBalance = balance ? formatBalance(balance.sol) : '0';

  // Form state
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [sending, setSending] = useState(false);

  // Get current network for display
  const currentNetwork = getCluster();

  // Validation state
  const [recipientError, setRecipientError] = useState('');
  const [amountError, setAmountError] = useState('');

  // Get SOL balance
  const solBalance = balance?.sol || 0;
  const solPrice = balance?.solUsd ? balance.solUsd / (solBalance || 1) : 0;
  const amountNum = parseFloat(amount) || 0;
  const usdValue = amountNum * solPrice;

  const validateRecipient = useCallback((value: string) => {
    if (!value) {
      setRecipientError('');
      return false;
    }

    if (!isValidAddress(value)) {
      setRecipientError('Invalid Solana address');
      return false;
    }

    setRecipientError('');
    return true;
  }, []);

  const validateAmount = useCallback((value: string) => {
    if (!value) {
      setAmountError('');
      return false;
    }

    const num = parseFloat(value);
    if (isNaN(num) || num <= 0) {
      setAmountError('Enter a valid amount');
      return false;
    }

    // Account for transaction fee (~0.000005 SOL)
    const maxAmount = solBalance - 0.001;
    if (num > maxAmount) {
      setAmountError('Insufficient balance (need to reserve for fees)');
      return false;
    }

    setAmountError('');
    return true;
  }, [solBalance]);

  const handleRecipientChange = (value: string) => {
    setRecipient(value.trim());
    if (value.length > 10) {
      validateRecipient(value.trim());
    }
  };

  const handleAmountChange = (value: string) => {
    const sanitized = value.replace(/[^0-9.]/g, '');
    const parts = sanitized.split('.');
    const formatted = parts.length > 2 ? `${parts[0]}.${parts.slice(1).join('')}` : sanitized;
    setAmount(formatted);
    if (formatted) {
      validateAmount(formatted);
    }
  };

  const handlePercentage = (percent: number) => {
    const maxAmount = Math.max(0, solBalance - 0.001);
    const value = (maxAmount * percent).toFixed(6);
    setAmount(value);
    validateAmount(value);
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  const handleSend = async () => {
    const isRecipientValid = validateRecipient(recipient);
    const isAmountValid = validateAmount(amount);

    if (!isRecipientValid || !isAmountValid) {
      return;
    }

    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }

    // Authenticate before sending (if enabled in settings)
    const authenticated = await authenticateForSend();
    if (!authenticated) {
      Alert.alert('Authentication Required', 'Please authenticate to send this transaction.');
      return;
    }

    Alert.alert(
      'Confirm Transaction',
      `Send ${amount} SOL to ${recipient.slice(0, 8)}...${recipient.slice(-8)}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Send',
          style: 'default',
          onPress: async () => {
            setSending(true);
            try {
              const result = await sendTransaction(recipient, parseFloat(amount));

              if (result.success) {
                if (Platform.OS !== 'web') {
                  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                }
                router.replace({
                  pathname: '/(main)/(wallet)/send-success',
                  params: {
                    signature: result.signature,
                    amount,
                    recipient,
                  },
                });
              } else {
                if (Platform.OS !== 'web') {
                  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
                }
                Alert.alert('Transaction Failed', result.error || 'Unknown error');
              }
            } catch (error: any) {
              if (Platform.OS !== 'web') {
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
              }
              Alert.alert('Error', error.message || 'Transaction failed');
            } finally {
              setSending(false);
            }
          },
        },
      ]
    );
  };

  const isFormValid = recipient && amount && !recipientError && !amountError && !sending;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        {/* Header */}
        <Animated.View entering={FadeInDown.delay(100)} style={styles.header}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={styles.backButton}
          >
            <Ionicons name="arrow-back" size={24} color={Colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Send SOL</Text>
          <View style={styles.backButton} />
        </Animated.View>

        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Amount Input */}
          <Animated.View entering={FadeInUp.delay(200)} style={styles.amountSection}>
            <Text style={styles.amountLabel}>AMOUNT</Text>
            <View style={styles.amountInputContainer}>
              <TextInput
                style={styles.amountInput}
                placeholder="0"
                placeholderTextColor={Colors.textTertiary}
                value={amount}
                onChangeText={handleAmountChange}
                keyboardType="decimal-pad"
              />
              <Text style={styles.amountSymbol}>SOL</Text>
            </View>
            <Text style={styles.usdValue}>
              ≈ ${usdValue.toFixed(2)} USD
            </Text>

            {/* Percentage Buttons */}
            <View style={styles.percentButtons}>
              {[0.25, 0.5, 0.75, 1].map((percent) => (
                <TouchableOpacity
                  key={percent}
                  onPress={() => handlePercentage(percent)}
                  style={styles.percentButton}
                >
                  <Text style={styles.percentButtonText}>
                    {percent === 1 ? 'MAX' : `${percent * 100}%`}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {amountError ? (
              <Text style={styles.errorText}>{amountError}</Text>
            ) : null}

            <View style={styles.balanceRow}>
              <Text style={styles.balanceLabel}>Available:</Text>
              <Text style={styles.balanceValue}>{formattedSolBalance} SOL</Text>
            </View>
          </Animated.View>

          {/* Recipient Input */}
          <Animated.View entering={FadeInUp.delay(300)} style={styles.recipientSection}>
            <Text style={styles.inputLabel}>RECIPIENT ADDRESS</Text>
            <View style={[
              styles.inputContainer,
              recipientError ? styles.inputError : null,
            ]}>
              <TextInput
                style={styles.textInput}
                placeholder="Enter Solana address"
                placeholderTextColor={Colors.textTertiary}
                value={recipient}
                onChangeText={handleRecipientChange}
                autoCapitalize="none"
                autoCorrect={false}
                multiline
                numberOfLines={2}
              />
              <TouchableOpacity
                onPress={() => router.push('/(main)/(wallet)/scan')}
                style={styles.scanButton}
              >
                <Ionicons name="scan-outline" size={20} color={Colors.primary} />
              </TouchableOpacity>
            </View>
            {recipientError ? (
              <Text style={styles.errorText}>{recipientError}</Text>
            ) : null}
          </Animated.View>

          {/* Transaction Info */}
          <Animated.View entering={FadeInUp.delay(400)} style={styles.infoCard}>
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Network Fee</Text>
              <Text style={styles.infoValue}>~0.000005 SOL</Text>
            </View>
            <View style={styles.infoDivider} />
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Network</Text>
              <View style={[
                styles.networkBadge,
                currentNetwork === 'mainnet-beta' && { backgroundColor: Colors.successDim },
              ]}>
                <View style={[
                  styles.networkDot,
                  currentNetwork === 'mainnet-beta' && { backgroundColor: Colors.success },
                ]} />
                <Text style={[
                  styles.networkText,
                  currentNetwork === 'mainnet-beta' && { color: Colors.success },
                ]}>
                  {currentNetwork === 'mainnet-beta' ? 'Mainnet' :
                   currentNetwork === 'devnet' ? 'Devnet' : 'Testnet'}
                </Text>
              </View>
            </View>
          </Animated.View>
        </ScrollView>

        {/* Send Buttons */}
        <Animated.View entering={FadeInUp.delay(500)} style={styles.bottomSection}>
          {/* Standard Send */}
          <TouchableOpacity
            onPress={handleSend}
            disabled={!isFormValid}
            style={[
              styles.sendButton,
              !isFormValid ? styles.sendButtonDisabled : null,
            ]}
          >
            {sending ? (
              <Text style={styles.sendButtonText}>Sending...</Text>
            ) : (
              <>
                <Ionicons name="arrow-up" size={20} color={Colors.background} />
                <Text style={styles.sendButtonText}>Send SOL</Text>
              </>
            )}
          </TouchableOpacity>

          {/* Split Send Option */}
          <TouchableOpacity
            onPress={() => router.push({
              pathname: '/(main)/(wallet)/send-split',
              params: { recipient, amount },
            })}
            style={styles.splitSendButton}
          >
            <View style={styles.splitSendIcon}>
              <Ionicons name="git-branch" size={18} color={P01.pink} />
            </View>
            <View style={styles.splitSendContent}>
              <Text style={styles.splitSendTitle}>Split Send (Privacy+)</Text>
              <Text style={styles.splitSendDesc}>
                Split into multiple transactions over time
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={Colors.textTertiary} />
          </TouchableOpacity>
        </Animated.View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  keyboardView: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.surfaceSecondary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    color: Colors.text,
    fontSize: 18,
    fontFamily: FontFamily.semibold,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: Spacing.xl,
    paddingBottom: Spacing['3xl'],
  },
  amountSection: {
    alignItems: 'center',
    marginBottom: Spacing['3xl'],
    paddingVertical: Spacing['2xl'],
  },
  amountLabel: {
    color: Colors.textTertiary,
    fontSize: 12,
    fontFamily: FontFamily.semibold,
    letterSpacing: 1,
    marginBottom: Spacing.lg,
  },
  amountInputContainer: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginBottom: Spacing.sm,
  },
  amountInput: {
    color: Colors.text,
    fontSize: 48,
    fontFamily: FontFamily.bold,
    minWidth: 60,
    textAlign: 'center',
  },
  amountSymbol: {
    color: Colors.textSecondary,
    fontSize: 24,
    fontFamily: FontFamily.medium,
    marginLeft: Spacing.sm,
  },
  usdValue: {
    color: Colors.textSecondary,
    fontSize: 15,
    fontFamily: FontFamily.regular,
    marginBottom: Spacing.xl,
  },
  percentButtons: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginBottom: Spacing.lg,
  },
  percentButton: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.lg,
    backgroundColor: Colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  percentButtonText: {
    color: Colors.primary,
    fontSize: 13,
    fontFamily: FontFamily.semibold,
  },
  balanceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
  },
  balanceLabel: {
    color: Colors.textTertiary,
    fontSize: 13,
    fontFamily: FontFamily.regular,
  },
  balanceValue: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontFamily: FontFamily.medium,
  },
  recipientSection: {
    marginBottom: Spacing['2xl'],
  },
  inputLabel: {
    color: Colors.textTertiary,
    fontSize: 12,
    fontFamily: FontFamily.semibold,
    letterSpacing: 1,
    marginBottom: Spacing.sm,
  },
  inputContainer: {
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: Spacing.lg,
  },
  inputError: {
    borderColor: Colors.error,
  },
  textInput: {
    flex: 1,
    color: Colors.text,
    fontSize: 15,
    fontFamily: FontFamily.mono,
    lineHeight: 22,
  },
  scanButton: {
    width: 40,
    height: 40,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.primaryDim,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: Spacing.md,
  },
  errorText: {
    color: Colors.error,
    fontSize: 12,
    fontFamily: FontFamily.regular,
    marginTop: Spacing.sm,
  },
  infoCard: {
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.lg,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.sm,
  },
  infoLabel: {
    color: Colors.textSecondary,
    fontSize: 14,
    fontFamily: FontFamily.regular,
  },
  infoValue: {
    color: Colors.text,
    fontSize: 14,
    fontFamily: FontFamily.medium,
  },
  infoDivider: {
    height: 1,
    backgroundColor: Colors.border,
    marginVertical: Spacing.sm,
  },
  networkBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: P01.pinkDim,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderRadius: BorderRadius.full,
    gap: Spacing.xs,
  },
  networkDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: P01.pink,
  },
  networkText: {
    color: P01.pink,
    fontSize: 12,
    fontFamily: FontFamily.medium,
  },
  bottomSection: {
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
    paddingBottom: Spacing['3xl'],
  },
  sendButton: {
    backgroundColor: Colors.primary,
    borderRadius: BorderRadius.lg,
    paddingVertical: Spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
  },
  sendButtonDisabled: {
    backgroundColor: Colors.textTertiary,
    opacity: 0.5,
  },
  sendButtonText: {
    color: Colors.background,
    fontSize: 16,
    fontFamily: FontFamily.semibold,
  },
  splitSendButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
    marginTop: Spacing.md,
    gap: Spacing.md,
  },
  splitSendIcon: {
    width: 40,
    height: 40,
    borderRadius: BorderRadius.md,
    backgroundColor: P01.pinkDim,
    justifyContent: 'center',
    alignItems: 'center',
  },
  splitSendContent: {
    flex: 1,
  },
  splitSendTitle: {
    color: Colors.text,
    fontSize: 14,
    fontFamily: FontFamily.semibold,
  },
  splitSendDesc: {
    color: Colors.textSecondary,
    fontSize: 12,
    fontFamily: FontFamily.regular,
    marginTop: 2,
  },
});

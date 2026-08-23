/**
 * Send SOL — the public transfer.
 *
 * 🎯 RESTYLED 2026-08-23.
 *   - ⛔ THE LOCAL `P01` PALETTE IS DELETED. This file declared its own four
 *     colours at the top, one of them the retired pink, which is precisely how
 *     a token sweep over `constants/theme.ts` can move an app and leave a
 *     screen behind. Every colour is `Colors.*` now.
 *   - the field labels were "AMOUNT" and "RECIPIENT ADDRESS", caps and
 *     letterspaced. That house style is being removed everywhere.
 *   - the "public send" notice was PINK. It is a caution, and caution in this
 *     system is amber; pink was decoration on the one line of this screen that
 *     is actually a warning. It also pointed the user at Private Send, which is
 *     the parked personal-payments feature — it now says what is visible and
 *     stops there.
 *   - every target is at least 44pt, and both errors carry
 *     `accessibilityRole="alert"` beside the field that produced them.
 *
 * ⛔ LEFT ALONE ON PURPOSE, and reported rather than changed:
 *   - the confirm dialog. It restates what is on screen, so by the lean rule it
 *     should go — but `authenticateForSend()` returns true when the user has
 *     biometrics switched off, and then this dialog is the ONLY thing between a
 *     tap and an irreversible transfer. Removing it is a security change, not a
 *     UI one.
 *   - the jump to the full-screen `send-success` route. Collapsing that into a
 *     return-to-where-you-were is the right call, but the success screen is not
 *     part of this pass and removing its only entry point would orphan it.
 */

import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

import { useWalletStore } from '@/stores/walletStore';
import { useSecuritySettings } from '@/hooks/useSecuritySettings';
import { isValidAddress } from '@/services/solana/transactions';
import { getCluster } from '@/services/solana/connection';
import { formatBalance } from '@/services/solana/balance';
import { Colors, FontFamily, FontSize, BorderRadius, Spacing, Layout } from '@/constants/theme';
import { Button } from '@/components/ui/Button';
import { p01Alert } from '@/stores/alertStore';

export default function SendScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ address?: string }>();
  const {
    balance,
    sendTransaction,
    loading,
    publicKey,
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
  // Amount held back from MAX so the account keeps enough for the network fee
  // (and a little headroom). The base fee is ~0.000005 SOL; we reserve more to
  // stay safe against priority fees. Surfaced in the info card so MAX is honest.
  const FEE_RESERVE_SOL = 0.001;
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

    if (publicKey && value === publicKey) {
      setRecipientError("That's your own wallet address");
      return false;
    }

    setRecipientError('');
    return true;
  }, [publicKey]);

  // Auto-populate recipient from QR scan
  useEffect(() => {
    if (params?.address) {
      setRecipient(params.address);
      validateRecipient(params.address);
    }
  }, [params?.address]);

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

    // Reserve fee headroom (see FEE_RESERVE_SOL)
    const maxAmount = solBalance - FEE_RESERVE_SOL;
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
    const maxAmount = Math.max(0, solBalance - FEE_RESERVE_SOL);
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
      p01Alert('Authentication Required', 'Please authenticate to send this transaction.');
      return;
    }

    p01Alert(
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
                p01Alert('Transaction Failed', result.error || 'Unknown error');
              }
            } catch (error: any) {
              if (Platform.OS !== 'web') {
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
              }
              p01Alert('Error', error.message || 'Transaction failed');
            } finally {
              setSending(false);
            }
          },
        },
      ]
    );
  };

  const isFormValid = !!recipient && !!amount && !recipientError && !amountError && !sending;

  const networkLabel =
    currentNetwork === 'mainnet-beta' ? 'Mainnet'
      : currentNetwork === 'devnet' ? 'Devnet'
        : 'Testnet';

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={styles.backButton}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Ionicons name="chevron-back" size={22} color={Colors.textSecondary} />
          </TouchableOpacity>
          <Text style={styles.headerTitle} accessibilityRole="header">Send SOL</Text>
          <View style={styles.backButton} />
        </View>

        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={[
            styles.scrollContent,
            { paddingBottom: Layout.tabBarTotalHeight + insets.bottom + Spacing['2xl'] },
          ]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Amount */}
          <View style={styles.amountSection}>
            <View style={styles.amountInputContainer}>
              <TextInput
                style={styles.amountInput}
                placeholder="0"
                placeholderTextColor={Colors.textTertiary}
                value={amount}
                onChangeText={handleAmountChange}
                keyboardType="decimal-pad"
                accessibilityLabel="Amount in SOL"
                accessibilityHint="Enter the amount of SOL to send"
              />
              <Text style={styles.amountSymbol}>SOL</Text>
            </View>

            {/* Only when a price was actually looked up. */}
            {solPrice > 0 ? (
              <Text style={styles.usdValue}>≈ ${usdValue.toFixed(2)}</Text>
            ) : null}

            <View style={styles.percentButtons}>
              {[0.25, 0.5, 0.75, 1].map((percent) => (
                <TouchableOpacity
                  key={percent}
                  onPress={() => handlePercentage(percent)}
                  style={styles.percentButton}
                  accessibilityRole="button"
                  accessibilityLabel={percent === 1 ? 'Maximum amount' : `${percent * 100} percent of balance`}
                >
                  <Text style={styles.percentButtonText}>
                    {percent === 1 ? 'Max' : `${percent * 100}%`}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {amountError ? (
              <Text style={styles.errorText} accessibilityRole="alert">{amountError}</Text>
            ) : null}

            <Text style={styles.balanceLine}>
              Available {formattedSolBalance} SOL
            </Text>
          </View>

          {/* Recipient */}
          <View style={styles.recipientSection}>
            <Text style={styles.inputLabel}>To</Text>
            <View style={[
              styles.inputContainer,
              recipientError ? styles.inputError : null,
            ]}>
              <TextInput
                style={styles.textInput}
                placeholder="Solana address"
                placeholderTextColor={Colors.textTertiary}
                value={recipient}
                onChangeText={handleRecipientChange}
                autoCapitalize="none"
                autoCorrect={false}
                multiline
                numberOfLines={2}
                accessibilityLabel="Recipient address"
                accessibilityHint="Enter the Solana wallet address of the recipient"
              />
              <TouchableOpacity
                onPress={() => router.push('/(main)/(wallet)/scan')}
                style={styles.inlineButton}
                accessibilityRole="button"
                accessibilityLabel="Scan QR code"
              >
                <Ionicons name="scan-outline" size={20} color={Colors.textSecondary} />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={async () => {
                  const { getStringAsync } = require('expo-clipboard');
                  const text = await getStringAsync();
                  if (text) { setRecipient(text.trim()); validateRecipient(text.trim()); }
                }}
                style={styles.inlineButton}
                accessibilityRole="button"
                accessibilityLabel="Paste address"
              >
                <Ionicons name="clipboard-outline" size={20} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>
            {recipientError ? (
              <Text style={styles.errorText} accessibilityRole="alert">{recipientError}</Text>
            ) : null}
          </View>

          {/* What this transfer reveals. Amber, because it is a caution. */}
          <View style={styles.caution}>
            <Ionicons name="eye-outline" size={16} color={Colors.yellow} />
            <Text style={styles.cautionText}>
              A public transfer. The amount, the recipient and this wallet are all visible on chain.
            </Text>
          </View>

          {/* Transaction detail */}
          <View style={styles.infoCard}>
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Network fee</Text>
              <Text style={styles.infoValue}>~0.000005 SOL</Text>
            </View>
            <View style={styles.infoDivider} />
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Held back for fees on Max</Text>
              <Text style={styles.infoValue}>{FEE_RESERVE_SOL} SOL</Text>
            </View>
            <View style={styles.infoDivider} />
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Network</Text>
              <Text style={styles.infoValue}>{networkLabel}</Text>
            </View>
          </View>

          <Button
            variant="primary"
            size="lg"
            fullWidth
            loading={sending || loading}
            disabled={!isFormValid}
            onPress={handleSend}
            accessibilityLabel="Send SOL"
            style={styles.sendButton}
          >
            Send SOL
          </Button>
        </ScrollView>
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
    paddingHorizontal: Spacing.md,
    minHeight: 56,
  },
  backButton: {
    width: 44,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    color: Colors.text,
    fontSize: FontSize.xl,
    fontFamily: FontFamily.displayMedium,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: Spacing.xl,
  },
  amountSection: {
    alignItems: 'center',
    paddingTop: Spacing['3xl'],
    paddingBottom: Spacing['2xl'],
  },
  amountInputContainer: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: Spacing.sm,
  },
  amountInput: {
    color: Colors.text,
    fontSize: FontSize['5xl'],
    fontFamily: FontFamily.display,
    minWidth: 60,
    textAlign: 'center',
    padding: 0,
  },
  amountSymbol: {
    color: Colors.textSecondary,
    fontSize: FontSize['2xl'],
    fontFamily: FontFamily.display,
  },
  usdValue: {
    color: Colors.textSecondary,
    fontSize: FontSize.md,
    fontFamily: FontFamily.mono,
    marginTop: Spacing.sm,
  },
  percentButtons: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginTop: Spacing['2xl'],
  },
  percentButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: Spacing.lg,
    borderRadius: BorderRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  percentButtonText: {
    color: Colors.text,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.medium,
  },
  balanceLine: {
    color: Colors.textTertiary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    marginTop: Spacing.lg,
  },
  recipientSection: {
    marginBottom: Spacing['2xl'],
  },
  inputLabel: {
    color: Colors.textSecondary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    marginBottom: Spacing.sm,
  },
  inputContainer: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: Spacing.lg,
    paddingRight: Spacing.xs,
    paddingVertical: Spacing.xs,
  },
  inputError: {
    borderColor: Colors.error,
  },
  textInput: {
    flex: 1,
    color: Colors.text,
    fontSize: FontSize.md,
    fontFamily: FontFamily.mono,
    lineHeight: 22,
    paddingVertical: Spacing.md,
  },
  inlineButton: {
    width: 44,
    height: 44,
    borderRadius: BorderRadius.md,
    justifyContent: 'center',
    alignItems: 'center',
  },
  errorText: {
    color: Colors.error,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    marginTop: Spacing.sm,
    alignSelf: 'flex-start',
  },
  caution: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
    padding: Spacing.md,
    marginBottom: Spacing.xl,
    backgroundColor: Colors.warningDim,
    borderRadius: BorderRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.yellow,
  },
  cautionText: {
    color: Colors.text,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    lineHeight: 19,
    flex: 1,
  },
  infoCard: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.md,
    gap: Spacing.lg,
  },
  infoLabel: {
    color: Colors.textSecondary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    flexShrink: 1,
  },
  infoValue: {
    color: Colors.text,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.mono,
  },
  infoDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Colors.borderSoft,
  },
  sendButton: {
    marginTop: Spacing['2xl'],
  },
});

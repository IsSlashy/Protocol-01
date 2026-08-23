/**
 * Split Send — one payment, delivered in parts, at times you did not choose.
 *
 * 🎯 RESTYLED 2026-08-23.
 *   - ⛔ THE LOCAL `P01` PALETTE IS DELETED. Eight colours declared at the top
 *     of this file, including the retired pink and a `yellowDim` that was still
 *     the OLD amber (`rgba(255, 204, 0, …)`) after the theme had moved to
 *     `#d9a24a`. Two more literals — `'#eae7df'` and `'#000000'` — were spelled
 *     out in a dozen style rules instead of read from the tokens that hold
 *     exactly those values.
 *   - ⛔ BOTH GRADIENT BUTTONS ARE GONE, and with them `expo-linear-gradient`.
 *     The primary action is `ui/Button`, so it gets the 44pt floor, the real
 *     `disabled` state and the busy announcement for free — the hand-rolled one
 *     dimmed to 50% opacity while staying pressable.
 *   - "SPLIT CONFIGURATION", "SUMMARY", "MAX" were caps. Sentence case.
 *   - 🚨 "for maximum privacy" IS DELETED FROM THE COPY. It is not a phrase
 *     this project is allowed to use: the anonymity set here is the set of
 *     temp wallets, the recipient still receives every part, and an unqualified
 *     superlative is the exact shape `privacy-claims.test.ts` exists to catch
 *     on its sibling screens. It now says what splitting actually does.
 *
 * ⛔ `createSplit`, `executeSplit`, the fee estimate and the slider bounds are
 * untouched.
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import Slider from '@react-native-community/slider';

import { useWalletStore } from '@/stores/walletStore';
import { useSplitTransactionStore } from '@/stores/splitTransactionStore';
import { TransactionSplitter } from '@/services/privacy/transactionSplitter';
import { getKeypair } from '@/services/solana/wallet';
import { Colors, FontFamily, FontSize, BorderRadius, Spacing, Layout } from '@/constants/theme';
import { Button } from '@/components/ui/Button';
import { p01Alert } from '@/stores/alertStore';

export default function SendSplitScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ recipient?: string; amount?: string }>();

  const { balance } = useWalletStore();
  const {
    config,
    setConfig,
    createSplit,
    executeSplit,
    isProcessing,
  } = useSplitTransactionStore();

  // Form state
  const [recipient, setRecipient] = useState(params.recipient || '');
  const [amount, setAmount] = useState(params.amount || '');
  const [numSplits, setNumSplits] = useState(config.numSplits);
  const [timeWindow, setTimeWindow] = useState(config.timeWindowHours);
  const [noiseEnabled, setNoiseEnabled] = useState(config.noiseEnabled);

  // Execution state
  const [step, setStep] = useState<'configure' | 'preview' | 'executing'>('configure');
  const [splitPreview, setSplitPreview] = useState<string[]>([]);
  const [progress, setProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState('');

  const handlePaste = async () => {
    const text = await Clipboard.getStringAsync();
    if (text) {
      setRecipient(text);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  const handleSetMax = () => {
    const max = (balance?.sol || 0) - 0.01; // Leave some for fees
    setAmount(Math.max(0, max).toString());
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const validateInputs = (): boolean => {
    // Split transactions require local keypair (secret key) access for creating
    // temporary wallets — always available now (local keypair only, Privy removed).
    if (!recipient.trim()) {
      p01Alert('Missing Recipient', 'Please enter a wallet address.');
      return false;
    }

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum < 0.01) {
      p01Alert('Invalid Amount', 'Minimum amount for split transactions is 0.01 SOL.');
      return false;
    }

    const totalWithFees = amountNum + TransactionSplitter.estimateFees(numSplits);
    if (totalWithFees > (balance?.sol || 0)) {
      p01Alert('Insufficient Balance', `You need ${totalWithFees.toFixed(4)} SOL (including fees).`);
      return false;
    }

    return true;
  };

  const handlePreview = async () => {
    if (!validateInputs()) return;

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    // Update config
    setConfig({
      numSplits,
      timeWindowHours: timeWindow,
      noiseEnabled,
    });

    try {
      const keypair = await getKeypair();
      if (!keypair) throw new Error('Wallet not available');

      const split = await createSplit(recipient, parseFloat(amount), keypair.secretKey);
      const schedule = TransactionSplitter.formatSchedule(split);
      setSplitPreview(schedule);
      setStep('preview');
    } catch (error) {
      p01Alert('Error', (error as Error).message);
    }
  };

  const handleExecute = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    setStep('executing');
    setProgress(0);
    setProgressMessage('Initializing...');

    try {
      const keypair = await getKeypair();
      if (!keypair) throw new Error('Wallet not available');

      const { activeSplits } = useSplitTransactionStore.getState();
      const latestSplit = activeSplits[activeSplits.length - 1];

      await executeSplit(
        latestSplit.id,
        keypair.secretKey,
        (message, prog) => {
          setProgressMessage(message);
          setProgress(prog);
        }
      );

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      p01Alert(
        'Split Transaction Started',
        `Your ${numSplits} payments will be delivered over the next ${timeWindow} hours. You'll receive notifications as each part completes.`,
        [{ text: 'OK', onPress: () => router.back() }]
      );
    } catch (error) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      p01Alert('Error', (error as Error).message);
      setStep('preview');
    }
  };

  const estimatedFees = TransactionSplitter.estimateFees(numSplits);
  const amountNum = parseFloat(amount) || 0;
  const total = amountNum + estimatedFees;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
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
        <Text style={styles.headerText} accessibilityRole="header">Split send</Text>
        <View style={styles.backButton} />
      </View>

      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          style={styles.content}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {step === 'configure' && (
            <>
              <Text style={styles.lede}>
                One payment, sent as several smaller ones from temporary wallets at times you
                did not pick. It costs more in fees and it does not hide the recipient.
              </Text>

              {/* Recipient */}
              <Text style={styles.inputTitle}>Recipient address</Text>
              <View style={styles.inputContainer}>
                <TextInput
                  style={styles.addressInput}
                  value={recipient}
                  onChangeText={setRecipient}
                  placeholder="Solana address"
                  placeholderTextColor={Colors.textTertiary}
                  autoCapitalize="none"
                  autoCorrect={false}
                  accessibilityLabel="Recipient address"
                />
                <TouchableOpacity
                  onPress={handlePaste}
                  style={styles.inputAction}
                  accessibilityRole="button"
                  accessibilityLabel="Paste address"
                >
                  <Ionicons name="clipboard-outline" size={20} color={Colors.textSecondary} />
                </TouchableOpacity>
              </View>

              {/* Amount */}
              <View style={styles.amountHeader}>
                <Text style={styles.inputTitle}>Amount</Text>
                <TouchableOpacity
                  onPress={handleSetMax}
                  style={styles.maxButton}
                  accessibilityRole="button"
                  accessibilityLabel="Maximum amount"
                >
                  <Text style={styles.maxButtonText}>Max</Text>
                </TouchableOpacity>
              </View>
              <View style={styles.amountContainer}>
                <TextInput
                  style={styles.amountInput}
                  value={amount}
                  onChangeText={setAmount}
                  placeholder="0.0"
                  placeholderTextColor={Colors.textTertiary}
                  keyboardType="decimal-pad"
                  accessibilityLabel="Amount in SOL"
                />
                <Text style={styles.amountSuffix}>SOL</Text>
              </View>

              {/* Configuration */}
              <Text style={styles.sectionTitle}>How it is split</Text>

              <View style={styles.configRow}>
                <Text style={styles.configText}>Number of parts</Text>
                <Text style={styles.configValue}>{numSplits}</Text>
              </View>
              <Slider
                style={styles.slider}
                minimumValue={2}
                maximumValue={10}
                step={1}
                value={numSplits}
                onValueChange={setNumSplits}
                minimumTrackTintColor={Colors.primary}
                maximumTrackTintColor={Colors.border}
                thumbTintColor={Colors.primary}
                accessibilityLabel="Number of parts"
              />

              <View style={styles.configRow}>
                <Text style={styles.configText}>Delivered over</Text>
                <Text style={styles.configValue}>{timeWindow}h</Text>
              </View>
              <Slider
                style={styles.slider}
                minimumValue={1}
                maximumValue={24}
                step={1}
                value={timeWindow}
                onValueChange={setTimeWindow}
                minimumTrackTintColor={Colors.primary}
                maximumTrackTintColor={Colors.border}
                thumbTintColor={Colors.primary}
                accessibilityLabel="Delivery window in hours"
              />

              <TouchableOpacity
                style={styles.toggleRow}
                onPress={() => setNoiseEnabled(!noiseEnabled)}
                accessibilityRole="switch"
                accessibilityState={{ checked: noiseEnabled }}
                accessibilityLabel="Vary the size of each part"
              >
                <Text style={styles.configText}>Vary the size of each part</Text>
                <View style={[styles.toggle, noiseEnabled && styles.toggleActive]}>
                  <View style={[styles.toggleThumb, noiseEnabled && styles.toggleThumbActive]} />
                </View>
              </TouchableOpacity>

              {/* Summary */}
              {amountNum > 0 && (
                <View style={styles.summaryCard}>
                  <View style={styles.summaryRow}>
                    <Text style={styles.summaryLabel}>Amount</Text>
                    <Text style={styles.summaryValue}>{amountNum.toFixed(4)} SOL</Text>
                  </View>
                  <View style={styles.summaryRow}>
                    <Text style={styles.summaryLabel}>Parts</Text>
                    <Text style={styles.summaryValue}>{numSplits}</Text>
                  </View>
                  <View style={styles.summaryRow}>
                    <Text style={styles.summaryLabel}>Delivered over</Text>
                    <Text style={styles.summaryValue}>{timeWindow} hours</Text>
                  </View>
                  <View style={styles.summaryRow}>
                    <Text style={styles.summaryLabel}>Estimated fees</Text>
                    <Text style={styles.summaryValue}>~{estimatedFees.toFixed(6)} SOL</Text>
                  </View>
                  <View style={styles.summaryDivider} />
                  <View style={styles.summaryRow}>
                    <Text style={styles.summaryLabelBold}>Total</Text>
                    <Text style={styles.summaryValueBold}>{total.toFixed(4)} SOL</Text>
                  </View>
                </View>
              )}
            </>
          )}

          {step === 'preview' && (
            <>
              <Text style={styles.previewTitle} accessibilityRole="header">Delivery schedule</Text>
              <Text style={styles.previewSubtitle}>
                The recipient receives these {splitPreview.length} payments, from different
                addresses, at these times.
              </Text>

              {splitPreview.map((item, index) => (
                <View key={index} style={styles.scheduleItem}>
                  <Text style={styles.scheduleIndex}>{index + 1}</Text>
                  <Text style={styles.scheduleText}>{item}</Text>
                </View>
              ))}

              <View style={styles.warningBox}>
                <Ionicons name="alert-circle-outline" size={18} color={Colors.yellow} />
                <Text style={styles.warningText}>
                  Keep the app installed until the last part lands. Each one is notified as it
                  completes.
                </Text>
              </View>
            </>
          )}

          {step === 'executing' && (
            <View style={styles.executingContainer}>
              <ActivityIndicator size="large" color={Colors.primary} />
              <Text style={styles.executingTitle} accessibilityRole="header">Setting up the split</Text>
              <Text style={styles.executingMessage}>{progressMessage}</Text>

              <View
                style={styles.progressBar}
                accessibilityRole="progressbar"
                accessibilityValue={{ min: 0, max: 100, now: Math.round(progress) }}
              >
                <View style={[styles.progressFill, { width: `${progress}%` }]} />
              </View>
              <Text style={styles.progressText}>{Math.round(progress)}%</Text>

              <Text style={styles.executingWarning}>
                Keep the app open while the temporary wallets are funded.
              </Text>
            </View>
          )}
        </ScrollView>

        {/* One action per step. */}
        {step !== 'executing' && (
          <View style={[styles.bottomContainer, { paddingBottom: Layout.tabBarTotalHeight + insets.bottom }]}>
            {step === 'configure' ? (
              <Button
                variant="primary"
                size="lg"
                fullWidth
                loading={isProcessing}
                disabled={!recipient || !amount}
                onPress={handlePreview}
              >
                Preview schedule
              </Button>
            ) : (
              <View style={styles.buttonRow}>
                <Button
                  variant="secondary"
                  size="lg"
                  style={styles.backAction}
                  onPress={() => setStep('configure')}
                >
                  Back
                </Button>
                <Button
                  variant="primary"
                  size="lg"
                  style={styles.confirmAction}
                  onPress={handleExecute}
                >
                  Send
                </Button>
              </View>
            )}
          </View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
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
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerText: {
    fontSize: FontSize.xl,
    fontFamily: FontFamily.displayMedium,
    color: Colors.text,
  },
  keyboardView: {
    flex: 1,
  },
  content: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing['3xl'],
  },
  lede: {
    fontSize: FontSize.md,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    lineHeight: 22,
    marginBottom: Spacing['2xl'],
  },
  inputTitle: {
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    marginBottom: Spacing.sm,
  },
  inputContainer: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: Spacing.lg,
    paddingRight: Spacing.xs,
    marginBottom: Spacing.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  addressInput: {
    flex: 1,
    paddingVertical: Spacing.md,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.mono,
    color: Colors.text,
  },
  inputAction: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  amountHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.sm,
  },
  maxButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingLeft: Spacing.lg,
  },
  maxButtonText: {
    fontSize: FontSize.sm,
    fontFamily: FontFamily.medium,
    color: Colors.primary,
  },
  amountContainer: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    marginBottom: Spacing['2xl'],
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  amountInput: {
    flex: 1,
    paddingVertical: Spacing.lg,
    fontSize: FontSize['2xl'],
    fontFamily: FontFamily.display,
    color: Colors.text,
  },
  amountSuffix: {
    fontSize: FontSize.lg,
    fontFamily: FontFamily.display,
    color: Colors.textSecondary,
  },
  sectionTitle: {
    fontSize: FontSize.lg,
    fontFamily: FontFamily.displayMedium,
    color: Colors.text,
    marginBottom: Spacing.lg,
  },
  configRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.xs,
  },
  configText: {
    fontSize: FontSize.md,
    fontFamily: FontFamily.regular,
    color: Colors.text,
  },
  configValue: {
    fontSize: FontSize.md,
    fontFamily: FontFamily.mono,
    color: Colors.text,
  },
  slider: {
    width: '100%',
    height: 40,
    marginBottom: Spacing.lg,
  },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: 48,
    marginBottom: Spacing.lg,
  },
  toggle: {
    width: 50,
    height: 28,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.surfaceTertiary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    justifyContent: 'center',
    padding: 2,
  },
  toggleActive: {
    backgroundColor: Colors.primaryDim,
    borderColor: Colors.primaryMuted,
  },
  toggleThumb: {
    width: 22,
    height: 22,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.textTertiary,
  },
  toggleThumbActive: {
    backgroundColor: Colors.primary,
    marginLeft: 'auto',
  },
  summaryCard: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    padding: Spacing.lg,
    marginTop: Spacing.md,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: Spacing.md,
  },
  summaryLabel: {
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
  },
  summaryValue: {
    fontSize: FontSize.sm,
    fontFamily: FontFamily.mono,
    color: Colors.text,
  },
  summaryDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Colors.borderSoft,
    marginBottom: Spacing.md,
  },
  summaryLabelBold: {
    fontSize: FontSize.md,
    fontFamily: FontFamily.medium,
    color: Colors.text,
  },
  summaryValueBold: {
    fontSize: FontSize.md,
    fontFamily: FontFamily.mono,
    color: Colors.text,
  },
  previewTitle: {
    fontSize: FontSize['2xl'],
    fontFamily: FontFamily.display,
    color: Colors.text,
  },
  previewSubtitle: {
    fontSize: FontSize.md,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    lineHeight: 22,
    marginTop: Spacing.sm,
    marginBottom: Spacing.xl,
  },
  scheduleItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.borderSoft,
  },
  scheduleIndex: {
    width: 20,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.mono,
    color: Colors.textTertiary,
  },
  scheduleText: {
    flex: 1,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.mono,
    color: Colors.text,
  },
  warningBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
    backgroundColor: Colors.warningDim,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginTop: Spacing.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.yellow,
  },
  warningText: {
    flex: 1,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    color: Colors.text,
    lineHeight: 20,
  },
  executingContainer: {
    alignItems: 'center',
    paddingVertical: Spacing['5xl'],
  },
  executingTitle: {
    fontSize: FontSize['2xl'],
    fontFamily: FontFamily.display,
    color: Colors.text,
    marginTop: Spacing['2xl'],
    marginBottom: Spacing.sm,
  },
  executingMessage: {
    fontSize: FontSize.md,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    marginBottom: Spacing.xl,
    textAlign: 'center',
  },
  progressBar: {
    width: '100%',
    height: 6,
    backgroundColor: Colors.surfaceTertiary,
    borderRadius: BorderRadius.full,
    overflow: 'hidden',
    marginBottom: Spacing.sm,
  },
  progressFill: {
    height: '100%',
    backgroundColor: Colors.primary,
    borderRadius: BorderRadius.full,
  },
  progressText: {
    fontSize: FontSize.sm,
    fontFamily: FontFamily.mono,
    color: Colors.textSecondary,
    marginBottom: Spacing.xl,
  },
  executingWarning: {
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    textAlign: 'center',
  },
  bottomContainer: {
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.md,
    backgroundColor: Colors.background,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.borderSoft,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: Spacing.md,
  },
  backAction: { flex: 1 },
  confirmAction: { flex: 2 },
});

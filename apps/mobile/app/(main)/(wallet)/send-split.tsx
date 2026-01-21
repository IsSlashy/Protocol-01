/**
 * Split Send Screen
 *
 * Allows users to send SOL using transaction splitting for maximum privacy.
 * The payment is split into multiple parts routed through temp wallets
 * and delivered at random times.
 */

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';
import Slider from '@react-native-community/slider';

import { useWalletStore } from '@/stores/walletStore';
import { useSplitTransactionStore } from '@/stores/splitTransactionStore';
import { TransactionSplitter, DEFAULT_SPLIT_CONFIG } from '@/services/privacy/transactionSplitter';
import { Colors, FontFamily, BorderRadius, Spacing } from '@/constants/theme';

// P-01 Design System Colors
const P01 = {
  cyan: '#39c5bb',
  cyanDim: 'rgba(57, 197, 187, 0.15)',
  pink: '#ff77a8',
  pinkDim: 'rgba(255, 119, 168, 0.15)',
  blue: '#3b82f6',
  blueDim: 'rgba(59, 130, 246, 0.15)',
  yellow: '#ffcc00',
  yellowDim: 'rgba(255, 204, 0, 0.15)',
};

export default function SendSplitScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ recipient?: string; amount?: string }>();

  const { balance, getKeypair } = useWalletStore();
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
    if (!recipient.trim()) {
      Alert.alert('Missing Recipient', 'Please enter a wallet address.');
      return false;
    }

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum < 0.01) {
      Alert.alert('Invalid Amount', 'Minimum amount for split transactions is 0.01 SOL.');
      return false;
    }

    const totalWithFees = amountNum + TransactionSplitter.estimateFees(numSplits);
    if (totalWithFees > (balance?.sol || 0)) {
      Alert.alert('Insufficient Balance', `You need ${totalWithFees.toFixed(4)} SOL (including fees).`);
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
      Alert.alert('Error', (error as Error).message);
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

      Alert.alert(
        'Split Transaction Started',
        `Your ${numSplits} payments will be delivered over the next ${timeWindow} hours. You'll receive notifications as each part completes.`,
        [{ text: 'OK', onPress: () => router.back() }]
      );
    } catch (error) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Error', (error as Error).message);
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
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color="#ffffff" />
        </TouchableOpacity>
        <View style={styles.headerTitle}>
          <Ionicons name="git-branch" size={20} color={P01.pink} />
          <Text style={styles.headerText}>Split Send</Text>
        </View>
        <View style={{ width: 40 }} />
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
              {/* Info Banner */}
              <Animated.View entering={FadeInDown.delay(100)}>
                <View style={styles.infoBanner}>
                  <Ionicons name="shield-checkmark" size={20} color={P01.cyan} />
                  <Text style={styles.infoBannerText}>
                    Split transactions divide your payment into multiple parts delivered
                    at random times for maximum privacy.
                  </Text>
                </View>
              </Animated.View>

              {/* Recipient Input */}
              <Animated.View entering={FadeInDown.delay(200)}>
                <Text style={styles.inputTitle}>Recipient Address</Text>
                <View style={styles.inputContainer}>
                  <TextInput
                    style={styles.addressInput}
                    value={recipient}
                    onChangeText={setRecipient}
                    placeholder="Solana wallet address..."
                    placeholderTextColor={Colors.textTertiary}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <TouchableOpacity onPress={handlePaste} style={styles.inputAction}>
                    <Ionicons name="clipboard-outline" size={20} color={P01.cyan} />
                  </TouchableOpacity>
                </View>
              </Animated.View>

              {/* Amount Input */}
              <Animated.View entering={FadeInDown.delay(300)}>
                <View style={styles.amountHeader}>
                  <Text style={styles.inputTitle}>Amount</Text>
                  <TouchableOpacity onPress={handleSetMax}>
                    <Text style={styles.maxButton}>MAX</Text>
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
                  />
                  <Text style={styles.amountSuffix}>SOL</Text>
                </View>
              </Animated.View>

              {/* Split Configuration */}
              <Animated.View entering={FadeInDown.delay(400)}>
                <Text style={styles.sectionTitle}>SPLIT CONFIGURATION</Text>

                {/* Number of Splits */}
                <View style={styles.configRow}>
                  <View style={styles.configLabel}>
                    <Ionicons name="git-branch" size={18} color={P01.pink} />
                    <Text style={styles.configText}>Number of Splits</Text>
                  </View>
                  <Text style={styles.configValue}>{numSplits}</Text>
                </View>
                <Slider
                  style={styles.slider}
                  minimumValue={2}
                  maximumValue={10}
                  step={1}
                  value={numSplits}
                  onValueChange={setNumSplits}
                  minimumTrackTintColor={P01.pink}
                  maximumTrackTintColor={Colors.border}
                  thumbTintColor={P01.pink}
                />

                {/* Time Window */}
                <View style={styles.configRow}>
                  <View style={styles.configLabel}>
                    <Ionicons name="time" size={18} color={P01.blue} />
                    <Text style={styles.configText}>Delivery Window</Text>
                  </View>
                  <Text style={styles.configValue}>{timeWindow}h</Text>
                </View>
                <Slider
                  style={styles.slider}
                  minimumValue={1}
                  maximumValue={24}
                  step={1}
                  value={timeWindow}
                  onValueChange={setTimeWindow}
                  minimumTrackTintColor={P01.blue}
                  maximumTrackTintColor={Colors.border}
                  thumbTintColor={P01.blue}
                />

                {/* Amount Noise Toggle */}
                <TouchableOpacity
                  style={styles.toggleRow}
                  onPress={() => setNoiseEnabled(!noiseEnabled)}
                >
                  <View style={styles.configLabel}>
                    <Ionicons name="analytics" size={18} color={P01.cyan} />
                    <Text style={styles.configText}>Amount Noise</Text>
                  </View>
                  <View style={[styles.toggle, noiseEnabled && styles.toggleActive]}>
                    <View style={[styles.toggleThumb, noiseEnabled && styles.toggleThumbActive]} />
                  </View>
                </TouchableOpacity>
              </Animated.View>

              {/* Summary */}
              {amountNum > 0 && (
                <Animated.View entering={FadeInUp.delay(100)}>
                  <View style={styles.summaryCard}>
                    <Text style={styles.summaryTitle}>SUMMARY</Text>
                    <View style={styles.summaryRow}>
                      <Text style={styles.summaryLabel}>Amount</Text>
                      <Text style={styles.summaryValue}>{amountNum.toFixed(4)} SOL</Text>
                    </View>
                    <View style={styles.summaryRow}>
                      <Text style={styles.summaryLabel}>Splits</Text>
                      <Text style={styles.summaryValue}>{numSplits} transactions</Text>
                    </View>
                    <View style={styles.summaryRow}>
                      <Text style={styles.summaryLabel}>Time Window</Text>
                      <Text style={styles.summaryValue}>{timeWindow} hours</Text>
                    </View>
                    <View style={styles.summaryRow}>
                      <Text style={styles.summaryLabel}>Est. Fees</Text>
                      <Text style={styles.summaryValue}>~{estimatedFees.toFixed(6)} SOL</Text>
                    </View>
                    <View style={styles.summaryDivider} />
                    <View style={styles.summaryRow}>
                      <Text style={styles.summaryLabelBold}>Total</Text>
                      <Text style={styles.summaryValueBold}>{total.toFixed(4)} SOL</Text>
                    </View>
                  </View>
                </Animated.View>
              )}
            </>
          )}

          {step === 'preview' && (
            <>
              <Animated.View entering={FadeInDown.delay(100)}>
                <View style={styles.previewHeader}>
                  <Ionicons name="calendar" size={24} color={P01.pink} />
                  <Text style={styles.previewTitle}>Delivery Schedule</Text>
                </View>
                <Text style={styles.previewSubtitle}>
                  Your payment will be split and delivered as follows:
                </Text>
              </Animated.View>

              {splitPreview.map((item, index) => (
                <Animated.View
                  key={index}
                  entering={FadeInDown.delay(200 + index * 100)}
                  style={styles.scheduleItem}
                >
                  <View style={styles.scheduleIcon}>
                    <Text style={styles.scheduleIndex}>{index + 1}</Text>
                  </View>
                  <Text style={styles.scheduleText}>{item}</Text>
                </Animated.View>
              ))}

              <Animated.View entering={FadeInUp.delay(500)} style={styles.warningBox}>
                <Ionicons name="information-circle" size={20} color={P01.yellow} />
                <Text style={styles.warningText}>
                  Keep the app installed. You'll receive notifications as each part is delivered.
                  The recipient will receive funds from different addresses at different times.
                </Text>
              </Animated.View>
            </>
          )}

          {step === 'executing' && (
            <Animated.View entering={FadeInDown} style={styles.executingContainer}>
              <View style={styles.executingIcon}>
                <ActivityIndicator size="large" color={P01.cyan} />
              </View>
              <Text style={styles.executingTitle}>Executing Split Transaction</Text>
              <Text style={styles.executingMessage}>{progressMessage}</Text>

              <View style={styles.progressBar}>
                <View style={[styles.progressFill, { width: `${progress}%` }]} />
              </View>
              <Text style={styles.progressText}>{Math.round(progress)}%</Text>

              <Text style={styles.executingWarning}>
                Please keep the app open during initial funding...
              </Text>
            </Animated.View>
          )}
        </ScrollView>

        {/* Bottom Button */}
        {step !== 'executing' && (
          <View style={styles.bottomContainer}>
            {step === 'configure' ? (
              <TouchableOpacity
                style={[styles.actionButton, (!recipient || !amount) && styles.buttonDisabled]}
                onPress={handlePreview}
                disabled={!recipient || !amount || isProcessing}
              >
                <LinearGradient
                  colors={[P01.pink, '#ff2d7a']}
                  style={styles.buttonGradient}
                >
                  {isProcessing ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <>
                      <Ionicons name="eye" size={20} color="#fff" />
                      <Text style={styles.buttonText}>Preview Schedule</Text>
                    </>
                  )}
                </LinearGradient>
              </TouchableOpacity>
            ) : (
              <View style={styles.buttonRow}>
                <TouchableOpacity
                  style={styles.backButtonBottom}
                  onPress={() => setStep('configure')}
                >
                  <Text style={styles.backButtonText}>Back</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.confirmButton}
                  onPress={handleExecute}
                >
                  <LinearGradient
                    colors={[P01.cyan, '#00ffe5']}
                    style={styles.buttonGradient}
                  >
                    <Ionicons name="checkmark-circle" size={20} color="#000" />
                    <Text style={styles.confirmButtonText}>Confirm & Send</Text>
                  </LinearGradient>
                </TouchableOpacity>
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
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  backButton: {
    padding: 8,
    marginLeft: -8,
  },
  headerTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerText: {
    fontSize: 18,
    fontFamily: FontFamily.bold,
    color: '#ffffff',
  },
  keyboardView: {
    flex: 1,
  },
  content: {
    flex: 1,
  },
  scrollContent: {
    padding: Spacing.md,
    paddingBottom: 120,
  },
  infoBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    backgroundColor: P01.cyanDim,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.lg,
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.3)',
  },
  infoBannerText: {
    flex: 1,
    fontSize: 13,
    fontFamily: FontFamily.regular,
    color: '#888892',
    lineHeight: 20,
  },
  inputTitle: {
    fontSize: 14,
    fontFamily: FontFamily.semibold,
    color: '#ffffff',
    marginBottom: Spacing.sm,
  },
  inputContainer: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: Spacing.sm,
    marginBottom: Spacing.lg,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  addressInput: {
    flex: 1,
    padding: Spacing.md,
    fontSize: 14,
    fontFamily: FontFamily.mono,
    color: '#ffffff',
  },
  inputAction: {
    padding: 8,
  },
  amountHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.sm,
  },
  maxButton: {
    fontSize: 12,
    fontFamily: FontFamily.bold,
    color: P01.cyan,
  },
  amountContainer: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    marginBottom: Spacing.lg,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  amountInput: {
    flex: 1,
    paddingVertical: Spacing.lg,
    fontSize: 28,
    fontFamily: FontFamily.bold,
    color: '#ffffff',
  },
  amountSuffix: {
    fontSize: 18,
    fontFamily: FontFamily.medium,
    color: '#888892',
  },
  sectionTitle: {
    fontSize: 11,
    fontFamily: FontFamily.bold,
    color: '#555560',
    letterSpacing: 1,
    marginBottom: Spacing.md,
  },
  configRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.xs,
  },
  configLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  configText: {
    fontSize: 14,
    fontFamily: FontFamily.medium,
    color: '#ffffff',
  },
  configValue: {
    fontSize: 14,
    fontFamily: FontFamily.bold,
    color: P01.cyan,
  },
  slider: {
    width: '100%',
    height: 40,
    marginBottom: Spacing.md,
  },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: Spacing.sm,
    marginBottom: Spacing.md,
  },
  toggle: {
    width: 50,
    height: 28,
    borderRadius: 14,
    backgroundColor: Colors.border,
    justifyContent: 'center',
    padding: 2,
  },
  toggleActive: {
    backgroundColor: P01.cyanDim,
  },
  toggleThumb: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#888892',
  },
  toggleThumbActive: {
    backgroundColor: P01.cyan,
    marginLeft: 'auto',
  },
  summaryCard: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginTop: Spacing.md,
  },
  summaryTitle: {
    fontSize: 11,
    fontFamily: FontFamily.bold,
    color: '#555560',
    letterSpacing: 1,
    marginBottom: Spacing.md,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: Spacing.sm,
  },
  summaryLabel: {
    fontSize: 14,
    fontFamily: FontFamily.regular,
    color: '#888892',
  },
  summaryValue: {
    fontSize: 14,
    fontFamily: FontFamily.medium,
    color: '#ffffff',
  },
  summaryDivider: {
    height: 1,
    backgroundColor: Colors.border,
    marginVertical: Spacing.sm,
  },
  summaryLabelBold: {
    fontSize: 14,
    fontFamily: FontFamily.bold,
    color: '#ffffff',
  },
  summaryValueBold: {
    fontSize: 14,
    fontFamily: FontFamily.bold,
    color: P01.pink,
  },
  previewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: Spacing.sm,
  },
  previewTitle: {
    fontSize: 20,
    fontFamily: FontFamily.bold,
    color: '#ffffff',
  },
  previewSubtitle: {
    fontSize: 14,
    fontFamily: FontFamily.regular,
    color: '#888892',
    marginBottom: Spacing.lg,
  },
  scheduleItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.sm,
  },
  scheduleIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: P01.pinkDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scheduleIndex: {
    fontSize: 14,
    fontFamily: FontFamily.bold,
    color: P01.pink,
  },
  scheduleText: {
    flex: 1,
    fontSize: 14,
    fontFamily: FontFamily.mono,
    color: '#ffffff',
  },
  warningBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: P01.yellowDim,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginTop: Spacing.lg,
    borderWidth: 1,
    borderColor: 'rgba(255, 204, 0, 0.3)',
  },
  warningText: {
    flex: 1,
    fontSize: 13,
    fontFamily: FontFamily.regular,
    color: '#888892',
    lineHeight: 20,
  },
  executingContainer: {
    alignItems: 'center',
    paddingVertical: Spacing['3xl'],
  },
  executingIcon: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: P01.cyanDim,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.lg,
  },
  executingTitle: {
    fontSize: 20,
    fontFamily: FontFamily.bold,
    color: '#ffffff',
    marginBottom: Spacing.sm,
  },
  executingMessage: {
    fontSize: 14,
    fontFamily: FontFamily.medium,
    color: P01.cyan,
    marginBottom: Spacing.lg,
  },
  progressBar: {
    width: '100%',
    height: 8,
    backgroundColor: Colors.surface,
    borderRadius: 4,
    overflow: 'hidden',
    marginBottom: Spacing.sm,
  },
  progressFill: {
    height: '100%',
    backgroundColor: P01.cyan,
    borderRadius: 4,
  },
  progressText: {
    fontSize: 14,
    fontFamily: FontFamily.mono,
    color: '#888892',
    marginBottom: Spacing.lg,
  },
  executingWarning: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: '#555560',
    textAlign: 'center',
  },
  bottomContainer: {
    padding: Spacing.md,
    paddingBottom: Spacing.xl,
    backgroundColor: Colors.background,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  actionButton: {
    borderRadius: BorderRadius.md,
    overflow: 'hidden',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: Spacing.lg,
  },
  buttonText: {
    fontSize: 16,
    fontFamily: FontFamily.bold,
    color: '#ffffff',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  backButtonBottom: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    paddingVertical: Spacing.lg,
    alignItems: 'center',
  },
  backButtonText: {
    fontSize: 16,
    fontFamily: FontFamily.bold,
    color: '#ffffff',
  },
  confirmButton: {
    flex: 2,
    borderRadius: BorderRadius.md,
    overflow: 'hidden',
  },
  confirmButtonText: {
    fontSize: 16,
    fontFamily: FontFamily.bold,
    color: '#000000',
  },
});

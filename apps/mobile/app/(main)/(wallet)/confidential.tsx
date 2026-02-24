import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  StyleSheet,
  TextInput,
  Modal,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { useWalletStore } from '@/stores/walletStore';
import { useConfidentialStore } from '@/stores/confidentialStore';
import { NATIVE_SOL_MINT_STR } from '@/services/zkspl';
import { Colors, FontFamily, BorderRadius, Spacing } from '@/constants/theme';

// P-01 Design System Colors
const P01 = {
  cyan: '#39c5bb',
  cyanDim: 'rgba(57, 197, 187, 0.15)',
  pink: '#ff77a8',
  pinkDim: 'rgba(255, 119, 168, 0.15)',
  blue: '#3b82f6',
  blueDim: 'rgba(59, 130, 246, 0.15)',
};

export default function ConfidentialBalanceScreen() {
  const router = useRouter();
  const { balance, publicKey } = useWalletStore();
  const {
    isInitialized,
    isLoading,
    balances,
    accounts,
    pendingCredits,
    error,
    initialize,
    ensureInitialized,
    refreshBalance,
    deposit,
    withdraw,
    confidentialTransfer,
    applyPending,
  } = useConfidentialStore();

  const [showBalance, setShowBalance] = useState(true);
  const [actionModal, setActionModal] = useState<'deposit' | 'withdraw' | 'transfer' | null>(null);
  const [amount, setAmount] = useState('');
  const [recipientAddress, setRecipientAddress] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  // Progress tracking
  const [progressStep, setProgressStep] = useState(0);
  const [progressMessage, setProgressMessage] = useState('');
  const [progressOperation, setProgressOperation] = useState<'deposit' | 'withdraw' | 'transfer' | null>(null);

  // Derived values
  const confidentialBalance = (balances[NATIVE_SOL_MINT_STR] || 0) / 1e9;
  const pendingCount = pendingCredits[NATIVE_SOL_MINT_STR] || 0;
  const accountExists = accounts[NATIVE_SOL_MINT_STR] || false;

  // Initialize on mount
  useEffect(() => {
    if (publicKey) {
      ensureInitialized();
    }
  }, [publicKey]);

  const handleRefresh = useCallback(async () => {
    await refreshBalance(NATIVE_SOL_MINT_STR);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [refreshBalance]);

  const formatBalance = () => {
    if (!showBalance) return '****';
    return `${confidentialBalance.toFixed(4)} SOL`;
  };

  // -----------------------------------------------------------------------
  // Deposit handler
  // -----------------------------------------------------------------------

  const handleDeposit = async () => {
    if (!amount || parseFloat(amount) <= 0) {
      Alert.alert('Invalid Amount', 'Please enter a valid amount');
      return;
    }
    if (!publicKey) {
      Alert.alert('Error', 'Wallet not connected');
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsProcessing(true);
    setProgressOperation('deposit');
    setProgressStep(0);
    setProgressMessage('Preparing deposit...');

    try {
      let currentStep = 10;
      const progressInterval = setInterval(() => {
        if (currentStep >= 85) {
          currentStep = 85;
        } else {
          const increment = currentStep < 40 ? 6 : currentStep < 65 ? 4 : 2;
          currentStep = Math.min(currentStep + increment, 85);
        }
        setProgressStep(currentStep);

        if (currentStep < 30) setProgressMessage('Generating proof...');
        else if (currentStep < 55) setProgressMessage('Signing transaction...');
        else if (currentStep < 75) setProgressMessage('Submitting to Solana...');
        else setProgressMessage('Confirming...');
      }, 200);

      await deposit(NATIVE_SOL_MINT_STR, parseFloat(amount));

      clearInterval(progressInterval);
      setProgressStep(100);
      setProgressMessage('Complete!');

      await new Promise((resolve) => setTimeout(resolve, 500));

      setActionModal(null);
      setAmount('');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Success', 'SOL deposited into confidential balance');
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Error', (err as Error).message);
    } finally {
      setIsProcessing(false);
      setProgressOperation(null);
      setProgressStep(0);
      setProgressMessage('');
    }
  };

  // -----------------------------------------------------------------------
  // Withdraw handler
  // -----------------------------------------------------------------------

  const handleWithdraw = async () => {
    if (!amount || parseFloat(amount) <= 0) {
      Alert.alert('Invalid Amount', 'Please enter a valid amount');
      return;
    }
    if (parseFloat(amount) > confidentialBalance) {
      Alert.alert('Insufficient Balance', 'You do not have enough confidential SOL');
      return;
    }
    if (!publicKey) {
      Alert.alert('Error', 'Wallet not connected');
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsProcessing(true);
    setProgressOperation('withdraw');
    setProgressStep(0);
    setProgressMessage('Preparing withdrawal...');

    try {
      let currentStep = 10;
      const progressInterval = setInterval(() => {
        if (currentStep >= 85) {
          currentStep = 85;
        } else {
          const increment = currentStep < 40 ? 6 : currentStep < 65 ? 4 : 2;
          currentStep = Math.min(currentStep + increment, 85);
        }
        setProgressStep(currentStep);

        if (currentStep < 30) setProgressMessage('Generating ZK proof...');
        else if (currentStep < 55) setProgressMessage('Signing transaction...');
        else if (currentStep < 75) setProgressMessage('Submitting to Solana...');
        else setProgressMessage('Confirming...');
      }, 200);

      await withdraw(NATIVE_SOL_MINT_STR, parseFloat(amount));

      clearInterval(progressInterval);
      setProgressStep(100);
      setProgressMessage('Complete!');

      await new Promise((resolve) => setTimeout(resolve, 500));

      setActionModal(null);
      setAmount('');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Success', 'SOL withdrawn from confidential balance');
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Error', (err as Error).message);
    } finally {
      setIsProcessing(false);
      setProgressOperation(null);
      setProgressStep(0);
      setProgressMessage('');
    }
  };

  // -----------------------------------------------------------------------
  // Transfer handler
  // -----------------------------------------------------------------------

  const handleTransfer = async () => {
    if (!amount || parseFloat(amount) <= 0) {
      Alert.alert('Invalid Amount', 'Please enter a valid amount');
      return;
    }
    if (!recipientAddress.trim()) {
      Alert.alert('Missing Recipient', 'Please enter a recipient address');
      return;
    }
    if (parseFloat(amount) > confidentialBalance) {
      Alert.alert('Insufficient Balance', 'You do not have enough confidential SOL');
      return;
    }

    // Validate the recipient is a valid Solana public key
    try {
      new (require('@solana/web3.js').PublicKey)(recipientAddress.trim());
    } catch {
      Alert.alert('Invalid Address', 'Please enter a valid Solana address');
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsProcessing(true);
    setProgressOperation('transfer');
    setProgressStep(0);
    setProgressMessage('Preparing transfer...');

    try {
      let currentStep = 10;
      const progressInterval = setInterval(() => {
        if (currentStep >= 85) {
          currentStep = 85;
        } else {
          const increment = currentStep < 40 ? 5 : currentStep < 65 ? 3 : 2;
          currentStep = Math.min(currentStep + increment, 85);
        }
        setProgressStep(currentStep);

        if (currentStep < 25) setProgressMessage('Generating ZK proof...');
        else if (currentStep < 45) setProgressMessage('Creating commitment...');
        else if (currentStep < 65) setProgressMessage('Signing transaction...');
        else if (currentStep < 80) setProgressMessage('Submitting to Solana...');
        else setProgressMessage('Confirming...');
      }, 250);

      await confidentialTransfer(
        NATIVE_SOL_MINT_STR,
        recipientAddress.trim(),
        parseFloat(amount),
      );

      clearInterval(progressInterval);
      setProgressStep(100);
      setProgressMessage('Complete!');

      await new Promise((resolve) => setTimeout(resolve, 500));

      setActionModal(null);
      setAmount('');
      setRecipientAddress('');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert(
        'Transfer Sent',
        'The confidential transfer has been sent. The recipient will see a pending credit they need to apply.',
      );
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Error', (err as Error).message);
    } finally {
      setIsProcessing(false);
      setProgressOperation(null);
      setProgressStep(0);
      setProgressMessage('');
    }
  };

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color={Colors.textPrimary} />
        </TouchableOpacity>
        <View style={styles.headerTitle}>
          <Ionicons name="lock-closed" size={20} color={P01.cyan} />
          <Text style={styles.headerText}>Confidential Balance</Text>
        </View>
        <TouchableOpacity onPress={() => setShowBalance(!showBalance)}>
          <Ionicons
            name={showBalance ? 'eye' : 'eye-off'}
            size={22}
            color={Colors.textSecondary}
          />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.content}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={isLoading}
            onRefresh={handleRefresh}
            tintColor={P01.cyan}
          />
        }
      >
        {/* Balance Card */}
        <Animated.View entering={FadeInDown.delay(100)}>
          <LinearGradient
            colors={[Colors.surface, Colors.background]}
            style={styles.balanceCard}
          >
            <View style={styles.balanceHeader}>
              <View style={styles.balanceLabel}>
                <Ionicons name="lock-closed" size={18} color={P01.cyan} />
                <Text style={styles.balanceLabelText}>Confidential Balance</Text>
              </View>
              <TouchableOpacity onPress={handleRefresh}>
                <Ionicons
                  name="refresh"
                  size={18}
                  color={Colors.textSecondary}
                  style={isLoading ? styles.spinning : undefined}
                />
              </TouchableOpacity>
            </View>

            <View style={styles.balanceAmount}>
              <Ionicons name="lock-closed" size={28} color={P01.cyan} style={{ opacity: 0.6 }} />
              <Text style={styles.balanceValue}>
                {isLoading && !isInitialized ? '...' : formatBalance()}
              </Text>
            </View>

            <Text style={styles.balanceSubtext}>
              Homomorphic encryption - Quantum-resistant
            </Text>

            {/* Status Badge */}
            <View style={styles.statusBadge}>
              <View style={styles.statusDot} />
              <Text style={styles.statusText}>zkSPL Quantum-Resistant</Text>
            </View>
          </LinearGradient>
        </Animated.View>

        {/* Action Buttons */}
        <Animated.View entering={FadeInDown.delay(200)} style={styles.actionsContainer}>
          <TouchableOpacity
            style={[styles.actionButton, { backgroundColor: P01.cyanDim }]}
            onPress={() => setActionModal('deposit')}
          >
            <Ionicons name="arrow-down" size={24} color={P01.cyan} />
            <Text style={[styles.actionText, { color: P01.cyan }]}>Deposit</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.actionButton,
              { backgroundColor: P01.pinkDim },
              confidentialBalance <= 0 && styles.actionButtonDisabled,
            ]}
            onPress={() => {
              if (confidentialBalance <= 0) return;
              setActionModal('withdraw');
            }}
            disabled={confidentialBalance <= 0}
          >
            <Ionicons
              name="arrow-up"
              size={24}
              color={confidentialBalance > 0 ? P01.pink : Colors.textTertiary}
            />
            <Text
              style={[
                styles.actionText,
                { color: confidentialBalance > 0 ? P01.pink : Colors.textTertiary },
              ]}
            >
              Withdraw
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.actionButton,
              { backgroundColor: P01.blueDim },
              confidentialBalance <= 0 && styles.actionButtonDisabled,
            ]}
            onPress={() => {
              if (confidentialBalance <= 0) return;
              setActionModal('transfer');
            }}
            disabled={confidentialBalance <= 0}
          >
            <Ionicons
              name="flash"
              size={24}
              color={confidentialBalance > 0 ? P01.blue : Colors.textTertiary}
            />
            <Text
              style={[
                styles.actionText,
                { color: confidentialBalance > 0 ? P01.blue : Colors.textTertiary },
              ]}
            >
              Transfer
            </Text>
          </TouchableOpacity>
        </Animated.View>

        {/* Prover Info */}
        <Animated.View entering={FadeInDown.delay(250)}>
          <View style={styles.proverInfo}>
            <Ionicons name="server" size={16} color="#60a5fa" />
            <Text style={styles.proverInfoText}>
              ZK proofs generated via backend server. Balance commitments are Poseidon hashes.
            </Text>
          </View>
        </Animated.View>

        {/* Pending Credits */}
        {pendingCount > 0 && (
          <Animated.View entering={FadeInDown.delay(300)}>
            <Text style={styles.sectionTitle}>PENDING CREDITS</Text>
            <View style={styles.pendingCard}>
              <View style={styles.pendingIcon}>
                <Ionicons name="hourglass" size={20} color="#fbbf24" />
              </View>
              <View style={styles.pendingInfo}>
                <Text style={styles.pendingTitle}>
                  {pendingCount} pending credit{pendingCount > 1 ? 's' : ''}
                </Text>
                <Text style={styles.pendingSubtext}>
                  Awaiting apply -- you need the amount and salt from the sender
                </Text>
              </View>
            </View>
          </Animated.View>
        )}

        {/* Transparent Balance */}
        <Animated.View entering={FadeInDown.delay(350)}>
          <Text style={styles.sectionTitle}>TRANSPARENT BALANCE</Text>
          <View style={styles.transparentCard}>
            <View style={styles.transparentIcon}>
              <Ionicons name="lock-open" size={20} color="#fff" />
            </View>
            <View style={styles.transparentInfo}>
              <Text style={styles.transparentAmount}>
                {balance?.sol?.toFixed(4) || '0'} SOL
              </Text>
              <Text style={styles.transparentLabel}>Available to deposit</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={Colors.textTertiary} />
          </View>
        </Animated.View>

        {/* Privacy Info Card */}
        <Animated.View entering={FadeInDown.delay(400)}>
          <LinearGradient
            colors={[P01.cyanDim, P01.blueDim]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.infoCard}
          >
            <View style={styles.infoIcon}>
              <Ionicons name="shield-checkmark" size={24} color={P01.cyan} />
            </View>
            <View style={styles.infoContent}>
              <Text style={styles.infoTitle}>zkSPL Confidential Tokens</Text>
              <Text style={styles.infoText}>
                Your balance is stored as a Poseidon commitment on-chain. Only you
                know the plaintext balance. Deposits and withdrawals use ZK proofs
                to update the commitment without revealing the balance.
              </Text>
            </View>
          </LinearGradient>
        </Animated.View>

        {/* Error display */}
        {error && (
          <Animated.View entering={FadeInDown.delay(450)}>
            <View style={styles.errorCard}>
              <Ionicons name="alert-circle" size={18} color="#ef4444" />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          </Animated.View>
        )}
      </ScrollView>

      {/* Deposit / Withdraw / Transfer Modal */}
      <Modal
        visible={actionModal !== null}
        animationType="slide"
        transparent
        onRequestClose={() => {
          if (!isProcessing) {
            setActionModal(null);
            setAmount('');
            setRecipientAddress('');
          }
        }}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={styles.modalContent}>
            {/* Modal Header */}
            <View style={styles.modalHeader}>
              <View
                style={[
                  styles.modalIcon,
                  {
                    backgroundColor:
                      actionModal === 'deposit'
                        ? P01.cyanDim
                        : actionModal === 'withdraw'
                          ? P01.pinkDim
                          : P01.blueDim,
                  },
                ]}
              >
                <Ionicons
                  name={
                    actionModal === 'deposit'
                      ? 'arrow-down'
                      : actionModal === 'withdraw'
                        ? 'arrow-up'
                        : 'flash'
                  }
                  size={28}
                  color={
                    actionModal === 'deposit'
                      ? P01.cyan
                      : actionModal === 'withdraw'
                        ? P01.pink
                        : P01.blue
                  }
                />
              </View>
              <View>
                <Text style={styles.modalTitle}>
                  {actionModal === 'deposit'
                    ? 'Deposit SOL'
                    : actionModal === 'withdraw'
                      ? 'Withdraw SOL'
                      : 'Confidential Transfer'}
                </Text>
                <Text style={styles.modalSubtitle}>
                  {actionModal === 'deposit'
                    ? 'Move SOL into confidential balance'
                    : actionModal === 'withdraw'
                      ? 'Withdraw from confidential balance'
                      : 'Send privately to another user'}
                </Text>
              </View>
            </View>

            {/* Recipient Address (transfer only) */}
            {actionModal === 'transfer' && (
              <View style={styles.inputContainer}>
                <Text style={styles.inputLabel}>Recipient Address</Text>
                <TextInput
                  style={styles.recipientInput}
                  value={recipientAddress}
                  onChangeText={setRecipientAddress}
                  placeholder="Solana address..."
                  placeholderTextColor={Colors.textTertiary}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
            )}

            {/* Amount Input */}
            <View style={styles.inputContainer}>
              <View style={styles.inputHeader}>
                <Text style={styles.inputLabel}>Amount</Text>
                <TouchableOpacity
                  onPress={() => {
                    const max =
                      actionModal === 'deposit'
                        ? balance?.sol || 0
                        : confidentialBalance;
                    setAmount(max.toString());
                  }}
                >
                  <Text style={styles.maxButton}>
                    Max:{' '}
                    {actionModal === 'deposit'
                      ? `${(balance?.sol || 0).toFixed(4)} SOL`
                      : `${confidentialBalance.toFixed(4)} SOL`}
                  </Text>
                </TouchableOpacity>
              </View>
              <View style={styles.inputRow}>
                <TextInput
                  style={styles.input}
                  value={amount}
                  onChangeText={setAmount}
                  placeholder="0.0"
                  placeholderTextColor={Colors.textTertiary}
                  keyboardType="decimal-pad"
                />
                <Text style={styles.inputSuffix}>SOL</Text>
              </View>
            </View>

            {/* Action Buttons */}
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.cancelButton}
                onPress={() => {
                  setActionModal(null);
                  setAmount('');
                  setRecipientAddress('');
                }}
                disabled={isProcessing}
              >
                <Text style={styles.cancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.confirmButton,
                  {
                    backgroundColor:
                      actionModal === 'deposit'
                        ? P01.cyan
                        : actionModal === 'withdraw'
                          ? P01.pink
                          : P01.blue,
                  },
                ]}
                onPress={
                  actionModal === 'deposit'
                    ? handleDeposit
                    : actionModal === 'withdraw'
                      ? handleWithdraw
                      : handleTransfer
                }
                disabled={isProcessing || !amount || parseFloat(amount) <= 0}
              >
                {isProcessing ? (
                  <ActivityIndicator color="#000" />
                ) : (
                  <Text style={styles.confirmText}>
                    {actionModal === 'deposit'
                      ? 'Deposit'
                      : actionModal === 'withdraw'
                        ? 'Withdraw'
                        : 'Transfer'}
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Progress Overlay */}
      <Modal
        visible={progressOperation !== null}
        animationType="fade"
        transparent
        onRequestClose={() => {}}
      >
        <View style={styles.progressOverlay}>
          <View style={styles.progressModal}>
            {/* Operation Icon */}
            <View
              style={[
                styles.progressIcon,
                {
                  backgroundColor:
                    progressOperation === 'deposit'
                      ? P01.cyanDim
                      : progressOperation === 'withdraw'
                        ? P01.pinkDim
                        : P01.blueDim,
                },
              ]}
            >
              <Ionicons
                name={
                  progressOperation === 'deposit'
                    ? 'arrow-down'
                    : progressOperation === 'withdraw'
                      ? 'arrow-up'
                      : 'flash'
                }
                size={32}
                color={
                  progressOperation === 'deposit'
                    ? P01.cyan
                    : progressOperation === 'withdraw'
                      ? P01.pink
                      : P01.blue
                }
              />
            </View>

            {/* Title */}
            <Text style={styles.progressTitle}>
              {progressOperation === 'deposit'
                ? 'Depositing SOL'
                : progressOperation === 'withdraw'
                  ? 'Withdrawing SOL'
                  : 'Sending Transfer'}
            </Text>

            {/* Progress Bar */}
            <View style={styles.progressBarContainer}>
              <View style={styles.progressBarBg}>
                <Animated.View
                  style={[
                    styles.progressBarFill,
                    {
                      width: `${progressStep}%`,
                      backgroundColor:
                        progressOperation === 'deposit'
                          ? P01.cyan
                          : progressOperation === 'withdraw'
                            ? P01.pink
                            : P01.blue,
                    },
                  ]}
                />
              </View>
              <Text style={styles.progressPercent}>{Math.round(progressStep)}%</Text>
            </View>

            {/* Status Message */}
            <Text
              style={[
                styles.progressStatus,
                {
                  color:
                    progressOperation === 'deposit'
                      ? P01.cyan
                      : progressOperation === 'withdraw'
                        ? P01.pink
                        : P01.blue,
                },
              ]}
            >
              {progressMessage}
            </Text>

            {/* Steps */}
            <View style={styles.progressSteps}>
              {['Prepare', 'ZK Proof', 'Submit', 'Done'].map((label, i) => {
                const thresholds = [10, 40, 70, 100];
                const isActive = progressStep >= thresholds[i];
                const activeColor =
                  progressOperation === 'deposit'
                    ? P01.cyan
                    : progressOperation === 'withdraw'
                      ? P01.pink
                      : P01.blue;
                return (
                  <React.Fragment key={label}>
                    {i > 0 && (
                      <View
                        style={[
                          styles.stepLine,
                          progressStep >= thresholds[i] && { backgroundColor: activeColor },
                        ]}
                      />
                    )}
                    <View style={styles.stepItem}>
                      <View
                        style={[
                          styles.stepDot,
                          isActive && { backgroundColor: activeColor, transform: [{ scale: 1.1 }] },
                        ]}
                      />
                      <Text style={[styles.stepText, isActive && styles.stepTextActive]}>
                        {label}
                      </Text>
                    </View>
                  </React.Fragment>
                );
              })}
            </View>

            {/* Keep app open */}
            {progressStep < 100 && (
              <Text style={styles.progressWarning}>Please keep the app open</Text>
            )}
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

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
    color: Colors.textPrimary,
  },
  content: {
    flex: 1,
  },
  scrollContent: {
    padding: Spacing.md,
    paddingBottom: 120,
  },

  // Balance Card
  balanceCard: {
    padding: Spacing.lg,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: `${P01.cyan}30`,
  },
  balanceHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.md,
  },
  balanceLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  balanceLabelText: {
    fontSize: 14,
    fontFamily: FontFamily.medium,
    color: Colors.textSecondary,
  },
  spinning: {
    opacity: 0.5,
  },
  balanceAmount: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    marginVertical: Spacing.lg,
  },
  balanceValue: {
    fontSize: 32,
    fontFamily: FontFamily.bold,
    color: Colors.textPrimary,
  },
  balanceSubtext: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    textAlign: 'center',
    marginBottom: Spacing.sm,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: P01.cyanDim,
    borderRadius: BorderRadius.sm,
    paddingVertical: 4,
    paddingHorizontal: 10,
    alignSelf: 'center',
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: P01.cyan,
  },
  statusText: {
    fontSize: 11,
    fontFamily: FontFamily.mono,
    color: P01.cyan,
  },

  // Actions
  actionsContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 24,
    marginVertical: Spacing.lg,
  },
  actionButton: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 72,
    height: 72,
    borderRadius: 36,
    gap: 4,
  },
  actionText: {
    fontSize: 12,
    fontFamily: FontFamily.medium,
  },
  actionButtonDisabled: {
    opacity: 0.5,
  },

  // Prover Info
  proverInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(96, 165, 250, 0.1)',
    borderRadius: BorderRadius.md,
    padding: Spacing.sm,
    marginBottom: Spacing.md,
    borderWidth: 1,
    borderColor: 'rgba(96, 165, 250, 0.3)',
  },
  proverInfoText: {
    flex: 1,
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: '#60a5fa',
  },

  // Sections
  sectionTitle: {
    fontSize: 11,
    fontFamily: FontFamily.bold,
    color: Colors.textTertiary,
    letterSpacing: 1,
    marginTop: Spacing.md,
    marginBottom: Spacing.sm,
  },

  // Pending
  pendingCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    gap: 12,
    borderWidth: 1,
    borderColor: 'rgba(251, 191, 36, 0.3)',
  },
  pendingIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(251, 191, 36, 0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pendingInfo: {
    flex: 1,
  },
  pendingTitle: {
    fontSize: 14,
    fontFamily: FontFamily.medium,
    color: '#fbbf24',
  },
  pendingSubtext: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    marginTop: 2,
  },

  // Transparent Balance
  transparentCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    gap: 12,
  },
  transparentIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#3b82f6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  transparentInfo: {
    flex: 1,
  },
  transparentAmount: {
    fontSize: 16,
    fontFamily: FontFamily.bold,
    color: Colors.textPrimary,
  },
  transparentLabel: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
  },

  // Info Card
  infoCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginTop: Spacing.md,
    gap: 12,
    borderWidth: 1,
    borderColor: `${P01.cyan}30`,
  },
  infoIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: P01.cyanDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  infoContent: {
    flex: 1,
  },
  infoTitle: {
    fontSize: 14,
    fontFamily: FontFamily.bold,
    color: Colors.textPrimary,
    marginBottom: 4,
  },
  infoText: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    lineHeight: 18,
  },

  // Error
  errorCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginTop: Spacing.md,
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.3)',
  },
  errorText: {
    flex: 1,
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: '#ef4444',
  },

  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.8)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: BorderRadius.xl,
    borderTopRightRadius: BorderRadius.xl,
    padding: Spacing.lg,
    paddingBottom: Spacing.lg + 40,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: Spacing.lg,
  },
  modalIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalTitle: {
    fontSize: 18,
    fontFamily: FontFamily.bold,
    color: Colors.textPrimary,
  },
  modalSubtitle: {
    fontSize: 13,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
  },
  inputContainer: {
    backgroundColor: Colors.background,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  inputHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.sm,
  },
  inputLabel: {
    fontSize: 12,
    fontFamily: FontFamily.medium,
    color: Colors.textTertiary,
  },
  maxButton: {
    fontSize: 12,
    fontFamily: FontFamily.medium,
    color: P01.cyan,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  input: {
    flex: 1,
    fontSize: 24,
    fontFamily: FontFamily.bold,
    color: Colors.textPrimary,
  },
  inputSuffix: {
    fontSize: 18,
    fontFamily: FontFamily.medium,
    color: Colors.textSecondary,
  },
  recipientInput: {
    fontSize: 14,
    fontFamily: FontFamily.mono,
    color: Colors.textPrimary,
    marginTop: Spacing.sm,
    paddingVertical: 4,
  },
  modalActions: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  cancelButton: {
    flex: 1,
    backgroundColor: Colors.background,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    alignItems: 'center',
  },
  cancelText: {
    fontSize: 16,
    fontFamily: FontFamily.bold,
    color: Colors.textPrimary,
  },
  confirmButton: {
    flex: 1,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    alignItems: 'center',
  },
  confirmText: {
    fontSize: 16,
    fontFamily: FontFamily.bold,
    color: '#000',
  },

  // Progress Overlay
  progressOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.9)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.lg,
  },
  progressModal: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.xl,
    padding: Spacing.xl,
    width: '100%',
    maxWidth: 340,
    alignItems: 'center',
  },
  progressIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.lg,
  },
  progressTitle: {
    fontSize: 20,
    fontFamily: FontFamily.bold,
    color: Colors.textPrimary,
    marginBottom: Spacing.lg,
  },
  progressBarContainer: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginBottom: Spacing.md,
  },
  progressBarBg: {
    flex: 1,
    height: 8,
    backgroundColor: Colors.background,
    borderRadius: 4,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    borderRadius: 4,
  },
  progressPercent: {
    fontSize: 14,
    fontFamily: FontFamily.bold,
    color: Colors.textSecondary,
    minWidth: 40,
    textAlign: 'right',
  },
  progressStatus: {
    fontSize: 14,
    fontFamily: FontFamily.medium,
    textAlign: 'center',
    marginBottom: Spacing.lg,
  },
  progressSteps: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    marginBottom: Spacing.md,
  },
  stepItem: {
    alignItems: 'center',
    gap: 4,
  },
  stepDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: Colors.border,
  },
  stepText: {
    fontSize: 10,
    fontFamily: FontFamily.medium,
    color: Colors.textTertiary,
  },
  stepTextActive: {
    color: Colors.textPrimary,
  },
  stepLine: {
    width: 24,
    height: 2,
    backgroundColor: Colors.border,
    marginHorizontal: 4,
    marginBottom: 16,
  },
  progressWarning: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    textAlign: 'center',
    marginTop: Spacing.sm,
  },
});

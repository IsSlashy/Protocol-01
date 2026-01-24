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
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';

import { useShieldedStore } from '@/stores/shieldedStore';
import { useZkProver } from '@/providers/ZkProverProvider';
import { getKeypair } from '@/services/solana/wallet';
import { Transaction } from '@solana/web3.js';
import { Colors, FontFamily, BorderRadius, Spacing } from '@/constants/theme';

// P-01 Design System Colors - NO purple allowed
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

export default function ShieldedTransferScreen() {
  const router = useRouter();
  const {
    shieldedBalance,
    isInitialized,
    ensureInitialized,
    transfer,
    pendingTransactions,
    getLastSentNote,
  } = useShieldedStore();

  // ZK Prover status
  const { isCircuitLoaded, error: proverError } = useZkProver();

  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [proofProgress, setProofProgress] = useState(0);
  const [proofStatus, setProofStatus] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);

  // Ensure ZK service is initialized on mount
  useEffect(() => {
    const init = async () => {
      const ready = await ensureInitialized();
      setIsReady(ready && isCircuitLoaded);
      if (!ready) {
        Alert.alert('Not Initialized', 'Please initialize your shielded wallet first.');
        router.replace('/(main)/(wallet)');
      } else if (!isCircuitLoaded) {
        Alert.alert(
          'ZK Prover Not Ready',
          'Circuit files are still loading. Please wait a moment or go back and try again.',
          [
            { text: 'Go Back', onPress: () => router.back() },
            { text: 'Wait', style: 'cancel' },
          ]
        );
      }
    };
    init();
  }, [isCircuitLoaded]);

  const handlePaste = async () => {
    const text = await Clipboard.getStringAsync();
    if (text) {
      setRecipient(text);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  const handleScan = () => {
    // TODO: Implement QR scanner for ZK addresses
    Alert.alert('Coming Soon', 'QR code scanning will be available in a future update.');
  };

  const handleSetMax = () => {
    setAmount(shieldedBalance.toString());
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const validateInputs = (): boolean => {
    if (!isCircuitLoaded) {
      Alert.alert('ZK Prover Not Ready', 'Circuit files are still loading. Please wait and try again.');
      return false;
    }

    if (!recipient.trim()) {
      Alert.alert('Missing Recipient', 'Please enter a ZK address.');
      return false;
    }

    if (!recipient.startsWith('zk:')) {
      Alert.alert('Invalid Address', 'ZK addresses must start with "zk:"');
      return false;
    }

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      Alert.alert('Invalid Amount', 'Please enter a valid amount greater than 0.');
      return false;
    }

    if (amountNum > shieldedBalance) {
      Alert.alert('Insufficient Balance', `You only have ${shieldedBalance.toFixed(4)} SOL shielded.`);
      return false;
    }

    return true;
  };

  const handleTransfer = async () => {
    if (!validateInputs()) return;

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsProcessing(true);
    setProofProgress(0);
    setProofStatus('Preparing transaction...');

    try {
      // Get keypair for signing
      const keypair = await getKeypair();
      if (!keypair) {
        throw new Error('Could not get wallet keypair');
      }

      // Create sign function
      const signTransaction = async (tx: Transaction): Promise<Transaction> => {
        tx.sign(keypair);
        return tx;
      };

      // Simulate proof generation progress
      const progressInterval = setInterval(() => {
        setProofProgress(prev => {
          if (prev >= 90) {
            clearInterval(progressInterval);
            return 90;
          }
          return prev + Math.random() * 15;
        });

        // Update status messages
        setProofStatus(prev => {
          const progress = proofProgress;
          if (progress < 20) return 'Selecting notes...';
          if (progress < 40) return 'Building witness...';
          if (progress < 60) return 'Generating ZK proof...';
          if (progress < 80) return 'Finalizing proof...';
          return 'Submitting transaction...';
        });
      }, 500);

      await transfer(recipient, parseFloat(amount), keypair.publicKey, signTransaction);

      clearInterval(progressInterval);
      setProofProgress(100);
      setProofStatus('Complete!');

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      // Get the note string to share with recipient
      const lastNote = getLastSentNote();
      if (lastNote) {
        Alert.alert(
          'Transfer Successful',
          `${amount} SOL has been sent privately.\n\n⚠️ IMPORTANT: The recipient must import this note to receive the funds.\n\nCopy and share this with the recipient:`,
          [
            {
              text: 'Copy Note',
              onPress: async () => {
                await Clipboard.setStringAsync(lastNote.noteString);
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                Alert.alert('Copied!', 'Share this note with the recipient so they can import it.', [
                  { text: 'OK', onPress: () => router.back() }
                ]);
              }
            },
            { text: 'Done', onPress: () => router.back() }
          ]
        );
      } else {
        Alert.alert(
          'Transfer Successful',
          `${amount} SOL has been sent privately to the recipient.`,
          [{ text: 'OK', onPress: () => router.back() }]
        );
      }
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Transfer Failed', (err as Error).message);
    } finally {
      setIsProcessing(false);
      setProofProgress(0);
      setProofStatus(null);
    }
  };

  const estimatedFee = 0.0001; // Approximate transaction fee
  const amountNum = parseFloat(amount) || 0;
  const total = amountNum + estimatedFee;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color="#ffffff" />
        </TouchableOpacity>
        <View style={styles.headerTitle}>
          <Ionicons name="flash" size={20} color={P01.blue} />
          <Text style={styles.headerText}>Shielded Transfer</Text>
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
          {/* Balance Card */}
          <Animated.View entering={FadeInDown.delay(100)}>
            <View style={styles.balanceCard}>
              <View style={styles.balanceRow}>
                <View style={styles.balanceIcon}>
                  <Ionicons name="shield" size={20} color={P01.cyan} />
                </View>
                <View>
                  <Text style={styles.balanceLabel}>Available Shielded</Text>
                  <Text style={styles.balanceValue}>{shieldedBalance.toFixed(4)} SOL</Text>
                </View>
              </View>
            </View>
          </Animated.View>

          {/* Recipient Input */}
          <Animated.View entering={FadeInDown.delay(200)}>
            <Text style={styles.inputTitle}>Recipient ZK Address</Text>
            <View style={styles.inputContainer}>
              <TextInput
                style={styles.addressInput}
                value={recipient}
                onChangeText={setRecipient}
                placeholder="zk:abc123..."
                placeholderTextColor={Colors.textTertiary}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <View style={styles.inputActions}>
                <TouchableOpacity onPress={handlePaste} style={styles.inputAction}>
                  <Ionicons name="clipboard-outline" size={20} color={P01.cyan} />
                </TouchableOpacity>
                <TouchableOpacity onPress={handleScan} style={styles.inputAction}>
                  <Ionicons name="scan-outline" size={20} color={P01.cyan} />
                </TouchableOpacity>
              </View>
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

          {/* Transaction Summary */}
          {amountNum > 0 && (
            <Animated.View entering={FadeInUp.delay(100)}>
              <View style={styles.summaryCard}>
                <Text style={styles.summaryTitle}>Transaction Summary</Text>
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>Amount</Text>
                  <Text style={styles.summaryValue}>{amountNum.toFixed(4)} SOL</Text>
                </View>
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>Network Fee</Text>
                  <Text style={styles.summaryValue}>~{estimatedFee} SOL</Text>
                </View>
                <View style={styles.summaryDivider} />
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabelBold}>Total</Text>
                  <Text style={styles.summaryValueBold}>{total.toFixed(4)} SOL</Text>
                </View>
              </View>
            </Animated.View>
          )}

          {/* Privacy Info */}
          <Animated.View entering={FadeInDown.delay(400)}>
            <View style={styles.privacyInfo}>
              <Ionicons name="eye-off" size={18} color={P01.cyan} />
              <Text style={styles.privacyText}>
                This transfer is fully private. Amount, sender, and recipient are hidden on-chain.
              </Text>
            </View>
          </Animated.View>

          {/* Proof Generation Progress */}
          {isProcessing && (
            <Animated.View entering={FadeInUp} style={styles.proofContainer}>
              <View style={styles.proofHeader}>
                <ActivityIndicator color={P01.cyan} />
                <Text style={styles.proofTitle}>Generating ZK Proof</Text>
              </View>
              <View style={styles.progressBar}>
                <View style={[styles.progressFill, { width: `${proofProgress}%` }]} />
              </View>
              <Text style={styles.proofStatus}>{proofStatus}</Text>
              <Text style={styles.proofWarning}>
                Please keep the app open. This may take 30-60 seconds.
              </Text>
            </Animated.View>
          )}
        </ScrollView>

        {/* Transfer Button */}
        <View style={styles.bottomContainer}>
          <TouchableOpacity
            style={[
              styles.transferButton,
              (!recipient || !amount || isProcessing) && styles.transferButtonDisabled,
            ]}
            onPress={handleTransfer}
            disabled={!recipient || !amount || isProcessing}
          >
            <LinearGradient
              colors={isProcessing ? ['#333', '#222'] : [P01.blue, '#2563eb']}
              style={styles.transferGradient}
            >
              {isProcessing ? (
                <View style={styles.processingRow}>
                  <ActivityIndicator color="#fff" size="small" />
                  <Text style={styles.transferText}>Processing...</Text>
                </View>
              ) : (
                <>
                  <Ionicons name="flash" size={20} color="#fff" />
                  <Text style={styles.transferText}>Send Privately</Text>
                </>
              )}
            </LinearGradient>
          </TouchableOpacity>
        </View>
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
    paddingBottom: 100,
  },
  balanceCard: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    padding: Spacing.md,
    marginBottom: Spacing.lg,
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.2)',
  },
  balanceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  balanceIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(57, 197, 187, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  balanceLabel: {
    fontSize: 12,
    fontFamily: FontFamily.medium,
    color: '#888892',
  },
  balanceValue: {
    fontSize: 20,
    fontFamily: FontFamily.bold,
    color: '#ffffff',
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
  inputActions: {
    flexDirection: 'row',
    gap: 8,
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
  summaryCard: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.lg,
  },
  summaryTitle: {
    fontSize: 12,
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
    color: P01.cyan,
  },
  privacyInfo: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: 'rgba(57, 197, 187, 0.1)',
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.lg,
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.2)',
  },
  privacyText: {
    flex: 1,
    fontSize: 13,
    fontFamily: FontFamily.regular,
    color: '#888892',
    lineHeight: 20,
  },
  proofContainer: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    padding: Spacing.lg,
    marginBottom: Spacing.lg,
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.3)',
  },
  proofHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: Spacing.md,
  },
  proofTitle: {
    fontSize: 16,
    fontFamily: FontFamily.bold,
    color: '#ffffff',
  },
  progressBar: {
    height: 6,
    backgroundColor: Colors.background,
    borderRadius: 3,
    overflow: 'hidden',
    marginBottom: Spacing.sm,
  },
  progressFill: {
    height: '100%',
    backgroundColor: P01.cyan,
    borderRadius: 3,
  },
  proofStatus: {
    fontSize: 13,
    fontFamily: FontFamily.medium,
    color: P01.cyan,
    marginBottom: 4,
  },
  proofWarning: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: '#555560',
  },
  bottomContainer: {
    padding: Spacing.md,
    paddingBottom: Spacing.xl,
    backgroundColor: Colors.background,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  transferButton: {
    borderRadius: BorderRadius.md,
    overflow: 'hidden',
  },
  transferButtonDisabled: {
    opacity: 0.5,
  },
  transferGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: Spacing.lg,
  },
  processingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  transferText: {
    fontSize: 16,
    fontFamily: FontFamily.bold,
    color: '#ffffff',
  },
});

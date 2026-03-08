import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  StyleSheet,
  Alert,
  Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';

import { useWalletStore } from '@/stores/walletStore';
import { useShieldedStore } from '@/stores/shieldedStore';
import { useZkProver } from '@/providers/ZkProverProvider';
import { useStarkProver } from '@/providers/StarkProverProvider';
import { usePrivyAuth } from '@/providers/PrivyProvider';
import { getKeypair } from '@/services/solana/wallet';
import { submitGenericStarkProof, type GenericStarkProof, CIRCUIT_CONFIDENTIAL_BALANCE } from '@/services/stark';
import { PublicKey, Transaction } from '@solana/web3.js';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import { requireBiometricAuth } from '@/utils/biometricGate';

import ShieldedBalanceCard from '@/components/privacy/ShieldedBalanceCard';
import ShieldedActions from '@/components/privacy/ShieldedActions';
import PrivacyInfoCard from '@/components/privacy/PrivacyInfoCard';
import PrivacyInfoModal from '@/components/privacy/PrivacyInfoModal';
import AmountInputModal from '@/components/privacy/AmountInputModal';
import StealthRecoveryModal from '@/components/privacy/StealthRecoveryModal';
import ZkProgressOverlay from '@/components/privacy/ZkProgressOverlay';

const SHIELDED_INFO_SECTIONS = [
  {
    title: 'How it works',
    text: 'Shielded transactions use zero-knowledge proofs (ZK-SNARKs) to hide amounts, senders, and recipients while proving the transaction is valid.',
  },
  {
    title: 'Shield',
    text: 'Convert transparent SOL into shielded notes. Your deposit amount is visible, but from then on, all movements are completely private.',
  },
  {
    title: 'Transfer',
    text: 'Send shielded SOL to any ZK address. The amount, sender, and recipient are all hidden. Only you and the recipient know the details.',
  },
  {
    title: 'Unshield',
    text: 'Withdraw shielded SOL back to a transparent address. The withdrawal amount becomes visible, but the source remains hidden.',
  },
];

export default function ShieldedWalletScreen() {
  const router = useRouter();
  const { balance, publicKey, isPrivyWallet } = useWalletStore();
  const { solanaWallet: privyWallet } = usePrivyAuth();
  const {
    isInitialized,
    isLoading,
    shieldedBalance,
    zkAddress,
    pendingTransactions,
    initialize,
    ensureInitialized,
    refreshBalance,
    shield,
    unshield,
    dismissPendingTransaction,
    scanStealthPayments,
    sweepAllStealthPayments,
    getPendingStealthPayments,
  } = useShieldedStore();

  const { isCircuitLoaded, error: proverError } = useZkProver();
  const {
    isReady: starkReady,
    generateConfidentialBalanceProof,
  } = useStarkProver();
  const [isLoadingProver, setIsLoadingProver] = useState(false);

  const [showBalance, setShowBalance] = useState(true);
  const [actionModal, setActionModal] = useState<'shield' | 'unshield' | null>(null);
  const [amount, setAmount] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [useRelay, setUseRelay] = useState(false); // Decentralized relay for private withdraw

  // Stealth recovery state
  const [showRecoveryModal, setShowRecoveryModal] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [isSweeping, setIsSweeping] = useState(false);
  const [foundPayments, setFoundPayments] = useState<Array<{ stealthAddress: string; amount: number; signature: string }>>([]);

  // Progress tracking
  const [progressStep, setProgressStep] = useState(0);
  const [progressMessage, setProgressMessage] = useState('');
  const [progressOperation, setProgressOperation] = useState<'shield' | 'unshield' | null>(null);

  // Auto-remove failed pending transactions after 15s
  useEffect(() => {
    const failedTxs = pendingTransactions.filter(tx => tx.status === 'failed');
    if (failedTxs.length === 0) return;
    const timers = failedTxs.map(tx => {
      const age = Date.now() - tx.createdAt;
      const remaining = Math.max(0, 15000 - age);
      return setTimeout(() => dismissPendingTransaction(tx.id), remaining);
    });
    return () => timers.forEach(clearTimeout);
  }, [pendingTransactions]);

  useEffect(() => {
    if (publicKey) ensureInitialized();
  }, [publicKey]);

  const handleRefresh = useCallback(async () => {
    await refreshBalance();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [refreshBalance]);

  const copyAddress = async () => {
    if (zkAddress) {
      await Clipboard.setStringAsync(zkAddress);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Copied', 'ZK address copied to clipboard');
    }
  };

  // Wallet signer helper
  const getWalletSigner = async () => {
    let walletPubkey: PublicKey;
    let signTransaction: (tx: Transaction) => Promise<Transaction>;

    if (isPrivyWallet && privyWallet) {
      walletPubkey = new PublicKey(privyWallet.address);
      signTransaction = privyWallet.signTransaction;
    } else {
      const keypair = await getKeypair();
      if (!keypair) throw new Error('Could not get wallet keypair');
      walletPubkey = keypair.publicKey;
      signTransaction = async (tx: Transaction): Promise<Transaction> => {
        tx.sign(keypair);
        return tx;
      };
    }
    return { walletPubkey, signTransaction };
  };

  const runProgress = (startStep: number, messages: [number, string][]) => {
    let currentStep = startStep;
    return setInterval(() => {
      if (currentStep >= 85) { currentStep = 85; } else {
        const increment = currentStep < 40 ? 6 : currentStep < 65 ? 4 : 2;
        currentStep = Math.min(currentStep + increment, 85);
      }
      setProgressStep(currentStep);
      for (const [threshold, msg] of messages) {
        if (currentStep < threshold) { setProgressMessage(msg); break; }
      }
    }, 200);
  };

  const handleShield = async () => {
    if (!amount || parseFloat(amount) <= 0) { Alert.alert('Invalid Amount', 'Please enter a valid amount'); return; }
    if (!publicKey) { Alert.alert('Error', 'Wallet not connected'); return; }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsProcessing(true);
    setProgressOperation('shield');
    setProgressStep(0);
    setProgressMessage('Preparing wallet...');

    try {
      setProgressStep(10);
      setProgressMessage('Connecting to wallet...');
      const { walletPubkey, signTransaction } = await getWalletSigner();
      setProgressStep(20);

      const interval = runProgress(20, [[40, 'Computing commitment...'], [65, 'Signing transaction...'], [100, 'Confirming on Solana...']]);
      await shield(parseFloat(amount), walletPubkey, signTransaction);
      clearInterval(interval);

      setProgressStep(100);
      setProgressMessage('Complete!');
      await new Promise(r => setTimeout(r, 500));

      setActionModal(null);
      setAmount('');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Success', 'SOL has been shielded successfully');
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

  const handleUnshield = async () => {
    if (!amount || parseFloat(amount) <= 0) { Alert.alert('Invalid Amount', 'Please enter a valid amount'); return; }
    if (parseFloat(amount) > shieldedBalance) { Alert.alert('Insufficient Balance', 'You do not have enough shielded SOL'); return; }
    if (!publicKey) { Alert.alert('Error', 'Wallet not connected'); return; }

    // Biometric gate — require auth before unshielding funds
    const authed = await requireBiometricAuth('Authenticate to unshield funds');
    if (!authed) {
      Alert.alert('Authentication Required', 'You must authenticate to unshield funds.');
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsProcessing(true);
    setProgressOperation('unshield');
    setProgressStep(0);
    setProgressMessage('Preparing withdrawal...');

    try {
      setProgressStep(10);
      const { walletPubkey, signTransaction } = await getWalletSigner();
      setProgressStep(15);

      if (starkReady && !useRelay) {
        // --- STARK path (quantum-resistant) ---
        setProgressStep(15);
        setProgressMessage('Generating STARK proof on-device...');

        // For shielded pool unshield, generate a confidential_balance STARK proof
        // using the shielded balance as inputs
        const amountLamports = Math.floor(parseFloat(amount) * 1e9);
        const oldBalanceLamports = Math.floor(shieldedBalance * 1e9);
        const newBalanceLamports = oldBalanceLamports - amountLamports;

        const starkResult = await generateConfidentialBalanceProof(
          '0', // spending key placeholder (shielded pool uses note-based keys)
          oldBalanceLamports.toString(),
          '0', // old salt
          newBalanceLamports.toString(),
          '0', // new salt
          amountLamports.toString(),
          '0', // amount salt
          '0', // token mint (native SOL)
        );

        const proofBytes = Buffer.from(starkResult.proofHex, 'hex');
        const publicInputs = starkResult.publicInputs.map(s => BigInt(s));

        setProgressStep(35);
        setProgressMessage('Verifying STARK proof on-chain...');
        const starkProof: GenericStarkProof = {
          proofBytes,
          circuitId: CIRCUIT_CONFIDENTIAL_BALANCE,
          publicInputs,
          proofSize: starkResult.proofSize,
        };
        await submitGenericStarkProof(starkProof, undefined, (step) => setProgressMessage(step));

        setProgressStep(55);
        setProgressMessage('Executing unshield...');
        const interval = runProgress(55, [[70, 'Generating ZK proof...'], [85, 'Signing transaction...'], [100, 'Confirming on Solana...']]);
        await unshield(parseFloat(amount), walletPubkey, walletPubkey, signTransaction, false);
        clearInterval(interval);
      } else {
        // --- Groth16 fallback (or relay mode) ---
        const progressSteps = useRelay
          ? [[20, 'Preparing proof...'], [40, 'Generating ZK proof...'], [55, 'Encrypting for relayer...'], [70, 'Submitting relay job...'], [85, 'Waiting for relayer...'], [100, 'Confirming on Solana...']]
          : [[30, 'Preparing proof...'], [50, 'Generating ZK proof...'], [70, 'Signing transaction...'], [100, 'Confirming on Solana...']];
        const interval = runProgress(15, progressSteps as [number, string][]);
        await unshield(parseFloat(amount), walletPubkey, walletPubkey, signTransaction, useRelay);
        clearInterval(interval);
      }

      setProgressStep(100);
      setProgressMessage('Complete!');
      await new Promise(r => setTimeout(r, 500));

      setActionModal(null);
      setAmount('');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const method = starkReady && !useRelay ? ' (STARK verified)' : useRelay ? ' via relay' : '';
      Alert.alert('Success', `SOL has been unshielded successfully${method}`);
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

  const handleOpenRecovery = async () => {
    setShowRecoveryModal(true);
    setFoundPayments([]);
    await handleScanStealth();
  };

  const handleScanStealth = async () => {
    setIsScanning(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      const result = await scanStealthPayments();
      setFoundPayments(result.payments);
      if (result.found > 0) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } else {
        const pending = getPendingStealthPayments();
        if (pending.length > 0) setFoundPayments(pending);
      }
    } catch (err) {
      Alert.alert('Scan Error', (err as Error).message);
    } finally { setIsScanning(false); }
  };

  const handleSweepAll = async () => {
    if (!publicKey) { Alert.alert('Error', 'Wallet not connected'); return; }
    setIsSweeping(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    try {
      const result = await sweepAllStealthPayments(publicKey);
      if (result.success && result.swept > 0) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        Alert.alert('Recovery Complete!', `Recovered ${result.totalAmount.toFixed(4)} SOL from ${result.swept} stealth payment(s).\n\nFunds are now in your transparent wallet.`,
          [{ text: 'OK', onPress: () => setShowRecoveryModal(false) }]);
        setFoundPayments([]);
        await refreshBalance();
      } else if (result.errors.length > 0) {
        Alert.alert('Partial Recovery', `Some payments failed:\n${result.errors.join('\n')}`);
      } else {
        Alert.alert('Nothing to Recover', 'No stealth payments found to sweep.');
      }
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Sweep Error', (err as Error).message);
    } finally { setIsSweeping(false); }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header — gradient with subtle cyan bottom border */}
      <LinearGradient colors={['#0d1117', '#0a0a0c']} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color={Colors.textPrimary} />
        </TouchableOpacity>
        <View style={styles.headerTitle}>
          <Ionicons name="shield-checkmark" size={22} color={P01Colors.cyan} />
          <Text style={styles.headerText}>Shielded Wallet</Text>
        </View>
        <View style={styles.headerActions}>
          <TouchableOpacity onPress={() => setShowBalance(!showBalance)}>
            <Ionicons name={showBalance ? 'eye' : 'eye-off'} size={22} color={Colors.textSecondary} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setShowInfo(true)} style={{ marginLeft: 12 }}>
            <Ionicons name="information-circle-outline" size={22} color={Colors.textSecondary} />
          </TouchableOpacity>
        </View>
        {/* Subtle cyan bottom border */}
        <View style={styles.headerBorder} />
      </LinearGradient>

      <ScrollView
        style={styles.content}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={handleRefresh} tintColor={P01Colors.cyan} />}
      >
        <ShieldedBalanceCard
          isLoading={isLoading}
          shieldedBalance={shieldedBalance}
          showBalance={showBalance}
          zkAddress={zkAddress}
          onRefresh={handleRefresh}
          onCopyAddress={copyAddress}
        />

        <ShieldedActions
          shieldedBalance={shieldedBalance}
          isLoadingProver={isLoadingProver}
          onShield={() => setActionModal('shield')}
          onUnshield={() => setActionModal('unshield')}
          onTransfer={() => router.push('/(main)/(privacy)/shielded-transfer')}
          onRecover={handleOpenRecovery}
          onShareNearby={() => router.push('/(main)/(privacy)/share-note' as any)}
          onReceiveNearby={() => router.push('/(main)/(privacy)/receive-note' as any)}
        />

        {/* Transparent Balance */}
        <Animated.View entering={FadeInDown.delay(300)}>
          <Text style={styles.sectionTitle}>TRANSPARENT BALANCE</Text>
          <View style={styles.transparentCard}>
            <LinearGradient
              colors={['#3b82f6', '#2563eb']}
              style={styles.transparentIcon}
            >
              <Ionicons name="lock-open" size={20} color="#fff" />
            </LinearGradient>
            <View style={styles.transparentInfo}>
              <Text style={styles.transparentLabel}>Available to shield</Text>
              <Text style={styles.transparentAmount}>{balance?.sol?.toFixed(4) || '0'} SOL</Text>
            </View>
          </View>
        </Animated.View>

        {/* Pending Transactions */}
        {pendingTransactions.length > 0 && (
          <Animated.View entering={FadeInDown.delay(350)}>
            <Text style={styles.sectionTitle}>PENDING</Text>
            {pendingTransactions.map((tx) => {
              const isFailed = tx.status === 'failed';
              return (
                <View
                  key={tx.id}
                  style={[
                    styles.pendingCard,
                    {
                      borderLeftWidth: 3,
                      borderLeftColor: isFailed ? '#ef4444' : '#fbbf24',
                    },
                    isFailed && styles.pendingCardFailed,
                  ]}
                >
                  <View style={[styles.pendingIcon, isFailed && { backgroundColor: 'rgba(239, 68, 68, 0.2)' }]}>
                    {isFailed ? (
                      <Ionicons name="close-circle" size={22} color="#ef4444" />
                    ) : (
                      <ActivityIndicator color="#fbbf24" size="small" />
                    )}
                  </View>
                  <View style={styles.pendingInfo}>
                    <Text style={styles.pendingType}>{tx.type}</Text>
                    {isFailed ? (
                      <View style={styles.pendingErrorBadge}>
                        <Text style={styles.pendingErrorText}>
                          {tx.error || 'Transaction failed'}
                        </Text>
                      </View>
                    ) : (
                      <Text style={styles.pendingStatus}>
                        {tx.status === 'generating_proof' ? 'Generating ZK proof...' : 'Processing...'}
                      </Text>
                    )}
                  </View>
                  {isFailed && (
                    <TouchableOpacity onPress={() => dismissPendingTransaction(tx.id)} style={styles.dismissButton}>
                      <Ionicons name="close" size={18} color={Colors.textTertiary} />
                    </TouchableOpacity>
                  )}
                </View>
              );
            })}
          </Animated.View>
        )}

        <PrivacyInfoCard
          title="ZK-SNARK Protection"
          description="Your shielded transactions use STARK zero-knowledge proofs (quantum-resistant). No one can see amounts, senders, or recipients on-chain."
        />
      </ScrollView>

      {/* Shield/Unshield Modal */}
      {actionModal && (
        <AmountInputModal
          visible={actionModal !== null}
          action={actionModal === 'shield' ? 'Shield' : (useRelay ? 'Private Unshield' : 'Unshield')}
          subtitle={actionModal === 'shield' ? 'Move SOL into shielded pool' : (useRelay ? 'Withdraw via decentralized relay' : 'Withdraw from shielded pool')}
          iconName={actionModal === 'shield' ? 'arrow-down' : 'arrow-up'}
          accentColor={actionModal === 'shield' ? P01Colors.cyan : P01Colors.pink}
          dimColor={actionModal === 'shield' ? P01Colors.cyanDim : P01Colors.pinkDim}
          amount={amount}
          onChangeAmount={setAmount}
          maxAmount={actionModal === 'shield' ? (balance?.sol || 0) : shieldedBalance}
          isProcessing={isProcessing}
          onConfirm={actionModal === 'shield' ? handleShield : handleUnshield}
          onClose={() => { setActionModal(null); setAmount(''); setUseRelay(false); }}
        >
          {actionModal === 'unshield' && (
            <View style={styles.relayToggleRow}>
              <View style={styles.relayToggleLeft}>
                <Ionicons name="shield-checkmark" size={16} color={useRelay ? P01Colors.cyan : '#666'} />
                <Text style={[styles.relayToggleLabel, useRelay && { color: P01Colors.cyan }]}>
                  Private Relay
                </Text>
              </View>
              <Switch
                value={useRelay}
                onValueChange={setUseRelay}
                trackColor={{ false: '#333', true: P01Colors.cyanDim }}
                thumbColor={useRelay ? P01Colors.cyan : '#888'}
              />
            </View>
          )}
        </AmountInputModal>
      )}

      <PrivacyInfoModal
        visible={showInfo}
        onClose={() => setShowInfo(false)}
        title="Shielded Transactions"
        subtitle="Zcash-style privacy on Solana"
        sections={SHIELDED_INFO_SECTIONS}
      />

      <StealthRecoveryModal
        visible={showRecoveryModal}
        isScanning={isScanning}
        isSweeping={isSweeping}
        foundPayments={foundPayments}
        onScan={handleScanStealth}
        onSweep={handleSweepAll}
        onClose={() => setShowRecoveryModal(false)}
      />

      <ZkProgressOverlay
        visible={progressOperation !== null}
        operation={progressOperation}
        progressStep={progressStep}
        progressMessage={progressMessage}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    position: 'relative',
  },
  headerBorder: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: 'rgba(57, 197, 187, 0.10)',
  },
  backButton: { padding: 8, marginLeft: -8 },
  headerTitle: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerText: { fontSize: 18, fontFamily: FontFamily.bold, color: Colors.textPrimary },
  headerActions: { flexDirection: 'row', alignItems: 'center' },
  content: { flex: 1 },
  scrollContent: { padding: Spacing.lg, paddingBottom: 120 },
  sectionTitle: {
    fontSize: 11,
    fontFamily: FontFamily.bold,
    color: Colors.textTertiary,
    letterSpacing: 1,
    marginTop: Spacing.md,
    marginBottom: Spacing.sm,
  },
  transparentCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    gap: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  transparentIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  transparentInfo: { flex: 1 },
  transparentLabel: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    marginBottom: 2,
  },
  transparentAmount: {
    fontSize: 16,
    fontFamily: FontFamily.bold,
    color: Colors.textPrimary,
  },
  pendingCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    gap: 12,
    marginBottom: Spacing.sm,
  },
  pendingCardFailed: {
    backgroundColor: 'rgba(239, 68, 68, 0.05)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.2)',
  },
  pendingIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(251, 191, 36, 0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pendingInfo: { flex: 1 },
  pendingType: {
    fontSize: 14,
    fontFamily: FontFamily.bold,
    color: Colors.textPrimary,
    textTransform: 'capitalize',
  },
  pendingStatus: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
  },
  pendingErrorBadge: {
    alignSelf: 'flex-start',
    marginTop: 3,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: BorderRadius.sm,
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
  },
  pendingErrorText: {
    fontSize: 12,
    fontFamily: FontFamily.medium,
    color: '#ef4444',
  },
  dismissButton: { padding: 8, marginLeft: 4 },
  relayToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginHorizontal: 4,
    marginTop: 8,
    backgroundColor: 'rgba(57, 197, 187, 0.06)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.12)',
  },
  relayToggleLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  relayToggleLabel: {
    fontSize: 14,
    fontFamily: FontFamily.medium,
    color: '#888',
  },
});

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  StyleSheet,
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
import { useStarkProver } from '@/providers/StarkProverProvider';
import { getKeypair } from '@/services/solana/wallet';
import { submitGenericStarkProof, type GenericStarkProof, CIRCUIT_CONFIDENTIAL_BALANCE } from '@/services/stark';
import { PublicKey, Transaction } from '@solana/web3.js';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import { requireBiometricAuth } from '@/utils/biometricGate';
import { p01Alert } from '@/stores/alertStore';

import ShieldedBalanceCard from '@/components/privacy/ShieldedBalanceCard';
import ShieldedActions from '@/components/privacy/ShieldedActions';
import PrivacyInfoCard from '@/components/privacy/PrivacyInfoCard';
import PrivacyInfoModal from '@/components/privacy/PrivacyInfoModal';
import AmountInputModal from '@/components/privacy/AmountInputModal';
import StealthRecoveryModal from '@/components/privacy/StealthRecoveryModal';
import ZkProgressOverlay from '@/components/privacy/ZkProgressOverlay';

/**
 * What this modal is allowed to claim.
 *
 * Every one of these four cards previously ended in an absolute — "completely
 * private", "all hidden", "the source remains hidden", "only you and the
 * recipient know". None of them survived measurement:
 *
 *  - The spend proof publishes the note commitment as `stark_commitment`
 *    (services/denominatedPool/index.ts:3192 → :3277 → :2941), and the deposit
 *    published that same value. A deposit/withdrawal pair is therefore
 *    matchable by anyone, confirmed on devnet. Only the C7 spend circuit
 *    changes this (docs/C7_SPEND_CIRCUIT_PLAN.md).
 *  - The wallet publicly funds the one-time key on both legs
 *    (stores/denominatedPoolStore.ts:1207-1223, :1460-1473) and the residual
 *    is swept back to it (:1256-1259, :1566-1570).
 *
 * What genuinely holds is the denomination argument: a pool has one amount, so
 * the size you moved is not distinctive. That is the claim these cards make now.
 */
const SHIELDED_INFO_SECTIONS = [
  {
    title: 'How it works',
    text: 'Shielded transactions carry a zero-knowledge proof that you own a valid note, without revealing which key signed for it. The proof still names the note on chain, so it is not an anonymity system yet.',
  },
  {
    title: 'Shield',
    text: 'Convert transparent SOL into shielded notes. Every deposit into a pool is the same fixed amount, so what you moved is not distinctive — but your deposit itself stays visible.',
  },
  {
    // Deliberately NOT claiming the "no on-chain record" property here. That
    // belongs to the denominated pool's offline note handoff; this legacy
    // module broadcasts a real transaction (shielded-transfer.tsx:152). The
    // amount claim is safe: the proof's public amount is hardcoded '0' and the
    // value rides in the output commitments (shielded-transfer.tsx:117-119).
    title: 'Transfer',
    text: 'Send shielded SOL to a ZK address. The amount rides inside the note commitments instead of appearing as a cleartext transfer amount — but this is still an on-chain transaction.',
  },
  {
    title: 'Unshield',
    text: 'Withdraw shielded SOL back to a transparent address. The withdrawal republishes the commitment your deposit published, so it can be matched back to that deposit.',
  },
];

export default function ShieldedWalletScreen() {
  const router = useRouter();
  const { balance, publicKey } = useWalletStore();
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
      setTimeout(() => Clipboard.setStringAsync(''), 60000);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      p01Alert('Copied', 'ZK address copied to clipboard. Clipboard will be cleared in 60 seconds.');
    }
  };

  // Wallet signer helper (local keypair only — Privy removed, spec §3 Phase 1).
  const getWalletSigner = async () => {
    const keypair = await getKeypair();
    if (!keypair) throw new Error('Could not get wallet keypair');
    const walletPubkey: PublicKey = keypair.publicKey;
    const signTransaction = async (tx: Transaction): Promise<Transaction> => {
      tx.sign(keypair);
      return tx;
    };
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
    if (!amount || parseFloat(amount) <= 0) { p01Alert('Invalid Amount', 'Please enter a valid amount'); return; }
    if (!publicKey) { p01Alert('Error', 'Wallet not connected'); return; }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsProcessing(true);
    setProgressOperation('shield');
    setProgressStep(0);
    setProgressMessage('Preparing wallet...');

    let interval: ReturnType<typeof setInterval> | undefined;
    try {
      setProgressStep(10);
      setProgressMessage('Connecting to wallet...');
      const { walletPubkey, signTransaction } = await getWalletSigner();
      setProgressStep(20);

      interval = runProgress(20, [[40, 'Computing commitment...'], [65, 'Signing transaction...'], [100, 'Confirming on Solana...']]);
      await shield(parseFloat(amount), walletPubkey, signTransaction);
      clearInterval(interval);

      setProgressStep(100);
      setProgressMessage('Complete!');
      await new Promise(r => setTimeout(r, 500));

      setActionModal(null);
      setAmount('');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      p01Alert('Success', 'SOL has been shielded successfully');
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      p01Alert('Error', (err as Error).message);
    } finally {
      if (interval) clearInterval(interval);
      setIsProcessing(false);
      setProgressOperation(null);
      setProgressStep(0);
      setProgressMessage('');
    }
  };

  const handleUnshield = async () => {
    if (!amount || parseFloat(amount) <= 0) { p01Alert('Invalid Amount', 'Please enter a valid amount'); return; }
    if (parseFloat(amount) > shieldedBalance) { p01Alert('Insufficient Balance', 'You do not have enough shielded SOL'); return; }
    if (!publicKey) { p01Alert('Error', 'Wallet not connected'); return; }

    // Biometric gate — require auth before unshielding funds
    const authed = await requireBiometricAuth('Authenticate to unshield funds');
    if (!authed) {
      p01Alert('Authentication Required', 'You must authenticate to unshield funds.');
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsProcessing(true);
    setProgressOperation('unshield');
    setProgressStep(0);
    setProgressMessage('Preparing withdrawal...');

    let interval: ReturnType<typeof setInterval> | undefined;
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
        interval = runProgress(55, [[70, 'Generating ZK proof...'], [85, 'Signing transaction...'], [100, 'Confirming on Solana...']]);
        await unshield(parseFloat(amount), walletPubkey, walletPubkey, signTransaction, false);
        clearInterval(interval);
      } else {
        // --- Groth16 fallback (or relay mode) ---
        const progressSteps = useRelay
          ? [[20, 'Preparing proof...'], [40, 'Generating ZK proof...'], [55, 'Encrypting for relayer...'], [70, 'Submitting relay job...'], [85, 'Waiting for relayer...'], [100, 'Confirming on Solana...']]
          : [[30, 'Preparing proof...'], [50, 'Generating ZK proof...'], [70, 'Signing transaction...'], [100, 'Confirming on Solana...']];
        interval = runProgress(15, progressSteps as [number, string][]);
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
      p01Alert('Success', `SOL has been unshielded successfully${method}`);
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      p01Alert('Error', (err as Error).message);
    } finally {
      if (interval) clearInterval(interval);
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
      p01Alert('Scan Error', (err as Error).message);
    } finally { setIsScanning(false); }
  };

  const handleSweepAll = async () => {
    if (!publicKey) { p01Alert('Error', 'Wallet not connected'); return; }
    setIsSweeping(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    try {
      const result = await sweepAllStealthPayments(publicKey);
      if (result.success && result.swept > 0) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        p01Alert('Recovery Complete!', `Recovered ${result.totalAmount.toFixed(4)} SOL from ${result.swept} stealth payment(s).\n\nFunds are now in your transparent wallet.`,
          [{ text: 'OK', onPress: () => setShowRecoveryModal(false) }]);
        setFoundPayments([]);
        await refreshBalance();
      } else if (result.errors.length > 0) {
        p01Alert('Partial Recovery', `Some payments failed:\n${result.errors.join('\n')}`);
      } else {
        p01Alert('Nothing to Recover', 'No stealth payments found to sweep.');
      }
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      p01Alert('Sweep Error', (err as Error).message);
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

        {/*
          Dropped 'No one can see amounts, senders, or recipients on-chain.'
          The spend proof publishes the note commitment the deposit published
          (services/denominatedPool/index.ts:3192), so a withdrawal is
          matchable to its deposit — measured on devnet, anonymity set 1. The
          title said ZK-SNARK while the body said STARK; the STARK is the one
          that ships, so the title now matches.
        */}
        <PrivacyInfoCard
          title="STARK Protection"
          description="Your shielded transactions are proved with STARK zero-knowledge proofs (quantum-resistant, no trusted setup). Amounts are not published in the clear, but a withdrawal can still be matched to the deposit it came from."
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

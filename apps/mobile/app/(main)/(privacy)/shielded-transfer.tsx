/**
 * Shielded transfer.
 *
 * 🎯 REBUILT ON THE REALIGNED THEME 2026-08-23. This file was the clearest case
 * of a screen that a theme sweep cannot reach: `#eae7df` and
 * `rgba(234, 231, 223, 0.62)` were written out as literals nineteen times, so
 * the values happened to be right today and would silently be wrong on the next
 * retune. They are `Colors.text` and `Colors.textSecondary` now.
 *
 * ⛔ THE GRADIENT BUTTON IS GONE. The primary action was a blue-to-blue
 * `LinearGradient` with a grey gradient for its disabled state — a second
 * accent, and a disabled treatment that only looked disabled. It is the kit's
 * `Button`, which is disabled in fact as well as in colour.
 *
 * ⛔ And "MAX" is "Max". An all-caps shouted label is the house style being
 * removed everywhere.
 */

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';

import { useShieldedStore } from '@/stores/shieldedStore';
import { useStarkProver } from '@/providers/StarkProverProvider';
import { getKeypair } from '@/services/solana/wallet';
import { submitGenericStarkProof, type GenericStarkProof, CIRCUIT_TRANSFER } from '@/services/stark';
import { PublicKey, Transaction } from '@solana/web3.js';
import { Colors, FontFamily, FontSize, BorderRadius, Spacing } from '@/constants/theme';
import { Button } from '@/components/ui';
import { p01Alert } from '@/stores/alertStore';

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

  const {
    isReady: starkReady,
    generateTransferProof: generateStarkTransferProof,
  } = useStarkProver();

  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [proofProgress, setProofProgress] = useState(0);
  const [proofStatus, setProofStatus] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    const init = async () => {
      const ready = await ensureInitialized();
      setIsReady(ready);
      if (!ready) {
        p01Alert('Not Initialized', 'Please initialize your shielded wallet first.');
        router.replace('/(main)/(wallet)');
      }
    };
    init();
  }, []);

  const handlePaste = async () => {
    const text = await Clipboard.getStringAsync();
    if (text) { setRecipient(text); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }
  };

  const handleScan = () => {
    p01Alert('QR Scanner', 'QR code scanning will be available in a future update. Please paste the address manually.');
  };

  const handleSetMax = () => {
    setAmount(shieldedBalance.toString());
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const validateInputs = (): boolean => {
    if (!recipient.trim()) { p01Alert('Missing Recipient', 'Please enter a ZK address.'); return false; }
    if (!recipient.startsWith('zk:')) { p01Alert('Invalid Address', 'ZK addresses must start with "zk:"'); return false; }
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) { p01Alert('Invalid Amount', 'Please enter a valid amount greater than 0.'); return false; }
    if (amountNum > shieldedBalance) { p01Alert('Insufficient Balance', `You only have ${shieldedBalance.toFixed(4)} SOL shielded.`); return false; }
    return true;
  };

  const handleTransfer = async () => {
    if (!validateInputs()) return;

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsProcessing(true);
    setProofProgress(0);
    setProofStatus('Preparing transaction...');

    let progressInterval: ReturnType<typeof setInterval> | undefined;
    try {
      // Local keypair is the only signing path (Privy removed — spec §3 Phase 1).
      const keypair = await getKeypair();
      if (!keypair) throw new Error('Could not get wallet keypair');
      const walletPubkey: PublicKey = keypair.publicKey;
      const signTransaction = async (tx: Transaction): Promise<Transaction> => { tx.sign(keypair); return tx; };

      // STARK path: generate and verify STARK transfer proof before Groth16 transfer
      if (starkReady) {
        setProofProgress(5);
        setProofStatus('Generating STARK transfer proof...');

        const amountLamports = Math.floor(parseFloat(amount) * 1e9);
        const balanceLamports = Math.floor(shieldedBalance * 1e9);
        const newBalanceLamports = balanceLamports - amountLamports;

        const starkResult = await generateStarkTransferProof(
          '0', // spending key placeholder (shielded pool uses note-based keys)
          '0', // token mint (native SOL)
          balanceLamports.toString(), '0', // input 1
          '0', '0', // input 2 (dummy)
          amountLamports.toString(), '0', recipient.slice(3), // output 1 (to recipient)
          newBalanceLamports.toString(), '0', walletPubkey.toBase58(), // output 2 (change)
          '0', // public amount
        );

        const proofBytes = Buffer.from(starkResult.proofHex, 'hex');
        const publicInputs = starkResult.publicInputs.map(s => BigInt(s));

        setProofProgress(30);
        setProofStatus('Verifying STARK proof on-chain...');
        const starkProof: GenericStarkProof = {
          proofBytes,
          circuitId: CIRCUIT_TRANSFER,
          publicInputs,
          proofSize: starkResult.proofSize,
        };
        await submitGenericStarkProof(starkProof, undefined, (step) => setProofStatus(step));
        setProofProgress(50);
        setProofStatus('STARK verified, executing transfer...');
      }

      let currentProgress = starkReady ? 50 : 0;
      progressInterval = setInterval(() => {
        if (currentProgress >= 90) { currentProgress = 90; } else {
          currentProgress = currentProgress + Math.random() * 15;
          if (currentProgress > 90) currentProgress = 90;
        }
        setProofProgress(currentProgress);
        if (currentProgress < 60) setProofStatus('Selecting notes...');
        else if (currentProgress < 70) setProofStatus('Building witness...');
        else if (currentProgress < 80) setProofStatus('Generating ZK proof...');
        else if (currentProgress < 85) setProofStatus('Finalizing proof...');
        else setProofStatus('Submitting transaction...');
      }, 500);

      await transfer(recipient, parseFloat(amount), walletPubkey, signTransaction);

      clearInterval(progressInterval);
      setProofProgress(100);
      setProofStatus('Complete!');

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      const lastNote = getLastSentNote();
      if (lastNote) {
        await Clipboard.setStringAsync(lastNote.noteString);
        setTimeout(() => Clipboard.setStringAsync(''), 60000);
        p01Alert(
          `Transfer Successful${starkReady ? ' (STARK)' : ''}`,
          `${amount} SOL has been sent privately.\n\nNote copied to clipboard (auto-clears in 60s)!\n\nIMPORTANT: Share this note with the recipient so they can import it and receive the funds.`,
          [
            { text: 'Copy Again', onPress: async () => { await Clipboard.setStringAsync(lastNote.noteString); setTimeout(() => Clipboard.setStringAsync(''), 60000); Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } },
            { text: 'Done', onPress: () => router.back() },
          ]
        );
      } else {
        p01Alert('Transfer Successful', `${amount} SOL has been sent privately to the recipient.${starkReady ? '\n\nSTARK proof verified on-chain.' : ''}`, [{ text: 'OK', onPress: () => router.back() }]);
      }
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      p01Alert('Transfer Failed', (err as Error).message);
    } finally {
      if (progressInterval) clearInterval(progressInterval);
      setIsProcessing(false);
      setProofProgress(0);
      setProofStatus(null);
    }
  };

  const estimatedFee = 0.0001;
  const amountNum = parseFloat(amount) || 0;
  const total = amountNum + estimatedFee;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="chevron-back" size={22} color={Colors.textSecondary} />
        </TouchableOpacity>
        <Text style={styles.headerText}>Shielded transfer</Text>
        <View style={styles.headerSpacer} />
      </View>

      <KeyboardAvoidingView style={styles.keyboardView} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView style={styles.content} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled" scrollEventThrottle={16} showsVerticalScrollIndicator={false}>
          <Animated.View entering={FadeInDown.delay(100)}>
            <View style={styles.balanceCard}>
              <Text style={styles.balanceLabel}>Available shielded</Text>
              <Text style={styles.balanceValue}>{shieldedBalance.toFixed(4)} SOL</Text>
            </View>
          </Animated.View>

          <Animated.View entering={FadeInDown.delay(200)}>
            <Text style={styles.inputTitle}>Recipient ZK address</Text>
            <View style={styles.inputContainer}>
              <TextInput
                style={styles.addressInput}
                value={recipient}
                onChangeText={setRecipient}
                placeholder="zk:abc123..."
                placeholderTextColor={Colors.textTertiary}
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel="Recipient ZK address"
              />
              <View style={styles.inputActions}>
                <TouchableOpacity
                  onPress={handlePaste}
                  style={styles.inputAction}
                  accessibilityRole="button"
                  accessibilityLabel="Paste address"
                >
                  <Ionicons name="clipboard-outline" size={18} color={Colors.textSecondary} />
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={handleScan}
                  style={styles.inputAction}
                  accessibilityRole="button"
                  accessibilityLabel="Scan a QR code"
                >
                  <Ionicons name="scan-outline" size={18} color={Colors.textSecondary} />
                </TouchableOpacity>
              </View>
            </View>
          </Animated.View>

          <Animated.View entering={FadeInDown.delay(300)}>
            <View style={styles.amountHeader}>
              <Text style={styles.inputTitle}>Amount</Text>
              <TouchableOpacity
                onPress={handleSetMax}
                style={styles.maxButton}
                accessibilityRole="button"
                accessibilityLabel="Use the full shielded balance"
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
          </Animated.View>

          {amountNum > 0 && (
            <Animated.View entering={FadeInUp.delay(100)}>
              <View style={styles.summaryCard}>
                <Text style={styles.summaryTitle}>Summary</Text>
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

          <Animated.View entering={FadeInDown.delay(400)}>
            <View style={styles.privacyInfo}>
              <Ionicons name="eye-off-outline" size={16} color={Colors.textSecondary} />
              {/*
                Was 'This transfer is fully private. Amount, sender, and
                recipient are hidden on-chain.' Three absolutes, none of them
                established. What IS checkable here is the amount: the proof is
                built with a public amount of '0' (:119) and the value rides in
                the output commitments (:117), so no cleartext amount is
                published. Sender and recipient privacy is not claimed, because
                nothing in this module demonstrates it.
              */}
              <Text style={styles.privacyText}>The amount is carried inside the note commitments, not published in the clear. This is still an on-chain transaction.</Text>
            </View>
          </Animated.View>

          {isProcessing && (
            <Animated.View entering={FadeInUp} style={styles.proofContainer}>
              <Text style={styles.proofTitle}>Generating the proof</Text>
              <View style={styles.progressBar}>
                <View style={[styles.progressFill, { width: `${proofProgress}%` }]} />
              </View>
              <Text style={styles.proofStatus} accessibilityLiveRegion="polite">{proofStatus}</Text>
              <Text style={styles.proofWarning}>Keep the app open. This takes 30 to 60 seconds.</Text>
            </Animated.View>
          )}
        </ScrollView>

        <View style={styles.bottomContainer}>
          <Button
            variant="primary"
            size="lg"
            fullWidth
            loading={isProcessing}
            disabled={!recipient || !amount}
            onPress={handleTransfer}
          >
            Send privately
          </Button>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, minHeight: 56,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.borderSoft,
  },
  backButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerSpacer: { width: 44 },
  headerText: {
    flex: 1, fontSize: FontSize.xl, fontFamily: FontFamily.displayMedium, color: Colors.text,
  },
  keyboardView: { flex: 1 },
  content: { flex: 1 },
  scrollContent: { padding: Spacing.xl, paddingBottom: 100 },

  balanceCard: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    padding: Spacing.lg, marginBottom: Spacing['2xl'],
    borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.border,
  },
  balanceLabel: {
    fontSize: FontSize.sm, fontFamily: FontFamily.regular, color: Colors.textSecondary,
  },
  balanceValue: {
    fontSize: FontSize['2xl'], fontFamily: FontFamily.display, color: Colors.text, marginTop: 2,
  },

  inputTitle: {
    fontSize: FontSize.sm, fontFamily: FontFamily.medium,
    color: Colors.textSecondary, marginBottom: Spacing.sm,
  },
  inputContainer: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    flexDirection: 'row', alignItems: 'center',
    paddingRight: Spacing.sm, marginBottom: Spacing['2xl'],
    borderWidth: 1, borderColor: Colors.border,
  },
  addressInput: {
    flex: 1, minHeight: 48, paddingHorizontal: Spacing.lg,
    fontSize: FontSize.sm, fontFamily: FontFamily.mono, color: Colors.text,
  },
  inputActions: { flexDirection: 'row' },
  inputAction: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },

  amountHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: Spacing.sm,
  },
  maxButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: Spacing.sm },
  maxButtonText: {
    fontSize: FontSize.sm, fontFamily: FontFamily.medium, color: Colors.primary,
  },
  amountContainer: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.lg, marginBottom: Spacing['2xl'],
    borderWidth: 1, borderColor: Colors.border,
  },
  amountInput: {
    flex: 1, paddingVertical: Spacing.lg,
    fontSize: FontSize['2xl'], fontFamily: FontFamily.monoMedium, color: Colors.text,
  },
  amountSuffix: {
    fontSize: FontSize.lg, fontFamily: FontFamily.regular, color: Colors.textSecondary,
  },

  summaryCard: {
    backgroundColor: Colors.surfaceSecondary, borderRadius: BorderRadius.md,
    padding: Spacing.lg, marginBottom: Spacing['2xl'],
    borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.border,
  },
  summaryTitle: {
    fontSize: FontSize.sm, fontFamily: FontFamily.medium,
    color: Colors.textTertiary, marginBottom: Spacing.md,
  },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: Spacing.sm },
  summaryLabel: {
    fontSize: FontSize.sm, fontFamily: FontFamily.regular, color: Colors.textSecondary,
  },
  summaryValue: { fontSize: FontSize.sm, fontFamily: FontFamily.mono, color: Colors.text },
  summaryDivider: {
    height: StyleSheet.hairlineWidth, backgroundColor: Colors.border, marginVertical: Spacing.sm,
  },
  summaryLabelBold: { fontSize: FontSize.sm, fontFamily: FontFamily.medium, color: Colors.text },
  summaryValueBold: { fontSize: FontSize.sm, fontFamily: FontFamily.monoMedium, color: Colors.text },

  privacyInfo: {
    flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm,
    borderRadius: BorderRadius.md, padding: Spacing.md, marginBottom: Spacing['2xl'],
    backgroundColor: Colors.surfaceSecondary,
    borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.border,
  },
  privacyText: {
    flex: 1, fontSize: FontSize.sm, fontFamily: FontFamily.regular,
    color: Colors.textSecondary, lineHeight: 20,
  },

  proofContainer: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    padding: Spacing.lg, marginBottom: Spacing['2xl'],
    borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.border,
  },
  proofTitle: {
    fontSize: FontSize.lg, fontFamily: FontFamily.displayMedium,
    color: Colors.text, marginBottom: Spacing.md,
  },
  progressBar: {
    height: 4, backgroundColor: Colors.surfaceTertiary, borderRadius: 2,
    overflow: 'hidden', marginBottom: Spacing.sm,
  },
  progressFill: { height: '100%', backgroundColor: Colors.primary, borderRadius: 2 },
  proofStatus: {
    fontSize: FontSize.sm, fontFamily: FontFamily.medium,
    color: Colors.text, marginBottom: Spacing.xs,
  },
  proofWarning: {
    fontSize: FontSize.xs, fontFamily: FontFamily.regular, color: Colors.textTertiary,
  },

  bottomContainer: {
    paddingHorizontal: Spacing.xl, paddingTop: Spacing.md, paddingBottom: 120,
    backgroundColor: Colors.background,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.borderSoft,
  },
});

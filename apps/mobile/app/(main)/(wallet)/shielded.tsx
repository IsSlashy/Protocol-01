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
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import Animated, {
  FadeInDown,
  FadeInUp,
} from 'react-native-reanimated';

import { useWalletStore } from '@/stores/walletStore';
import { useShieldedStore } from '@/stores/shieldedStore';
import { Colors, FontFamily, BorderRadius, Spacing } from '@/constants/theme';

// P-01 Design System Colors - NO purple/violet allowed
const P01 = {
  cyan: '#39c5bb',
  cyanDim: 'rgba(57, 197, 187, 0.15)',
  pink: '#ff77a8',
  pinkDim: 'rgba(255, 119, 168, 0.15)',
  blue: '#3b82f6',
  blueDim: 'rgba(59, 130, 246, 0.15)',
};

export default function ShieldedWalletScreen() {
  const router = useRouter();
  const { balance, publicKey } = useWalletStore();
  const {
    isInitialized,
    isLoading,
    shieldedBalance,
    notes,
    zkAddress,
    pendingTransactions,
    initialize,
    refreshBalance,
    shield,
    unshield,
  } = useShieldedStore();

  const [showBalance, setShowBalance] = useState(true);
  const [actionModal, setActionModal] = useState<'shield' | 'unshield' | null>(null);
  const [amount, setAmount] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [showInfo, setShowInfo] = useState(false);

  // Initialize on mount
  useEffect(() => {
    if (!isInitialized && publicKey) {
      initialize();
    }
  }, [publicKey, isInitialized]);

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

  const handleShield = async () => {
    if (!amount || parseFloat(amount) <= 0) {
      Alert.alert('Invalid Amount', 'Please enter a valid amount');
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsProcessing(true);

    try {
      await shield(parseFloat(amount));
      setActionModal(null);
      setAmount('');
      Alert.alert('Success', 'SOL has been shielded successfully');
    } catch (err) {
      Alert.alert('Error', (err as Error).message);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleUnshield = async () => {
    if (!amount || parseFloat(amount) <= 0) {
      Alert.alert('Invalid Amount', 'Please enter a valid amount');
      return;
    }

    if (parseFloat(amount) > shieldedBalance) {
      Alert.alert('Insufficient Balance', 'You do not have enough shielded SOL');
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsProcessing(true);

    try {
      await unshield(parseFloat(amount));
      setActionModal(null);
      setAmount('');
      Alert.alert('Success', 'SOL has been unshielded successfully');
    } catch (err) {
      Alert.alert('Error', (err as Error).message);
    } finally {
      setIsProcessing(false);
    }
  };

  const formatShieldedBalance = () => {
    if (!showBalance) return '****';
    return `${shieldedBalance.toFixed(4)} SOL`;
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
        >
          <Ionicons name="arrow-back" size={24} color={Colors.textPrimary} />
        </TouchableOpacity>
        <View style={styles.headerTitle}>
          <Ionicons name="shield-checkmark" size={20} color={P01.cyan} />
          <Text style={styles.headerText}>Shielded Wallet</Text>
        </View>
        <View style={styles.headerActions}>
          <TouchableOpacity onPress={() => setShowBalance(!showBalance)}>
            <Ionicons
              name={showBalance ? 'eye' : 'eye-off'}
              size={22}
              color={Colors.textSecondary}
            />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setShowInfo(true)} style={{ marginLeft: 16 }}>
            <Ionicons name="information-circle-outline" size={22} color={Colors.textSecondary} />
          </TouchableOpacity>
        </View>
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
        {/* Shielded Balance Card */}
        <Animated.View entering={FadeInDown.delay(100)}>
          <LinearGradient
            colors={[Colors.surface, Colors.background]}
            style={styles.balanceCard}
          >
            <View style={styles.balanceHeader}>
              <View style={styles.balanceLabel}>
                <Ionicons name="shield" size={18} color={P01.cyan} />
                <Text style={styles.balanceLabelText}>Shielded Balance</Text>
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
                {isLoading ? '...' : formatShieldedBalance()}
              </Text>
            </View>

            <Text style={styles.balanceSubtext}>
              Fully private • Zero-knowledge protected
            </Text>

            {/* ZK Address */}
            <TouchableOpacity onPress={copyAddress} style={styles.zkAddressContainer}>
              <View style={styles.zkAddressLabel}>
                <Text style={styles.zkAddressLabelText}>ZK Address</Text>
                <View style={styles.copyButton}>
                  <Ionicons name="copy-outline" size={14} color={P01.cyan} />
                  <Text style={styles.copyText}>Copy</Text>
                </View>
              </View>
              <Text style={styles.zkAddress} numberOfLines={1}>
                {zkAddress || 'Initializing...'}
              </Text>
            </TouchableOpacity>
          </LinearGradient>
        </Animated.View>

        {/* Action Buttons */}
        <Animated.View entering={FadeInDown.delay(200)} style={styles.actionsContainer}>
          <TouchableOpacity
            style={[styles.actionButton, { backgroundColor: P01.cyanDim }]}
            onPress={() => setActionModal('shield')}
          >
            <Ionicons name="arrow-down" size={24} color={P01.cyan} />
            <Text style={[styles.actionText, { color: P01.cyan }]}>Shield</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.actionButton, { backgroundColor: P01.pinkDim }]}
            onPress={() => setActionModal('unshield')}
            disabled={shieldedBalance <= 0}
          >
            <Ionicons name="arrow-up" size={24} color={P01.pink} />
            <Text style={[styles.actionText, { color: P01.pink }]}>Unshield</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.actionButton, { backgroundColor: P01.blueDim }]}
            onPress={() => router.push('/(main)/(wallet)/shielded-transfer')}
            disabled={shieldedBalance <= 0}
          >
            <Ionicons name="flash" size={24} color={P01.blue} />
            <Text style={[styles.actionText, { color: P01.blue }]}>Transfer</Text>
          </TouchableOpacity>
        </Animated.View>

        {/* Transparent Balance */}
        <Animated.View entering={FadeInDown.delay(300)}>
          <Text style={styles.sectionTitle}>TRANSPARENT BALANCE</Text>
          <View style={styles.transparentCard}>
            <View style={styles.transparentIcon}>
              <Ionicons name="lock-open" size={20} color="#fff" />
            </View>
            <View style={styles.transparentInfo}>
              <Text style={styles.transparentAmount}>
                {balance?.sol?.toFixed(4) || '0'} SOL
              </Text>
              <Text style={styles.transparentLabel}>Available to shield</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={Colors.textTertiary} />
          </View>
        </Animated.View>

        {/* Pending Transactions */}
        {pendingTransactions.length > 0 && (
          <Animated.View entering={FadeInDown.delay(350)}>
            <Text style={styles.sectionTitle}>PENDING</Text>
            {pendingTransactions.map((tx) => (
              <View key={tx.id} style={styles.pendingCard}>
                <View style={styles.pendingIcon}>
                  <ActivityIndicator color="#fbbf24" size="small" />
                </View>
                <View style={styles.pendingInfo}>
                  <Text style={styles.pendingType}>{tx.type}</Text>
                  <Text style={styles.pendingStatus}>
                    {tx.status === 'generating_proof' ? 'Generating ZK proof...' : 'Processing...'}
                  </Text>
                </View>
              </View>
            ))}
          </Animated.View>
        )}

        {/* Shielded Notes */}
        <Animated.View entering={FadeInDown.delay(400)}>
          <Text style={styles.sectionTitle}>SHIELDED NOTES ({notes.length})</Text>
          <View style={styles.notesContainer}>
            {notes.length === 0 ? (
              <View style={styles.emptyNotes}>
                <Ionicons name="shield-outline" size={40} color={Colors.textTertiary} />
                <Text style={styles.emptyText}>No shielded notes yet</Text>
                <Text style={styles.emptySubtext}>
                  Shield some SOL to create your first private note
                </Text>
              </View>
            ) : (
              notes.slice(0, 5).map((note, index) => (
                <View key={index} style={styles.noteCard}>
                  <View style={styles.noteIcon}>
                    <Ionicons name="lock-closed" size={18} color={P01.cyan} />
                  </View>
                  <View style={styles.noteInfo}>
                    <Text style={styles.noteAmount}>
                      {showBalance ? `${(Number(note.amount) / 1e9).toFixed(4)} SOL` : '****'}
                    </Text>
                    <Text style={styles.noteIndex}>Index: {note.leafIndex ?? 'pending'}</Text>
                  </View>
                </View>
              ))
            )}
          </View>
        </Animated.View>

        {/* Privacy Info */}
        <Animated.View entering={FadeInDown.delay(500)}>
          <LinearGradient
            colors={[P01.cyanDim, P01.pinkDim]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.infoCard}
          >
            <View style={styles.infoIcon}>
              <Ionicons name="shield-checkmark" size={24} color={P01.cyan} />
            </View>
            <View style={styles.infoContent}>
              <Text style={styles.infoTitle}>ZK-SNARK Protection</Text>
              <Text style={styles.infoText}>
                Your shielded transactions use Groth16 zero-knowledge proofs.
                No one can see amounts, senders, or recipients on-chain.
              </Text>
            </View>
          </LinearGradient>
        </Animated.View>
      </ScrollView>

      {/* Shield/Unshield Modal */}
      <Modal
        visible={actionModal !== null}
        animationType="slide"
        transparent
        onRequestClose={() => setActionModal(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <View style={[
                styles.modalIcon,
                { backgroundColor: actionModal === 'shield' ? P01.cyanDim : P01.pinkDim }
              ]}>
                <Ionicons
                  name={actionModal === 'shield' ? 'arrow-down' : 'arrow-up'}
                  size={28}
                  color={actionModal === 'shield' ? P01.cyan : P01.pink}
                />
              </View>
              <View>
                <Text style={styles.modalTitle}>
                  {actionModal === 'shield' ? 'Shield SOL' : 'Unshield SOL'}
                </Text>
                <Text style={styles.modalSubtitle}>
                  {actionModal === 'shield'
                    ? 'Move SOL into shielded pool'
                    : 'Withdraw from shielded pool'}
                </Text>
              </View>
            </View>

            <View style={styles.inputContainer}>
              <View style={styles.inputHeader}>
                <Text style={styles.inputLabel}>Amount</Text>
                <TouchableOpacity onPress={() => {
                  const max = actionModal === 'shield'
                    ? (balance?.sol || 0)
                    : shieldedBalance;
                  setAmount(max.toString());
                }}>
                  <Text style={styles.maxButton}>
                    Max: {actionModal === 'shield'
                      ? `${(balance?.sol || 0).toFixed(4)} SOL`
                      : `${shieldedBalance.toFixed(4)} SOL`}
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

            {actionModal === 'shield' && notes.length === 0 && (
              <View style={styles.warningBox}>
                <Ionicons name="warning" size={20} color="#fbbf24" />
                <Text style={styles.warningText}>
                  Proof generation may take 30-60 seconds on first use.
                </Text>
              </View>
            )}

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.cancelButton}
                onPress={() => {
                  setActionModal(null);
                  setAmount('');
                }}
                disabled={isProcessing}
              >
                <Text style={styles.cancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.confirmButton,
                  { backgroundColor: actionModal === 'shield' ? P01.cyan : P01.pink }
                ]}
                onPress={actionModal === 'shield' ? handleShield : handleUnshield}
                disabled={isProcessing || !amount || parseFloat(amount) <= 0}
              >
                {isProcessing ? (
                  <ActivityIndicator color="#000" />
                ) : (
                  <Text style={styles.confirmText}>
                    {actionModal === 'shield' ? 'Shield' : 'Unshield'}
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Info Modal */}
      <Modal
        visible={showInfo}
        animationType="fade"
        transparent
        onRequestClose={() => setShowInfo(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.infoModalContent}>
            <View style={styles.infoModalHeader}>
              <View style={[styles.modalIcon, { backgroundColor: P01.cyanDim }]}>
                <Ionicons name="shield-checkmark" size={28} color={P01.cyan} />
              </View>
              <View>
                <Text style={styles.modalTitle}>Shielded Transactions</Text>
                <Text style={styles.modalSubtitle}>Zcash-style privacy on Solana</Text>
              </View>
            </View>

            <ScrollView style={styles.infoScroll}>
              <View style={styles.infoSection}>
                <Text style={styles.infoSectionTitle}>How it works</Text>
                <Text style={styles.infoSectionText}>
                  Shielded transactions use zero-knowledge proofs (ZK-SNARKs) to hide
                  amounts, senders, and recipients while proving the transaction is valid.
                </Text>
              </View>

              <View style={styles.infoSection}>
                <Text style={styles.infoSectionTitle}>Shield</Text>
                <Text style={styles.infoSectionText}>
                  Convert transparent SOL into shielded notes. Your deposit amount is visible,
                  but from then on, all movements are completely private.
                </Text>
              </View>

              <View style={styles.infoSection}>
                <Text style={styles.infoSectionTitle}>Transfer</Text>
                <Text style={styles.infoSectionText}>
                  Send shielded SOL to any ZK address. The amount, sender, and recipient
                  are all hidden. Only you and the recipient know the details.
                </Text>
              </View>

              <View style={styles.infoSection}>
                <Text style={styles.infoSectionTitle}>Unshield</Text>
                <Text style={styles.infoSectionText}>
                  Withdraw shielded SOL back to a transparent address. The withdrawal
                  amount becomes visible, but the source remains hidden.
                </Text>
              </View>
            </ScrollView>

            <TouchableOpacity
              style={[styles.confirmButton, { backgroundColor: P01.cyan }]}
              onPress={() => setShowInfo(false)}
            >
              <Text style={styles.confirmText}>Got it</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
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
    color: Colors.textPrimary,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  content: {
    flex: 1,
  },
  scrollContent: {
    padding: Spacing.md,
    paddingBottom: 32,
  },
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
    marginBottom: Spacing.md,
  },
  zkAddressContainer: {
    backgroundColor: 'rgba(0,0,0,0.3)',
    borderRadius: BorderRadius.md,
    padding: Spacing.sm,
  },
  zkAddressLabel: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  zkAddressLabelText: {
    fontSize: 11,
    fontFamily: FontFamily.medium,
    color: Colors.textTertiary,
  },
  copyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  copyText: {
    fontSize: 11,
    fontFamily: FontFamily.medium,
    color: P01.cyan,
  },
  zkAddress: {
    fontSize: 12,
    fontFamily: FontFamily.mono,
    color: Colors.textPrimary,
  },
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
  pendingCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    gap: 12,
    marginBottom: Spacing.sm,
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
  pendingType: {
    fontSize: 14,
    fontFamily: FontFamily.medium,
    color: Colors.textPrimary,
    textTransform: 'capitalize',
  },
  pendingStatus: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
  },
  notesContainer: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    overflow: 'hidden',
  },
  emptyNotes: {
    alignItems: 'center',
    padding: Spacing.xl,
  },
  emptyText: {
    fontSize: 14,
    fontFamily: FontFamily.medium,
    color: Colors.textSecondary,
    marginTop: Spacing.sm,
  },
  emptySubtext: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    marginTop: 4,
    textAlign: 'center',
  },
  noteCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    gap: 12,
  },
  noteIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: P01.cyanDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  noteInfo: {
    flex: 1,
  },
  noteAmount: {
    fontSize: 14,
    fontFamily: FontFamily.mono,
    color: Colors.textPrimary,
  },
  noteIndex: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
  },
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
  warningBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(251, 191, 36, 0.1)',
    borderRadius: BorderRadius.md,
    padding: Spacing.sm,
    marginBottom: Spacing.md,
  },
  warningText: {
    flex: 1,
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: '#fbbf24',
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
  infoModalContent: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.xl,
    margin: Spacing.lg,
    padding: Spacing.lg,
    maxHeight: '80%',
  },
  infoModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: Spacing.lg,
  },
  infoScroll: {
    marginBottom: Spacing.md,
  },
  infoSection: {
    backgroundColor: Colors.background,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.sm,
  },
  infoSectionTitle: {
    fontSize: 14,
    fontFamily: FontFamily.bold,
    color: Colors.textPrimary,
    marginBottom: 4,
  },
  infoSectionText: {
    fontSize: 13,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    lineHeight: 20,
  },
});

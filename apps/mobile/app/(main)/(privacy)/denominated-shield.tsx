import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  StyleSheet,
  Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import Animated, {
  FadeInDown,
  FadeInUp,
  FadeIn,
  SlideInDown,
  SlideOutDown,
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withSequence,
  withDelay,
  Easing,
  interpolateColor,
} from 'react-native-reanimated';
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';

import { useDenominatedPoolStore } from '@/stores/denominatedPoolStore';
import { useWalletStore } from '@/stores/walletStore';
import { useAuth } from '@/providers/PrivyProvider';
import {
  type PoolConfig,
  SOL_POOLS,
  USDC_POOLS,
} from '@/services/denominatedPool';
import { getConnection } from '@/services/solana/connection';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

type TokenTab = 'SOL' | 'USDC';

// ─── Confirmation Sheet ───────────────────────────────────────────
interface ConfirmSheetProps {
  visible: boolean;
  pool: PoolConfig | null;
  walletBalance: number;
  noteCount: number;
  isProcessing: boolean;
  progress: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

function ConfirmSheet({
  visible,
  pool,
  walletBalance,
  noteCount,
  isProcessing,
  progress,
  onConfirm,
  onClose,
}: ConfirmSheetProps) {
  const pulseAnim = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      pulseAnim.value = withRepeat(
        withSequence(
          withTiming(1, { duration: 1200, easing: Easing.inOut(Easing.ease) }),
          withTiming(0, { duration: 1200, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
      );
    }
  }, [visible]);

  const glowStyle = useAnimatedStyle(() => ({
    borderColor: interpolateColor(
      pulseAnim.value,
      [0, 1],
      ['rgba(57, 197, 187, 0.2)', 'rgba(57, 197, 187, 0.6)'],
    ),
  }));

  if (!pool) return null;

  const denomination = pool.denomination;
  const token = pool.token;
  const balanceSol = walletBalance / LAMPORTS_PER_SOL;
  const needed = Number(pool.denominationAtomic) / (token === 'SOL' ? LAMPORTS_PER_SOL : 1e6);
  const hasEnough = token === 'SOL'
    ? walletBalance >= Number(pool.denominationAtomic) + 50_000
    : true;
  const anonymityLabel = noteCount === 0 ? 'New pool' :
    noteCount < 10 ? `${noteCount} notes (Low)` :
    noteCount < 100 ? `${noteCount} notes (Medium)` : `${noteCount} notes (High)`;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={cs.overlay}>
        <TouchableOpacity style={cs.backdrop} activeOpacity={1} onPress={isProcessing ? undefined : onClose} />

        <Animated.View
          entering={SlideInDown.springify().damping(18).stiffness(140)}
          exiting={SlideOutDown.duration(250)}
          style={cs.sheet}
        >
          {/* Drag handle */}
          <View style={cs.dragRow}>
            <View style={cs.dragHandle} />
          </View>

          {/* Header */}
          <View style={cs.sheetHeader}>
            <LinearGradient
              colors={[P01Colors.cyanDim, 'rgba(57, 197, 187, 0.05)']}
              style={cs.sheetIconWrap}
            >
              <Ionicons name="shield-checkmark" size={28} color={P01Colors.cyan} />
            </LinearGradient>
            <View style={{ flex: 1 }}>
              <Text style={cs.sheetTitle}>Shield {token}</Text>
              <Text style={cs.sheetSubtitle}>Deposit into privacy pool</Text>
            </View>
          </View>

          {/* Amount display */}
          <Animated.View style={[cs.amountCard, glowStyle]}>
            <Text style={cs.amountValue}>{denomination}</Text>
            <Text style={cs.amountToken}>{token}</Text>
          </Animated.View>

          {/* Details */}
          <View style={cs.detailsCard}>
            <DetailRow
              icon="wallet-outline"
              label="Your balance"
              value={`${balanceSol.toFixed(4)} SOL`}
              valueColor={hasEnough ? Colors.text : '#EF4444'}
            />
            <View style={cs.detailDivider} />
            <DetailRow
              icon="people-outline"
              label="Anonymity set"
              value={anonymityLabel}
              valueColor={noteCount >= 100 ? P01Colors.green : noteCount >= 10 ? P01Colors.cyan : P01Colors.yellow}
            />
            <View style={cs.detailDivider} />
            <DetailRow
              icon="time-outline"
              label="Maturity"
              value="~1 epoch (~1 hour)"
              valueColor={Colors.textSecondary}
            />
            <View style={cs.detailDivider} />
            <DetailRow
              icon="hardware-chip-outline"
              label="Proof system"
              value="STARK (PQ-safe)"
              valueColor="#8B5CF6"
            />
          </View>

          {/* Insufficient balance warning */}
          {!hasEnough && (
            <View style={cs.warningCard}>
              <Ionicons name="warning" size={16} color="#FBBF24" />
              <Text style={cs.warningText}>
                Insufficient balance. You need {needed} {token} + fees.
              </Text>
            </View>
          )}

          {/* Processing overlay inside sheet */}
          {isProcessing && (
            <Animated.View entering={FadeIn.duration(200)} style={cs.processingCard}>
              <ActivityIndicator size="small" color={P01Colors.cyan} />
              <Text style={cs.processingText}>{progress || 'Processing...'}</Text>
            </Animated.View>
          )}

          {/* Buttons */}
          <View style={cs.sheetActions}>
            <TouchableOpacity
              style={cs.cancelBtn}
              onPress={onClose}
              disabled={isProcessing}
              activeOpacity={0.7}
            >
              <Text style={cs.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={onConfirm}
              disabled={isProcessing || !hasEnough}
              activeOpacity={0.8}
              style={{ flex: 1 }}
            >
              <LinearGradient
                colors={isProcessing || !hasEnough
                  ? ['rgba(57,197,187,0.3)', 'rgba(57,197,187,0.15)']
                  : [P01Colors.cyan, '#20A89E']}
                style={cs.confirmBtn}
              >
                {isProcessing ? (
                  <ActivityIndicator size="small" color="#000" />
                ) : (
                  <>
                    <Ionicons name="shield-checkmark" size={18} color="#000" />
                    <Text style={cs.confirmBtnText}>Shield {denomination} {token}</Text>
                  </>
                )}
              </LinearGradient>
            </TouchableOpacity>
          </View>

          {/* Fine print */}
          <Text style={cs.finePrint}>
            Your note will be stored locally. Keep this device safe.
          </Text>
        </Animated.View>
      </View>
    </Modal>
  );
}

function DetailRow({ icon, label, value, valueColor }: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
  valueColor: string;
}) {
  return (
    <View style={cs.detailRow}>
      <Ionicons name={icon} size={16} color={Colors.textTertiary} />
      <Text style={cs.detailLabel}>{label}</Text>
      <Text style={[cs.detailValue, { color: valueColor }]}>{value}</Text>
    </View>
  );
}

// ─── Result Modal ─────────────────────────────────────────────────
interface ResultModalProps {
  visible: boolean;
  type: 'success' | 'error';
  title: string;
  message: string;
  actions?: Array<{ label: string; onPress: () => void; primary?: boolean }>;
  onDismiss: () => void;
}

function ResultModal({ visible, type, title, message, actions, onDismiss }: ResultModalProps) {
  const iconColor = type === 'success' ? P01Colors.cyan : '#EF4444';
  const iconName = type === 'success' ? 'checkmark-circle' : 'alert-circle';
  const pulseAnim = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      pulseAnim.value = withRepeat(
        withSequence(
          withTiming(1, { duration: 1500, easing: Easing.inOut(Easing.ease) }),
          withTiming(0, { duration: 1500, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
      );
    }
  }, [visible]);

  const glowStyle = useAnimatedStyle(() => ({
    borderColor: interpolateColor(
      pulseAnim.value,
      [0, 1],
      [`${iconColor}33`, `${iconColor}88`],
    ),
  }));

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={onDismiss}
    >
      <View style={rm.overlay}>
        <TouchableOpacity style={rm.backdrop} activeOpacity={1} onPress={onDismiss} />
        <Animated.View
          entering={FadeInUp.springify().damping(14).stiffness(100)}
          style={[rm.card, glowStyle]}
        >
          {/* Top accent */}
          <View style={[rm.topAccent, { backgroundColor: iconColor }]} />

          {/* Icon */}
          <View style={[rm.iconWrap, { backgroundColor: `${iconColor}15` }]}>
            <Ionicons name={iconName} size={40} color={iconColor} />
          </View>

          <Text style={rm.title}>{title}</Text>
          <Text style={rm.message}>{message}</Text>

          {/* Actions */}
          <View style={rm.actions}>
            {actions?.map((action, i) => (
              <TouchableOpacity
                key={i}
                style={[
                  rm.actionBtn,
                  action.primary
                    ? { backgroundColor: iconColor }
                    : { backgroundColor: 'transparent', borderWidth: 1, borderColor: Colors.border },
                ]}
                onPress={action.onPress}
                activeOpacity={0.7}
              >
                <Text style={[
                  rm.actionText,
                  action.primary ? { color: '#000' } : { color: Colors.text },
                ]}>
                  {action.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Corner accents */}
          <View style={[rm.corner, rm.cornerBL, { backgroundColor: `${iconColor}60` }]} />
          <View style={[rm.corner, rm.cornerBLv, { backgroundColor: `${iconColor}60` }]} />
          <View style={[rm.corner, rm.cornerBR, { backgroundColor: `${iconColor}60` }]} />
          <View style={[rm.corner, rm.cornerBRv, { backgroundColor: `${iconColor}60` }]} />
        </Animated.View>
      </View>
    </Modal>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────
export default function DenominatedShieldScreen() {
  const router = useRouter();
  const [tokenTab, setTokenTab] = useState<TokenTab>('SOL');
  const [walletBalance, setWalletBalance] = useState<number>(0);
  const [loadingBalance, setLoadingBalance] = useState(true);

  // Confirmation sheet
  const [selectedPool, setSelectedPool] = useState<PoolConfig | null>(null);

  // Result modal
  const [resultModal, setResultModal] = useState<{
    visible: boolean;
    type: 'success' | 'error';
    title: string;
    message: string;
    actions?: ResultModalProps['actions'];
  }>({ visible: false, type: 'success', title: '', message: '' });

  const {
    isLoading,
    error,
    progress,
    poolCache,
    shieldNote,
    refreshPoolInfo,
  } = useDenominatedPoolStore();

  const pools = tokenTab === 'SOL' ? SOL_POOLS : USDC_POOLS;
  const { publicKey: storePublicKey, initializeWithPrivy } = useWalletStore();
  const { walletAddress: privyWalletAddress } = useAuth();
  const walletPublicKey = privyWalletAddress || storePublicKey;

  useEffect(() => {
    if (privyWalletAddress && !storePublicKey) {
      initializeWithPrivy(privyWalletAddress);
    }
  }, [privyWalletAddress, storePublicKey]);

  const fetchBalance = useCallback(async () => {
    setLoadingBalance(true);
    try {
      if (walletPublicKey) {
        const connection = getConnection();
        const bal = await connection.getBalance(new PublicKey(walletPublicKey));
        setWalletBalance(bal);
      }
    } catch (err) {
      console.error('[DenomShield] Failed to fetch balance:', err);
    }
    setLoadingBalance(false);
  }, [walletPublicKey]);

  useEffect(() => {
    fetchBalance();
    refreshPoolInfo();
  }, [fetchBalance]);

  const handleSelectPool = useCallback((pool: PoolConfig) => {
    console.log('[Shield] Pool selected:', pool.denomination, pool.token, 'PDA:', pool.poolPDA.toBase58().slice(0, 8));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedPool(pool);
  }, []);

  const handleConfirmShield = useCallback(async () => {
    if (!selectedPool) return;
    console.log('[Shield] Confirm pressed for', selectedPool.denomination, selectedPool.token);
    console.log('[Shield] Wallet pubkey:', walletPublicKey || 'NONE');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    // Refresh balance right before check
    let currentBalance = walletBalance;
    try {
      if (walletPublicKey) {
        const connection = getConnection();
        currentBalance = await connection.getBalance(new PublicKey(walletPublicKey));
        setWalletBalance(currentBalance);
      }
    } catch {}

    console.log('[Shield] Balance refreshed:', currentBalance, 'lamports =', (currentBalance / LAMPORTS_PER_SOL).toFixed(4), 'SOL');

    const needed = Number(selectedPool.denominationAtomic);
    console.log('[Shield] Needed:', needed, 'lamports + 50000 fees');
    if (selectedPool.token === 'SOL' && currentBalance < needed + 50_000) {
      console.log('[Shield] INSUFFICIENT BALANCE — aborting');
      setSelectedPool(null);
      setResultModal({
        visible: true,
        type: 'error',
        title: 'Insufficient Balance',
        message: `You need ${selectedPool.denomination} SOL + fees.\n\nCurrent balance: ${(currentBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`,
        actions: [{ label: 'OK', onPress: () => setResultModal(m => ({ ...m, visible: false })), primary: true }],
      });
      return;
    }

    try {
      console.log('[Shield] Calling shieldNote()...');
      await shieldNote(selectedPool);
      console.log('[Shield] shieldNote() SUCCESS');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const pool = selectedPool;
      setSelectedPool(null);
      setResultModal({
        visible: true,
        type: 'success',
        title: 'Shielded!',
        message: `${pool.denomination} ${pool.token} deposited into the privacy pool.\n\nYour note is saved locally and will mature after ~1 epoch (~1 hour).`,
        actions: [
          {
            label: 'View Notes',
            onPress: () => {
              setResultModal(m => ({ ...m, visible: false }));
              router.push('/(main)/(privacy)/denominated-notes' as any);
            },
            primary: true,
          },
          { label: 'Done', onPress: () => setResultModal(m => ({ ...m, visible: false })) },
        ],
      });
      fetchBalance();
    } catch (err: any) {
      console.error('[Shield] FAILED:', err.message, err);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setSelectedPool(null);
      setResultModal({
        visible: true,
        type: 'error',
        title: 'Shield Failed',
        message: err.message || 'An unknown error occurred.',
        actions: [{ label: 'OK', onPress: () => setResultModal(m => ({ ...m, visible: false })), primary: true }],
      });
    }
  }, [selectedPool, walletBalance, walletPublicKey, shieldNote, router, fetchBalance]);

  const getPoolNoteCount = (pool: PoolConfig): number => {
    const cached = poolCache[pool.poolPDA.toBase58()];
    return cached?.info.noteCount ?? 0;
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={22} color={Colors.text} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Ionicons name="shield-checkmark" size={20} color={P01Colors.cyan} />
          <Text style={styles.headerTitle}>Shield</Text>
        </View>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Wallet Balance Card */}
        <Animated.View entering={FadeInDown.delay(50)}>
          <LinearGradient
            colors={['rgba(57,197,187,0.06)', 'rgba(57,197,187,0.01)']}
            style={styles.balanceCard}
          >
            <View style={styles.balanceLeft}>
              <Text style={styles.balanceLabel}>Available</Text>
              <Text style={styles.balanceValue}>
                {loadingBalance ? '...' : (walletBalance / LAMPORTS_PER_SOL).toFixed(4)}
              </Text>
              <Text style={styles.balanceSuffix}>SOL</Text>
            </View>
            <TouchableOpacity onPress={fetchBalance} style={styles.refreshBtn}>
              <Ionicons name="refresh" size={18} color={P01Colors.cyan} />
            </TouchableOpacity>
          </LinearGradient>
        </Animated.View>

        {/* Token Tabs */}
        <Animated.View entering={FadeInUp.delay(100)} style={styles.tabRow}>
          {(['SOL', 'USDC'] as TokenTab[]).map(tab => (
            <TouchableOpacity
              key={tab}
              style={[styles.tab, tokenTab === tab && styles.tabActive]}
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setTokenTab(tab);
              }}
              activeOpacity={0.7}
            >
              <Text style={[styles.tabText, tokenTab === tab && styles.tabTextActive]}>
                {tab}
              </Text>
            </TouchableOpacity>
          ))}
        </Animated.View>

        {/* Explainer */}
        <Animated.View entering={FadeInUp.delay(150)}>
          <View style={styles.explainer}>
            <Ionicons name="information-circle-outline" size={16} color={Colors.textTertiary} />
            <Text style={styles.explainerText}>
              Choose a denomination. Same-size deposits are indistinguishable — the larger the pool, the stronger your privacy.
            </Text>
          </View>
        </Animated.View>

        {/* Section label */}
        <Animated.View entering={FadeInUp.delay(180)}>
          <Text style={styles.sectionLabel}>SELECT AMOUNT</Text>
        </Animated.View>

        {/* Pool Cards */}
        {pools.map((pool, i) => {
          const noteCount = getPoolNoteCount(pool);
          const anonymityLevel = noteCount === 0 ? 0 :
            noteCount < 10 ? 1 : noteCount < 100 ? 2 : 3;
          const anonymityLabel = ['Empty', 'Low', 'Medium', 'High'][anonymityLevel];
          const anonymityColor = [Colors.textTertiary, P01Colors.yellow, P01Colors.cyan, P01Colors.green][anonymityLevel];
          const balanceSol = walletBalance / LAMPORTS_PER_SOL;
          const canAfford = pool.token === 'SOL' ? balanceSol >= pool.denomination : true;

          return (
            <Animated.View key={pool.poolPDA.toBase58()} entering={FadeInUp.delay(220 + i * 60)}>
              <TouchableOpacity
                style={[styles.poolCard, !canAfford && styles.poolCardDimmed]}
                onPress={() => handleSelectPool(pool)}
                disabled={isLoading}
                activeOpacity={0.7}
              >
                <LinearGradient
                  colors={canAfford
                    ? [P01Colors.cyanDim, 'rgba(57, 197, 187, 0.02)']
                    : ['rgba(50,50,50,0.08)', 'rgba(30,30,30,0.02)']}
                  style={[styles.poolCardGradient, !canAfford && { borderColor: Colors.border }]}
                >
                  <View style={styles.poolHeader}>
                    {/* Left: amount */}
                    <View style={styles.poolLeft}>
                      <Text style={[styles.poolAmount, !canAfford && { color: Colors.textSecondary }]}>
                        {pool.denomination}
                      </Text>
                      <Text style={styles.poolToken}>{pool.token}</Text>
                    </View>

                    {/* Right: anonymity + chevron */}
                    <View style={styles.poolRight}>
                      <View style={[styles.anonymityBadge, { borderColor: anonymityColor }]}>
                        <View style={[styles.anonymityDot, { backgroundColor: anonymityColor }]} />
                        <Text style={[styles.anonymityText, { color: anonymityColor }]}>
                          {anonymityLabel}
                        </Text>
                      </View>
                      <Ionicons
                        name="chevron-forward"
                        size={20}
                        color={canAfford ? P01Colors.cyan : Colors.textTertiary}
                      />
                    </View>
                  </View>

                  {/* Bottom row: pool stats */}
                  <View style={styles.poolMeta}>
                    <View style={styles.poolMetaItem}>
                      <Ionicons name="people" size={12} color={Colors.textTertiary} />
                      <Text style={styles.poolMetaText}>{noteCount} notes</Text>
                    </View>
                    <View style={styles.poolMetaDot} />
                    <View style={styles.poolMetaItem}>
                      <Ionicons name="time" size={12} color={Colors.textTertiary} />
                      <Text style={styles.poolMetaText}>~1h maturity</Text>
                    </View>
                    <View style={styles.poolMetaDot} />
                    <View style={styles.poolMetaItem}>
                      <Ionicons name="hardware-chip" size={12} color={Colors.textTertiary} />
                      <Text style={styles.poolMetaText}>STARK</Text>
                    </View>
                    {!canAfford && (
                      <>
                        <View style={styles.poolMetaDot} />
                        <Text style={[styles.poolMetaText, { color: '#EF4444' }]}>Insufficient</Text>
                      </>
                    )}
                  </View>
                </LinearGradient>
              </TouchableOpacity>
            </Animated.View>
          );
        })}

        {/* Error */}
        {error && !isLoading && (
          <View style={styles.errorCard}>
            <Ionicons name="warning" size={18} color={Colors.error} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}
      </ScrollView>

      {/* Confirmation Sheet */}
      <ConfirmSheet
        visible={selectedPool !== null}
        pool={selectedPool}
        walletBalance={walletBalance}
        noteCount={selectedPool ? getPoolNoteCount(selectedPool) : 0}
        isProcessing={isLoading}
        progress={progress}
        onConfirm={handleConfirmShield}
        onClose={() => { if (!isLoading) setSelectedPool(null); }}
      />

      {/* Result Modal */}
      <ResultModal
        visible={resultModal.visible}
        type={resultModal.type}
        title={resultModal.title}
        message={resultModal.message}
        actions={resultModal.actions}
        onDismiss={() => setResultModal(m => ({ ...m, visible: false }))}
      />
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
  },
  headerCenter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  backBtn: {
    width: 40, height: 40, borderRadius: 9999,
    backgroundColor: Colors.surfaceSecondary,
    justifyContent: 'center', alignItems: 'center',
  },
  headerTitle: {
    color: Colors.text,
    fontSize: 20,
    fontFamily: FontFamily.bold,
  },
  scrollView: { flex: 1 },
  scrollContent: {
    paddingHorizontal: Spacing.xl,
    paddingBottom: 120,
  },

  /* Balance card */
  balanceCard: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: BorderRadius.lg,
    padding: Spacing.lg,
    marginBottom: Spacing.lg,
    borderWidth: 1,
    borderColor: `${P01Colors.cyan}25`,
  },
  balanceLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 6,
  },
  balanceLabel: {
    fontSize: 13,
    fontFamily: FontFamily.medium,
    color: Colors.textTertiary,
    marginRight: 4,
  },
  balanceValue: {
    fontSize: 22,
    fontFamily: FontFamily.bold,
    color: Colors.text,
  },
  balanceSuffix: {
    fontSize: 14,
    fontFamily: FontFamily.medium,
    color: Colors.textSecondary,
  },
  refreshBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: `${P01Colors.cyan}15`,
    justifyContent: 'center', alignItems: 'center',
  },

  /* Tabs */
  tabRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginBottom: Spacing.lg,
  },
  tab: {
    flex: 1,
    paddingVertical: Spacing.md,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
    backgroundColor: Colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  tabActive: {
    backgroundColor: P01Colors.cyanDim,
    borderColor: P01Colors.cyan,
  },
  tabText: {
    fontSize: 14,
    fontFamily: FontFamily.semibold,
    color: Colors.textSecondary,
  },
  tabTextActive: { color: P01Colors.cyan },

  /* Explainer */
  explainer: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  explainerText: {
    flex: 1,
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    lineHeight: 18,
  },

  /* Section label */
  sectionLabel: {
    fontSize: 11,
    fontFamily: FontFamily.bold,
    color: Colors.textTertiary,
    letterSpacing: 1.2,
    marginBottom: Spacing.md,
  },

  /* Pool cards */
  poolCard: {
    borderRadius: BorderRadius.lg,
    overflow: 'hidden',
    marginBottom: Spacing.sm,
  },
  poolCardDimmed: {
    opacity: 0.6,
  },
  poolCardGradient: {
    borderRadius: BorderRadius.lg,
    padding: Spacing.lg,
    borderWidth: 1,
    borderColor: `${P01Colors.cyan}25`,
  },
  poolHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.sm,
  },
  poolLeft: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 6,
  },
  poolAmount: {
    fontSize: 28,
    fontFamily: FontFamily.bold,
    color: Colors.text,
  },
  poolToken: {
    fontSize: 16,
    fontFamily: FontFamily.medium,
    color: Colors.textSecondary,
  },
  poolRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  anonymityBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: BorderRadius.sm,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  anonymityDot: { width: 6, height: 6, borderRadius: 3 },
  anonymityText: { fontSize: 11, fontFamily: FontFamily.mono },
  poolMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  poolMetaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  poolMetaText: {
    fontSize: 11,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
  },
  poolMetaDot: {
    width: 3,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: Colors.border,
  },

  /* Error */
  errorCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: Colors.errorDim,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.error,
  },
  errorText: {
    flex: 1,
    fontSize: 13,
    fontFamily: FontFamily.regular,
    color: Colors.error,
  },
});

// ─── Confirm Sheet Styles ─────────────────────────────────────────
const cs = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.75)',
  },
  sheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: Spacing.xl,
    paddingBottom: 40,
    borderTopWidth: 1,
    borderTopColor: `${P01Colors.cyan}30`,
  },
  dragRow: {
    alignItems: 'center',
    paddingTop: 10,
    paddingBottom: Spacing.md,
  },
  dragHandle: {
    width: 40, height: 4, borderRadius: 2,
    backgroundColor: Colors.border,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginBottom: Spacing.xl,
  },
  sheetIconWrap: {
    width: 52, height: 52, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
  },
  sheetTitle: {
    fontSize: 20,
    fontFamily: FontFamily.bold,
    color: Colors.text,
  },
  sheetSubtitle: {
    fontSize: 13,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    marginTop: 2,
  },
  amountCard: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: 'rgba(0,0,0,0.35)',
    borderRadius: BorderRadius.lg,
    paddingVertical: Spacing.xl,
    marginBottom: Spacing.lg,
    borderWidth: 1.5,
  },
  amountValue: {
    fontSize: 44,
    fontFamily: FontFamily.bold,
    color: Colors.text,
  },
  amountToken: {
    fontSize: 20,
    fontFamily: FontFamily.medium,
    color: Colors.textSecondary,
  },
  detailsCard: {
    backgroundColor: 'rgba(0,0,0,0.2)',
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
  },
  detailLabel: {
    flex: 1,
    fontSize: 13,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
  },
  detailValue: {
    fontSize: 13,
    fontFamily: FontFamily.semibold,
  },
  detailDivider: {
    height: 1,
    backgroundColor: Colors.border,
    marginHorizontal: 4,
  },
  warningCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(251, 191, 36, 0.1)',
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
    borderWidth: 1,
    borderColor: 'rgba(251, 191, 36, 0.3)',
  },
  warningText: {
    flex: 1,
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: '#FBBF24',
    lineHeight: 17,
  },
  processingCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: `${P01Colors.cyan}10`,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  processingText: {
    fontSize: 13,
    fontFamily: FontFamily.medium,
    color: P01Colors.cyan,
  },
  sheetActions: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginTop: Spacing.sm,
  },
  cancelBtn: {
    flex: 0.4,
    paddingVertical: 14,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
  },
  cancelBtnText: {
    fontSize: 15,
    fontFamily: FontFamily.semibold,
    color: Colors.text,
  },
  confirmBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: BorderRadius.md,
  },
  confirmBtnText: {
    fontSize: 15,
    fontFamily: FontFamily.bold,
    color: '#000',
  },
  finePrint: {
    fontSize: 11,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    textAlign: 'center',
    marginTop: Spacing.md,
  },
});

// ─── Result Modal Styles ──────────────────────────────────────────
const rm = StyleSheet.create({
  overlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.75)',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  card: {
    width: '85%',
    maxWidth: 360,
    backgroundColor: Colors.surface,
    borderRadius: 20,
    overflow: 'hidden',
    borderWidth: 1,
  },
  topAccent: {
    height: 2,
  },
  iconWrap: {
    width: 64, height: 64, borderRadius: 32,
    alignItems: 'center', justifyContent: 'center',
    alignSelf: 'center',
    marginTop: 28,
    marginBottom: 16,
  },
  title: {
    fontSize: 20,
    fontFamily: FontFamily.bold,
    color: Colors.text,
    textAlign: 'center',
    marginBottom: 8,
    paddingHorizontal: 24,
  },
  message: {
    fontSize: 14,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    paddingHorizontal: 24,
    marginBottom: 24,
  },
  actions: {
    paddingHorizontal: 20,
    paddingBottom: 24,
    gap: 10,
  },
  actionBtn: {
    paddingVertical: 13,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionText: {
    fontSize: 15,
    fontFamily: FontFamily.bold,
  },
  corner: { position: 'absolute' },
  cornerBL: { bottom: 0, left: 0, width: 24, height: 2 },
  cornerBLv: { bottom: 0, left: 0, width: 2, height: 24 },
  cornerBR: { bottom: 0, right: 0, width: 24, height: 2 },
  cornerBRv: { bottom: 0, right: 0, width: 2, height: 24 },
});

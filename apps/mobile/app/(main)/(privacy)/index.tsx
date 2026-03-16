import React, { useCallback, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';

import { useShieldedStore } from '@/stores/shieldedStore';
import { useConfidentialStore } from '@/stores/confidentialStore';
import { useDenominatedPoolStore } from '@/stores/denominatedPoolStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useArcium } from '@/providers/ArciumProvider';
import { useArciumStore } from '@/stores/arciumStore';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';

export default function PrivacyDashboard() {
  const router = useRouter();

  const {
    shieldedBalance,
    isInitialized: shieldedInitialized,
    isLoading: shieldedLoading,
    notes,
  } = useShieldedStore();

  const {
    balances: confidentialBalances,
    isInitialized: confidentialInitialized,
    isLoading: confidentialLoading,
    pendingCredits,
  } = useConfidentialStore();

  const { notes: denomNotes, getActiveNotes } = useDenominatedPoolStore();
  const activeNotes = getActiveNotes();
  const activeNoteCount = activeNotes.length;
  const matureNoteCount = activeNotes.filter(n => n.status === 'mature').length;

  const {
    shieldedWalletEnabled,
    confidentialBalanceEnabled,
    initialize: initSettings,
  } = useSettingsStore();

  const { isMpcActive, programAvailable } = useArcium();
  const { } = useArciumStore(); // MPC always on

  useEffect(() => { initSettings(); }, []);

  const confidentialSolBalance = (confidentialBalances['11111111111111111111111111111111'] || 0) / 1e9;
  const pendingCount = pendingCredits['11111111111111111111111111111111'] || 0;

  const isLoading = shieldedLoading || confidentialLoading;

  // Show legacy cards if toggle enabled OR if user has funds
  const hasShieldedFunds = shieldedBalance > 0 || notes.filter(n => Number(n.amount) > 0).length > 0;
  const hasConfidentialFunds = confidentialSolBalance > 0 || pendingCount > 0;
  const showShielded = shieldedWalletEnabled || hasShieldedFunds;
  const showConfidential = confidentialBalanceEnabled || hasConfidentialFunds;

  // Badge for settings if user has legacy funds but toggles are off
  const hasLegacyFundsWarning = (hasShieldedFunds && !shieldedWalletEnabled) || (hasConfidentialFunds && !confidentialBalanceEnabled);

  const onRefresh = useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, []);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <Animated.View entering={FadeInDown.delay(50)} style={styles.header}>
        <Text style={styles.headerTitle} accessibilityRole="header">Privacy</Text>
        <View style={styles.headerRight}>
          <TouchableOpacity
            style={styles.headerButton}
            onPress={() => router.push('/(main)/(settings)')}
            accessibilityRole="button"
            accessibilityLabel={hasLegacyFundsWarning ? 'Settings, attention needed' : 'Settings'}
          >
            <Ionicons name="settings-outline" size={20} color={Colors.text} />
            {hasLegacyFundsWarning && <View style={styles.settingsBadge} />}
          </TouchableOpacity>
        </View>
      </Animated.View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={isLoading} onRefresh={onRefresh} tintColor={Colors.primary} />
        }
      >
        {/* ═══════ HERO: Privacy Pool (Denominated Pools) ═══════ */}
        <Animated.View entering={FadeInUp.delay(100)}>
          <TouchableOpacity
            style={styles.modeCard}
            onPress={() => router.push('/(main)/(privacy)/denominated-notes' as any)}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={`Privacy Pool, ${activeNoteCount > 0 ? `${activeNoteCount} active notes` : 'fixed-denomination anonymous pool'}`}
            accessibilityHint="Opens privacy pool notes"
          >
            <BlurView intensity={15} tint="dark" style={styles.heroGradient}>
              <LinearGradient
                colors={['rgba(57, 197, 187, 0.06)', 'rgba(255, 119, 168, 0.03)', 'transparent']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={StyleSheet.absoluteFill}
              />
              <View style={styles.modeCardHeader}>
                <View style={[styles.modeIconContainer, { backgroundColor: P01Colors.cyanDim }]}>
                  <Ionicons name="shield-checkmark" size={28} color={P01Colors.cyan} />
                </View>
                <View style={styles.modeCardInfo}>
                  <Text style={styles.heroTitle}>Privacy Pool</Text>
                  <Text style={styles.modeCardSubtitle}>
                    {activeNoteCount > 0
                      ? `${activeNoteCount} active note${activeNoteCount > 1 ? 's' : ''}`
                      : 'Fixed-denomination anonymous pool'}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={20} color={P01Colors.cyan} />
              </View>

              {/* Quick Stats */}
              <View style={styles.quickStats}>
                <View style={styles.statItem}>
                  <Text style={styles.statValue}>STARK</Text>
                  <Text style={styles.statLabel}>Proof System</Text>
                </View>
                <View style={styles.statDivider} />
                <View style={styles.statItem}>
                  <Text style={styles.statValue}>Full</Text>
                  <Text style={styles.statLabel}>Anonymity</Text>
                </View>
                <View style={styles.statDivider} />
                <View style={styles.statItem}>
                  <Text style={styles.statValue}>On-device</Text>
                  <Text style={styles.statLabel}>Proving</Text>
                </View>
              </View>

              {/* Quick Actions — Row 1 */}
              <View style={styles.quickActions}>
                <TouchableOpacity
                  style={[styles.quickAction, { backgroundColor: P01Colors.cyanDim }]}
                  onPress={() => router.push('/(main)/(privacy)/denominated-shield' as any)}
                  accessibilityRole="button"
                  accessibilityLabel="Shield SOL"
                  accessibilityHint="Deposit SOL into the privacy pool"
                >
                  <Ionicons name="arrow-down" size={16} color={P01Colors.cyan} />
                  <Text style={[styles.quickActionText, { color: P01Colors.cyan }]}>Shield</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.quickAction, { backgroundColor: P01Colors.pinkDim }]}
                  onPress={() => router.push('/(main)/(privacy)/denominated-unshield' as any)}
                  accessibilityRole="button"
                  accessibilityLabel="Unshield SOL"
                  accessibilityHint="Withdraw SOL from the privacy pool"
                >
                  <Ionicons name="arrow-up" size={16} color={P01Colors.pink} />
                  <Text style={[styles.quickActionText, { color: P01Colors.pink }]}>Unshield</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.quickAction, { backgroundColor: 'rgba(57, 197, 187, 0.08)' }]}
                  onPress={() => router.push('/(main)/(privacy)/denominated-notes' as any)}
                  accessibilityRole="button"
                  accessibilityLabel="View notes"
                >
                  <Ionicons name="receipt" size={16} color={P01Colors.cyan} />
                  <Text style={[styles.quickActionText, { color: P01Colors.cyan }]}>Notes</Text>
                </TouchableOpacity>
              </View>
              {/* Quick Actions — Row 2: Private Send (prominent) */}
              <View style={[styles.quickActions, { marginTop: Spacing.sm }]}>
                <TouchableOpacity
                  style={[styles.quickAction, { flex: 1, backgroundColor: 'rgba(57, 197, 187, 0.08)', borderWidth: 1, borderColor: 'rgba(57, 197, 187, 0.2)' }]}
                  onPress={() => router.push('/(main)/(privacy)/private-send' as any)}
                  accessibilityRole="button"
                  accessibilityLabel="Private Send with Privacy Router"
                  accessibilityHint="Send SOL through multiple wallets with time delays for maximum anonymity"
                >
                  <Ionicons name="git-branch-outline" size={16} color={P01Colors.cyan} />
                  <Text style={[styles.quickActionText, { color: P01Colors.cyan }]}>Private Send</Text>
                  <View style={{ backgroundColor: 'rgba(57, 197, 187, 0.2)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, marginLeft: 4 }}>
                    <Text style={{ color: P01Colors.cyan, fontSize: 9, fontWeight: '700' }}>NEW</Text>
                  </View>
                </TouchableOpacity>
              </View>
              {/* Quick Actions — Row 3: Send & Receive */}
              <View style={[styles.quickActions, { marginTop: Spacing.sm }]}>
                <TouchableOpacity
                  style={[styles.quickAction, { backgroundColor: 'rgba(139, 139, 255, 0.12)' }]}
                  onPress={() => router.push('/(main)/(privacy)/denominated-transfer' as any)}
                  accessibilityRole="button"
                  accessibilityLabel={`Send private transfer${matureNoteCount > 0 ? `, ${matureNoteCount} mature notes available` : ''}`}
                >
                  <Ionicons name="send" size={16} color="#8B8BFF" />
                  <Text style={[styles.quickActionText, { color: '#8B8BFF' }]}>Send</Text>
                  {matureNoteCount > 0 && (
                    <View style={styles.actionBadge}>
                      <Text style={styles.actionBadgeText}>{matureNoteCount}</Text>
                    </View>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.quickAction, { backgroundColor: 'rgba(139, 139, 255, 0.12)' }]}
                  onPress={() => router.push('/(main)/(privacy)/denominated-import' as any)}
                  accessibilityRole="button"
                  accessibilityLabel="Receive private transfer"
                >
                  <Ionicons name="download" size={16} color="#8B8BFF" />
                  <Text style={[styles.quickActionText, { color: '#8B8BFF' }]}>Receive</Text>
                </TouchableOpacity>
              </View>
            </BlurView>
          </TouchableOpacity>
        </Animated.View>

        {/* Explainer */}
        <Animated.View entering={FadeInUp.delay(200)}>
          <View style={styles.explainerCard}>
            <Ionicons name="information-circle-outline" size={18} color={Colors.textTertiary} />
            <Text style={styles.explainerText}>
              Privacy Pool uses STARK proofs (quantum-resistant, hash-based) with fixed denominations for maximum anonymity. All proofs are generated on your device — no private data leaves your phone.
            </Text>
          </View>
        </Animated.View>

        {/* ═══════ MPC ENHANCEMENT: Arcium — always on ═══════ */}
        <Animated.View entering={FadeInUp.delay(250)}>
          <View style={styles.mpcCard}>
            <View style={styles.mpcCardRow}>
              <View style={styles.mpcIconWrap}>
                <Ionicons name="shield-checkmark" size={16} color="#7C3AED" />
              </View>
              <View style={styles.mpcCardInfo}>
                <Text style={styles.mpcCardTitle}>
                  Multi-Party Computation
                </Text>
                <Text style={styles.mpcCardDesc}>
                  {isMpcActive
                    ? 'Arcium MPC active — threshold computation enabled'
                    : 'Arcium MPC initializing...'}
                </Text>
              </View>
              <View style={{ backgroundColor: '#10b98120', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 }}>
                <Text style={{ color: '#10b981', fontSize: 11, fontWeight: '600' }}>ON</Text>
              </View>
            </View>
          </View>
        </Animated.View>

        {/* ═══════ LEGACY: Shielded Wallet (conditional) ═══════ */}
        {showShielded && (
          <Animated.View entering={FadeInUp.delay(300)}>
            {/* Funds warning if toggle is off */}
            {hasShieldedFunds && !shieldedWalletEnabled && (
              <View style={styles.fundsWarning}>
                <Ionicons name="alert-circle" size={16} color={P01Colors.yellow} />
                <Text style={styles.fundsWarningText}>
                  You have {shieldedBalance.toFixed(4)} SOL in this pool — withdraw recommended.
                </Text>
              </View>
            )}
            <TouchableOpacity
              style={styles.modeCard}
              onPress={() => router.push('/(main)/(privacy)/shielded')}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={`Shielded Wallet, legacy, ${shieldedInitialized ? `${shieldedBalance.toFixed(4)} SOL shielded` : 'variable-amount privacy pool'}`}
            >
              <BlurView intensity={10} tint="dark" style={styles.modeCardGradient}>
                <View style={styles.modeCardHeader}>
                  <View style={[styles.modeIconContainer, { backgroundColor: 'rgba(100,100,100,0.15)' }]}>
                    <Ionicons name="shield-half" size={24} color={Colors.textSecondary} />
                  </View>
                  <View style={styles.modeCardInfo}>
                    <View style={styles.legacyTitleRow}>
                      <Text style={styles.modeCardTitle}>Shielded Wallet</Text>
                      <View style={styles.legacyBadge}>
                        <Text style={styles.legacyBadgeText}>Legacy</Text>
                      </View>
                    </View>
                    <Text style={styles.modeCardSubtitle}>
                      {shieldedInitialized
                        ? `${shieldedBalance.toFixed(4)} SOL shielded`
                        : 'Variable-amount privacy pool'}
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={20} color={Colors.textTertiary} />
                </View>

                <Text style={styles.migrationText}>
                  Migrate to Privacy Pool for stronger anonymity with fixed denominations.
                </Text>

                <View style={styles.quickActions}>
                  <TouchableOpacity
                    style={[styles.quickAction, { backgroundColor: 'rgba(100,100,100,0.1)' }]}
                    onPress={() => router.push('/(main)/(privacy)/shielded')}
                    accessibilityRole="button"
                    accessibilityLabel="Withdraw from shielded wallet"
                  >
                    <Ionicons name="arrow-up" size={16} color={Colors.textSecondary} />
                    <Text style={[styles.quickActionText, { color: Colors.textSecondary }]}>Withdraw</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.quickAction, { backgroundColor: 'rgba(100,100,100,0.1)' }]}
                    onPress={() => router.push('/(main)/(privacy)/shielded-transfer')}
                    accessibilityRole="button"
                    accessibilityLabel="Transfer from shielded wallet"
                  >
                    <Ionicons name="flash" size={16} color={Colors.textSecondary} />
                    <Text style={[styles.quickActionText, { color: Colors.textSecondary }]}>Transfer</Text>
                  </TouchableOpacity>
                </View>
              </BlurView>
            </TouchableOpacity>
          </Animated.View>
        )}

        {/* ═══════ LEGACY: Confidential Balance (conditional) ═══════ */}
        {showConfidential && (
          <Animated.View entering={FadeInUp.delay(350)}>
            {/* Funds warning if toggle is off */}
            {hasConfidentialFunds && !confidentialBalanceEnabled && (
              <View style={styles.fundsWarning}>
                <Ionicons name="alert-circle" size={16} color={P01Colors.yellow} />
                <Text style={styles.fundsWarningText}>
                  You have {confidentialSolBalance.toFixed(4)} SOL in confidential balance — withdraw recommended.
                </Text>
              </View>
            )}
            <TouchableOpacity
              style={styles.modeCard}
              onPress={() => router.push('/(main)/(privacy)/confidential')}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={`Confidential Balance, legacy, ${confidentialInitialized ? `${confidentialSolBalance.toFixed(4)} SOL confidential` : 'quantum-resistant amount hiding'}`}
            >
              <BlurView intensity={10} tint="dark" style={styles.modeCardGradient}>
                <View style={styles.modeCardHeader}>
                  <View style={[styles.modeIconContainer, { backgroundColor: 'rgba(100,100,100,0.15)' }]}>
                    <Ionicons name="lock-closed" size={24} color={Colors.textSecondary} />
                  </View>
                  <View style={styles.modeCardInfo}>
                    <View style={styles.legacyTitleRow}>
                      <Text style={styles.modeCardTitle}>Confidential Balance</Text>
                      <View style={styles.legacyBadge}>
                        <Text style={styles.legacyBadgeText}>Legacy</Text>
                      </View>
                    </View>
                    <Text style={styles.modeCardSubtitle}>
                      {confidentialInitialized
                        ? `${confidentialSolBalance.toFixed(4)} SOL confidential`
                        : 'Quantum-resistant amount hiding'}
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={20} color={Colors.textTertiary} />
                </View>

                <Text style={styles.migrationText}>
                  Hides amounts but not sender/recipient. Use Privacy Pool for full anonymity.
                </Text>

                <View style={styles.quickActions}>
                  <TouchableOpacity
                    style={[styles.quickAction, { backgroundColor: 'rgba(100,100,100,0.1)' }]}
                    onPress={() => router.push('/(main)/(privacy)/confidential')}
                    accessibilityRole="button"
                    accessibilityLabel="Withdraw from confidential balance"
                  >
                    <Ionicons name="arrow-up" size={16} color={Colors.textSecondary} />
                    <Text style={[styles.quickActionText, { color: Colors.textSecondary }]}>Withdraw</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.quickAction, { backgroundColor: 'rgba(100,100,100,0.1)' }]}
                    onPress={() => router.push('/(main)/(privacy)/confidential')}
                    accessibilityRole="button"
                    accessibilityLabel="Transfer from confidential balance"
                  >
                    <Ionicons name="flash" size={16} color={Colors.textSecondary} />
                    <Text style={[styles.quickActionText, { color: Colors.textSecondary }]}>Transfer</Text>
                  </TouchableOpacity>
                </View>
              </BlurView>
            </TouchableOpacity>
          </Animated.View>
        )}

        {/* Enable legacy features hint (shown when both are hidden) */}
        {!showShielded && !showConfidential && (
          <Animated.View entering={FadeInUp.delay(300)}>
            <TouchableOpacity
              style={styles.enableHint}
              onPress={() => router.push('/(main)/(settings)')}
              accessibilityRole="button"
              accessibilityLabel="Enable legacy privacy features in Settings"
            >
              <Ionicons name="options-outline" size={16} color={Colors.textTertiary} />
              <Text style={styles.enableHintText}>
                Legacy privacy features (Shielded Wallet, Confidential Balance) can be enabled in Settings.
              </Text>
            </TouchableOpacity>
          </Animated.View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
  },
  headerTitle: {
    color: Colors.text,
    fontSize: 24,
    fontFamily: FontFamily.bold,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  headerButton: {
    width: 40,
    height: 40,
    borderRadius: 9999,
    backgroundColor: Colors.surfaceSecondary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  settingsBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: P01Colors.yellow,
  },
  scrollView: { flex: 1 },
  scrollContent: {
    paddingHorizontal: Spacing.xl,
    paddingBottom: 120,
  },
  modeCard: {
    borderRadius: 20,
    overflow: 'hidden',
    marginBottom: Spacing.lg,
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.07)',
  },
  heroGradient: {
    padding: Spacing.lg,
    backgroundColor: 'rgba(12, 12, 14, 0.65)',
  },
  modeCardGradient: {
    padding: Spacing.lg,
    backgroundColor: 'rgba(12, 12, 14, 0.6)',
  },
  modeCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Spacing.lg,
  },
  modeIconContainer: {
    width: 44,
    height: 44,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.md,
  },
  modeCardInfo: { flex: 1 },
  heroTitle: {
    fontSize: 18,
    fontFamily: FontFamily.bold,
    color: Colors.text,
  },
  modeCardTitle: {
    fontSize: 16,
    fontFamily: FontFamily.semibold,
    color: Colors.text,
  },
  modeCardSubtitle: {
    fontSize: 13,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  legacyTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  legacyBadge: {
    backgroundColor: 'rgba(100,100,100,0.2)',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
  },
  legacyBadgeText: {
    fontSize: 10,
    fontFamily: FontFamily.mono,
    fontWeight: '600',
    color: Colors.textTertiary,
  },
  migrationText: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    marginBottom: Spacing.md,
    lineHeight: 17,
  },
  quickStats: {
    flexDirection: 'row',
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    borderRadius: 14,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  statItem: {
    flex: 1,
    alignItems: 'center',
  },
  statValue: {
    fontSize: 14,
    fontFamily: FontFamily.bold,
    color: Colors.text,
  },
  statLabel: {
    fontSize: 11,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    marginTop: 2,
  },
  statDivider: {
    width: 1,
    backgroundColor: Colors.border,
    marginHorizontal: 4,
  },
  quickActions: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  quickAction: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: 12,
  },
  quickActionText: {
    fontSize: 13,
    fontFamily: FontFamily.medium,
  },
  actionBadge: {
    backgroundColor: '#8B8BFF',
    borderRadius: 8,
    minWidth: 16,
    height: 16,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  actionBadgeText: {
    fontSize: 10,
    fontFamily: FontFamily.bold,
    color: '#000',
  },
  explainerCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    borderRadius: 14,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.04)',
    marginBottom: Spacing.lg,
  },
  explainerText: {
    flex: 1,
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    lineHeight: 18,
  },
  fundsWarning: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: P01Colors.yellowDim,
    borderRadius: BorderRadius.md,
    padding: Spacing.sm,
    marginBottom: Spacing.sm,
    borderWidth: 1,
    borderColor: 'rgba(255, 204, 0, 0.3)',
  },
  fundsWarningText: {
    flex: 1,
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: P01Colors.yellow,
    lineHeight: 16,
  },
  mpcCard: {
    backgroundColor: 'rgba(124, 58, 237, 0.04)',
    borderRadius: 14,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: 'rgba(124, 58, 237, 0.10)',
    marginBottom: Spacing.lg,
  },
  mpcCardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  mpcIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: 'rgba(124, 58, 237, 0.10)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  mpcCardInfo: { flex: 1 },
  mpcCardTitle: {
    fontSize: 12,
    fontFamily: FontFamily.bold,
    color: '#7C3AED',
    letterSpacing: 0.3,
    marginBottom: 2,
  },
  mpcCardDesc: {
    fontSize: 11,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    lineHeight: 16,
  },
  mpcStatusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  mpcDotActive: {
    backgroundColor: '#22c55e',
  },
  mpcDotIdle: {
    backgroundColor: 'rgba(124, 58, 237, 0.4)',
  },
  enableHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: Spacing.md,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  enableHintText: {
    flex: 1,
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    lineHeight: 17,
  },
});

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
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';

import { useShieldedStore } from '@/stores/shieldedStore';
import { useConfidentialStore } from '@/stores/confidentialStore';
import { useDenominatedPoolStore } from '@/stores/denominatedPoolStore';
import { useSettingsStore } from '@/stores/settingsStore';
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
        <Text style={styles.headerTitle}>Privacy</Text>
        <View style={styles.headerRight}>
          <TouchableOpacity
            style={styles.headerButton}
            onPress={() => router.push('/(main)/(settings)')}
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
          >
            <LinearGradient
              colors={[P01Colors.cyanDim, 'rgba(57, 197, 187, 0.03)']}
              style={styles.heroGradient}
            >
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
                  <Text style={styles.statValue}>Groth16</Text>
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
                >
                  <Ionicons name="arrow-down" size={16} color={P01Colors.cyan} />
                  <Text style={[styles.quickActionText, { color: P01Colors.cyan }]}>Shield</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.quickAction, { backgroundColor: P01Colors.pinkDim }]}
                  onPress={() => router.push('/(main)/(privacy)/denominated-unshield' as any)}
                >
                  <Ionicons name="arrow-up" size={16} color={P01Colors.pink} />
                  <Text style={[styles.quickActionText, { color: P01Colors.pink }]}>Unshield</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.quickAction, { backgroundColor: 'rgba(57, 197, 187, 0.08)' }]}
                  onPress={() => router.push('/(main)/(privacy)/denominated-notes' as any)}
                >
                  <Ionicons name="receipt" size={16} color={P01Colors.cyan} />
                  <Text style={[styles.quickActionText, { color: P01Colors.cyan }]}>Notes</Text>
                </TouchableOpacity>
              </View>
              {/* Quick Actions — Row 2: Send & Receive */}
              <View style={[styles.quickActions, { marginTop: Spacing.sm }]}>
                <TouchableOpacity
                  style={[styles.quickAction, { backgroundColor: 'rgba(139, 139, 255, 0.12)' }]}
                  onPress={() => router.push('/(main)/(privacy)/denominated-transfer' as any)}
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
                >
                  <Ionicons name="download" size={16} color="#8B8BFF" />
                  <Text style={[styles.quickActionText, { color: '#8B8BFF' }]}>Receive</Text>
                </TouchableOpacity>
              </View>
            </LinearGradient>
          </TouchableOpacity>
        </Animated.View>

        {/* Explainer */}
        <Animated.View entering={FadeInUp.delay(200)}>
          <View style={styles.explainerCard}>
            <Ionicons name="information-circle-outline" size={18} color={Colors.textTertiary} />
            <Text style={styles.explainerText}>
              Privacy Pool uses Groth16 ZK-SNARKs with fixed denominations (Tornado-style) for maximum anonymity. All proofs are generated on your device — no private data leaves your phone.
            </Text>
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
            >
              <LinearGradient
                colors={['rgba(100, 100, 100, 0.08)', 'rgba(50, 50, 50, 0.03)']}
                style={styles.modeCardGradient}
              >
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
                  >
                    <Ionicons name="arrow-up" size={16} color={Colors.textSecondary} />
                    <Text style={[styles.quickActionText, { color: Colors.textSecondary }]}>Withdraw</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.quickAction, { backgroundColor: 'rgba(100,100,100,0.1)' }]}
                    onPress={() => router.push('/(main)/(privacy)/shielded-transfer')}
                  >
                    <Ionicons name="flash" size={16} color={Colors.textSecondary} />
                    <Text style={[styles.quickActionText, { color: Colors.textSecondary }]}>Transfer</Text>
                  </TouchableOpacity>
                </View>
              </LinearGradient>
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
            >
              <LinearGradient
                colors={['rgba(100, 100, 100, 0.08)', 'rgba(50, 50, 50, 0.03)']}
                style={styles.modeCardGradient}
              >
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
                  >
                    <Ionicons name="arrow-up" size={16} color={Colors.textSecondary} />
                    <Text style={[styles.quickActionText, { color: Colors.textSecondary }]}>Withdraw</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.quickAction, { backgroundColor: 'rgba(100,100,100,0.1)' }]}
                    onPress={() => router.push('/(main)/(privacy)/confidential')}
                  >
                    <Ionicons name="flash" size={16} color={Colors.textSecondary} />
                    <Text style={[styles.quickActionText, { color: Colors.textSecondary }]}>Transfer</Text>
                  </TouchableOpacity>
                </View>
              </LinearGradient>
            </TouchableOpacity>
          </Animated.View>
        )}

        {/* Enable legacy features hint (shown when both are hidden) */}
        {!showShielded && !showConfidential && (
          <Animated.View entering={FadeInUp.delay(300)}>
            <TouchableOpacity
              style={styles.enableHint}
              onPress={() => router.push('/(main)/(settings)')}
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
  container: { flex: 1, backgroundColor: Colors.background },
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
    borderRadius: BorderRadius.lg,
    overflow: 'hidden',
    marginBottom: Spacing.lg,
  },
  heroGradient: {
    borderRadius: BorderRadius.lg,
    padding: Spacing.lg,
    borderWidth: 1.5,
    borderColor: P01Colors.cyan + '40',
  },
  modeCardGradient: {
    borderRadius: BorderRadius.lg,
    padding: Spacing.lg,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  modeCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Spacing.lg,
  },
  modeIconContainer: {
    width: 48,
    height: 48,
    borderRadius: BorderRadius.md,
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
    backgroundColor: 'rgba(0,0,0,0.3)',
    borderRadius: BorderRadius.md,
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
    paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md,
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
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
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

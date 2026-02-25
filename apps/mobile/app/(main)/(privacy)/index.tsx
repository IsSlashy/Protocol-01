import React, { useState, useCallback, useEffect } from 'react';
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
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';

import PrivacySegmentedControl from '@/components/privacy/PrivacySegmentedControl';

type Segment = 'shielded' | 'confidential';

export default function PrivacyDashboard() {
  const router = useRouter();
  const [segment, setSegment] = useState<Segment>('shielded');

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

  const confidentialSolBalance = (confidentialBalances['11111111111111111111111111111111'] || 0) / 1e9;
  const pendingCount = pendingCredits['11111111111111111111111111111111'] || 0;
  const totalPrivateBalance = shieldedBalance + confidentialSolBalance;

  const isLoading = shieldedLoading || confidentialLoading;

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
        {/* Combined Private Balance Card */}
        <Animated.View entering={FadeInUp.delay(100)}>
          <LinearGradient
            colors={['#111111', '#0a0a0a']}
            style={styles.balanceCard}
          >
            <View style={styles.balanceLabel}>
              <Ionicons name="shield-half" size={20} color={P01Colors.cyan} />
              <Text style={styles.balanceLabelText}>Combined Private Balance</Text>
            </View>
            <Text style={styles.balanceAmount}>
              {totalPrivateBalance.toFixed(4)} SOL
            </Text>
            <View style={styles.balanceBreakdown}>
              <View style={styles.breakdownItem}>
                <View style={[styles.breakdownDot, { backgroundColor: P01Colors.cyan }]} />
                <Text style={styles.breakdownText}>
                  {shieldedBalance.toFixed(4)} Shielded
                </Text>
              </View>
              <View style={styles.breakdownItem}>
                <View style={[styles.breakdownDot, { backgroundColor: P01Colors.blue }]} />
                <Text style={styles.breakdownText}>
                  {confidentialSolBalance.toFixed(4)} Confidential
                </Text>
              </View>
            </View>
          </LinearGradient>
        </Animated.View>

        {/* Segmented Control */}
        <Animated.View entering={FadeInUp.delay(200)}>
          <PrivacySegmentedControl selected={segment} onChange={setSegment} />
        </Animated.View>

        {/* Shielded Segment */}
        {segment === 'shielded' && (
          <Animated.View entering={FadeInUp.delay(250)}>
            <TouchableOpacity
              style={styles.modeCard}
              onPress={() => router.push('/(main)/(privacy)/shielded')}
              activeOpacity={0.7}
            >
              <LinearGradient
                colors={[P01Colors.cyanDim, 'rgba(57, 197, 187, 0.03)']}
                style={styles.modeCardGradient}
              >
                <View style={styles.modeCardHeader}>
                  <View style={[styles.modeIconContainer, { backgroundColor: P01Colors.cyanDim }]}>
                    <Ionicons name="shield-checkmark" size={24} color={P01Colors.cyan} />
                  </View>
                  <View style={styles.modeCardInfo}>
                    <Text style={styles.modeCardTitle}>Shielded Wallet</Text>
                    <Text style={styles.modeCardSubtitle}>
                      {shieldedInitialized
                        ? `${shieldedBalance.toFixed(4)} SOL shielded`
                        : 'ZK-SNARK privacy'}
                    </Text>
                  </View>
                  <View style={styles.modeBadge}>
                    <Text style={[styles.modeBadgeText, { color: P01Colors.cyan }]}>ZK</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={20} color={P01Colors.cyan} />
                </View>

                {/* Quick Stats */}
                <View style={styles.quickStats}>
                  <View style={styles.statItem}>
                    <Text style={styles.statValue}>{notes.filter(n => Number(n.amount) > 0).length}</Text>
                    <Text style={styles.statLabel}>Notes</Text>
                  </View>
                  <View style={styles.statDivider} />
                  <View style={styles.statItem}>
                    <Text style={styles.statValue}>Groth16</Text>
                    <Text style={styles.statLabel}>Proof System</Text>
                  </View>
                  <View style={styles.statDivider} />
                  <View style={styles.statItem}>
                    <Text style={styles.statValue}>Full</Text>
                    <Text style={styles.statLabel}>Privacy</Text>
                  </View>
                </View>

                {/* Quick Actions */}
                <View style={styles.quickActions}>
                  <TouchableOpacity
                    style={[styles.quickAction, { backgroundColor: P01Colors.cyanDim }]}
                    onPress={() => router.push('/(main)/(privacy)/shielded')}
                  >
                    <Ionicons name="arrow-down" size={16} color={P01Colors.cyan} />
                    <Text style={[styles.quickActionText, { color: P01Colors.cyan }]}>Shield</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.quickAction, { backgroundColor: P01Colors.pinkDim }]}
                    onPress={() => router.push('/(main)/(privacy)/shielded')}
                  >
                    <Ionicons name="arrow-up" size={16} color={P01Colors.pink} />
                    <Text style={[styles.quickActionText, { color: P01Colors.pink }]}>Unshield</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.quickAction, { backgroundColor: P01Colors.blueDim }]}
                    onPress={() => router.push('/(main)/(privacy)/shielded-transfer')}
                  >
                    <Ionicons name="flash" size={16} color={P01Colors.blue} />
                    <Text style={[styles.quickActionText, { color: P01Colors.blue }]}>Transfer</Text>
                  </TouchableOpacity>
                </View>
              </LinearGradient>
            </TouchableOpacity>
          </Animated.View>
        )}

        {/* Confidential Segment */}
        {segment === 'confidential' && (
          <Animated.View entering={FadeInUp.delay(250)}>
            <TouchableOpacity
              style={styles.modeCard}
              onPress={() => router.push('/(main)/(privacy)/confidential')}
              activeOpacity={0.7}
            >
              <LinearGradient
                colors={[P01Colors.blueDim, 'rgba(59, 130, 246, 0.03)']}
                style={styles.modeCardGradient}
              >
                <View style={styles.modeCardHeader}>
                  <View style={[styles.modeIconContainer, { backgroundColor: P01Colors.blueDim }]}>
                    <Ionicons name="lock-closed" size={24} color={P01Colors.blue} />
                  </View>
                  <View style={styles.modeCardInfo}>
                    <Text style={styles.modeCardTitle}>Confidential Balance</Text>
                    <Text style={styles.modeCardSubtitle}>
                      {confidentialInitialized
                        ? `${confidentialSolBalance.toFixed(4)} SOL confidential`
                        : 'Quantum-resistant privacy'}
                    </Text>
                  </View>
                  <View style={[styles.modeBadge, { backgroundColor: P01Colors.blueDim }]}>
                    <Text style={[styles.modeBadgeText, { color: P01Colors.blue }]}>zkSPL</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={20} color={P01Colors.blue} />
                </View>

                {/* Quick Stats */}
                <View style={styles.quickStats}>
                  <View style={styles.statItem}>
                    <Text style={styles.statValue}>{pendingCount}</Text>
                    <Text style={styles.statLabel}>Pending</Text>
                  </View>
                  <View style={styles.statDivider} />
                  <View style={styles.statItem}>
                    <Text style={styles.statValue}>Poseidon</Text>
                    <Text style={styles.statLabel}>Hash</Text>
                  </View>
                  <View style={styles.statDivider} />
                  <View style={styles.statItem}>
                    <Text style={styles.statValue}>QR</Text>
                    <Text style={styles.statLabel}>Quantum-Safe</Text>
                  </View>
                </View>

                {/* Quick Actions */}
                <View style={styles.quickActions}>
                  <TouchableOpacity
                    style={[styles.quickAction, { backgroundColor: P01Colors.cyanDim }]}
                    onPress={() => router.push('/(main)/(privacy)/confidential')}
                  >
                    <Ionicons name="arrow-down" size={16} color={P01Colors.cyan} />
                    <Text style={[styles.quickActionText, { color: P01Colors.cyan }]}>Deposit</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.quickAction, { backgroundColor: P01Colors.pinkDim }]}
                    onPress={() => router.push('/(main)/(privacy)/confidential')}
                  >
                    <Ionicons name="arrow-up" size={16} color={P01Colors.pink} />
                    <Text style={[styles.quickActionText, { color: P01Colors.pink }]}>Withdraw</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.quickAction, { backgroundColor: P01Colors.blueDim }]}
                    onPress={() => router.push('/(main)/(privacy)/confidential')}
                  >
                    <Ionicons name="flash" size={16} color={P01Colors.blue} />
                    <Text style={[styles.quickActionText, { color: P01Colors.blue }]}>Transfer</Text>
                  </TouchableOpacity>
                </View>
              </LinearGradient>
            </TouchableOpacity>
          </Animated.View>
        )}

        {/* Privacy Explainer */}
        <Animated.View entering={FadeInUp.delay(350)}>
          <View style={styles.explainerCard}>
            <Ionicons name="information-circle-outline" size={18} color={Colors.textTertiary} />
            <Text style={styles.explainerText}>
              {segment === 'shielded'
                ? 'Shielded Wallet uses Groth16 ZK-SNARKs (Zcash-style) to hide amounts, senders, and recipients completely.'
                : 'Confidential Balance uses Poseidon hash commitments (quantum-resistant) for account-based private token operations.'}
            </Text>
          </View>
        </Animated.View>
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
  scrollView: { flex: 1 },
  scrollContent: {
    paddingHorizontal: Spacing.xl,
    paddingBottom: 120,
  },
  balanceCard: {
    borderRadius: BorderRadius.xl,
    padding: Spacing.xl,
    marginBottom: Spacing.lg,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  balanceLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: Spacing.md,
  },
  balanceLabelText: {
    fontSize: 14,
    fontFamily: FontFamily.medium,
    color: Colors.textSecondary,
  },
  balanceAmount: {
    fontSize: 32,
    fontFamily: FontFamily.bold,
    color: Colors.text,
    marginBottom: Spacing.md,
  },
  balanceBreakdown: {
    flexDirection: 'row',
    gap: Spacing.lg,
  },
  breakdownItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  breakdownDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  breakdownText: {
    fontSize: 13,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
  },
  modeCard: {
    borderRadius: BorderRadius.lg,
    overflow: 'hidden',
    marginBottom: Spacing.lg,
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
  modeBadge: {
    backgroundColor: P01Colors.cyanDim,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    marginRight: Spacing.sm,
  },
  modeBadgeText: {
    fontSize: 10,
    fontFamily: FontFamily.mono,
    fontWeight: '600',
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
  explainerCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
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
});

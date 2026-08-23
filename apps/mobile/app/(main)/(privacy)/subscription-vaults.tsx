/**
 * Subscription vaults — the on-chain side of what the Subs tab lists.
 *
 * 🎯 RESTYLED ON THE REALIGNED THEME 2026-08-23.
 *   - the summary was a `LinearGradient` from `#111111` to `#0a0a0a`, two
 *     greys from a palette the brand does not use, hardcoded here so the theme
 *     sweep could not reach them. It is a flat row of four counts now.
 *   - the vault icon, the add button, the "Ended" badge and the pull-to-refresh
 *     spinner were pink. Pink is retired; there is one accent.
 *   - the "Private" button in the empty state was `#3b82f6`, a blue that
 *     appears nowhere else in the product.
 *   - the status badges were monospace. Mono is for addresses, hashes and
 *     amounts; a word is not data.
 *
 * ⚠️ `statusBadge` still reads `entitlementStatus`, never `info.isActive`. The
 * program writes that `true` at subscribe and `false` NOWHERE.
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  StyleSheet,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';

import { useSubscriptionVaultStore, type StoredVaultInfo } from '@/stores/subscriptionVaultStore';
import { entitlementStatus, type VaultInfo } from '@/services/subscriptionVault';
import { Badge } from '@/components/ui';
import {
  Colors,
  FontFamily,
  FontSize,
  BorderRadius,
  Spacing,
  Layout,
} from '@/constants/theme';
import { getConnection } from '@/services/solana/connection';

export default function SubscriptionVaultsScreen() {
  const router = useRouter();
  const [currentSlot, setCurrentSlot] = useState<number | null>(null);
  const [vaultInfos, setVaultInfos] = useState<Record<string, VaultInfo>>({});
  const [refreshing, setRefreshing] = useState(false);

  const { vaults, refreshVault, recoverOrphanedVaults } = useSubscriptionVaultStore();
  const [recovering, setRecovering] = useState(false);

  const handleRecover = useCallback(async () => {
    if (recovering) return;
    setRecovering(true);
    try {
      const { recovered, scanned } = await recoverOrphanedVaults();
      Alert.alert(
        'Recovery scan complete',
        recovered > 0
          ? `Recovered ${recovered} subscription${recovered === 1 ? '' : 's'} from ${scanned} on-chain account${scanned === 1 ? '' : 's'}.`
          : `Scanned ${scanned} vault${scanned === 1 ? '' : 's'} on-chain. No orphaned subscriptions found that match your notes.`
      );
    } catch (err) {
      Alert.alert('Recovery failed', (err as Error).message);
    } finally {
      setRecovering(false);
    }
  }, [recovering, recoverOrphanedVaults]);

  useEffect(() => {
    const init = async () => {
      const conn = getConnection();
      const slot = await conn.getSlot('confirmed');
      setCurrentSlot(slot);
    };
    init();

    const interval = setInterval(async () => {
      try {
        const conn = getConnection();
        const slot = await conn.getSlot('confirmed');
        setCurrentSlot(slot);
      } catch {}
    }, 30_000);

    return () => clearInterval(interval);
  }, []);

  const loadVaultInfos = useCallback(async () => {
    const infos: Record<string, VaultInfo> = {};
    for (const vault of vaults) {
      const info = await refreshVault(vault.vaultAddress);
      if (info) {
        infos[vault.vaultAddress] = info;
      }
    }
    setVaultInfos(infos);
  }, [vaults, refreshVault]);

  useEffect(() => {
    loadVaultInfos();
  }, [loadVaultInfos]);

  const onRefresh = useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setRefreshing(true);
    await loadVaultInfos();
    setRefreshing(false);
  }, [loadVaultInfos]);

  const handleVaultTap = (vault: StoredVaultInfo) => {
    router.push({
      pathname: '/(main)/(privacy)/vault-detail' as any,
      params: { vaultAddress: vault.vaultAddress },
    });
  };

  /**
   * Never derive this badge from `info.isActive`. The program writes that
   * `true` at subscribe and `false` NOWHERE, so a subscription that has spent
   * every period it paid for still reports `true` and used to render "Active".
   * `entitlementStatus` answers the question the badge is actually asking, and
   * returns 'unknown' rather than the optimistic answer when the slot poll has
   * not landed yet.
   */
  const statusBadge = (vault: StoredVaultInfo, info: VaultInfo | undefined) => {
    if (!info) {
      return <Badge variant="neutral" size="sm">Loading</Badge>;
    }

    switch (entitlementStatus(info, currentSlot ?? 0)) {
      case 'inactive':
        return <Badge variant="neutral" size="sm">Inactive</Badge>;
      case 'paused':
        return <Badge variant="warn" size="sm">Paused</Badge>;
      case 'unknown':
        return <Badge variant="neutral" size="sm">Checking</Badge>;
      case 'ended':
        return <Badge variant="neutral" size="sm">Ended</Badge>;
      default:
        return <Badge variant="good" size="sm">Active</Badge>;
    }
  };

  const renderVault = (vault: StoredVaultInfo, index: number) => {
    const info = vaultInfos[vault.vaultAddress];

    return (
      <Animated.View key={vault.vaultAddress} entering={FadeInUp.delay(80 + index * 50)}>
        <TouchableOpacity
          style={styles.vaultCard}
          onPress={() => handleVaultTap(vault)}
          activeOpacity={0.75}
          accessibilityRole="button"
          accessibilityLabel={`Subscription to ${vault.retailer.slice(0, 8)}`}
        >
          <View style={styles.vaultHeader}>
            <View style={styles.vaultLeft}>
              <View style={styles.vaultIcon}>
                <Ionicons name="repeat" size={18} color={Colors.primary} />
              </View>
              <View style={styles.vaultTitleWrap}>
                <Text style={styles.vaultTitle} numberOfLines={1}>
                  {vault.isPrivateMode ? 'Private subscription' : 'Subscription'}
                </Text>
                <Text style={styles.vaultSubtitle} numberOfLines={1}>
                  {vault.retailer.slice(0, 8)}…
                </Text>
              </View>
            </View>
            {statusBadge(vault, info)}
          </View>

          <View style={styles.vaultDetail}>
            <Text style={styles.vaultDetailLabel}>Rate</Text>
            <Text style={styles.vaultDetailValue}>
              {info ? `${Number(info.rate) / 1e9} SOL` : '—'}
            </Text>
          </View>

          <View style={styles.vaultDetail}>
            <Text style={styles.vaultDetailLabel}>Interval</Text>
            <Text style={styles.vaultDetailValue}>
              {info ? `${Number(info.intervalSlots)} slots` : '—'}
            </Text>
          </View>

          {info && currentSlot && (
            <>
              <View style={styles.vaultDetail}>
                <Text style={styles.vaultDetailLabel}>Claimed periods</Text>
                <Text style={styles.vaultDetailValue}>{Number(info.claimedPeriods)}</Text>
              </View>
              <View style={styles.vaultDetail}>
                <Text style={styles.vaultDetailLabel}>Total deposited</Text>
                <Text style={styles.vaultDetailValue}>
                  {(Number(info.totalDeposited) / 1e9).toFixed(3)} SOL
                </Text>
              </View>
            </>
          )}
        </TouchableOpacity>
      </Animated.View>
    );
  };

  const recoverControl = (
    <TouchableOpacity
      style={styles.recoverBtn}
      onPress={handleRecover}
      disabled={recovering}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel="Scan the chain for subscriptions this device has lost"
      accessibilityState={{ disabled: recovering, busy: recovering }}
    >
      <Ionicons
        name={recovering ? 'sync' : 'cloud-download-outline'}
        size={14}
        color={Colors.textSecondary}
      />
      <Text style={styles.recoverBtnText}>
        {recovering ? 'Scanning on-chain…' : 'Scan for orphaned subscriptions'}
      </Text>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* ── Header ── */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.iconBtn}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="chevron-back" size={22} color={Colors.textSecondary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>Vaults</Text>
        <TouchableOpacity
          onPress={() => router.push('/(main)/(privacy)/subscribe-private' as any)}
          style={styles.iconBtn}
          accessibilityRole="button"
          accessibilityLabel="Open a new private subscription"
        >
          <Ionicons name="add" size={22} color={Colors.primary} />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />
        }
      >
        {/* ── Four counts, flat. A gradient behind a number is decoration. ── */}
        {vaults.length > 0 && (
          <Animated.View entering={FadeInDown.delay(40)} style={styles.summaryRow}>
            <SummaryItem label="Total" value={vaults.length} />
            <View style={styles.summaryDivider} />
            <SummaryItem
              label="Active"
              accent
              value={
                Object.values(vaultInfos).filter(
                  (v) => v && entitlementStatus(v, currentSlot ?? 0) === 'current',
                ).length
              }
            />
            <View style={styles.summaryDivider} />
            <SummaryItem
              label="Paused"
              value={Object.values(vaultInfos).filter(v => v?.isPaused).length}
            />
            <View style={styles.summaryDivider} />
            <SummaryItem
              label="Ended"
              value={
                Object.values(vaultInfos).filter(
                  (v) => v && entitlementStatus(v, currentSlot ?? 0) === 'ended',
                ).length
              }
            />
          </Animated.View>
        )}

        {/* ── Empty ── */}
        {vaults.length === 0 && (
          <Animated.View entering={FadeInUp.delay(80)} style={styles.empty}>
            <Ionicons name="repeat-outline" size={28} color={Colors.textTertiary} />
            <Text style={styles.emptyTitle}>No vaults yet</Text>
            <Text style={styles.emptyText}>
              A vault is what a recurring subscription lives in. Open one with a shielded
              note and it appears here.
            </Text>
            {/* Wallet-based ("Normal") subscribe is gone: its vault address was
                derived from the subscriber's wallet, so the subscription was
                publicly linkable to that wallet. Private is the only mode. */}
            <TouchableOpacity
              style={styles.emptyAction}
              onPress={() => router.push('/(main)/(privacy)/subscribe-private' as any)}
              activeOpacity={0.85}
              accessibilityRole="button"
            >
              <Ionicons name="lock-closed" size={18} color={Colors.background} />
              <Text style={styles.emptyActionText}>Open a private subscription</Text>
            </TouchableOpacity>
            {recoverControl}
          </Animated.View>
        )}

        {/* ── The vaults ── */}
        {vaults.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>My subscriptions</Text>
            {vaults.map((vault, i) => renderVault(vault, i))}
            {recoverControl}
          </>
        )}

        {/* ── What a vault is, and what it is not ── */}
        <Animated.View entering={FadeInUp.delay(320)} style={styles.explainer}>
          <Ionicons name="information-circle-outline" size={16} color={Colors.textTertiary} />
          <Text style={styles.explainerText}>
            A vault pays a retailer one period at a time and lets you pause and resume
            whenever you like. It cannot be cancelled and nothing in it can be refunded —
            every lamport goes to the retailer.
          </Text>
        </Animated.View>
      </ScrollView>
    </SafeAreaView>
  );
}

function SummaryItem({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <View style={styles.summaryItem}>
      <Text style={[styles.summaryValue, accent && styles.summaryValueAccent]}>{value}</Text>
      <Text style={styles.summaryLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  scrollView: { flex: 1 },
  scrollContent: {
    paddingHorizontal: Layout.screenPadding,
    paddingBottom: Layout.tabBarTotalHeight + Spacing['4xl'],
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingBottom: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.borderSoft,
  },
  iconBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    flex: 1,
    fontFamily: FontFamily.displayMedium,
    fontSize: FontSize.xl,
    color: Colors.text,
  },

  // Summary
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.xl,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.borderSoft,
    marginBottom: Spacing.xl,
  },
  summaryItem: { flex: 1, alignItems: 'center', gap: 2 },
  summaryValue: {
    fontFamily: FontFamily.displayMedium,
    fontSize: FontSize.xl,
    color: Colors.text,
  },
  summaryValueAccent: { color: Colors.primary },
  summaryLabel: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    color: Colors.textTertiary,
  },
  summaryDivider: {
    width: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
    backgroundColor: Colors.borderSoft,
  },

  // Empty
  empty: {
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing['5xl'],
  },
  emptyTitle: {
    fontFamily: FontFamily.display,
    fontSize: FontSize['2xl'],
    color: Colors.text,
  },
  emptyText: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.md,
    lineHeight: 22,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
  emptyAction: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    alignSelf: 'stretch',
    minHeight: 52,
    marginTop: Spacing.lg,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.primary,
  },
  emptyActionText: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.md,
    color: Colors.background,
  },

  // Recovery
  recoverBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    minHeight: 44,
    marginTop: Spacing.lg,
    paddingHorizontal: Spacing.lg,
    borderRadius: BorderRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  recoverBtnText: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },

  sectionTitle: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginBottom: Spacing.md,
  },

  // Vault card
  vaultCard: {
    padding: Spacing.lg,
    marginBottom: Spacing.md,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  vaultHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: Spacing.md,
    marginBottom: Spacing.md,
  },
  vaultLeft: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  vaultIcon: {
    width: 36,
    height: 36,
    borderRadius: BorderRadius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.primaryDim,
  },
  vaultTitleWrap: { flex: 1, minWidth: 0 },
  vaultTitle: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.md,
    color: Colors.text,
  },
  vaultSubtitle: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.xs,
    color: Colors.textTertiary,
    marginTop: 2,
  },
  vaultDetail: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: Spacing.md,
    paddingVertical: 4,
  },
  vaultDetailLabel: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textTertiary,
  },
  vaultDetailValue: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },

  // Explainer
  explainer: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.md,
    marginTop: Spacing['2xl'],
    padding: Spacing.lg,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.surfaceSecondary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSoft,
  },
  explainerText: {
    flex: 1,
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    lineHeight: 19,
    color: Colors.textTertiary,
  },
});

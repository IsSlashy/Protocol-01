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
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';

import { useSubscriptionVaultStore, type StoredVaultInfo } from '@/stores/subscriptionVaultStore';
import { type VaultInfo } from '@/services/subscriptionVault';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
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

  const statusBadge = (vault: StoredVaultInfo, info: VaultInfo | undefined) => {
    if (!info) {
      return (
        <View style={[styles.statusBadge, { borderColor: Colors.textTertiary }]}>
          <Text style={[styles.statusText, { color: Colors.textTertiary }]}>Loading</Text>
        </View>
      );
    }

    if (!info.isActive) {
      return (
        <View style={[styles.statusBadge, { borderColor: Colors.textTertiary }]}>
          <Text style={[styles.statusText, { color: Colors.textTertiary }]}>Cancelled</Text>
        </View>
      );
    }

    if (info.isPaused) {
      return (
        <View style={[styles.statusBadge, { borderColor: P01Colors.yellow }]}>
          <Text style={[styles.statusText, { color: P01Colors.yellow }]}>Paused</Text>
        </View>
      );
    }

    return (
      <View style={[styles.statusBadge, { borderColor: P01Colors.cyan }]}>
        <Text style={[styles.statusText, { color: P01Colors.cyan }]}>Active</Text>
      </View>
    );
  };

  const renderVault = (vault: StoredVaultInfo, index: number) => {
    const info = vaultInfos[vault.vaultAddress];

    return (
      <Animated.View key={vault.vaultAddress} entering={FadeInUp.delay(100 + index * 60)}>
        <TouchableOpacity style={styles.vaultCard} onPress={() => handleVaultTap(vault)}>
          <View style={styles.vaultHeader}>
            <View style={styles.vaultLeft}>
              <View style={[styles.vaultIcon, { backgroundColor: P01Colors.pinkDim }]}>
                <Ionicons name="card-outline" size={20} color={P01Colors.pink} />
              </View>
              <View>
                <Text style={styles.vaultTitle}>
                  {vault.isPrivateMode ? 'Private' : 'Normal'} Subscription
                </Text>
                <Text style={styles.vaultSubtitle}>
                  {vault.retailer.slice(0, 8)}...
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
                <Text style={styles.vaultDetailLabel}>Claimed Periods</Text>
                <Text style={styles.vaultDetailValue}>
                  {Number(info.claimedPeriods)}
                </Text>
              </View>
              <View style={styles.vaultDetail}>
                <Text style={styles.vaultDetailLabel}>Total Deposited</Text>
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

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={22} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Subscriptions</Text>
        <TouchableOpacity
          onPress={() => router.push('/(main)/(privacy)/subscribe-normal' as any)}
          style={styles.addBtn}
        >
          <Ionicons name="add" size={22} color={P01Colors.pink} />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={P01Colors.pink} />
        }
      >
        {/* Summary Card */}
        {vaults.length > 0 && (
          <Animated.View entering={FadeInDown.delay(50)}>
            <LinearGradient
              colors={['#111111', '#0a0a0a']}
              style={styles.summaryCard}
            >
              <View style={styles.summaryRow}>
                <View style={styles.summaryItem}>
                  <Text style={styles.summaryValue}>{vaults.length}</Text>
                  <Text style={styles.summaryLabel}>Total</Text>
                </View>
                <View style={styles.summaryDivider} />
                <View style={styles.summaryItem}>
                  <Text style={[styles.summaryValue, { color: P01Colors.cyan }]}>
                    {Object.values(vaultInfos).filter(v => v?.isActive && !v?.isPaused).length}
                  </Text>
                  <Text style={styles.summaryLabel}>Active</Text>
                </View>
                <View style={styles.summaryDivider} />
                <View style={styles.summaryItem}>
                  <Text style={[styles.summaryValue, { color: P01Colors.yellow }]}>
                    {Object.values(vaultInfos).filter(v => v?.isPaused).length}
                  </Text>
                  <Text style={styles.summaryLabel}>Paused</Text>
                </View>
              </View>
            </LinearGradient>
          </Animated.View>
        )}

        {/* Empty State */}
        {vaults.length === 0 && (
          <Animated.View entering={FadeInUp.delay(100)}>
            <View style={styles.emptyCard}>
              <Ionicons name="card-outline" size={48} color={Colors.textTertiary} />
              <Text style={styles.emptyTitle}>No Subscriptions Yet</Text>
              <Text style={styles.emptyText}>
                Create a subscription vault to send recurring payments to a retailer.
              </Text>
              <View style={styles.emptyActions}>
                <TouchableOpacity
                  style={styles.emptyAction}
                  onPress={() => router.push('/(main)/(privacy)/subscribe-normal' as any)}
                >
                  <Ionicons name="add" size={18} color="#000" />
                  <Text style={styles.emptyActionText}>Normal</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.emptyAction, { backgroundColor: '#8B8BFF' }]}
                  onPress={() => router.push('/(main)/(privacy)/subscribe-private' as any)}
                >
                  <Ionicons name="shield-checkmark" size={18} color="#000" />
                  <Text style={styles.emptyActionText}>Private</Text>
                </TouchableOpacity>
              </View>
              <TouchableOpacity
                style={styles.recoverBtn}
                onPress={handleRecover}
                disabled={recovering}
                accessibilityRole="button"
              >
                <Ionicons name={recovering ? 'sync' : 'cloud-download-outline'} size={14} color={P01Colors.cyan} />
                <Text style={styles.recoverBtnText}>
                  {recovering ? 'Scanning on-chain…' : 'Scan for orphaned subscriptions'}
                </Text>
              </TouchableOpacity>
            </View>
          </Animated.View>
        )}

        {/* Vaults List */}
        {vaults.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>My Subscriptions</Text>
            {vaults.map((vault, i) => renderVault(vault, i))}
            <TouchableOpacity
              style={styles.recoverBtn}
              onPress={handleRecover}
              disabled={recovering}
              accessibilityRole="button"
            >
              <Ionicons name={recovering ? 'sync' : 'cloud-download-outline'} size={14} color={P01Colors.cyan} />
              <Text style={styles.recoverBtnText}>
                {recovering ? 'Scanning on-chain…' : 'Scan for orphaned subscriptions'}
              </Text>
            </TouchableOpacity>
          </>
        )}

        {/* Explainer */}
        <Animated.View entering={FadeInUp.delay(400)}>
          <View style={styles.explainer}>
            <Ionicons name="information-circle-outline" size={16} color={Colors.textTertiary} />
            <Text style={styles.explainerText}>
              Subscription vaults enable recurring payments. Retailers can claim accumulated
              periods. You can pause or cancel anytime.
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
  addBtn: {
    width: 36, height: 36, borderRadius: 9999,
    backgroundColor: P01Colors.pinkDim,
    justifyContent: 'center', alignItems: 'center',
  },
  scrollView: { flex: 1 },
  scrollContent: {
    paddingHorizontal: Spacing.xl,
    paddingBottom: 120,
  },
  summaryCard: {
    borderRadius: BorderRadius.xl,
    padding: Spacing.xl,
    marginBottom: Spacing.lg,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  summaryRow: {
    flexDirection: 'row',
  },
  summaryItem: {
    flex: 1,
    alignItems: 'center',
  },
  summaryValue: {
    fontSize: 20,
    fontFamily: FontFamily.bold,
    color: Colors.text,
  },
  summaryLabel: {
    fontSize: 11,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    marginTop: 2,
  },
  summaryDivider: {
    width: 1,
    backgroundColor: Colors.border,
    marginHorizontal: 4,
  },
  emptyCard: {
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing['3xl'],
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    borderColor: Colors.border,
    marginTop: Spacing['3xl'],
  },
  emptyTitle: {
    fontSize: 18,
    fontFamily: FontFamily.bold,
    color: Colors.text,
  },
  emptyText: {
    fontSize: 14,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  },
  emptyActions: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginTop: Spacing.sm,
  },
  emptyAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: BorderRadius.md,
    backgroundColor: P01Colors.pink,
  },
  emptyActionText: {
    fontSize: 14,
    fontFamily: FontFamily.bold,
    color: '#000',
  },
  recoverBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: Spacing.md,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: BorderRadius.md,
    borderWidth: 1,
    borderColor: `${P01Colors.cyan}40`,
    backgroundColor: `${P01Colors.cyan}10`,
  },
  recoverBtnText: {
    fontSize: 12,
    fontFamily: FontFamily.semibold,
    color: P01Colors.cyan,
  },
  sectionTitle: {
    fontSize: 15,
    fontFamily: FontFamily.semibold,
    color: Colors.textSecondary,
    marginBottom: Spacing.md,
  },
  vaultCard: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    padding: Spacing.lg,
    marginBottom: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  vaultHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.md,
  },
  vaultLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  vaultIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
  },
  vaultTitle: {
    fontSize: 16,
    fontFamily: FontFamily.bold,
    color: Colors.text,
  },
  vaultSubtitle: {
    fontSize: 12,
    fontFamily: FontFamily.mono,
    color: Colors.textTertiary,
    marginTop: 2,
  },
  statusBadge: {
    borderWidth: 1,
    borderRadius: BorderRadius.sm,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  statusText: {
    fontSize: 11,
    fontFamily: FontFamily.mono,
  },
  vaultDetail: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  vaultDetailLabel: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
  },
  vaultDetailValue: {
    fontSize: 12,
    fontFamily: FontFamily.mono,
    color: Colors.textSecondary,
  },
  explainer: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginTop: Spacing.xl,
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

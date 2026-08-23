/**
 * Subs: the merchant subscriptions you already pay for.
 *
 * 🎯 WHAT THIS SCREEN STOPPED BEING, 2026-08-23
 * ─────────────────────────────────────────────
 * It was two products behind one segmented control. "Personal" created a
 * payment stream to a person — salary, allowance, rent — and "Services" browsed
 * the on-chain merchant registry. Founder ruling: merchant subscriptions ARE
 * the product, personal payments are parked, and browsing merchants is the new
 * Discover tab's whole job.
 *
 * So this screen answers exactly one question now: what am I paying for, and
 * when does the next one land. A list of my subscriptions, and nothing else.
 *
 * ⛔ THE THINGS DELETED HERE ARE DELETED ON PURPOSE, not moved:
 *   - the personal/services toggle, and the "New Payment Stream" button under
 *     it, which was the entry point to the parked feature
 *   - the merchant list, which is `app/(main)/(discover)` and would otherwise
 *     be maintained in two places that disagree
 *   - the "Private Balance / Shield more" mini-card, which carried no decision
 *     this screen makes. It is the Shield tab's headline, in full, one tap away.
 *
 * ⚠️ `handleSync` is untouched. It is the only way a subscription comes back
 * after a wipe, and it does two unrelated recoveries (memo scan + vault PDA
 * scan) that both have to run.
 */

import React, { useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  InteractionManager,
  StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { useStreamStore } from '../../../stores/streamStore';
import { useWalletStore } from '../../../stores/walletStore';
import { useSubscriptionVaultStore } from '../../../stores/subscriptionVaultStore';
import { useStarkProver } from '../../../providers/StarkProverProvider';
import { Stream, formatFrequency, upsertStreamFromVault } from '../../../services/solana/streams';
import { readCachedServices } from '../../../services/solana/serviceRegistry';
import { EmptyState } from '@/components/common';
import { Badge } from '@/components/ui';
import {
  Colors,
  FontFamily,
  FontSize,
  BorderRadius,
  Spacing,
  Layout,
} from '@/constants/theme';
import { p01Alert } from '@/stores/alertStore';
import { useT } from '@/i18n';

export default function StreamsDashboard() {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const { publicKey } = useWalletStore();
  const {
    streams, stats, loading, refreshing, syncing,
    initialize, refresh, syncFromChain,
  } = useStreamStore();
  const recoverOrphanedVaults = useSubscriptionVaultStore(s => s.recoverOrphanedVaults);
  const { isReady: starkReady, computeCommitment } = useStarkProver();

  useEffect(() => {
    initialize(publicKey || undefined);
    // Auto-sync on mount: pull memo-tagged streams from chain history so
    // subscriptions reappear after wipe + re-login without requiring a
    // manual pull-to-refresh. Silent (no UI feedback) — pull-to-refresh
    // remains the user-initiated path for explicit re-sync.
    if (publicKey) {
      refresh(publicKey).catch((e) => console.warn('[Streams] auto-sync on mount failed:', (e as Error).message));
    }
  }, [publicKey]);

  // Auto-process due payments on focus
  const isProcessingRef = useRef(false);
  useFocusEffect(
    useCallback(() => {
      const handle = InteractionManager.runAfterInteractions(async () => {
        if (isProcessingRef.current) return;
        isProcessingRef.current = true;
        try {
          const { processAllDuePayments } = useStreamStore.getState();
          await processAllDuePayments();
          // Then ask the chain what is actually still alive. Status used to be
          // purely local, so a vault closed on chain kept its green card
          // indefinitely — MEASURED on the Disney+ subscription, cancelled at
          // slot 481,031,335 and still displaying as active. Since the
          // 2026-08-04 redeploy the final claim CLOSES the vault, so this is
          // now the normal way every subscription ends, not an edge case.
          const { reconcileStreamsWithChain } = await import('../../../services/solana/streams');
          const r = await reconcileStreamsWithChain();
          if (r.changed > 0) await refresh(publicKey || undefined);
        } catch {} finally { isProcessingRef.current = false; }
      });
      return () => handle.cancel();
    }, [publicKey, refresh])
  );

  const onRefresh = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await refresh(publicKey || undefined);
  };

  const handleSync = async () => {
    if (!publicKey) return p01Alert(t('alerts.walletRequired'), t('alerts.walletRequiredDesc'));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    let walletNew = 0;
    let walletUpdated = 0;
    let vaultRecovered = 0;
    try {
      // (1) Wallet classic subscriptions via memo-scan of tx history
      const r = await syncFromChain(publicKey);
      walletNew = r.newStreams;
      walletUpdated = r.updatedStreams;
    } catch (err) {
      console.warn('[Streams] memo sync failed:', (err as Error).message);
    }
    try {
      // (2) zk-vault subscriptions via SubscriptionVault PDA scan. Requires the
      // STARK prover (Goldilocks commitment); silently skipped if not ready.
      const starkFn = starkReady ? computeCommitment : undefined;
      const { newVaults } = await recoverOrphanedVaults(starkFn);
      if (newVaults.length > 0) {
        const services = await readCachedServices().catch(() => []);
        const retailerToName = new Map<string, string>();
        for (const s of services) retailerToName.set(s.retailer.toBase58(), s.name);
        for (const vault of newVaults) {
          const retailerName = retailerToName.get(vault.retailer);
          const created = await upsertStreamFromVault(vault, { retailerName });
          if (created) vaultRecovered += 1;
        }
        await refresh(publicKey || undefined).catch(() => {});
      }
    } catch (err) {
      console.warn('[Streams] vault recovery failed:', (err as Error).message);
    }
    const totalNew = walletNew + vaultRecovered;
    if (totalNew > 0 || walletUpdated > 0) {
      const parts: string[] = [];
      if (totalNew > 0) parts.push(`${totalNew} recovered`);
      if (walletUpdated > 0) parts.push(`${walletUpdated} updated`);
      p01Alert(t('alerts.syncComplete'), parts.join(', '));
    } else {
      p01Alert(t('alerts.syncComplete'), 'Nothing to recover — your state matches the chain.');
    }
  };

  // ⚠️ ONE list. It used to be split by "is this name in the registry", which
  // put a subscription in a different tab depending on a string match against a
  // merchant name — so renaming a service moved somebody's subscription.
  const subscriptions = streams
    .filter(s => s.status !== 'cancelled' && s.status !== 'completed')
    .sort((a, b) => a.nextPaymentDate - b.nextPaymentDate);

  const activeCount = subscriptions.filter(s => s.status === 'active').length;
  const nextDue = activeCount > 0
    ? Math.min(...subscriptions.filter(s => s.status === 'active').map(s => s.nextPaymentDate))
    : null;

  return (
    <View style={st.container}>
      <ScrollView
        style={st.flex}
        contentContainerStyle={{
          paddingTop: insets.top + Spacing.sm,
          paddingBottom: Layout.tabBarTotalHeight + insets.bottom + Spacing['2xl'],
        }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />
        }
      >
        {/* ── Header ── */}
        <View style={st.header}>
          <Text style={st.title}>Subscriptions</Text>
          <TouchableOpacity
            onPress={handleSync}
            disabled={syncing}
            style={st.syncBtn}
            accessibilityRole="button"
            accessibilityLabel="Recover subscriptions from chain"
            accessibilityState={{ disabled: syncing, busy: syncing }}
          >
            {syncing
              ? <ActivityIndicator size="small" color={Colors.primary} />
              : <Ionicons name="cloud-download-outline" size={20} color={Colors.textSecondary} />}
          </TouchableOpacity>
        </View>

        {/* ── What this costs you, per month ──
            The one number worth setting large. No card around it: a panel
            border here would be decoration around a headline. */}
        {subscriptions.length > 0 && (
          <Animated.View entering={FadeIn.duration(250)} style={st.pad}>
            <Text style={st.eyebrow}>{t('streams.monthlyOutflow')}</Text>
            <View style={st.amountRow}>
              <Text style={st.amount}>{stats.monthlyOutflow.toFixed(2)}</Text>
              <Text style={st.amountUnit}>SOL</Text>
            </View>
            <Text style={st.summarySub}>
              {t('streams.activeStreams', { count: activeCount })}
              {nextDue
                ? ` · ${t('streams.nextPayment', { date: new Date(nextDue).toLocaleDateString() })}`
                : ''}
            </Text>
          </Animated.View>
        )}

        {/* ── My subscriptions ── */}
        <View style={[st.pad, st.list]}>
          {loading && subscriptions.length === 0 ? (
            <ActivityIndicator size="large" color={Colors.primary} style={st.loader} />
          ) : subscriptions.length === 0 ? (
            /* An empty state that does not say what to do next is a dead end,
               and the next thing is on another tab.
               ⚠️ The wrapper is load-bearing: `EmptyState` is `flex: 1`, and a
               flex child inside a ScrollView's content view has no height to
               fill, so without a minHeight it renders as nothing at all. */
            <View style={st.emptyWrap}>
              <EmptyState
                icon="repeat-outline"
                title="Nothing subscribed yet"
                description="Subscriptions you open with a merchant appear here, with the date of the next payment."
                actionLabel="Browse merchants"
                onAction={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                  router.push('/(main)/(discover)' as any);
                }}
              />
            </View>
          ) : (
            subscriptions.map((s, i) => (
              <SubscriptionRow
                key={s.id}
                stream={s}
                index={i}
                onPress={() => router.push({ pathname: '/(main)/(streams)/[id]', params: { id: s.id } })}
              />
            ))
          )}
        </View>
      </ScrollView>
    </View>
  );
}

// ─── One subscription ────────────────────────────────────────────────────────

function SubscriptionRow({ stream: s, index, onPress }: {
  stream: Stream; index: number; onPress: () => void;
}) {
  const t = useT();
  const isActive = s.status === 'active';
  const isPaused = s.status === 'paused';
  const daysUntil = Math.ceil((s.nextPaymentDate - Date.now()) / 86_400_000);
  const statusText = isPaused
    ? t('common.paused')
    : daysUntil <= 0
      ? t('streams.dueNow')
      : daysUntil === 1
        ? t('streams.dueTomorrow')
        : t('streams.daysLeft', { count: daysUntil });

  return (
    <Animated.View entering={FadeInDown.delay(index * 40).duration(250)}>
      <TouchableOpacity
        onPress={onPress}
        activeOpacity={0.7}
        style={st.row}
        accessibilityRole="button"
        accessibilityLabel={`${s.name}, ${statusText}`}
      >
        <View style={[st.rowMark, isActive && st.rowMarkActive]}>
          <Text style={[st.rowInitial, isActive && st.rowInitialActive]}>
            {s.name.slice(0, 1).toUpperCase()}
          </Text>
        </View>

        <View style={st.rowBody}>
          <Text
            style={[st.rowName, !isActive && st.rowNameQuiet]}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {s.name}
          </Text>
          <View style={st.rowMeta}>
            {isPaused && <Badge variant="warn" size="sm">{t('common.paused')}</Badge>}
            {/* ⚠️ "Private" is the accurate word and the modest one: the money
                comes from a shielded note, but the wallet still signs. */}
            {isActive && (s.useZkPool || s.useStealthAddress) && (
              <Badge variant="good" size="sm">Private</Badge>
            )}
            {!isPaused && (
              <Text style={st.rowSub} numberOfLines={1}>{statusText}</Text>
            )}
          </View>
        </View>

        <View style={st.rowAmountWrap}>
          <Text style={[st.rowAmount, !isActive && st.rowNameQuiet]}>
            {s.amountPerPayment.toFixed(s.amountPerPayment < 1 ? 4 : 2)}
          </Text>
          <Text style={st.rowFreq}>{formatFrequency(s.frequency, s.customIntervalDays)}</Text>
        </View>

        <Ionicons name="chevron-forward" size={16} color={Colors.textTertiary} />
      </TouchableOpacity>
    </Animated.View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  flex: { flex: 1 },
  pad: { paddingHorizontal: Layout.screenPadding },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Layout.screenPadding,
    paddingVertical: Spacing.lg,
  },
  title: {
    fontFamily: FontFamily.display,
    fontSize: FontSize['3xl'],
    color: Colors.text,
  },
  syncBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Headline
  eyebrow: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  amountRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: Spacing.sm,
    marginTop: Spacing.xs,
  },
  amount: {
    fontFamily: FontFamily.display,
    fontSize: FontSize['4xl'],
    color: Colors.text,
    // Tabular so a balance that ticks does not shift the layout under a thumb.
    fontVariant: ['tabular-nums'],
  },
  amountUnit: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.md,
    color: Colors.textSecondary,
  },
  summarySub: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textTertiary,
    marginTop: Spacing.xs,
  },

  // List
  list: { marginTop: Spacing['2xl'] },
  loader: { marginTop: Spacing['5xl'] },
  emptyWrap: { minHeight: 380 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    minHeight: 64,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.borderSoft,
  },
  rowMark: {
    width: 40,
    height: 40,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  rowMarkActive: {
    backgroundColor: Colors.primaryDim,
    borderColor: Colors.primaryMuted,
  },
  rowInitial: {
    fontFamily: FontFamily.displayMedium,
    fontSize: FontSize.lg,
    color: Colors.textTertiary,
  },
  rowInitialActive: { color: Colors.primary },

  rowBody: { flex: 1, minWidth: 0 },
  rowName: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.md,
    color: Colors.text,
  },
  rowNameQuiet: { color: Colors.textSecondary },
  rowMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginTop: 3,
  },
  rowSub: {
    flexShrink: 1,
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },

  rowAmountWrap: { alignItems: 'flex-end', flexShrink: 0 },
  rowAmount: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.sm,
    color: Colors.text,
  },
  rowFreq: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    color: Colors.textTertiary,
    marginTop: 2,
  },
});

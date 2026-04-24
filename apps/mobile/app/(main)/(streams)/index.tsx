import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  Pressable,
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
import { useDenominatedPoolStore } from '../../../stores/denominatedPoolStore';
import { useSubscriptionVaultStore } from '../../../stores/subscriptionVaultStore';
import { useStarkProver } from '../../../providers/StarkProverProvider';
import { Stream, formatFrequency, upsertStreamFromVault } from '../../../services/solana/streams';
import {
  useServiceRegistry,
  formatInterval,
  formatPriceSOL,
  iconKeyToIonicons,
  readCachedServices,
  type ServiceEntry,
} from '../../../services/solana/serviceRegistry';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import { p01Alert } from '@/stores/alertStore';
import { useT } from '@/i18n';

const TAB_BAR_HEIGHT = 85;

type SectionType = 'personal' | 'services';

export default function StreamsDashboard() {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [activeSection, setActiveSection] = useState<SectionType>('personal');

  const { publicKey } = useWalletStore();
  const {
    streams, stats, loading, refreshing, syncing,
    initialize, refresh, syncFromChain,
  } = useStreamStore();
  const { notes: denomNotes } = useDenominatedPoolStore();
  const recoverOrphanedVaults = useSubscriptionVaultStore(s => s.recoverOrphanedVaults);
  const { isReady: starkReady, computeCommitment } = useStarkProver();
  const {
    services: registryServices,
    loading: registryLoading,
    refreshing: registryRefreshing,
    refresh: refreshRegistry,
  } = useServiceRegistry({ verifiedOnly: false });

  const availableNotes = denomNotes.filter(n => n.status === 'mature' || n.status === 'pending');
  const privateBalance = availableNotes.reduce((sum, n) => sum + n.denomination, 0);

  useEffect(() => { initialize(publicKey || undefined); }, [publicKey]);

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
        } catch {} finally { isProcessingRef.current = false; }
      });
      return () => handle.cancel();
    }, [])
  );

  const onRefresh = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await Promise.all([
      refresh(publicKey || undefined),
      refreshRegistry(),
    ]);
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

  // Counts & stats
  const activeCount = streams.filter(s => s.status === 'active').length;
  const activeStreams = streams.filter(s => s.status === 'active');
  const nextDue = activeStreams.length > 0
    ? Math.min(...activeStreams.map(s => s.nextPaymentDate)) : null;

  const serviceStreams = streams.filter(s =>
    s.status !== 'cancelled' && s.status !== 'completed' &&
    registryServices.some(svc => s.name.toLowerCase().includes(svc.name.toLowerCase()))
  );
  const personalStreams = streams.filter(s =>
    s.status !== 'cancelled' && s.status !== 'completed' &&
    !registryServices.some(svc => s.name.toLowerCase().includes(svc.name.toLowerCase()))
  ).sort((a, b) => a.nextPaymentDate - b.nextPaymentDate);

  return (
    <View style={st.container}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: TAB_BAR_HEIGHT + insets.bottom + 24 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing || registryRefreshing} onRefresh={onRefresh} tintColor={P01Colors.cyan} />}
      >
        {/* ── Header ── */}
        <View style={st.header}>
          <Text style={st.headerTitle}>{t('streams.title')}</Text>
          <TouchableOpacity
            onPress={handleSync}
            disabled={syncing}
            style={st.syncBtn}
            accessibilityLabel="Recover subscriptions from chain"
          >
            {syncing
              ? <ActivityIndicator size={16} color={P01Colors.cyan} />
              : <Ionicons name="cloud-download-outline" size={20} color={P01Colors.cyan} />}
          </TouchableOpacity>
        </View>

        {/* ── Summary Card ── */}
        <Animated.View entering={FadeIn.duration(300)} style={st.pad}>
          <View style={st.summaryCard}>
            <View style={st.summaryRow}>
              <View>
                <Text style={st.summaryLabel}>{t('streams.monthlyOutflow')}</Text>
                <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
                  <Text style={st.summaryAmount}>{stats.monthlyOutflow.toFixed(2)}</Text>
                  <Text style={st.summaryUnit}>SOL</Text>
                </View>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={st.statValue}>{activeCount}</Text>
                <Text style={st.statLabel}>{t('common.active').toLowerCase()}</Text>
              </View>
            </View>
            {nextDue && (
              <View style={st.nextDueRow}>
                <Ionicons name="time-outline" size={13} color={Colors.textSecondary} />
                <Text style={st.nextDueText}>
                  {t('streams.nextPayment', { date: new Date(nextDue).toLocaleDateString() })}
                </Text>
              </View>
            )}
          </View>
        </Animated.View>

        {/* ── Section Toggle ── */}
        <View style={st.pad}>
          <View style={st.toggle}>
            {(['personal', 'services'] as SectionType[]).map(sec => {
              const active = activeSection === sec;
              const color = sec === 'personal' ? P01Colors.cyan : P01Colors.pink;
              return (
                <Pressable
                  key={sec}
                  onPress={() => { Haptics.selectionAsync(); setActiveSection(sec); }}
                  style={[st.toggleBtn, active && { backgroundColor: color }]}
                >
                  <Ionicons
                    name={sec === 'personal' ? 'person' : 'apps'}
                    size={16}
                    color={active ? '#000' : Colors.textSecondary}
                  />
                  <Text style={[st.toggleText, active && { color: '#000' }]}>
                    {sec === 'personal' ? t('streams.personal') : t('streams.services')}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* ── Personal Section ── */}
        {activeSection === 'personal' && (
          <Animated.View entering={FadeInDown.duration(250)} style={st.pad}>
            <TouchableOpacity
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                router.push('/(main)/(streams)/create');
              }}
              activeOpacity={0.8}
              style={st.createBtn}
            >
              <Ionicons name="add" size={20} color="#000" />
              <Text style={st.createBtnText}>{t('streams.newPaymentStream')}</Text>
            </TouchableOpacity>

            {loading && personalStreams.length === 0 ? (
              <ActivityIndicator size="large" color={P01Colors.cyan} style={{ marginTop: 48 }} />
            ) : personalStreams.length === 0 ? (
              <View style={st.empty}>
                <View style={st.emptyIcon}>
                  <Ionicons name="wallet-outline" size={28} color={P01Colors.cyan} />
                </View>
                <Text style={st.emptyTitle}>{t('streams.noStreams')}</Text>
                <Text style={st.emptyDesc}>{t('streams.noStreamsDesc')}</Text>
              </View>
            ) : (
              <View style={{ gap: 8 }}>
                {personalStreams.map((s, i) => (
                  <StreamCard key={s.id} stream={s} index={i} accent={P01Colors.cyan}
                    onPress={() => router.push({ pathname: '/(main)/(streams)/[id]', params: { id: s.id } })} />
                ))}
              </View>
            )}
          </Animated.View>
        )}

        {/* ── Services Section ── */}
        {activeSection === 'services' && (
          <Animated.View entering={FadeInDown.duration(250)} style={st.pad}>
            {/* Private balance mini-card */}
            <View style={st.privateCard}>
              <View style={st.privateIconWrap}>
                <Ionicons name="eye-off" size={16} color={P01Colors.pink} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={st.privateLabel}>{t('streams.privateBalance')}</Text>
                <Text style={st.privateAmount}>{privateBalance.toFixed(privateBalance < 1 ? 4 : 2)} SOL</Text>
              </View>
              <TouchableOpacity
                onPress={() => router.push('/(main)/(privacy)/denominated-shield' as any)}
                style={st.shieldBtn}
              >
                <Text style={st.shieldBtnText}>{t('streams.shieldMore')}</Text>
              </TouchableOpacity>
            </View>

            {/* Services list (loaded from on-chain Service Registry) */}
            <View style={{ gap: 8, marginTop: 16 }}>
              {registryLoading && registryServices.length === 0 ? (
                <ActivityIndicator size="large" color={P01Colors.pink} style={{ marginTop: 48 }} />
              ) : registryServices.length === 0 ? (
                <View style={st.empty}>
                  <View style={st.emptyIcon}>
                    <Ionicons name="cube-outline" size={28} color={P01Colors.pink} />
                  </View>
                  <Text style={st.emptyTitle}>{t('streams.noServices', { defaultValue: 'No services available' })}</Text>
                  <Text style={st.emptyDesc}>
                    {t('streams.noServicesDesc', { defaultValue: 'Pull down to refresh the registry.' })}
                  </Text>
                </View>
              ) : (
                registryServices.map((svc, i) => {
                  const subscribed = serviceStreams.some(s =>
                    s.name.toLowerCase().includes(svc.name.toLowerCase()) && s.status === 'active'
                  );
                  return (
                    <ServiceCard key={svc.pda.toBase58()} service={svc} index={i} subscribed={subscribed}
                      onPress={() => {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                        if (subscribed) {
                          const stream = serviceStreams.find(s => s.name.toLowerCase().includes(svc.name.toLowerCase()));
                          if (stream) router.push({ pathname: '/(main)/(streams)/[id]', params: { id: stream.id } });
                        } else {
                          router.push({
                            pathname: '/(main)/(streams)/subscribe',
                            params: {
                              serviceId: svc.slug,
                              serviceName: svc.name,
                              servicePda: svc.pda.toBase58(),
                              retailer: svc.retailer.toBase58(),
                              priceLamports: svc.priceAtomic.toString(),
                              intervalSlots: svc.intervalSlots.toString(),
                              supportsOneshot: svc.supportsOneshot ? '1' : '0',
                              supportsVault: svc.supportsVault ? '1' : '0',
                              verified: svc.verified ? '1' : '0',
                              iconKey: svc.iconKey,
                              category: svc.category,
                              // Legacy keys kept for backward compat with subscribe.tsx.
                              price: (Number(svc.priceAtomic) / 1e9).toString(),
                              frequency: formatInterval(svc.intervalSlots),
                            },
                          });
                        }
                      }} />
                  );
                })
              )}
            </View>
          </Animated.View>
        )}
      </ScrollView>
    </View>
  );
}

// ─── Stream Card ─────────────────────────────────────────────────────────────

function StreamCard({ stream: s, index, accent, onPress }: {
  stream: Stream; index: number; accent: string; onPress: () => void;
}) {
  const t = useT();
  const isActive = s.status === 'active';
  const isPaused = s.status === 'paused';
  const daysUntil = Math.ceil((s.nextPaymentDate - Date.now()) / 86_400_000);
  const statusText = isPaused ? t('common.paused') : daysUntil <= 0 ? t('streams.dueNow') : daysUntil === 1 ? t('streams.dueTomorrow') : t('streams.daysLeft', { count: daysUntil });

  return (
    <Animated.View entering={FadeInDown.delay(index * 40).duration(250)}>
      <TouchableOpacity onPress={onPress} activeOpacity={0.7} style={st.card}>
        <View style={[st.cardIcon, { backgroundColor: isActive ? `${accent}18` : '#1a1a1f' }]}>
          <Text style={[st.cardInitial, { color: isActive ? accent : Colors.textTertiary }]}>
            {s.name.slice(0, 1).toUpperCase()}
          </Text>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[st.cardName, !isActive && { color: Colors.textSecondary }]} numberOfLines={1}>{s.name}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 }}>
            {isPaused && <Badge text={t('common.paused').toUpperCase()} color={P01Colors.yellow} />}
            {s.useZkPool && isActive && <Badge text="ZK" color={P01Colors.pink} />}
            {s.useStealthAddress && !s.useZkPool && isActive && <Badge text={t('streams.stealth').toUpperCase()} color={P01Colors.pink} />}
            <Text style={st.cardSub} numberOfLines={1}>{statusText}</Text>
          </View>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={[st.cardAmount, !isActive && { color: Colors.textSecondary }]}>
            {s.amountPerPayment.toFixed(s.amountPerPayment < 1 ? 4 : 2)}
          </Text>
          <Text style={st.cardFreq}>{formatFrequency(s.frequency, s.customIntervalDays)}</Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color={Colors.textTertiary} />
      </TouchableOpacity>
    </Animated.View>
  );
}

// ─── Service Card ────────────────────────────────────────────────────────────

function ServiceCard({ service: svc, index, subscribed, onPress }: {
  service: ServiceEntry; index: number; subscribed: boolean; onPress: () => void;
}) {
  const t = useT();
  const iconName = iconKeyToIonicons(svc.iconKey);
  const priceLabel = `${formatPriceSOL(svc.priceAtomic)} SOL`;
  const intervalLabel = formatInterval(svc.intervalSlots);
  const ageMs = Date.now() - svc.createdAt * 1000;
  const isNew = ageMs >= 0 && ageMs < 24 * 60 * 60 * 1000;
  return (
    <Animated.View entering={FadeInDown.delay(index * 40).duration(250)}>
      <TouchableOpacity onPress={onPress} activeOpacity={0.7} style={st.card}>
        <View style={[st.cardIcon, { backgroundColor: subscribed ? P01Colors.greenDim : P01Colors.pinkDim }]}>
          <Ionicons name={iconName as any} size={20} color={subscribed ? P01Colors.green : P01Colors.pink} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={st.cardName} numberOfLines={1}>{svc.name}</Text>
            {svc.verified && (
              <Ionicons name="checkmark-circle" size={14} color={P01Colors.cyan} />
            )}
            {isNew && <Badge text="NEW" color={P01Colors.cyan} />}
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 }}>
            {subscribed && <Badge text={t('common.active').toUpperCase()} color={P01Colors.green} />}
            {!svc.verified && <Badge text="UNVERIFIED" color={P01Colors.yellow} />}
            <Text style={st.cardSub}>{svc.category || '—'}</Text>
          </View>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={st.cardAmount}>{priceLabel}</Text>
          <Text style={st.cardFreq}>/{intervalLabel}</Text>
        </View>
        {!subscribed && (
          <View style={st.subscribeChip}>
            <Ionicons name="add" size={14} color={P01Colors.pink} />
          </View>
        )}
      </TouchableOpacity>
    </Animated.View>
  );
}

// ─── Badge ───────────────────────────────────────────────────────────────────

function Badge({ text, color }: { text: string; color: string }) {
  return (
    <View style={[st.badge, { backgroundColor: `${color}20` }]}>
      <Text style={[st.badgeText, { color }]}>{text}</Text>
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  pad: { paddingHorizontal: Spacing.xl },

  // Header
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl, paddingVertical: Spacing.lg,
  },
  headerTitle: { fontSize: 28, fontFamily: FontFamily.bold, color: Colors.text },
  syncBtn: {
    width: 40, height: 40, borderRadius: BorderRadius.full,
    backgroundColor: Colors.surfaceSecondary, alignItems: 'center', justifyContent: 'center',
  },

  // Summary
  summaryCard: {
    backgroundColor: Colors.surfaceSecondary, borderRadius: BorderRadius.xl,
    padding: Spacing.xl, marginBottom: Spacing.lg,
  },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  summaryLabel: { fontSize: 13, fontFamily: FontFamily.medium, color: Colors.textSecondary, marginBottom: 4 },
  summaryAmount: { fontSize: 32, fontFamily: FontFamily.bold, color: Colors.text },
  summaryUnit: { fontSize: 14, fontFamily: FontFamily.medium, color: Colors.textSecondary },
  statValue: { fontSize: 24, fontFamily: FontFamily.bold, color: P01Colors.cyan },
  statLabel: { fontSize: 12, fontFamily: FontFamily.regular, color: Colors.textSecondary },
  nextDueRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: Colors.surfaceTertiary,
  },
  nextDueText: { fontSize: 12, fontFamily: FontFamily.regular, color: Colors.textSecondary },

  // Toggle
  toggle: {
    flexDirection: 'row', gap: 4, padding: 4,
    backgroundColor: Colors.surfaceSecondary, borderRadius: BorderRadius.lg, marginBottom: Spacing.xl,
  },
  toggleBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 10, borderRadius: BorderRadius.md,
  },
  toggleText: { fontSize: 13, fontFamily: FontFamily.semibold, color: Colors.textSecondary },

  // Create button
  createBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 14, borderRadius: BorderRadius.lg,
    backgroundColor: P01Colors.cyan, marginBottom: Spacing.xl,
  },
  createBtnText: { fontSize: 15, fontFamily: FontFamily.semibold, color: '#000' },

  // Empty state
  empty: { alignItems: 'center', paddingVertical: 48 },
  emptyIcon: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: P01Colors.cyanDim, alignItems: 'center', justifyContent: 'center', marginBottom: 16,
  },
  emptyTitle: { fontSize: 16, fontFamily: FontFamily.semibold, color: Colors.text, marginBottom: 4 },
  emptyDesc: { fontSize: 13, fontFamily: FontFamily.regular, color: Colors.textSecondary, textAlign: 'center' },

  // Cards
  card: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 14, backgroundColor: Colors.surfaceSecondary, borderRadius: BorderRadius.xl,
  },
  cardIcon: {
    width: 42, height: 42, borderRadius: BorderRadius.md,
    alignItems: 'center', justifyContent: 'center',
  },
  cardInitial: { fontSize: 16, fontFamily: FontFamily.bold },
  cardName: { fontSize: 14, fontFamily: FontFamily.medium, color: Colors.text },
  cardSub: { fontSize: 12, fontFamily: FontFamily.regular, color: Colors.textSecondary },
  cardAmount: { fontSize: 14, fontFamily: FontFamily.semibold, color: Colors.text },
  cardFreq: { fontSize: 11, fontFamily: FontFamily.regular, color: Colors.textSecondary, marginTop: 2 },

  // Badge
  badge: { paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4 },
  badgeText: { fontSize: 9, fontFamily: FontFamily.semibold },

  // Subscribe chip
  subscribeChip: {
    width: 28, height: 28, borderRadius: BorderRadius.full,
    backgroundColor: P01Colors.pinkDim, alignItems: 'center', justifyContent: 'center',
  },

  // Private balance card
  privateCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 14, backgroundColor: Colors.surfaceSecondary, borderRadius: BorderRadius.xl,
  },
  privateIconWrap: {
    width: 36, height: 36, borderRadius: BorderRadius.sm,
    backgroundColor: P01Colors.pinkDim, alignItems: 'center', justifyContent: 'center',
  },
  privateLabel: { fontSize: 11, fontFamily: FontFamily.regular, color: Colors.textSecondary },
  privateAmount: { fontSize: 16, fontFamily: FontFamily.bold, color: Colors.text },
  shieldBtn: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: BorderRadius.sm,
    backgroundColor: P01Colors.pinkDim,
  },
  shieldBtnText: { fontSize: 12, fontFamily: FontFamily.semibold, color: P01Colors.pink },
});

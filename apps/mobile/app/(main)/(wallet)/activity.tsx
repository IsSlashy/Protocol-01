/**
 * Activity — everything this wallet has done.
 *
 * 🎯 RESTYLED 2026-08-23. What changed and why:
 *   - ⛔ TWO BARE `'#000'` LITERALS. The selected filter tab painted its label
 *     and its icon pure black, which is the one thing this system explicitly
 *     forbids ("NO black text"). On a cyan chip the correct colour is the
 *     ground, `Colors.background`.
 *   - the send rows were `P01Colors.pink`. Pink is retired and aliased to cyan,
 *     so sends and receives had quietly become the SAME colour — the one thing
 *     the colour was there to distinguish. A receive is the accent; a send is
 *     plain text, which is what "money left" looks like everywhere else.
 *   - "ZK" was a 9pt all-caps bold chip. It is a word now, and the word is
 *     "Private", because that is what a holder of one of these notes cares
 *     about and "ZK" is the implementation.
 *   - the date separators were caps-and-letterspaced between two rules. One
 *     quiet line of text.
 *   - 🚨 THE BACK BUTTON AND THE REFRESH BUTTON HAD NO ACCESSIBLE NAME AND WERE
 *     40pt. Both are named and 44pt. The filter tabs now report which one is
 *     selected instead of relying on the fill.
 *   - the list ended 40pt above the bottom, under the floating tab bar. It uses
 *     `Layout.tabBarTotalHeight` plus the inset, like every other tab screen.
 */

import React, { useState, useCallback, useEffect, useMemo } from 'react';
import {
  View, Text, FlatList, ScrollView, TouchableOpacity, RefreshControl, Linking, StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useWalletStore } from '@/stores/walletStore';
import { useStreamStore } from '@/stores/streamStore';
import { getExplorerUrl } from '@/services/solana/connection';
import { p01Alert } from '@/stores/alertStore';
import { useT, t as tStatic } from '@/i18n';
import { Colors, FontFamily, FontSize, BorderRadius, Spacing, Layout } from '@/constants/theme';

type FilterType = 'all' | 'sent' | 'received' | 'streams' | 'scheduled';

interface Transaction {
  id: string;
  type: 'send' | 'receive' | 'stream';
  token: string;
  amount: number;
  address: string;
  timestamp: Date;
  status: 'completed' | 'pending' | 'failed';
  isPrivate: boolean;
}

const FILTERS: { id: FilterType; label: () => string; icon: string }[] = [
  { id: 'all', label: () => tStatic('activity.all'), icon: 'layers-outline' },
  { id: 'sent', label: () => tStatic('activity.sent'), icon: 'arrow-up-outline' },
  { id: 'received', label: () => tStatic('activity.received'), icon: 'arrow-down-outline' },
  { id: 'streams', label: () => tStatic('activity.streams'), icon: 'water-outline' },
  { id: 'scheduled', label: () => tStatic('activity.scheduled'), icon: 'time-outline' },
];

const PAGE_SIZE = 20;
const fmtAddr = (a: string) => a?.length > 12 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a;

const timeAgo = (d: Date) => {
  const h = Math.floor((Date.now() - d.getTime()) / 3_600_000);
  if (h < 1) return tStatic('activity.justNow');
  if (h < 24) return tStatic('activity.hoursAgo', { count: h });
  const days = Math.floor(h / 24);
  if (days < 7) return tStatic('activity.daysAgo', { count: days });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

const timeUntil = (d: Date) => {
  const diff = d.getTime() - Date.now();
  if (diff < 0) return tStatic('streams.dueNow');
  const h = Math.floor(diff / 3_600_000);
  if (h < 1) return '<1h';
  if (h < 24) return `${h}h`;
  return tStatic('streams.daysLeft', { count: Math.floor(h / 24) });
};

export default function ActivityScreen() {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { transactions: storeTxs, refreshTransactions, refreshing: storeRefreshing, publicKey } = useWalletStore();
  const { streams, initialize: initStreams } = useStreamStore();

  const [filter, setFilter] = useState<FilterType>('all');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => { initStreams(publicKey || undefined); }, [publicKey]);
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [filter]);
  useEffect(() => {
    if (storeTxs.length > 0) { setLoaded(true); refreshTransactions().catch(() => {}); }
    else { refreshTransactions().then(() => setLoaded(true)).catch(() => setLoaded(true)); }
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await Promise.race([refreshTransactions(), new Promise((_, r) => setTimeout(() => r('timeout'), 15_000))]); }
    catch {} finally { setRefreshing(false); }
  }, [refreshTransactions]);

  // Scheduled payments
  const scheduled = useMemo(() =>
    streams.filter(s => s.status === 'active').map(s => ({
      id: s.id, name: s.name, address: s.recipientAddress,
      amount: s.amountPerPayment, frequency: s.frequency, isPrivate: s.useStealthAddress || s.amountNoise > 0,
      nextDate: new Date(s.nextPaymentDate),
    })).sort((a, b) => a.nextDate.getTime() - b.nextDate.getTime()),
  [streams]);

  // All transactions
  const allTxs: Transaction[] = useMemo(() => {
    const wallet: Transaction[] = storeTxs.map(tx => ({
      id: tx.signature, type: tx.type === 'unknown' ? 'send' : tx.type as 'send' | 'receive',
      token: tx.token || 'SOL', amount: tx.amount || 0,
      address: fmtAddr(tx.type === 'send' ? (tx.to || '') : (tx.from || '')),
      timestamp: new Date(tx.timestamp ? tx.timestamp * 1000 : Date.now()),
      status: tx.status === 'confirmed' ? 'completed' as const : tx.status as 'pending' | 'failed',
      isPrivate: false,
    }));
    const stream: Transaction[] = streams.flatMap(s =>
      s.paymentHistory.map(p => ({
        id: p.id, type: 'stream' as const, token: 'SOL', amount: p.amount,
        address: fmtAddr(s.recipientAddress),
        timestamp: new Date(p.timestamp),
        status: p.status === 'success' ? 'completed' as const : 'failed' as const,
        isPrivate: s.useStealthAddress || s.amountNoise > 0,
      }))
    );
    return [...wallet, ...stream].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }, [storeTxs, streams]);

  const filtered = allTxs.filter(tx =>
    filter === 'sent' ? tx.type === 'send'
    : filter === 'received' ? tx.type === 'receive'
    : filter === 'streams' ? tx.type === 'stream'
    : true
  );
  const paginated = filtered.slice(0, visibleCount);
  const hasMore = filtered.length > visibleCount;

  const handleTxPress = useCallback((tx: Transaction) => {
    const isValid = tx.id?.length >= 80 && !tx.id.includes('-') && !tx.id.includes('_');
    if (isValid) Linking.openURL(getExplorerUrl(tx.id, 'tx'));
    else p01Alert(t('activity.localTransaction'), t('activity.localTransactionDesc'), undefined, 'info');
  }, []);

  // Group by date
  type ListItem = { kind: 'header'; date: string } | { kind: 'tx'; tx: Transaction };
  const listData: ListItem[] = useMemo(() => {
    const groups: Record<string, Transaction[]> = {};
    for (const tx of paginated) {
      const d = tx.timestamp.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      (groups[d] ??= []).push(tx);
    }
    const items: ListItem[] = [];
    for (const [date, txs] of Object.entries(groups)) {
      items.push({ kind: 'header', date });
      for (const tx of txs) items.push({ kind: 'tx', tx });
    }
    return items;
  }, [paginated]);

  const TYPE_CFG = {
    receive: { icon: 'arrow-down' as const, label: t('activity.received'), sign: '+' },
    send: { icon: 'arrow-up' as const, label: t('activity.sent'), sign: '-' },
    stream: { icon: 'water-outline' as const, label: t('activity.streams'), sign: '-' },
  };

  const listPaddingBottom = Layout.tabBarTotalHeight + insets.bottom + Spacing.xl;

  const renderItem = useCallback(({ item }: { item: ListItem }) => {
    if (item.kind === 'header') {
      return <Text style={st.dateText}>{item.date}</Text>;
    }

    const tx = item.tx;
    const cfg = TYPE_CFG[tx.type] || TYPE_CFG.send;
    const isFailed = tx.status === 'failed';

    return (
      <TouchableOpacity onPress={() => handleTxPress(tx)} activeOpacity={0.6} style={st.txRow}>
        <View style={st.txIcon}>
          <Ionicons name={cfg.icon} size={16} color={Colors.textSecondary} />
        </View>

        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={st.txLabelRow}>
            <Text style={st.txLabel} numberOfLines={1}>{cfg.label}</Text>
            {tx.isPrivate && (
              <View style={st.privateChip}>
                <Text style={st.privateChipText}>Private</Text>
              </View>
            )}
          </View>
          <Text style={st.txAddr} numberOfLines={1}>{tx.address} · {timeAgo(tx.timestamp)}</Text>
        </View>

        <View style={{ alignItems: 'flex-end' }}>
          <Text style={[st.txAmount, tx.type === 'receive' && { color: Colors.primary }, isFailed && { color: Colors.error }]}>
            {cfg.sign}{tx.amount.toFixed(tx.amount < 1 ? 4 : 2)} {tx.token}
          </Text>
          {isFailed && <Text style={st.txFailed}>{t('common.failed')}</Text>}
        </View>
      </TouchableOpacity>
    );
  }, [handleTxPress]);

  const keyExtractor = useCallback((item: ListItem, i: number) =>
    item.kind === 'header' ? `h-${item.date}` : `t-${item.tx.id}-${i}`, []);

  // Scheduled / Empty states
  const renderAlt = () => {
    if (!loaded) {
      return (
        <View style={st.emptyWrap}>
          {[...Array(6)].map((_, i) => (
            <View key={i} style={st.skeleton}>
              <View style={[st.skeletonCircle, { opacity: 0.3 - i * 0.03 }]} />
              <View style={{ flex: 1, gap: 6 }}>
                <View style={[st.skeletonBar, { width: 80, opacity: 0.3 }]} />
                <View style={[st.skeletonBar, { width: 120, opacity: 0.2 }]} />
              </View>
            </View>
          ))}
        </View>
      );
    }

    if (filter === 'scheduled') {
      if (scheduled.length === 0) return <EmptyState icon="time-outline" title={t('activity.noScheduled')} desc={t('activity.transactionsWillAppear')} />;
      return (
        <View style={{ paddingHorizontal: Spacing.xl }}>
          {scheduled.map(p => (
            <TouchableOpacity key={p.id} onPress={() => router.push(`/(main)/(streams)/${p.id}`)} activeOpacity={0.6} style={st.txRow}>
              <View style={st.txIcon}>
                <Ionicons name="time-outline" size={16} color={Colors.textSecondary} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={st.txLabel} numberOfLines={1}>{p.name}</Text>
                <Text style={st.txAddr}>{fmtAddr(p.address)} · {timeUntil(p.nextDate)}</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={st.txAmount}>-{p.amount.toFixed(4)}</Text>
                <Text style={st.txAddr}>{p.frequency}</Text>
              </View>
            </TouchableOpacity>
          ))}
        </View>
      );
    }

    if (filtered.length === 0) {
      const cfg = { all: t('activity.noActivity'), sent: t('activity.noSent'), received: t('activity.noReceived'), streams: t('activity.noStreams'), scheduled: '' };
      return <EmptyState icon="layers-outline" title={cfg[filter] || t('activity.noActivity')} desc={t('activity.transactionsWillAppear')} />;
    }
    return null;
  };

  const showFlatList = loaded && filter !== 'scheduled' && filtered.length > 0;

  return (
    <View style={[st.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={st.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={st.iconBtn}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="chevron-back" size={22} color={Colors.textSecondary} />
        </TouchableOpacity>
        <View style={{ alignItems: 'center' }}>
          <Text style={st.headerTitle} accessibilityRole="header">{t('activity.title')}</Text>
          <Text style={st.headerSub}>{allTxs.length} transaction{allTxs.length !== 1 ? 's' : ''}</Text>
        </View>
        <TouchableOpacity
          onPress={onRefresh}
          style={st.iconBtn}
          accessibilityRole="button"
          accessibilityLabel={t('common.refresh')}
          accessibilityState={{ busy: refreshing }}
        >
          <Ionicons name="refresh-outline" size={20} color={Colors.textSecondary} />
        </TouchableOpacity>
      </View>

      {/* Filter tabs */}
      <View style={st.filterBar}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: Spacing.sm }}>
          {FILTERS.map(tab => {
            const active = filter === tab.id;
            return (
              <TouchableOpacity
                key={tab.id}
                onPress={() => setFilter(tab.id)}
                style={[st.filterTab, active && st.filterTabActive]}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={tab.label()}
              >
                <Ionicons
                  name={tab.icon as any}
                  size={14}
                  color={active ? Colors.background : Colors.textSecondary}
                />
                <Text style={[st.filterText, active && st.filterTextActive]}>{tab.label()}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {/* Content */}
      {showFlatList ? (
        <FlatList
          data={listData}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: Spacing.xl, paddingBottom: listPaddingBottom }}
          showsVerticalScrollIndicator={false}
          initialNumToRender={PAGE_SIZE}
          maxToRenderPerBatch={10}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
          ListFooterComponent={hasMore ? (
            <TouchableOpacity
              onPress={() => setVisibleCount(v => v + PAGE_SIZE)}
              style={st.loadMore}
              accessibilityRole="button"
            >
              <Text style={st.loadMoreText}>{t('activity.loadMore', { count: filtered.length - visibleCount })}</Text>
            </TouchableOpacity>
          ) : null}
        />
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: listPaddingBottom }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}>
          {renderAlt()}
        </ScrollView>
      )}
    </View>
  );
}

function EmptyState({ icon, title, desc }: { icon: string; title: string; desc: string }) {
  return (
    <View style={st.emptyState}>
      <View style={st.emptyIcon}>
        <Ionicons name={icon as any} size={28} color={Colors.textTertiary} />
      </View>
      <Text style={st.emptyTitle}>{title}</Text>
      <Text style={st.emptyDesc}>{desc}</Text>
    </View>
  );
}

const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },

  // Header
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, minHeight: 56,
  },
  iconBtn: {
    width: 44, height: 44, alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: { fontSize: FontSize.xl, fontFamily: FontFamily.displayMedium, color: Colors.text },
  headerSub: { fontSize: FontSize.xs, fontFamily: FontFamily.regular, color: Colors.textTertiary, marginTop: 1 },

  // Filters
  filterBar: { paddingHorizontal: Spacing.xl, marginBottom: Spacing.md, marginTop: Spacing.sm },
  filterTab: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.xs,
    paddingHorizontal: Spacing.lg, minHeight: 44, borderRadius: BorderRadius.full,
    borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.border,
  },
  filterTabActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  filterText: { fontSize: FontSize.sm, fontFamily: FontFamily.medium, color: Colors.textSecondary },
  filterTextActive: { color: Colors.background },

  // Date separator
  dateText: {
    fontSize: FontSize.sm, fontFamily: FontFamily.regular, color: Colors.textTertiary,
    marginTop: Spacing.xl, marginBottom: Spacing.xs,
  },

  // Transaction row
  txRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    paddingVertical: Spacing.md, minHeight: 60,
  },
  txIcon: {
    width: 36, height: 36, borderRadius: BorderRadius.md,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: Colors.surfaceTertiary,
  },
  txLabelRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  txLabel: { fontSize: FontSize.md, fontFamily: FontFamily.medium, color: Colors.text },
  txAddr: { fontSize: FontSize.sm, fontFamily: FontFamily.regular, color: Colors.textSecondary, marginTop: 2 },
  txAmount: { fontSize: FontSize.md, fontFamily: FontFamily.mono, color: Colors.text },
  txFailed: { fontSize: FontSize.xs, fontFamily: FontFamily.regular, color: Colors.error, marginTop: 2 },

  // The one thing worth marking on a row
  privateChip: {
    paddingHorizontal: Spacing.sm, paddingVertical: 1, borderRadius: BorderRadius.sm,
    backgroundColor: Colors.primaryDim,
  },
  privateChipText: { fontSize: FontSize.xs, fontFamily: FontFamily.medium, color: Colors.primary },

  // Load more
  loadMore: { alignItems: 'center', justifyContent: 'center', minHeight: 44, marginTop: Spacing.md },
  loadMoreText: { fontSize: FontSize.sm, fontFamily: FontFamily.medium, color: Colors.primary },

  // Empty
  emptyWrap: { paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm },
  emptyState: { alignItems: 'center', paddingVertical: Spacing['6xl'], paddingHorizontal: Spacing['3xl'] },
  emptyIcon: {
    width: 56, height: 56, borderRadius: BorderRadius.full,
    backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.border,
    marginBottom: Spacing['2xl'],
  },
  emptyTitle: { fontSize: FontSize['2xl'], fontFamily: FontFamily.display, color: Colors.text, textAlign: 'center' },
  emptyDesc: {
    fontSize: FontSize.md, fontFamily: FontFamily.regular, color: Colors.textSecondary,
    textAlign: 'center', marginTop: Spacing.sm,
  },

  // Skeleton
  skeleton: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingVertical: Spacing.md },
  skeletonCircle: { width: 36, height: 36, borderRadius: BorderRadius.md, backgroundColor: Colors.surfaceTertiary },
  skeletonBar: { height: 10, borderRadius: 4, backgroundColor: Colors.surfaceTertiary },
});

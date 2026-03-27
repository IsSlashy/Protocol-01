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
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';

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
    receive: { icon: 'arrow-down' as const, color: P01Colors.cyan, label: t('activity.received'), sign: '+' },
    send: { icon: 'arrow-up' as const, color: P01Colors.pink, label: t('activity.sent'), sign: '-' },
    stream: { icon: 'water-outline' as const, color: P01Colors.blue, label: t('activity.streams'), sign: '-' },
  };

  const renderItem = useCallback(({ item }: { item: ListItem }) => {
    if (item.kind === 'header') {
      return (
        <View style={st.dateHeader}>
          <View style={st.dateLine} />
          <Text style={st.dateText}>{item.date}</Text>
          <View style={st.dateLine} />
        </View>
      );
    }

    const tx = item.tx;
    const cfg = TYPE_CFG[tx.type] || TYPE_CFG.send;
    const isFailed = tx.status === 'failed';

    return (
      <TouchableOpacity onPress={() => handleTxPress(tx)} activeOpacity={0.6} style={st.txRow}>
        {/* Icon */}
        <View style={[st.txIcon, { backgroundColor: `${cfg.color}15` }]}>
          <Ionicons name={cfg.icon} size={16} color={cfg.color} />
        </View>

        {/* Details */}
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={st.txLabel} numberOfLines={1}>{cfg.label}</Text>
            {tx.isPrivate && (
              <View style={st.zkChip}>
                <Text style={st.zkText}>ZK</Text>
              </View>
            )}
          </View>
          <Text style={st.txAddr} numberOfLines={1}>{tx.address} · {timeAgo(tx.timestamp)}</Text>
        </View>

        {/* Amount */}
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={[st.txAmount, tx.type === 'receive' && { color: P01Colors.cyan }, isFailed && { color: Colors.error }]}>
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
        <View style={{ paddingHorizontal: Spacing.xl, gap: 2 }}>
          {scheduled.map(p => (
            <TouchableOpacity key={p.id} onPress={() => router.push(`/(main)/(streams)/${p.id}`)} activeOpacity={0.6} style={st.txRow}>
              <View style={[st.txIcon, { backgroundColor: P01Colors.blueDim }]}>
                <Ionicons name="time-outline" size={16} color={P01Colors.blue} />
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
        <TouchableOpacity onPress={() => router.back()} style={st.backBtn}>
          <Ionicons name="arrow-back" size={20} color={Colors.text} />
        </TouchableOpacity>
        <View style={{ alignItems: 'center' }}>
          <Text style={st.headerTitle}>{t('activity.title')}</Text>
          <Text style={st.headerSub}>{allTxs.length} transaction{allTxs.length !== 1 ? 's' : ''}</Text>
        </View>
        <TouchableOpacity onPress={onRefresh} style={st.backBtn}>
          <Ionicons name="refresh-outline" size={18} color={P01Colors.cyan} />
        </TouchableOpacity>
      </View>

      {/* Filter tabs */}
      <View style={{ paddingHorizontal: Spacing.xl, marginBottom: 12 }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
          {FILTERS.map(tab => {
            const active = filter === tab.id;
            return (
              <TouchableOpacity key={tab.id} onPress={() => setFilter(tab.id)}
                style={[st.filterTab, active && { backgroundColor: P01Colors.cyan }]}>
                <Ionicons name={tab.icon as any} size={13} color={active ? '#000' : Colors.textSecondary} />
                <Text style={[st.filterText, active && { color: '#000' }]}>{tab.label()}</Text>
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
          contentContainerStyle={{ paddingHorizontal: Spacing.xl, paddingBottom: 40 }}
          showsVerticalScrollIndicator={false}
          initialNumToRender={PAGE_SIZE}
          maxToRenderPerBatch={10}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={P01Colors.cyan} />}
          ListFooterComponent={hasMore ? (
            <TouchableOpacity onPress={() => setVisibleCount(v => v + PAGE_SIZE)} style={st.loadMore}>
              <Text style={st.loadMoreText}>{t('activity.loadMore', { count: filtered.length - visibleCount })}</Text>
            </TouchableOpacity>
          ) : null}
        />
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={P01Colors.cyan} />}>
          {renderAlt()}
        </ScrollView>
      )}
    </View>
  );
}

function EmptyState({ icon, title, desc }: { icon: string; title: string; desc: string }) {
  return (
    <View style={{ alignItems: 'center', paddingVertical: 64 }}>
      <View style={st.emptyIcon}>
        <Ionicons name={icon as any} size={32} color={Colors.textTertiary} />
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
    paddingHorizontal: Spacing.xl, paddingVertical: Spacing.md,
  },
  backBtn: {
    width: 40, height: 40, borderRadius: BorderRadius.lg,
    backgroundColor: Colors.surfaceSecondary, alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: { fontSize: 18, fontFamily: FontFamily.bold, color: Colors.text },
  headerSub: { fontSize: 11, fontFamily: FontFamily.regular, color: Colors.textTertiary, marginTop: 1 },

  // Filters
  filterTab: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: BorderRadius.full,
    backgroundColor: Colors.surfaceSecondary,
  },
  filterText: { fontSize: 13, fontFamily: FontFamily.semibold, color: Colors.text },

  // Date header
  dateHeader: { flexDirection: 'row', alignItems: 'center', marginTop: 16, marginBottom: 8 },
  dateLine: { flex: 1, height: 1, backgroundColor: Colors.surfaceTertiary },
  dateText: {
    fontSize: 11, fontFamily: FontFamily.semibold, color: Colors.textTertiary,
    paddingHorizontal: 10, textTransform: 'uppercase', letterSpacing: 0.5,
  },

  // Transaction row — LIGHTWEIGHT
  txRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 12, paddingHorizontal: 4,
  },
  txIcon: {
    width: 36, height: 36, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  txLabel: { fontSize: 14, fontFamily: FontFamily.medium, color: Colors.text },
  txAddr: { fontSize: 12, fontFamily: FontFamily.regular, color: Colors.textSecondary, marginTop: 2 },
  txAmount: { fontSize: 14, fontFamily: FontFamily.semibold, color: Colors.text },
  txFailed: { fontSize: 10, fontFamily: FontFamily.medium, color: Colors.error, marginTop: 2 },

  // ZK chip
  zkChip: { paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, backgroundColor: P01Colors.cyanDim },
  zkText: { fontSize: 9, fontFamily: FontFamily.bold, color: P01Colors.cyan },

  // Load more
  loadMore: { alignItems: 'center', paddingVertical: 16 },
  loadMoreText: { fontSize: 13, fontFamily: FontFamily.medium, color: P01Colors.cyan },

  // Empty
  emptyWrap: { paddingHorizontal: Spacing.xl, paddingTop: 8 },
  emptyIcon: {
    width: 56, height: 56, borderRadius: 16,
    backgroundColor: Colors.surfaceSecondary, alignItems: 'center', justifyContent: 'center', marginBottom: 16,
  },
  emptyTitle: { fontSize: 16, fontFamily: FontFamily.semibold, color: Colors.text, marginBottom: 4 },
  emptyDesc: { fontSize: 13, fontFamily: FontFamily.regular, color: Colors.textSecondary },

  // Skeleton
  skeleton: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  skeletonCircle: { width: 36, height: 36, borderRadius: 10, backgroundColor: Colors.surfaceTertiary },
  skeletonBar: { height: 10, borderRadius: 4, backgroundColor: Colors.surfaceTertiary },
});

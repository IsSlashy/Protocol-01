import React, { useEffect, useCallback, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, RefreshControl, StyleSheet, Linking, Share,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
// Animations removed — staggered FadeInDown on each note caused tearing during navigation transitions

import { useDenominatedPoolStore, type StoredNote, type NoteStatus } from '@/stores/denominatedPoolStore';
import { receiptFromJSON, slotToEpoch } from '@/services/denominatedPool';
import { getCluster } from '@/services/solana/connection';
import { vaultDecrypt } from '@/utils/crypto/noteVault';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import { p01Alert } from '@/stores/alertStore';
import { useT, t as tStatic } from '@/i18n';

const SLOTS_PER_EPOCH = 7200;
const DEFAULT_SLOT_MS = 500;

function fmtTime(ms: number): string {
  if (ms <= 0) return tStatic('common.ready');
  const mins = Math.ceil(ms / 60_000);
  if (mins < 60) return `~${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rm = mins % 60;
  return rm > 0 ? `~${hrs}h ${rm}m` : `~${hrs}h`;
}

interface RouteProgress {
  routeId: string; completedHops: number; totalHops: number;
  nextHopAt?: number; destination: string; status: string;
}

export default function DenominatedNotesScreen() {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [showHistory, setShowHistory] = useState(false);
  const [currentSlot, setCurrentSlot] = useState<number | null>(null);
  const [expandedNote, setExpandedNote] = useState<string | null>(null);
  const [routeProgress, setRouteProgress] = useState<Record<string, RouteProgress>>({});
  const [slotMs, setSlotMs] = useState(DEFAULT_SLOT_MS);

  const {
    notes, isLoading, refreshAllPools, refreshNoteStatuses,
    exportAllNotes, exportNote, poolCache, recoverTransferredNotes,
  } = useDenominatedPoolStore();

  // Dedup + refresh on mount
  useEffect(() => {
    const store = useDenominatedPoolStore.getState();
    const seen = new Map<string, typeof store.notes[0]>();
    for (const n of store.notes) {
      const ex = seen.get(n.id);
      if (!ex || n.status === 'spent' || n.shieldedAt > ex.shieldedAt) seen.set(n.id, n);
    }
    const deduped = [...seen.values()];
    if (deduped.length < store.notes.length) useDenominatedPoolStore.setState({ notes: deduped });
    refreshNoteStatuses().catch(() => {});

    // Load route progress
    (async () => {
      try {
        const { useWalletStore } = require('@/stores/walletStore');
        const pk = useWalletStore.getState().publicKey;
        if (!pk) return;
        const { sha256 } = require('@noble/hashes/sha256');
        const { bytesToHex } = require('@noble/hashes/utils');
        const skHash = bytesToHex(sha256(new TextEncoder().encode(pk)));
        const { loadAllRoutes } = require('@/services/privacyRouter/routeCipher');
        const routes = await loadAllRoutes(skHash);
        const progress: Record<string, RouteProgress> = {};
        for (const r of routes) {
          if (r.status === 'completed' || r.status === 'failed') continue;
          const done = r.hops.filter((h: any) => h.status === 'completed').length;
          const next = r.hops.find((h: any) => h.status !== 'completed');
          progress[`${r.sourceDenomination}_${r.createdAt}`] = {
            routeId: r.id, completedHops: done, totalHops: r.hops.length,
            nextHopAt: next?.scheduledAt, destination: r.destination, status: r.status,
          };
        }
        setRouteProgress(progress);
      } catch {}
    })();
  }, []);

  // Slot polling
  useEffect(() => {
    let cancelled = false;
    let interval: ReturnType<typeof setInterval>;
    const init = async () => {
      try {
        const { getConnection } = await import('@/services/solana/connection');
        const conn = getConnection();
        const s1 = await conn.getSlot('confirmed');
        const t1 = Date.now();
        if (cancelled) return;
        setCurrentSlot(s1);
        setTimeout(async () => {
          if (cancelled) return;
          try {
            const s2 = await conn.getSlot('confirmed');
            const diff = s2 - s1;
            if (diff > 0) setSlotMs(Math.max(200, Math.min(800, (Date.now() - t1) / diff)));
            setCurrentSlot(s2);
          } catch {}
        }, 3000);
        interval = setInterval(async () => {
          if (cancelled) return;
          try { setCurrentSlot(await conn.getSlot('confirmed')); } catch {}
        }, 30_000);
      } catch {}
    };
    refreshNoteStatuses(); init();
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const cluster = getCluster();
  const clusterNotes = notes.filter(n => (n.cluster ?? 'devnet') === cluster);
  const activeNotes = clusterNotes.filter(n => n.status !== 'spent' && n.status !== 'transferred');
  const historyNotes = clusterNotes.filter(n => n.status === 'spent' || n.status === 'transferred');

  const getMaturity = useCallback((note: StoredNote) => {
    if (note.status === 'mature') return { isMature: true, remainingMs: 0 };
    if (!currentSlot) return { isMature: false, remainingMs: -1 };
    try {
      const receipt = receiptFromJSON(vaultDecrypt(note.receiptJSON));
      const epoch = slotToEpoch(currentSlot);
      const cached = poolCache[note.poolPDA];
      const delay = (cached?.info.epochDelay ?? 1n) + BigInt(cached?.info.dynamicDelay ?? 2);
      const minEpoch = epoch - delay;
      if (receipt.depositEpoch <= minEpoch) return { isMature: true, remainingMs: 0 };
      const matSlot = Number(receipt.depositEpoch + delay) * SLOTS_PER_EPOCH;
      return { isMature: false, remainingMs: Math.max(0, matSlot - currentSlot) * slotMs };
    } catch { return { isMature: false, remainingMs: -1 }; }
  }, [currentSlot, slotMs, poolCache]);

  const onRefresh = useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await refreshAllPools();
  }, []);

  // ── Handlers ────────────────────────────────────────────────

  const handleUnshield = (n: StoredNote) => {
    if (n.status !== 'mature') return p01Alert(t('privacy.notReady'), t('privacy.stillMaturing'));
    router.push({ pathname: '/(main)/(privacy)/denominated-unshield' as any, params: { noteId: n.id } });
  };
  const handleTransfer = (n: StoredNote) => {
    if (n.status !== 'mature') return p01Alert(t('privacy.notReady'), t('privacy.mustBeMature'));
    router.push({ pathname: '/(main)/(privacy)/denominated-transfer' as any, params: { noteId: n.id } });
  };
  const handleEmergency = (n: StoredNote) => {
    p01Alert(t('privacy.emergencyUnshield'), t('privacy.emergencyDesc'),
      [{ text: t('common.cancel'), style: 'cancel' },
       { text: t('privacy.proceed'), style: 'destructive', onPress: () => router.push({ pathname: '/(main)/(privacy)/denominated-unshield' as any, params: { noteId: n.id, emergency: '1' } }) }]);
  };
  const handleExport = async (n: StoredNote) => {
    try {
      const enc = exportNote(n.id);
      await Clipboard.setStringAsync(enc);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      p01Alert(t('privacy.noteExported'), t('privacy.noteExportedDesc'));
      setTimeout(async () => { try { const c = await Clipboard.getStringAsync(); if (c === enc) await Clipboard.setStringAsync(''); } catch {} }, 60000);
    } catch (e) { p01Alert(t('common.error'), (e as Error).message); }
  };
  const handleNearby = (n: StoredNote) => {
    try { router.push({ pathname: '/(main)/(privacy)/share-note' as any, params: { noteData: exportNote(n.id), noteId: n.id } }); }
    catch (e) { p01Alert(t('common.error'), (e as Error).message); }
  };
  const handleManualShare = (n: StoredNote) => {
    try { const enc = exportNote(n.id); Clipboard.setStringAsync(enc); setTimeout(() => Clipboard.setStringAsync(''), 60000); Share.share({ message: enc, title: 'P01 Note' }); }
    catch (e) { p01Alert(t('common.error'), (e as Error).message); }
  };
  const handleBackup = () => {
    const enc = exportAllNotes();
    if (!enc.length) return p01Alert(t('alerts.noNotes'), t('privacy.noBackup'));
    p01Alert(t('privacy.backup'), t('privacy.backupDesc', { count: enc.length }),
      [{ text: t('common.copied'), onPress: async () => { await Clipboard.setStringAsync(JSON.stringify(enc)); setTimeout(() => Clipboard.setStringAsync(''), 60000); Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } },
       { text: t('common.cancel'), style: 'cancel' }]);
  };
  const handleRecover = () => {
    const count = clusterNotes.filter(n => n.status === 'transferred' && !n.spentTxSig).length;
    if (!count) return p01Alert(t('privacy.recover'), t('privacy.nothingToRecover'));
    p01Alert(t('privacy.recover'), t('privacy.recoverDesc', { count }),
      [{ text: t('common.cancel'), style: 'cancel' },
       { text: t('privacy.recover'), onPress: () => { recoverTransferredNotes(); Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } }]);
  };

  // ── Status config ──────────────────────────────────────────

  const statusCfg = (s: NoteStatus) => ({
    mature:      { icon: 'checkmark-circle' as const, color: P01Colors.cyan, label: t('common.ready') },
    pending:     { icon: 'time' as const, color: P01Colors.yellow, label: t('privacy.maturing') },
    imported:    { icon: 'download' as const, color: '#8B8BFF', label: t('privacy.imported') },
    spent:       { icon: 'close-circle' as const, color: Colors.textTertiary, label: t('privacy.spent') },
    transferred: { icon: 'swap-horizontal' as const, color: '#8B8BFF', label: t('common.send') },
    locked:      { icon: 'lock-closed' as const, color: P01Colors.pink, label: t('privacy.locked') },
  }[s]);

  const srcLabel = (n: StoredNote) =>
    n.source === 'received' ? t('common.receive') : n.source === 'imported_backup' ? t('privacy.restored') : t('privacy.deposited');

  // ── Render note ────────────────────────────────────────────

  const renderNote = (note: StoredNote, index: number) => {
    const cfg = statusCfg(note.status);
    const expanded = expandedNote === note.id;
    const maturity = getMaturity(note);

    return (
      <View key={note.id}>
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={() => setExpandedNote(expanded ? null : note.id)}
          style={st.noteCard}
        >
          {/* Main row */}
          <View style={st.noteRow}>
            <View style={[st.noteIcon, { backgroundColor: `${cfg.color}15` }]}>
              <Ionicons name={cfg.icon} size={18} color={cfg.color} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={st.noteAmount}>{note.denomination} {note.token}</Text>
              <Text style={st.noteSub}>
                {srcLabel(note)} · {new Date(note.shieldedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </Text>
            </View>

            {/* Status / time */}
            {note.status === 'mature' ? (
              <View style={[st.badge, { backgroundColor: `${P01Colors.cyan}15` }]}>
                <Text style={[st.badgeText, { color: P01Colors.cyan }]}>{t('common.ready').toUpperCase()}</Text>
              </View>
            ) : (note.status === 'pending' || note.status === 'imported') ? (
              <Text style={st.timeText}>
                {maturity.remainingMs > 0 ? fmtTime(maturity.remainingMs) : maturity.remainingMs === 0 ? t('common.ready') : '...'}
              </Text>
            ) : (
              <View style={[st.badge, { backgroundColor: `${cfg.color}15` }]}>
                <Text style={[st.badgeText, { color: cfg.color }]}>{cfg.label.toUpperCase()}</Text>
              </View>
            )}

            <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={Colors.textTertiary} />
          </View>

          {/* Locked route progress */}
          {note.status === 'locked' && (() => {
            const pk = Object.keys(routeProgress).find(k => k.startsWith(`${note.denomination}_`));
            const rp = pk ? routeProgress[pk] : null;
            if (!rp) return null;
            const pct = Math.round((rp.completedHops / rp.totalHops) * 100);
            return (
              <View style={{ marginTop: 8 }}>
                <View style={st.progressTrack}>
                  <View style={[st.progressFill, { width: `${Math.max(5, pct)}%` as any }]} />
                </View>
                <Text style={st.progressLabel}>Hop {rp.completedHops}/{rp.totalHops} · {pct}%</Text>
              </View>
            );
          })()}

          {/* Expanded details + actions */}
          {expanded && (
            <View style={st.expandedSection}>
              {/* Technical details */}
              <View style={st.detailRow}>
                <Text style={st.detailLabel}>{t('privacy.pool')}</Text>
                <Text style={st.detailValue}>{note.poolPDA.slice(0, 8)}...{note.poolPDA.slice(-4)}</Text>
              </View>
              <View style={st.detailRow}>
                <Text style={st.detailLabel}>{t('privacy.noteId')}</Text>
                <Text style={st.detailValue}>{note.id}</Text>
              </View>
              {note.spentTxSig && (
                <TouchableOpacity style={st.detailRow}
                  onPress={() => Linking.openURL(`https://explorer.solana.com/tx/${note.spentTxSig}?cluster=devnet`)}>
                  <Text style={st.detailLabel}>Tx</Text>
                  <Text style={[st.detailValue, { color: P01Colors.cyan }]}>{note.spentTxSig.slice(0, 12)}... ↗</Text>
                </TouchableOpacity>
              )}
              {note.status === 'transferred' && note.transferredTo && (
                <TouchableOpacity style={st.detailRow}
                  onPress={() => Share.share({ message: note.transferredTo!, title: 'P01 Note' })}>
                  <Text style={st.detailLabel}>{t('privacy.transferred')}</Text>
                  <Text style={[st.detailValue, { color: '#8B8BFF' }]}>{t('privacy.reshare')} ↗</Text>
                </TouchableOpacity>
              )}

              {/* Actions */}
              {note.status === 'mature' && (
                <View style={st.actions}>
                  <ActionChip icon="wallet-outline" label={t('privacy.withdraw')} color={P01Colors.cyan} onPress={() => handleUnshield(note)} />
                  <ActionChip icon="send-outline" label={t('common.send')} color={P01Colors.pink} onPress={() => handleTransfer(note)} />
                  <ActionChip icon="radio-outline" label={t('privacy.receiveNearby')} color={P01Colors.blue} onPress={() => handleNearby(note)} />
                  <ActionChip icon="share-outline" label={t('common.share')} color={Colors.textSecondary} onPress={() => handleManualShare(note)} />
                </View>
              )}
              {(note.status === 'pending' || note.status === 'imported') && (
                <View style={st.actions}>
                  {note.source === 'shielded' && (
                    <ActionChip icon="flash" label={t('privacy.emergencyUnshield')} color={Colors.error} onPress={() => handleEmergency(note)} />
                  )}
                  <ActionChip icon="cloud-upload-outline" label={t('privacy.backup')} color={Colors.textSecondary} onPress={() => handleExport(note)} />
                </View>
              )}
            </View>
          )}
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <View style={[st.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={st.header}>
        <TouchableOpacity onPress={() => router.back()} style={st.backBtn}>
          <Ionicons name="arrow-back" size={22} color={Colors.text} />
        </TouchableOpacity>
        <Text style={st.headerTitle}>{t('privacy.myNotes')}</Text>
        <View style={{ flexDirection: 'row', gap: 6 }}>
          {clusterNotes.some(n => n.status === 'transferred' && !n.spentTxSig) && (
            <TouchableOpacity onPress={handleRecover} style={st.headerBtn}>
              <Ionicons name="refresh-circle-outline" size={18} color={P01Colors.yellow} />
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={handleBackup} style={st.headerBtn}>
            <Ionicons name="cloud-upload-outline" size={18} color={Colors.textSecondary} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => router.push('/(main)/(privacy)/denominated-shield' as any)}
            style={[st.headerBtn, { backgroundColor: P01Colors.cyanDim }]}>
            <Ionicons name="add" size={20} color={P01Colors.cyan} />
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: Spacing.xl, paddingBottom: 120 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={onRefresh} tintColor={P01Colors.cyan} />}>

        {/* Quick actions — compact chips */}
        <View style={st.quickRow}>
          <TouchableOpacity style={st.quickChip} onPress={() => router.push('/(main)/(privacy)/receive-note' as any)}>
            <Ionicons name="bluetooth" size={16} color={P01Colors.blue} />
            <Text style={st.quickLabel}>{t('common.receive')}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={st.quickChip} onPress={() => router.push('/(main)/(privacy)/denominated-import' as any)}>
            <Ionicons name="clipboard-outline" size={16} color={P01Colors.cyan} />
            <Text style={st.quickLabel}>{t('privacy.import')}</Text>
          </TouchableOpacity>
        </View>

        {/* Summary */}
        {clusterNotes.length > 0 && (
          <View style={st.summaryCard}>
            {[
              { val: activeNotes.length, label: t('common.active'), color: Colors.text },
              { val: activeNotes.filter(n => n.status === 'mature').length, label: t('common.ready'), color: P01Colors.cyan },
              { val: activeNotes.filter(n => n.status === 'pending' || n.status === 'imported').length, label: t('common.pending'), color: P01Colors.yellow },
              { val: historyNotes.length, label: t('privacy.history'), color: Colors.text },
            ].map((s, i) => (
              <React.Fragment key={s.label}>
                {i > 0 && <View style={st.summaryDivider} />}
                <View style={{ flex: 1, alignItems: 'center' }}>
                  <Text style={[st.summaryVal, { color: s.color }]}>{s.val}</Text>
                  <Text style={st.summaryLabel}>{s.label}</Text>
                </View>
              </React.Fragment>
            ))}
          </View>
        )}

        {/* Empty */}
        {clusterNotes.length === 0 && (
          <View style={st.empty}>
            <Ionicons name="receipt-outline" size={40} color={Colors.textTertiary} />
            <Text style={st.emptyTitle}>{t('privacy.noNotes')}</Text>
            <Text style={st.emptyDesc}>{t('privacy.noNotesDesc')}</Text>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
              <TouchableOpacity style={st.emptyBtn} onPress={() => router.push('/(main)/(privacy)/denominated-shield' as any)}>
                <Text style={st.emptyBtnText}>{t('privacy.shield')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[st.emptyBtn, { backgroundColor: '#8B8BFF' }]}
                onPress={() => router.push('/(main)/(privacy)/denominated-import' as any)}>
                <Text style={st.emptyBtnText}>{t('privacy.import')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Active notes */}
        {activeNotes.length > 0 && (
          <>
            <Text style={st.sectionTitle}>{t('privacy.activeNotes')}</Text>
            {activeNotes.map((n, i) => renderNote(n, i))}
          </>
        )}

        {/* History */}
        {historyNotes.length > 0 && (
          <>
            <TouchableOpacity style={st.historyToggle} onPress={() => setShowHistory(!showHistory)}>
              <Text style={st.sectionTitle}>{t('privacy.history')} ({historyNotes.length})</Text>
              <Ionicons name={showHistory ? 'chevron-up' : 'chevron-down'} size={16} color={Colors.textSecondary} />
            </TouchableOpacity>
            {showHistory && historyNotes.map((n, i) => renderNote(n, i + activeNotes.length))}
          </>
        )}

        {/* Footer */}
        <View style={st.footer}>
          <Ionicons name="information-circle-outline" size={14} color={Colors.textTertiary} />
          <Text style={st.footerText}>{t('privacy.notesStoredLocally')}</Text>
        </View>
      </ScrollView>
    </View>
  );
}

function ActionChip({ icon, label, color, onPress }: { icon: string; label: string; color: string; onPress: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} style={[st.actionChip, { backgroundColor: `${color}12` }]} activeOpacity={0.7}>
      <Ionicons name={icon as any} size={14} color={color} />
      <Text style={[st.actionChipText, { color }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl, paddingVertical: Spacing.md,
  },
  backBtn: {
    width: 40, height: 40, borderRadius: BorderRadius.full,
    backgroundColor: Colors.surfaceSecondary, alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: { fontSize: 20, fontFamily: FontFamily.bold, color: Colors.text },
  headerBtn: {
    width: 34, height: 34, borderRadius: BorderRadius.full,
    backgroundColor: Colors.surfaceSecondary, alignItems: 'center', justifyContent: 'center',
  },

  // Quick actions
  quickRow: { flexDirection: 'row', gap: 8, marginBottom: Spacing.lg },
  quickChip: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 11, borderRadius: BorderRadius.lg, backgroundColor: Colors.surfaceSecondary,
  },
  quickLabel: { fontSize: 13, fontFamily: FontFamily.semibold, color: Colors.text },

  // Summary
  summaryCard: {
    flexDirection: 'row', padding: Spacing.xl,
    backgroundColor: Colors.surfaceSecondary, borderRadius: BorderRadius.xl, marginBottom: Spacing.lg,
  },
  summaryDivider: { width: 1, backgroundColor: Colors.surfaceTertiary, marginHorizontal: 4 },
  summaryVal: { fontSize: 20, fontFamily: FontFamily.bold },
  summaryLabel: { fontSize: 11, fontFamily: FontFamily.regular, color: Colors.textTertiary, marginTop: 2 },

  // Empty
  empty: { alignItems: 'center', paddingVertical: 48 },
  emptyTitle: { fontSize: 18, fontFamily: FontFamily.bold, color: Colors.text, marginTop: 12 },
  emptyDesc: { fontSize: 13, fontFamily: FontFamily.regular, color: Colors.textSecondary, marginTop: 4, textAlign: 'center' },
  emptyBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 20, paddingVertical: 10, borderRadius: BorderRadius.md, backgroundColor: P01Colors.cyan,
  },
  emptyBtnText: { fontSize: 14, fontFamily: FontFamily.bold, color: '#000' },

  // Section
  sectionTitle: { fontSize: 14, fontFamily: FontFamily.semibold, color: Colors.textSecondary, marginBottom: 10 },
  historyToggle: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: Spacing.xl, marginBottom: 10, paddingVertical: 4,
  },

  // Note card
  noteCard: {
    backgroundColor: Colors.surfaceSecondary, borderRadius: BorderRadius.xl,
    padding: 14, marginBottom: 8,
  },
  noteRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  noteIcon: { width: 38, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  noteAmount: { fontSize: 15, fontFamily: FontFamily.bold, color: Colors.text },
  noteSub: { fontSize: 12, fontFamily: FontFamily.regular, color: Colors.textSecondary, marginTop: 1 },
  timeText: { fontSize: 12, fontFamily: FontFamily.medium, color: P01Colors.yellow, marginRight: 4 },

  // Badge
  badge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 5, marginRight: 4 },
  badgeText: { fontSize: 9, fontFamily: FontFamily.bold },

  // Route progress
  progressTrack: { height: 4, borderRadius: 2, backgroundColor: Colors.surfaceTertiary, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 2, backgroundColor: P01Colors.pink },
  progressLabel: { fontSize: 11, fontFamily: FontFamily.regular, color: Colors.textTertiary, marginTop: 4 },

  // Expanded
  expandedSection: { marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: Colors.surfaceTertiary },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  detailLabel: { fontSize: 12, fontFamily: FontFamily.regular, color: Colors.textTertiary },
  detailValue: { fontSize: 12, fontFamily: FontFamily.mono, color: Colors.textSecondary },

  // Actions
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  actionChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: BorderRadius.sm,
  },
  actionChipText: { fontSize: 12, fontFamily: FontFamily.medium },

  // Footer
  footer: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8,
    marginTop: Spacing.xl, padding: Spacing.md,
  },
  footerText: { flex: 1, fontSize: 12, fontFamily: FontFamily.regular, color: Colors.textTertiary, lineHeight: 17 },
});

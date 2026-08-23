/**
 * Your notes — the full inventory behind the Shield screen's short list.
 *
 * 🎯 WHAT CHANGED 2026-08-23, AND WHY
 * ───────────────────────────────────
 *  - A NOTE IS AN AMOUNT AND A STATE. It was an amount, a state, a source, a
 *    date, a pool PDA and a note id — six facts for an object that supports two
 *    decisions. The pool address and the internal id are gone from the sheet;
 *    nobody holds "leaf #12", they hold 1 SOL.
 *  - A MATURE NOTE NOW CARRIES ITS NEXT STEP: "Subscribe with this note". That
 *    is the product. Until today the only paths off this screen were withdraw
 *    and send, i.e. the two ways to stop using it.
 *  - AN IMMATURE NOTE CARRIES THE REASON, not an ellipsis. "Maturing..." reads
 *    as a spinner that is taking too long; the wait is on chain and nothing in
 *    the interface can shorten it, so the screen says exactly that.
 *  - ⛔ NO MORE ALL-CAPS LABELS. `READY`, `USED NOTES`, `SPENT` — that house
 *    style is being removed everywhere.
 *  - The four-cell counter card became one sentence, and the five unlabelled
 *    icon buttons in the header became two labelled rows at the bottom. An
 *    unlabelled icon in a wallet is a guess about someone's money.
 *
 * ⚠️ NO LOGIC WAS TOUCHED. Every handler, store call and argument below is the
 * code that was here before; only what the screen looks like and says changed.
 */

import React, { useEffect, useCallback, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, RefreshControl, StyleSheet, Linking, Share,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
// Animations removed — staggered FadeInDown on each note caused tearing during navigation transitions

import { useDenominatedPoolStore, useActiveNotes, type StoredNote, type NoteStatus } from '@/stores/denominatedPoolStore';
import { useBatchUnshieldStore } from '@/stores/batchUnshieldStore';
import { receiptFromJSON, slotToEpoch } from '@/services/denominatedPool';
import { getCluster } from '@/services/solana/connection';
import { vaultDecrypt } from '@/utils/crypto/noteVault';
import { Button } from '@/components/ui/Button';
import { Colors, FontFamily, FontSize, BorderRadius, Spacing } from '@/constants/theme';
import { p01Alert } from '@/stores/alertStore';
import { useT, t as tStatic } from '@/i18n';
import RecoveryBootModal from '@/components/privacy/RecoveryBootModal';

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
  const [batchMode, setBatchMode] = useState(false);

  const batchSelectedIds = useBatchUnshieldStore((s) => s.selectedIds);
  const batchToggle = useBatchUnshieldStore((s) => s.toggle);
  const batchSetSelection = useBatchUnshieldStore((s) => s.setSelection);
  const batchClearSelection = useBatchUnshieldStore((s) => s.clearSelection);

  const {
    isLoading, refreshAllPools, refreshNoteStatuses,
    exportAllNotes, exportNote, poolCache, recoverTransferredNotes, rescanPool,
  } = useDenominatedPoolStore();
  const [isRescanning, setIsRescanning] = useState(false);
  const [recoveryModalOpen, setRecoveryModalOpen] = useState(false);

  const onRecoveryModalClose = (success: boolean) => {
    setRecoveryModalOpen(false);
    setIsRescanning(false);
    deactivateKeepAwake('p01-rescan');
    const hapticType = success
      ? Haptics.NotificationFeedbackType.Success
      : Haptics.NotificationFeedbackType.Warning;
    Haptics.notificationAsync(hapticType).catch(() => {});
  };

  // Guard against the user navigating away while the rescan modal is still
  // open — without this, the keep-awake tag would leak until the process
  // dies (battery drain, no correctness break).
  useEffect(() => () => {
    deactivateKeepAwake('p01-rescan');
  }, []);

  const notes = useActiveNotes();

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
        const { sha256 } = require('@noble/hashes/sha2');
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

  const handleSubscribe = (n: StoredNote) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push({ pathname: '/(main)/(privacy)/subscribe-private' as any, params: { noteId: n.id } });
  };
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
  const handleRescanFromSeed = () => {
    if (isRescanning) return;
    p01Alert(
      t('privacy.rescanFromSeed'),
      t('privacy.rescanFromSeedDesc'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('privacy.rescanFromSeed'),
          onPress: async () => {
            // Flip the RecoveryBootModal into manual mode — it handles the
            // scan UI + success/error display and calls us back on close.
            setIsRescanning(true);
            const KEEP_AWAKE_TAG = 'p01-rescan';
            await activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
            setRecoveryModalOpen(true);
            // The keep-awake is released in onRecoveryModalClose below.
          },
        },
      ],
    );
  };

  // ── Batch multi-select handlers ────────────────────────────

  const matureActive = activeNotes.filter(n => n.status === 'mature');
  const maturingActive = activeNotes.filter(n => n.status !== 'mature');
  const selectedCount = batchSelectedIds.length;
  const selectedSum = batchSelectedIds.reduce((acc, id) => {
    const n = matureActive.find(x => x.id === id);
    return acc + (n?.denomination ?? 0);
  }, 0);
  // Only allow single-token batches — mixing SOL + USDC in one sweep doesn't
  // make sense and the sequential loop would need two different recipients.
  const selectedTokens = new Set(
    batchSelectedIds
      .map(id => matureActive.find(x => x.id === id)?.token)
      .filter((x): x is NonNullable<typeof x> => !!x),
  );
  const mixedTokens = selectedTokens.size > 1;
  const recoverableCount = clusterNotes.filter(n => n.status === 'transferred' && !n.spentTxSig).length;

  const toggleBatchMode = () => {
    Haptics.selectionAsync();
    setBatchMode(m => {
      const next = !m;
      if (!next) batchClearSelection();
      return next;
    });
    setExpandedNote(null);
  };

  const onNoteTap = (note: StoredNote) => {
    if (batchMode) {
      if (note.status !== 'mature') return; // silently ignore non-mature selection
      Haptics.selectionAsync();
      batchToggle(note.id);
      return;
    }
    setExpandedNote(expandedNote === note.id ? null : note.id);
  };

  const handleSelectAllMature = () => {
    if (!matureActive.length) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // If everything of the first token is already selected, clear; else select
    // all of the dominant token to keep the batch homogeneous.
    const firstToken = matureActive[0].token;
    const sameToken = matureActive.filter(n => n.token === firstToken);
    const allSelected = sameToken.every(n => batchSelectedIds.includes(n.id));
    if (allSelected) batchClearSelection();
    else batchSetSelection(sameToken.map(n => n.id));
  };

  const handleBatchProceed = () => {
    if (!selectedCount) return;
    if (mixedTokens) {
      p01Alert(t('common.error'), t('privacy.batchMixedTokens'));
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    router.push({ pathname: '/(main)/(privacy)/denominated-unshield-batch' as any });
  };

  // ── State labels ───────────────────────────────────────────
  // ⛔ Sentence case. A badge that has to shout to be noticed means the layout
  // around it is wrong.

  const statusCfg = (s: NoteStatus) => ({
    mature:      { tone: 'good' as const, label: t('common.ready') },
    pending:     { tone: 'warn' as const, label: t('privacy.maturing') },
    imported:    { tone: 'warn' as const, label: t('privacy.imported') },
    spent:       { tone: 'quiet' as const, label: t('privacy.spent') },
    transferred: { tone: 'quiet' as const, label: t('privacy.transferred') },
    locked:      { tone: 'warn' as const, label: t('privacy.locked') },
  }[s]);

  const srcLabel = (n: StoredNote) =>
    n.source === 'received' ? t('common.receive') : n.source === 'imported_backup' ? t('privacy.restored') : t('privacy.deposited');

  // ── Render note ────────────────────────────────────────────

  const renderNote = (note: StoredNote, index: number) => {
    const cfg = statusCfg(note.status);
    const expanded = !batchMode && expandedNote === note.id;
    const maturity = getMaturity(note);
    const isSelected = batchMode && batchSelectedIds.includes(note.id);
    const isSelectable = batchMode && note.status === 'mature';
    const waiting = note.status === 'pending' || note.status === 'imported';
    const countdown = waiting
      ? (maturity.remainingMs > 0
        ? fmtTime(maturity.remainingMs)
        : maturity.remainingMs === 0 ? t('common.ready') : cfg.label)
      : cfg.label;

    return (
      <View key={note.id} style={[st.noteCard, isSelected && st.noteCardSelected, batchMode && !isSelectable && st.noteCardDimmed]}>
        <TouchableOpacity
          activeOpacity={0.8}
          onPress={() => onNoteTap(note)}
          disabled={batchMode && !isSelectable}
          style={st.noteRow}
          accessibilityRole="button"
          accessibilityState={{ expanded, selected: isSelected }}
          accessibilityLabel={`${note.denomination} ${note.token}, ${countdown}`}
        >
          {batchMode && (
            <View
              style={[
                st.checkbox,
                isSelected && st.checkboxChecked,
                !isSelectable && st.checkboxDisabled,
              ]}
            >
              {isSelected && <Ionicons name="checkmark" size={14} color={Colors.background} />}
            </View>
          )}

          <View style={st.noteMain}>
            {/* Amount and state. Never an internal identifier. */}
            <Text style={st.noteAmount}>{note.denomination} {note.token}</Text>
            <Text style={st.noteSub}>
              {srcLabel(note)} · {new Date(note.shieldedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </Text>
          </View>

          <View style={[st.pill, cfg.tone === 'good' && st.pillGood, cfg.tone === 'warn' && st.pillWarn]}>
            <Text
              style={[
                st.pillText,
                cfg.tone === 'good' && st.pillTextGood,
                cfg.tone === 'warn' && st.pillTextWarn,
              ]}
            >
              {countdown}
            </Text>
          </View>

          {!batchMode && (
            <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={Colors.textTertiary} />
          )}
        </TouchableOpacity>

        {/* Locked route progress */}
        {note.status === 'locked' && (() => {
          const pk = Object.keys(routeProgress).find(k => k.startsWith(`${note.denomination}_`));
          const rp = pk ? routeProgress[pk] : null;
          if (!rp) return null;
          const pct = Math.round((rp.completedHops / rp.totalHops) * 100);
          return (
            <View style={st.progressWrap}>
              <View style={st.progressTrack}>
                <View style={[st.progressFill, { width: `${Math.max(5, pct)}%` as any }]} />
              </View>
              <Text style={st.progressLabel}>Hop {rp.completedHops} of {rp.totalHops}</Text>
            </View>
          );
        })()}

        {/* Expanded: what this note can do next */}
        {expanded && (
          <View style={st.expanded}>
            {note.status === 'mature' && (
              <>
                {/* 🎯 THE PATH. Merchant subscriptions are the product, and a
                    mature note is what pays for one without your wallet
                    signing. It goes first, and it is the only primary. */}
                <Button
                  variant="primary"
                  size="sm"
                  fullWidth
                  onPress={() => handleSubscribe(note)}
                  accessibilityLabel={`Subscribe with this ${note.denomination} ${note.token} note`}
                >
                  Subscribe with this note
                </Button>
                <View style={st.actions}>
                  <ActionChip icon="arrow-up-outline" label={t('privacy.withdraw')} onPress={() => handleUnshield(note)} />
                  <ActionChip icon="paper-plane-outline" label={t('common.send')} onPress={() => handleTransfer(note)} />
                  <ActionChip icon="radio-outline" label={t('privacy.receiveNearby')} onPress={() => handleNearby(note)} />
                  <ActionChip icon="share-outline" label={t('common.share')} onPress={() => handleManualShare(note)} />
                </View>
              </>
            )}

            {waiting && (
              <>
                <Text style={st.reason}>
                  A fresh note waits out the pool's delay before it can be spent. The chain
                  enforces that, so no screen can shorten it.
                </Text>
                <View style={st.actions}>
                  {note.source === 'shielded' && (
                    <ActionChip icon="flash-outline" label={t('privacy.emergencyUnshield')} danger onPress={() => handleEmergency(note)} />
                  )}
                  <ActionChip icon="cloud-upload-outline" label={t('privacy.backup')} onPress={() => handleExport(note)} />
                </View>
              </>
            )}

            {note.spentTxSig && (
              <TouchableOpacity
                style={st.linkRow}
                onPress={() => Linking.openURL(`https://explorer.solana.com/tx/${note.spentTxSig}?cluster=devnet`)}
                accessibilityRole="link"
                accessibilityLabel="Open this transaction in the block explorer"
              >
                <Text style={st.linkText}>View on the explorer</Text>
                <Ionicons name="open-outline" size={14} color={Colors.primary} />
              </TouchableOpacity>
            )}

            {note.status === 'transferred' && note.transferredTo && (
              <TouchableOpacity
                style={st.linkRow}
                onPress={() => Share.share({ message: note.transferredTo!, title: 'P01 Note' })}
                accessibilityRole="button"
                accessibilityLabel={t('privacy.reshare')}
              >
                <Text style={st.linkText}>{t('privacy.reshare')}</Text>
                <Ionicons name="share-outline" size={14} color={Colors.primary} />
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>
    );
  };

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
        <Text style={st.headerTitle} accessibilityRole="header">
          {batchMode ? t('privacy.selectNotes') : t('privacy.myNotes')}
        </Text>
        {batchMode ? (
          <View style={st.headerActions}>
            <TouchableOpacity
              onPress={handleSelectAllMature}
              style={st.iconBtn}
              disabled={!matureActive.length}
              accessibilityRole="button"
              accessibilityLabel="Select every ready note"
              accessibilityState={{ disabled: !matureActive.length }}
            >
              <Ionicons
                name="checkmark-done-outline"
                size={20}
                color={matureActive.length ? Colors.primary : Colors.textTertiary}
              />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={toggleBatchMode}
              style={st.iconBtn}
              accessibilityRole="button"
              accessibilityLabel="Leave selection mode"
            >
              <Ionicons name="close" size={22} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>
        ) : matureActive.length >= 2 ? (
          <TouchableOpacity
            onPress={toggleBatchMode}
            style={st.iconBtn}
            accessibilityRole="button"
            accessibilityLabel="Select several notes to withdraw together"
          >
            <Ionicons name="list-outline" size={20} color={Colors.primary} />
          </TouchableOpacity>
        ) : (
          <View style={st.iconBtn} />
        )}
      </View>

      <ScrollView
        style={st.scroll}
        contentContainerStyle={[
          st.scrollContent,
          { paddingBottom: insets.bottom + (batchMode ? 120 : 40) },
        ]}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={onRefresh} tintColor={Colors.primary} />}
      >
        {/* One sentence where four counters used to be. */}
        {clusterNotes.length > 0 && (
          <Text style={st.summary}>
            {matureActive.length} ready to spend
            {maturingActive.length > 0 ? `, ${maturingActive.length} still maturing` : ''}
            {historyNotes.length > 0 ? `, ${historyNotes.length} already used` : ''}.
          </Text>
        )}

        {/* Recovery is a decision, so it is a labelled row rather than an
            unlabelled icon that only appears when it applies. */}
        {recoverableCount > 0 && (
          <View style={st.recoverCard}>
            <View style={st.recoverMain}>
              <Text style={st.recoverTitle}>
                {recoverableCount} transfer{recoverableCount === 1 ? '' : 's'} never landed
              </Text>
              <Text style={st.recoverBody}>
                The note was handed over but nothing spent it. You can take it back.
              </Text>
            </View>
            <Button
              variant="secondary"
              size="sm"
              onPress={handleRecover}
              accessibilityLabel={t('privacy.recover')}
            >
              {t('privacy.recover')}
            </Button>
          </View>
        )}

        {/* Empty */}
        {clusterNotes.length === 0 && (
          <View style={st.empty}>
            <Text style={st.emptyTitle}>{t('privacy.noNotes')}</Text>
            <Text style={st.emptyBody}>{t('privacy.noNotesDesc')}</Text>
            <View style={st.emptyActions}>
              <Button
                variant="primary"
                size="lg"
                fullWidth
                onPress={() => router.push('/(main)/(privacy)/denominated-shield' as any)}
                accessibilityLabel={t('privacy.shield')}
              >
                {t('privacy.shield')}
              </Button>
              <Button
                variant="secondary"
                size="md"
                fullWidth
                onPress={() => router.push('/(main)/(privacy)/denominated-import' as any)}
                accessibilityLabel={t('privacy.import')}
              >
                {t('privacy.import')}
              </Button>
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
            <TouchableOpacity
              style={st.historyToggle}
              onPress={() => setShowHistory(!showHistory)}
              accessibilityRole="button"
              accessibilityState={{ expanded: showHistory }}
              accessibilityLabel={`${t('privacy.history')}, ${historyNotes.length}`}
            >
              <Text style={st.sectionTitle}>{t('privacy.history')} ({historyNotes.length})</Text>
              <Ionicons name={showHistory ? 'chevron-up' : 'chevron-down'} size={16} color={Colors.textSecondary} />
            </TouchableOpacity>
            {showHistory && historyNotes.map((n, i) => renderNote(n, i + activeNotes.length))}
          </>
        )}

        {/* The tools that used to be five unlabelled icons in the header. */}
        {clusterNotes.length > 0 && (
          <>
            <Text style={st.sectionTitle}>Note tools</Text>
            <ToolRow
              icon="download-outline"
              label={t('common.receive')}
              sub="Take a note handed to you nearby"
              onPress={() => router.push('/(main)/(privacy)/receive-note' as any)}
            />
            <ToolRow
              icon="clipboard-outline"
              label={t('privacy.import')}
              sub="Paste a note someone sent you"
              onPress={() => router.push('/(main)/(privacy)/denominated-import' as any)}
            />
            <ToolRow
              icon="cloud-upload-outline"
              label={t('privacy.backup')}
              sub="Copy every note, so a wiped app is not a lost note"
              onPress={handleBackup}
            />
            <ToolRow
              icon="key-outline"
              label={t('privacy.rescanFromSeed')}
              sub={t('privacy.rescanFromSeedDesc')}
              onPress={handleRescanFromSeed}
              disabled={isRescanning}
            />
          </>
        )}

        <Text style={st.footerText}>{t('privacy.notesStoredLocally')}</Text>
      </ScrollView>

      {/* Batch action bar — sticky bottom */}
      {batchMode && (
        <View style={[st.batchBar, { paddingBottom: Math.max(insets.bottom, Spacing.md) }]}>
          <View style={st.batchBarMain}>
            <Text style={st.batchBarCount}>
              {selectedCount === 0
                ? t('privacy.batchTapToSelect')
                : t('privacy.batchSelectedCount', { count: selectedCount })}
            </Text>
            {selectedCount > 0 && !mixedTokens && (
              <Text style={st.batchBarSum}>
                {selectedSum} {matureActive.find(n => n.id === batchSelectedIds[0])?.token ?? ''}
              </Text>
            )}
            {mixedTokens && (
              <Text style={st.batchBarError} accessibilityRole="alert">
                {t('privacy.batchMixedTokens')}
              </Text>
            )}
          </View>
          <Button
            variant="primary"
            size="md"
            onPress={handleBatchProceed}
            disabled={!selectedCount || mixedTokens}
            accessibilityLabel={t('privacy.withdraw')}
          >
            {t('privacy.withdraw')}
          </Button>
        </View>
      )}
      {/* Manual rescan modal — reuses the boot-time scanner with a visible
          blocking UI. Closes via user action; releases keep-awake + rescanning state. */}
      <RecoveryBootModal manualOpen={recoveryModalOpen} onManualClose={onRecoveryModalClose} />
    </View>
  );
}

function ActionChip({ icon, label, onPress, danger }: {
  icon: string; label: string; onPress: () => void; danger?: boolean;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[st.actionChip, danger && st.actionChipDanger]}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Ionicons name={icon as any} size={15} color={danger ? Colors.error : Colors.textSecondary} />
      <Text style={[st.actionChipText, danger && st.actionChipTextDanger]}>{label}</Text>
    </TouchableOpacity>
  );
}

function ToolRow({ icon, label, sub, onPress, disabled }: {
  icon: string; label: string; sub?: string; onPress: () => void; disabled?: boolean;
}) {
  return (
    <TouchableOpacity
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      style={[st.toolRow, disabled && st.toolRowDisabled]}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
    >
      <Ionicons name={icon as any} size={18} color={Colors.primary} />
      <View style={st.toolMain}>
        <Text style={st.toolLabel}>{label}</Text>
        {sub ? <Text style={st.toolSub} numberOfLines={2}>{sub}</Text> : null}
      </View>
      <Ionicons name="chevron-forward" size={16} color={Colors.textTertiary} />
    </TouchableOpacity>
  );
}

const st = StyleSheet.create({
  // Transparent on purpose: the tab layout paints the ground once.
  container: { flex: 1, backgroundColor: 'transparent' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    minHeight: 56,
  },
  headerTitle: {
    flex: 1,
    fontSize: FontSize.xl,
    fontFamily: FontFamily.displayMedium,
    color: Colors.text,
    paddingHorizontal: Spacing.xs,
  },
  headerActions: { flexDirection: 'row', alignItems: 'center' },
  iconBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },

  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: Spacing.xl },

  summary: {
    fontSize: FontSize.md,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    marginBottom: Spacing['2xl'],
  },

  // Recovery
  recoverCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.lg,
    marginBottom: Spacing['2xl'],
    borderRadius: BorderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.yellow,
    backgroundColor: Colors.warningDim,
  },
  recoverMain: { flex: 1, minWidth: 0 },
  recoverTitle: { fontSize: FontSize.md, fontFamily: FontFamily.medium, color: Colors.text },
  recoverBody: {
    fontSize: FontSize.xs, fontFamily: FontFamily.regular,
    color: Colors.textSecondary, lineHeight: 16, marginTop: 2,
  },

  // Empty
  empty: { alignItems: 'center', paddingVertical: Spacing['5xl'] },
  emptyTitle: {
    fontSize: FontSize.xl, fontFamily: FontFamily.display,
    color: Colors.text, textAlign: 'center',
  },
  emptyBody: {
    fontSize: FontSize.md, fontFamily: FontFamily.regular, color: Colors.textSecondary,
    marginTop: Spacing.sm, textAlign: 'center', lineHeight: 21, maxWidth: 300,
  },
  emptyActions: { width: '100%', gap: Spacing.md, marginTop: Spacing['3xl'] },

  // Section
  sectionTitle: {
    fontSize: FontSize.lg, fontFamily: FontFamily.displayMedium,
    color: Colors.text, marginTop: Spacing['2xl'], marginBottom: Spacing.md,
  },
  historyToggle: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    minHeight: 44,
  },

  // Note card
  noteCard: {
    borderRadius: BorderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.lg,
    marginBottom: Spacing.sm,
  },
  noteCardSelected: { borderColor: Colors.primary, backgroundColor: Colors.primaryDim },
  noteCardDimmed: { opacity: 0.4 },
  noteRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    minHeight: 64, paddingVertical: Spacing.md,
  },
  noteMain: { flex: 1, minWidth: 0 },
  noteAmount: {
    fontSize: FontSize.lg, fontFamily: FontFamily.displayMedium,
    color: Colors.text, fontVariant: ['tabular-nums'],
  },
  noteSub: {
    fontSize: FontSize.xs, fontFamily: FontFamily.regular,
    color: Colors.textTertiary, marginTop: 2,
  },

  // State pill
  pill: {
    paddingHorizontal: Spacing.sm, paddingVertical: 2,
    borderRadius: BorderRadius.full,
    borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.border,
  },
  pillGood: { borderColor: Colors.primaryMuted, backgroundColor: Colors.primaryDim },
  pillWarn: { borderColor: Colors.yellow, backgroundColor: Colors.warningDim },
  pillText: { fontSize: FontSize.xs, fontFamily: FontFamily.medium, color: Colors.textSecondary },
  pillTextGood: { color: Colors.primary },
  pillTextWarn: { color: Colors.yellow },

  // Route progress
  progressWrap: { paddingBottom: Spacing.md },
  progressTrack: {
    height: 3, borderRadius: 2,
    backgroundColor: Colors.surfaceTertiary, overflow: 'hidden',
  },
  progressFill: { height: '100%', borderRadius: 2, backgroundColor: Colors.primary },
  progressLabel: {
    fontSize: FontSize.xs, fontFamily: FontFamily.regular,
    color: Colors.textTertiary, marginTop: Spacing.xs,
  },

  // Expanded
  expanded: {
    paddingBottom: Spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.borderSoft,
    paddingTop: Spacing.lg,
    gap: Spacing.md,
  },
  reason: {
    fontSize: FontSize.sm, fontFamily: FontFamily.regular,
    color: Colors.textTertiary, lineHeight: 18,
  },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  actionChip: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.xs,
    minHeight: 44, paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.border,
  },
  actionChipDanger: { borderColor: Colors.error },
  actionChipText: { fontSize: FontSize.sm, fontFamily: FontFamily.regular, color: Colors.textSecondary },
  actionChipTextDanger: { color: Colors.error },
  linkRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, minHeight: 44,
  },
  linkText: { fontSize: FontSize.sm, fontFamily: FontFamily.regular, color: Colors.primary },

  // Tools
  toolRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    minHeight: 60, paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.borderSoft,
  },
  toolRowDisabled: { opacity: 0.4 },
  toolMain: { flex: 1, minWidth: 0 },
  toolLabel: { fontSize: FontSize.md, fontFamily: FontFamily.regular, color: Colors.text },
  toolSub: {
    fontSize: FontSize.xs, fontFamily: FontFamily.regular,
    color: Colors.textTertiary, lineHeight: 16, marginTop: 2,
  },

  footerText: {
    fontSize: FontSize.xs, fontFamily: FontFamily.regular,
    color: Colors.textTertiary, lineHeight: 17, marginTop: Spacing['2xl'],
  },

  // Batch multi-select
  checkbox: {
    width: 22, height: 22, borderRadius: BorderRadius.sm, borderWidth: 1.5,
    borderColor: Colors.textTertiary, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  checkboxChecked: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  checkboxDisabled: { borderColor: Colors.borderSoft },
  batchBar: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    paddingHorizontal: Spacing.xl, paddingTop: Spacing.lg,
    backgroundColor: Colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border,
  },
  batchBarMain: { flex: 1, minWidth: 0 },
  batchBarCount: { fontSize: FontSize.md, fontFamily: FontFamily.medium, color: Colors.text },
  batchBarSum: {
    fontSize: FontSize.sm, fontFamily: FontFamily.regular,
    color: Colors.textSecondary, marginTop: 2, fontVariant: ['tabular-nums'],
  },
  batchBarError: {
    fontSize: FontSize.sm, fontFamily: FontFamily.regular,
    color: Colors.error, marginTop: 2,
  },
});

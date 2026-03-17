import React, { useEffect, useCallback, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  StyleSheet,
  Linking,
  Share,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';

import {
  useDenominatedPoolStore,
  type StoredNote,
  type NoteStatus,
} from '@/stores/denominatedPoolStore';
import {
  receiptFromJSON,
  slotToEpoch,
} from '@/services/denominatedPool';
import { getCluster } from '@/services/solana/connection';
import { vaultDecrypt } from '@/utils/crypto/noteVault';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import { p01Alert } from '@/stores/alertStore';

const SLOTS_PER_EPOCH = 7200;
const DEFAULT_SLOT_DURATION_MS = 500; // fallback before we measure
// No hardcoded minimum — maturity is determined by on-chain epoch delay

function formatTimeRemaining(ms: number): string {
  if (ms <= 0) return 'Ready';
  const mins = Math.ceil(ms / 60_000);
  if (mins < 60) return `~${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return remainMins > 0 ? `~${hrs}h ${remainMins}m` : `~${hrs}h`;
}

/* ── Glass card wrapper ─────────────────────────────────────────── */
function GlassCard({ children, style }: { children: React.ReactNode; style?: any }) {
  return (
    <View style={[styles.glassOuter, style]}>
      <BlurView intensity={14} tint="dark" style={styles.glassBlur}>
        <LinearGradient
          colors={['rgba(57, 197, 187, 0.06)', 'rgba(255, 119, 168, 0.03)', 'transparent']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        {children}
      </BlurView>
    </View>
  );
}

interface RouteProgress {
  routeId: string;
  completedHops: number;
  totalHops: number;
  nextHopAt?: number;
  destination: string;
  status: string;
}

export default function DenominatedNotesScreen() {
  const router = useRouter();
  const [showHistory, setShowHistory] = useState(false);
  const [currentSlot, setCurrentSlot] = useState<number | null>(null);
  const [expandedNote, setExpandedNote] = useState<string | null>(null);
  const [routeProgress, setRouteProgress] = useState<Record<string, RouteProgress>>({});
  const [slotDurationMs, setSlotDurationMs] = useState(DEFAULT_SLOT_DURATION_MS);

  const {
    notes,
    isLoading,
    refreshAllPools,
    refreshNoteStatuses,
    exportAllNotes,
    exportNote,
    poolCache,
    recoverTransferredNotes,
  } = useDenominatedPoolStore();


  // On mount: deduplicate notes (same id = same commitment) and refresh on-chain status.
  // Notes recovered from the stale-session bug may be duplicates or already spent.
  useEffect(() => {
    const store = useDenominatedPoolStore.getState();
    const seen = new Map<string, typeof store.notes[0]>();
    for (const n of store.notes) {
      const existing = seen.get(n.id);
      if (!existing) { seen.set(n.id, n); continue; }
      // Keep the one with the most "terminal" status, or the newest
      if (n.status === 'spent' || (n.shieldedAt > existing.shieldedAt)) {
        seen.set(n.id, n);
      }
    }
    const deduped = [...seen.values()];
    if (deduped.length < store.notes.length) {
      console.log(`[DenomNotes] Deduped: ${store.notes.length} → ${deduped.length} notes`);
      useDenominatedPoolStore.setState({ notes: deduped });
    }
    // Refresh on-chain nullifier status to mark spent notes correctly
    refreshNoteStatuses().catch(() => {});

    // Load route progress for locked notes
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
        for (const route of routes) {
          if (route.status === 'completed' || route.status === 'failed') continue;
          const completed = route.hops.filter((h: any) => h.status === 'completed').length;
          const nextHop = route.hops.find((h: any) => h.status !== 'completed');
          // Key by denomination to match with notes
          const key = `${route.sourceDenomination}_${route.createdAt}`;
          progress[key] = {
            routeId: route.id,
            completedHops: completed,
            totalHops: route.hops.length,
            nextHopAt: nextHop?.scheduledAt,
            destination: route.destination,
            status: route.status,
          };
        }
        setRouteProgress(progress);
      } catch {}
    })();
  }, []);

  const cluster = getCluster();
  const clusterNotes = notes.filter(n => (n.cluster ?? 'devnet') === cluster);
  const activeNotes = clusterNotes.filter(n => n.status !== 'spent' && n.status !== 'transferred');
  const historyNotes = clusterNotes.filter(n => n.status === 'spent' || n.status === 'transferred');

  // Measure real slot duration by taking two readings, then poll every 30s
  useEffect(() => {
    let cancelled = false;
    let interval: ReturnType<typeof setInterval>;

    const init = async () => {
      try {
        const { getConnection } = await import('@/services/solana/connection');
        const conn = getConnection();

        // First reading
        const slot1 = await conn.getSlot('confirmed');
        const time1 = Date.now();
        if (cancelled) return;
        console.log('[DenomNotes] Initial slot:', slot1);
        setCurrentSlot(slot1);

        // Second reading after 3s to measure real slot speed
        setTimeout(async () => {
          if (cancelled) return;
          try {
            const slot2 = await conn.getSlot('confirmed');
            const time2 = Date.now();
            const slotDiff = slot2 - slot1;
            const timeDiff = time2 - time1;
            if (slotDiff > 0) {
              const measured = timeDiff / slotDiff;
              console.log('[DenomNotes] Measured slot duration:', measured.toFixed(0), 'ms');
              // Clamp to reasonable range (200-800ms)
              setSlotDurationMs(Math.max(200, Math.min(800, measured)));
            }
            if (!cancelled) setCurrentSlot(slot2);
          } catch (e) {
            console.warn('[DenomNotes] Second slot read failed:', e);
          }
        }, 3000);

        // Ongoing polling every 30s
        interval = setInterval(async () => {
          if (cancelled) return;
          try {
            const s = await conn.getSlot('confirmed');
            if (!cancelled) setCurrentSlot(s);
          } catch {}
        }, 30_000);
      } catch {
        // Non-critical — slot polling will retry in 30s
      }
    };

    refreshNoteStatuses();
    init();
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const getMaturityInfo = useCallback((note: StoredNote) => {
    if (note.status === 'mature') {
      return { isMature: true, remainingMs: 0 };
    }
    if (!currentSlot) {
      console.log('[DenomNotes] getMaturityInfo: no currentSlot yet');
      return { isMature: false, remainingMs: -1 }; // no slot data yet
    }

    try {
      const receipt = receiptFromJSON(vaultDecrypt(note.receiptJSON));
      const currentEpoch = slotToEpoch(currentSlot);
      const cached = poolCache[note.poolPDA];
      const epochDelay = cached?.info.epochDelay ?? 1n;
      const dynamicDelay = BigInt(cached?.info.dynamicDelay ?? 2);
      const totalDelay = epochDelay + dynamicDelay;
      const minEpoch = currentEpoch - totalDelay;

      console.log('[DenomNotes] maturity check:', {
        currentSlot,
        currentEpoch: currentEpoch.toString(),
        depositEpoch: receipt.depositEpoch.toString(),
        totalDelay: totalDelay.toString(),
        minEpoch: minEpoch.toString(),
        isMature: receipt.depositEpoch <= minEpoch,
      });

      if (receipt.depositEpoch <= minEpoch) {
        return { isMature: true, remainingMs: 0 };
      }

      // Maturity slot = (depositEpoch + totalDelay) * SLOTS_PER_EPOCH
      const maturitySlot = Number(receipt.depositEpoch + totalDelay) * SLOTS_PER_EPOCH;
      const slotsLeft = Math.max(0, maturitySlot - currentSlot);
      const remainingMs = slotsLeft * slotDurationMs;
      console.log('[DenomNotes] time remaining:', formatTimeRemaining(remainingMs), `(${slotsLeft} slots)`);
      return { isMature: false, remainingMs };
    } catch (e) {
      console.error('[DenomNotes] getMaturityInfo error:', e);
      return { isMature: false, remainingMs: -1 };
    }
  }, [currentSlot, slotDurationMs, poolCache]);

  const onRefresh = useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await refreshAllPools();
  }, [refreshAllPools]);

  const handleUnshield = (note: StoredNote) => {
    if (note.status !== 'mature') {
      p01Alert('Not Ready', 'This note is still maturing. Please wait ~1 epoch (~1 hour).');
      return;
    }
    router.push({
      pathname: '/(main)/(privacy)/denominated-unshield' as any,
      params: { noteId: note.id },
    });
  };

  const handleTransfer = (note: StoredNote) => {
    if (note.status !== 'mature') {
      p01Alert('Not Ready', 'This note must be mature before transfer.');
      return;
    }
    router.push({
      pathname: '/(main)/(privacy)/denominated-transfer' as any,
      params: { noteId: note.id },
    });
  };

  const handleEmergencyUnshield = (note: StoredNote) => {
    p01Alert(
      'Emergency Unshield',
      'PRIVACY WARNING: Emergency unshield bypasses the maturity period. ' +
      'This withdrawal will be distinguishable on-chain, reducing your privacy.\n\n' +
      'Only use this if you urgently need the funds.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Proceed',
          style: 'destructive',
          onPress: () => {
            router.push({
              pathname: '/(main)/(privacy)/denominated-unshield' as any,
              params: { noteId: note.id, emergency: '1' },
            });
          },
        },
      ],
    );
  };

  const handleExportNote = async (note: StoredNote) => {
    try {
      const encoded = exportNote(note.id);
      await Clipboard.setStringAsync(encoded);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      p01Alert(
        'Note Exported',
        'Note backup copied to clipboard. Store it safely — it contains your private keys. Clipboard will be cleared in 60 seconds.',
      );
      // Security: Auto-clear clipboard after 60 seconds (contains private keys)
      setTimeout(async () => {
        try {
          const current = await Clipboard.getStringAsync();
          if (current === encoded) {
            await Clipboard.setStringAsync('');
          }
        } catch (_) {}
      }, 60000);
    } catch (err) {
      p01Alert('Export Failed', (err as Error).message);
    }
  };

  const handleManualShare = (note: StoredNote) => {
    p01Alert(
      'Less Secure Sharing',
      'Nearby sharing uses end-to-end encryption. Manual sharing exposes your note to other apps on your device.\n\nOnly use this if Nearby isn\'t available.',
      [
        {
          text: 'Copy & Share',
          onPress: async () => {
            try {
              const encoded = exportNote(note.id);
              await Clipboard.setStringAsync(encoded);
              setTimeout(() => Clipboard.setStringAsync(''), 60000);
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              Share.share({ message: encoded, title: 'Protocol 01 — Private Note' });
            } catch (err) {
              p01Alert('Error', (err as Error).message);
            }
          },
        },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  };

  const handleNearbyShare = (note: StoredNote) => {
    try {
      const encoded = exportNote(note.id);
      router.push({
        pathname: '/(main)/(privacy)/share-note' as any,
        params: { noteData: encoded, noteId: note.id },
      });
    } catch (err) {
      p01Alert('Error', (err as Error).message);
    }
  };

  const handleBackup = () => {
    const encoded = exportAllNotes();
    if (encoded.length === 0) {
      p01Alert('No Notes', 'No active notes to back up.');
      return;
    }
    p01Alert(
      'Backup Notes',
      `${encoded.length} note(s) will be copied. Keep this data safe — it contains your private keys.`,
      [
        {
          text: 'Copy to Clipboard',
          onPress: async () => {
            await Clipboard.setStringAsync(JSON.stringify(encoded));
            setTimeout(() => Clipboard.setStringAsync(''), 60000);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          },
        },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  };

  const handleImport = () => {
    router.push('/(main)/(privacy)/denominated-import' as any);
  };

  const handleRecoverNotes = () => {
    const transferredCount = clusterNotes.filter(n => n.status === 'transferred' && !n.spentTxSig).length;
    if (transferredCount === 0) {
      p01Alert('Nothing to Recover', 'No failed transfers found.');
      return;
    }
    p01Alert(
      'Recover Notes',
      `Found ${transferredCount} note(s) marked as transferred but never confirmed on-chain. ` +
      'This can happen if a nearby share (NFC/Bluetooth) failed mid-transfer.\n\n' +
      'Recover them?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Recover',
          onPress: () => {
            const count = recoverTransferredNotes();
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            p01Alert('Recovered', `${count} note(s) restored to your active notes.`);
          },
        },
      ],
    );
  };

  const handleViewTx = (txSig: string) => {
    Linking.openURL(`https://explorer.solana.com/tx/${txSig}?cluster=devnet`);
  };

  const handleReshareNote = async (note: StoredNote) => {
    if (!note.transferredTo) return;
    await Share.share({
      message: note.transferredTo,
      title: 'Protocol 01 — Private Note',
    });
  };

  const statusConfig = (status: NoteStatus) => {
    switch (status) {
      case 'mature':
        return {
          icon: 'checkmark-circle' as const,
          color: P01Colors.cyan,
          label: 'Ready',
          bgColor: P01Colors.cyanDim,
        };
      case 'pending':
        return {
          icon: 'time' as const,
          color: P01Colors.yellow,
          label: 'Maturing',
          bgColor: P01Colors.yellowDim,
        };
      case 'imported':
        return {
          icon: 'download' as const,
          color: '#8B8BFF',
          label: 'Imported',
          bgColor: 'rgba(139, 139, 255, 0.1)',
        };
      case 'spent':
        return {
          icon: 'close-circle' as const,
          color: Colors.textTertiary,
          label: 'Spent',
          bgColor: 'rgba(255, 255, 255, 0.05)',
        };
      case 'transferred':
        return {
          icon: 'swap-horizontal' as const,
          color: '#8B8BFF',
          label: 'Transferred',
          bgColor: 'rgba(139, 139, 255, 0.1)',
        };
      case 'locked':
        return {
          icon: 'lock-closed' as const,
          color: P01Colors.pink,
          label: 'Locked',
          bgColor: P01Colors.pinkDim,
        };
    }
  };

  const sourceLabel = (note: StoredNote) => {
    switch (note.source) {
      case 'shielded': return 'Deposited';
      case 'received': return 'Received';
      case 'imported_backup': return 'Restored';
      default: return 'Deposited';
    }
  };

  const renderNote = (note: StoredNote, index: number) => {
    const cfg = statusConfig(note.status);

    return (
      <Animated.View key={note.id} entering={FadeInUp.delay(100 + index * 60)}>
        <GlassCard style={{ marginBottom: Spacing.md }}>
          <View style={styles.noteCardInner}>
            <View style={styles.noteHeader}>
              <View style={styles.noteLeft}>
                <View style={[styles.statusIcon, { backgroundColor: cfg.bgColor }]}>
                  <Ionicons name={cfg.icon} size={20} color={cfg.color} />
                </View>
                <View>
                  <Text style={styles.noteAmount}>{note.denomination} {note.token}</Text>
                  <Text style={styles.noteTime}>
                    {sourceLabel(note)} · {new Date(note.shieldedAt).toLocaleString()}
                  </Text>
                </View>
              </View>
              <View style={[styles.statusBadge, { borderColor: cfg.color }]}>
                <Text style={[styles.statusText, { color: cfg.color }]}>{cfg.label}</Text>
              </View>
            </View>

            {/* Pool address (truncated) */}
            <View style={styles.noteDetail}>
              <Text style={styles.noteDetailLabel}>Pool</Text>
              <Text style={styles.noteDetailValue}>
                {note.poolPDA.slice(0, 12)}...{note.poolPDA.slice(-6)}
              </Text>
            </View>

            <View style={styles.noteDetail}>
              <Text style={styles.noteDetailLabel}>Note ID</Text>
              <Text style={styles.noteDetailValue}>{note.id}</Text>
            </View>

            {note.spentTxSig && (
              <TouchableOpacity style={styles.noteDetail} onPress={() => handleViewTx(note.spentTxSig!)}>
                <Text style={styles.noteDetailLabel}>Tx</Text>
                <Text style={[styles.noteDetailValue, { color: P01Colors.cyan }]}>
                  {note.spentTxSig.slice(0, 16)}... ↗
                </Text>
              </TouchableOpacity>
            )}

            {note.status === 'transferred' && note.transferredTo && (
              <TouchableOpacity style={styles.noteDetail} onPress={() => handleReshareNote(note)}>
                <Text style={styles.noteDetailLabel}>Sent to</Text>
                <Text style={[styles.noteDetailValue, { color: '#8B8BFF' }]}>
                  Re-share note link ↗
                </Text>
              </TouchableOpacity>
            )}

            {/* Status + Actions */}
            {note.status === 'mature' && (
              <>
                <TouchableOpacity
                  style={styles.readyBanner}
                  onPress={() => setExpandedNote(expandedNote === note.id ? null : note.id)}
                  activeOpacity={0.7}
                >
                  <Ionicons name="shield-checkmark" size={14} color={P01Colors.green} />
                  <Text style={[styles.readyBannerText, { flex: 1 }]}>Ready</Text>
                  <Ionicons
                    name={expandedNote === note.id ? 'chevron-up' : 'chevron-down'}
                    size={14}
                    color={P01Colors.green}
                  />
                </TouchableOpacity>
                {expandedNote === note.id && (
                  <View style={styles.compactActions}>
                    <TouchableOpacity style={styles.compactBtn} onPress={() => handleUnshield(note)}>
                      <Ionicons name="wallet-outline" size={16} color={P01Colors.cyan} />
                      <Text style={[styles.compactBtnText, { color: P01Colors.cyan }]}>Withdraw</Text>
                    </TouchableOpacity>
                    <View style={styles.compactDivider} />
                    <TouchableOpacity style={styles.compactBtn} onPress={() => handleTransfer(note)}>
                      <Ionicons name="send-outline" size={16} color={P01Colors.pink} />
                      <Text style={[styles.compactBtnText, { color: P01Colors.pink }]}>Send</Text>
                    </TouchableOpacity>
                    <View style={styles.compactDivider} />
                    <TouchableOpacity style={styles.compactBtn} onPress={() => handleNearbyShare(note)}>
                      <Ionicons name="radio-outline" size={16} color="#6C8EFF" />
                      <Text style={[styles.compactBtnText, { color: '#6C8EFF' }]}>Nearby</Text>
                    </TouchableOpacity>
                    <View style={styles.compactDivider} />
                    <TouchableOpacity style={styles.compactBtn} onPress={() => handleManualShare(note)}>
                      <Ionicons name="share-outline" size={16} color={Colors.textSecondary} />
                      <Text style={[styles.compactBtnText, { color: Colors.textSecondary }]}>Share</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </>
            )}
            {note.status === 'locked' && (() => {
              // Find matching route progress
              const progressKey = Object.keys(routeProgress).find(k =>
                k.startsWith(`${note.denomination}_`)
              );
              const rp = progressKey ? routeProgress[progressKey] : null;
              const pct = rp ? Math.round((rp.completedHops / rp.totalHops) * 100) : 0;
              const nextIn = rp?.nextHopAt
                ? formatTimeRemaining(rp.nextHopAt - Date.now())
                : null;
              return (
                <>
                  <View style={styles.lockedBanner}>
                    <Ionicons name="lock-closed" size={14} color={P01Colors.pink} />
                    <Text style={styles.lockedBannerText}>
                      {rp ? `Routing · Hop ${rp.completedHops}/${rp.totalHops}` : 'Locked'}
                    </Text>
                  </View>
                  {rp && (
                    <View style={styles.progressContainer}>
                      <View style={styles.progressBar}>
                        <View style={[styles.progressFill, { width: `${Math.max(5, pct)}%` as any }]} />
                      </View>
                      <View style={styles.progressInfo}>
                        <Text style={styles.progressText}>
                          {pct}% complete
                        </Text>
                        {nextIn && (
                          <Text style={styles.progressText}>
                            Next hop in {nextIn}
                          </Text>
                        )}
                      </View>
                      <Text style={styles.progressDest}>
                        To: {rp.destination.slice(0, 8)}...{rp.destination.slice(-4)}
                      </Text>
                    </View>
                  )}
                </>
              );
            })()}
            {(note.status === 'pending' || note.status === 'imported') && (() => {
              const maturity = getMaturityInfo(note);
              const timeStr = maturity.remainingMs > 0
                ? formatTimeRemaining(maturity.remainingMs)
                : maturity.remainingMs === 0 ? 'Ready' : 'Calculating...';
              return (
                <>
                  <View style={styles.pendingBanner}>
                    <Ionicons name="hourglass-outline" size={14} color={P01Colors.yellow} />
                    <Text style={styles.pendingBannerText}>
                      Available in {timeStr}
                    </Text>
                  </View>
                  <View style={styles.noteActions}>
                    {note.source === 'shielded' && (
                      <TouchableOpacity
                        style={[styles.actionBtn, { backgroundColor: Colors.errorDim }]}
                        onPress={() => handleEmergencyUnshield(note)}
                      >
                        <Ionicons name="flash" size={16} color={Colors.error} />
                        <Text style={[styles.actionText, { color: Colors.error }]}>Emergency</Text>
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity
                      style={[styles.actionBtn, { backgroundColor: 'rgba(255, 255, 255, 0.05)' }]}
                      onPress={() => handleExportNote(note)}
                    >
                      <Ionicons name="cloud-upload-outline" size={16} color={Colors.textSecondary} />
                      <Text style={[styles.actionText, { color: Colors.textSecondary }]}>Backup</Text>
                    </TouchableOpacity>
                  </View>
                </>
              );
            })()}
          </View>
        </GlassCard>
      </Animated.View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <Animated.View entering={FadeInDown.delay(50)} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={22} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>My Notes</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {clusterNotes.some(n => n.status === 'transferred' && !n.spentTxSig) && (
            <TouchableOpacity onPress={handleRecoverNotes} style={styles.headerActionBtn}>
              <Ionicons name="refresh-circle-outline" size={18} color={P01Colors.yellow} />
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={handleBackup} style={styles.headerActionBtn}>
            <Ionicons name="cloud-upload-outline" size={18} color={Colors.textSecondary} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => router.push('/(main)/(privacy)/denominated-shield' as any)}
            style={styles.addBtn}
          >
            <Ionicons name="add" size={22} color={P01Colors.cyan} />
          </TouchableOpacity>
        </View>
      </Animated.View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={isLoading} onRefresh={onRefresh} tintColor={P01Colors.cyan} />
        }
      >
        {/* Quick actions: Receive + Import */}
        <Animated.View entering={FadeInUp.delay(80)}>
          <View style={styles.quickActions}>
            <TouchableOpacity
              style={styles.quickActionBtn}
              onPress={() => router.push('/(main)/(privacy)/receive-note' as any)}
            >
              <BlurView intensity={12} tint="dark" style={styles.quickActionBlur}>
                <LinearGradient
                  colors={['rgba(57, 197, 187, 0.06)', 'rgba(255, 119, 168, 0.03)', 'transparent']}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={StyleSheet.absoluteFill}
                />
                <Ionicons name="bluetooth" size={20} color={P01Colors.blue} />
                <Text style={styles.quickActionLabel}>Receive Nearby</Text>
              </BlurView>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.quickActionBtn}
              onPress={handleImport}
            >
              <BlurView intensity={12} tint="dark" style={styles.quickActionBlur}>
                <LinearGradient
                  colors={['rgba(57, 197, 187, 0.06)', 'rgba(255, 119, 168, 0.03)', 'transparent']}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={StyleSheet.absoluteFill}
                />
                <Ionicons name="clipboard-outline" size={20} color={P01Colors.cyan} />
                <Text style={styles.quickActionLabel}>Import Note</Text>
              </BlurView>
            </TouchableOpacity>
          </View>
        </Animated.View>

        {/* Summary Card */}
        {clusterNotes.length > 0 && (
          <Animated.View entering={FadeInDown.delay(100)}>
            <GlassCard style={{ marginBottom: Spacing.lg }}>
              <View style={styles.summaryInner}>
                <View style={styles.summaryRow}>
                  <View style={styles.summaryItem}>
                    <Text style={styles.summaryValue}>{activeNotes.length}</Text>
                    <Text style={styles.summaryLabel}>Active</Text>
                  </View>
                  <View style={styles.summaryDivider} />
                  <View style={styles.summaryItem}>
                    <Text style={[styles.summaryValue, { color: P01Colors.cyan }]}>
                      {activeNotes.filter(n => n.status === 'mature').length}
                    </Text>
                    <Text style={styles.summaryLabel}>Ready</Text>
                  </View>
                  <View style={styles.summaryDivider} />
                  <View style={styles.summaryItem}>
                    <Text style={[styles.summaryValue, { color: P01Colors.yellow }]}>
                      {activeNotes.filter(n => n.status === 'pending' || n.status === 'imported').length}
                    </Text>
                    <Text style={styles.summaryLabel}>Pending</Text>
                  </View>
                  <View style={styles.summaryDivider} />
                  <View style={styles.summaryItem}>
                    <Text style={styles.summaryValue}>{historyNotes.length}</Text>
                    <Text style={styles.summaryLabel}>History</Text>
                  </View>
                </View>
              </View>
            </GlassCard>
          </Animated.View>
        )}

        {/* Empty State */}
        {clusterNotes.length === 0 && (
          <Animated.View entering={FadeInUp.delay(100)}>
            <GlassCard style={{ marginTop: Spacing['3xl'] }}>
              <View style={styles.emptyInner}>
                <Ionicons name="receipt-outline" size={48} color={Colors.textTertiary} />
                <Text style={styles.emptyTitle}>No Notes Yet</Text>
                <Text style={styles.emptyText}>
                  Shield some funds into a denomination pool to create your first private note.
                </Text>
                <View style={styles.emptyActions}>
                  <TouchableOpacity
                    style={styles.emptyAction}
                    onPress={() => router.push('/(main)/(privacy)/denominated-shield' as any)}
                  >
                    <Ionicons name="shield-checkmark" size={18} color="#000" />
                    <Text style={styles.emptyActionText}>Shield</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.emptyAction, { backgroundColor: '#8B8BFF' }]}
                    onPress={handleImport}
                  >
                    <Ionicons name="download" size={18} color="#000" />
                    <Text style={styles.emptyActionText}>Receive</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </GlassCard>
          </Animated.View>
        )}

        {/* Active Notes */}
        {activeNotes.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>Active Notes</Text>
            {activeNotes.map((note, i) => renderNote(note, i))}
          </>
        )}

        {/* History (collapsible) */}
        {historyNotes.length > 0 && (
          <>
            <TouchableOpacity
              style={styles.historyHeader}
              onPress={() => setShowHistory(!showHistory)}
            >
              <Text style={[styles.sectionTitle, { marginBottom: 0 }]}>
                History ({historyNotes.length})
              </Text>
              <Ionicons
                name={showHistory ? 'chevron-up' : 'chevron-down'}
                size={18}
                color={Colors.textSecondary}
              />
            </TouchableOpacity>
            {showHistory && historyNotes.map((note, i) => renderNote(note, i + activeNotes.length))}
          </>
        )}

        {/* Explainer */}
        <Animated.View entering={FadeInUp.delay(400)}>
          <View style={styles.explainer}>
            <BlurView intensity={12} tint="dark" style={styles.explainerBlur}>
              <LinearGradient
                colors={['rgba(57, 197, 187, 0.06)', 'rgba(255, 119, 168, 0.03)', 'transparent']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={StyleSheet.absoluteFill}
              />
              <View style={styles.explainerContent}>
                <Ionicons name="information-circle-outline" size={16} color={Colors.textTertiary} />
                <Text style={styles.explainerText}>
                  Notes are stored locally on your device. If you delete them, the funds are lost forever.
                  Back up your notes before clearing app data.
                </Text>
              </View>
            </BlurView>
          </View>
        </Animated.View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
    backgroundColor: 'transparent',
  },
  backBtn: {
    width: 40, height: 40, borderRadius: 9999,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    justifyContent: 'center', alignItems: 'center',
  },
  headerTitle: {
    color: Colors.text,
    fontSize: 20,
    fontFamily: FontFamily.bold,
  },
  headerActionBtn: {
    width: 36, height: 36, borderRadius: 9999,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    justifyContent: 'center', alignItems: 'center',
  },
  addBtn: {
    width: 36, height: 36, borderRadius: 9999,
    backgroundColor: P01Colors.cyanDim,
    justifyContent: 'center', alignItems: 'center',
  },
  scrollView: { flex: 1 },
  scrollContent: {
    paddingHorizontal: Spacing.xl,
    paddingBottom: 120,
  },

  /* ── Glass card primitives ──────────────────────────────────── */
  glassOuter: {
    borderRadius: 20,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.07)',
  },
  glassBlur: {
    backgroundColor: 'rgba(12, 12, 14, 0.65)',
  },

  /* ── Quick actions ──────────────────────────────────────────── */
  quickActions: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginBottom: Spacing.lg,
  },
  quickActionBtn: {
    flex: 1,
    borderRadius: 20,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.07)',
  },
  quickActionBlur: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    backgroundColor: 'rgba(12, 12, 14, 0.65)',
  },
  quickActionLabel: {
    fontSize: 14,
    fontFamily: FontFamily.semibold,
    color: Colors.text,
  },

  /* ── Summary card ───────────────────────────────────────────── */
  summaryInner: {
    padding: Spacing.xl,
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
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    marginHorizontal: 4,
  },

  /* ── Empty state ────────────────────────────────────────────── */
  emptyInner: {
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing['3xl'],
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
    backgroundColor: P01Colors.cyan,
  },
  emptyActionText: {
    fontSize: 14,
    fontFamily: FontFamily.bold,
    color: '#000',
  },

  /* ── Section headers ────────────────────────────────────────── */
  sectionTitle: {
    fontSize: 15,
    fontFamily: FontFamily.semibold,
    color: Colors.textSecondary,
    marginBottom: Spacing.md,
  },
  historyHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: Spacing.xl,
    marginBottom: Spacing.md,
    paddingVertical: Spacing.sm,
  },

  /* ── Note card inner ────────────────────────────────────────── */
  noteCardInner: {
    padding: Spacing.lg,
  },
  noteHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.md,
  },
  noteLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  statusIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
  },
  noteAmount: {
    fontSize: 16,
    fontFamily: FontFamily.bold,
    color: Colors.text,
  },
  noteTime: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
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
  noteDetail: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  noteDetailLabel: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
  },
  noteDetailValue: {
    fontSize: 12,
    fontFamily: FontFamily.mono,
    color: Colors.textSecondary,
  },

  /* ── Banners ────────────────────────────────────────────────── */
  readyBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(16, 185, 129, 0.08)',
    borderRadius: BorderRadius.sm,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginTop: Spacing.sm,
  },
  readyBannerText: {
    fontSize: 12,
    fontFamily: FontFamily.medium,
    color: P01Colors.green,
  },
  pendingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255, 204, 0, 0.08)',
    borderRadius: BorderRadius.sm,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginTop: Spacing.sm,
  },
  pendingBannerText: {
    fontSize: 12,
    fontFamily: FontFamily.medium,
    color: P01Colors.yellow,
  },

  /* ── Locked note with route progress ───────────────────────── */
  lockedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: P01Colors.pinkDim,
    borderRadius: BorderRadius.sm,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginTop: Spacing.sm,
  },
  lockedBannerText: {
    fontSize: 12,
    fontFamily: FontFamily.medium,
    color: P01Colors.pink,
    flex: 1,
  },
  progressContainer: {
    marginTop: 8,
  },
  progressBar: {
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 2,
    backgroundColor: P01Colors.pink,
  },
  progressInfo: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  progressText: {
    fontSize: 11,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
  },
  progressDest: {
    fontSize: 11,
    fontFamily: FontFamily.mono,
    color: Colors.textTertiary,
    marginTop: 2,
  },

  /* ── Compact collapsible actions ────────────────────────────── */
  compactActions: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    borderRadius: BorderRadius.md,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.06)',
  },
  compactBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 10,
  },
  compactBtnText: {
    fontSize: 12,
    fontFamily: FontFamily.medium,
  },
  compactDivider: {
    width: 1,
    height: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  noteActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: Spacing.sm,
    marginTop: Spacing.sm,
    paddingTop: Spacing.sm,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.04)',
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: BorderRadius.sm,
    backgroundColor: P01Colors.cyanDim,
  },
  actionBtnDisabled: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: BorderRadius.sm,
    backgroundColor: P01Colors.yellowDim,
  },
  actionText: {
    fontSize: 13,
    fontFamily: FontFamily.medium,
  },

  /* ── Explainer ──────────────────────────────────────────────── */
  explainer: {
    borderRadius: 20,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.04)',
    marginTop: Spacing.xl,
  },
  explainerBlur: {
    backgroundColor: 'rgba(12, 12, 14, 0.55)',
  },
  explainerContent: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: Spacing.md,
  },
  explainerText: {
    flex: 1,
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    lineHeight: 18,
  },
});

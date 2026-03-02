import React, { useEffect, useCallback, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  Alert,
  StyleSheet,
  Linking,
  Share,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';

import {
  useDenominatedPoolStore,
  type StoredNote,
  type NoteStatus,
} from '@/stores/denominatedPoolStore';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';

export default function DenominatedNotesScreen() {
  const router = useRouter();
  const [showHistory, setShowHistory] = useState(false);

  const {
    notes,
    isLoading,
    refreshAllPools,
    refreshNoteStatuses,
    exportAllNotes,
    exportNote,
  } = useDenominatedPoolStore();

  const activeNotes = notes.filter(n => n.status !== 'spent' && n.status !== 'transferred');
  const historyNotes = notes.filter(n => n.status === 'spent' || n.status === 'transferred');

  useEffect(() => {
    refreshNoteStatuses();
  }, []);

  const onRefresh = useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await refreshAllPools();
  }, [refreshAllPools]);

  const handleUnshield = (note: StoredNote) => {
    if (note.status !== 'mature') {
      Alert.alert('Not Ready', 'This note is still maturing. Please wait ~1 epoch (~1 hour).');
      return;
    }
    router.push({
      pathname: '/(main)/(privacy)/denominated-unshield' as any,
      params: { noteId: note.id },
    });
  };

  const handleTransfer = (note: StoredNote) => {
    if (note.status !== 'mature') {
      Alert.alert('Not Ready', 'This note must be mature before transfer.');
      return;
    }
    router.push({
      pathname: '/(main)/(privacy)/denominated-transfer' as any,
      params: { noteId: note.id },
    });
  };

  const handleEmergencyUnshield = (note: StoredNote) => {
    Alert.alert(
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
      Alert.alert(
        'Note Exported',
        'Note backup copied to clipboard. Store it safely — it contains your private keys.',
      );
    } catch (err) {
      Alert.alert('Export Failed', (err as Error).message);
    }
  };

  const handleBackup = () => {
    const encoded = exportAllNotes();
    if (encoded.length === 0) {
      Alert.alert('No Notes', 'No active notes to back up.');
      return;
    }
    Alert.alert(
      'Backup Notes',
      `${encoded.length} note(s) will be copied. Keep this data safe — it contains your private keys.`,
      [
        {
          text: 'Copy to Clipboard',
          onPress: async () => {
            await Clipboard.setStringAsync(JSON.stringify(encoded));
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
          bgColor: Colors.surfaceSecondary,
        };
      case 'transferred':
        return {
          icon: 'swap-horizontal' as const,
          color: '#8B8BFF',
          label: 'Transferred',
          bgColor: 'rgba(139, 139, 255, 0.1)',
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
        <View style={styles.noteCard}>
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

          {/* Actions */}
          <View style={styles.noteActions}>
            {note.status === 'mature' && (
              <>
                <TouchableOpacity
                  style={styles.actionBtn}
                  onPress={() => handleUnshield(note)}
                >
                  <Ionicons name="arrow-up-circle" size={16} color={P01Colors.cyan} />
                  <Text style={[styles.actionText, { color: P01Colors.cyan }]}>Withdraw</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.actionBtn, { backgroundColor: '#1a1a3a' }]}
                  onPress={() => handleTransfer(note)}
                >
                  <Ionicons name="swap-horizontal" size={16} color="#8B8BFF" />
                  <Text style={[styles.actionText, { color: '#8B8BFF' }]}>Transfer</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.actionBtn, { backgroundColor: Colors.surfaceSecondary }]}
                  onPress={() => handleExportNote(note)}
                >
                  <Ionicons name="cloud-upload-outline" size={16} color={Colors.textSecondary} />
                  <Text style={[styles.actionText, { color: Colors.textSecondary }]}>Backup</Text>
                </TouchableOpacity>
              </>
            )}
            {(note.status === 'pending' || note.status === 'imported') && (
              <>
                <View style={styles.actionBtnDisabled}>
                  <Ionicons name="time-outline" size={16} color={P01Colors.yellow} />
                  <Text style={[styles.actionText, { color: P01Colors.yellow }]}>Maturing...</Text>
                </View>
                <TouchableOpacity
                  style={[styles.actionBtn, { backgroundColor: Colors.errorDim }]}
                  onPress={() => handleEmergencyUnshield(note)}
                >
                  <Ionicons name="flash" size={16} color={Colors.error} />
                  <Text style={[styles.actionText, { color: Colors.error }]}>Emergency</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.actionBtn, { backgroundColor: Colors.surfaceSecondary }]}
                  onPress={() => handleExportNote(note)}
                >
                  <Ionicons name="cloud-upload-outline" size={16} color={Colors.textSecondary} />
                  <Text style={[styles.actionText, { color: Colors.textSecondary }]}>Backup</Text>
                </TouchableOpacity>
              </>
            )}
            {/* spent and transferred: no actions, just display info */}
          </View>
        </View>
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
        <Text style={styles.headerTitle}>My Notes</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TouchableOpacity onPress={handleImport} style={styles.headerActionBtn}>
            <Ionicons name="download-outline" size={18} color={P01Colors.cyan} />
          </TouchableOpacity>
          <TouchableOpacity onPress={handleBackup} style={styles.headerActionBtn}>
            <Ionicons name="cloud-upload-outline" size={18} color={P01Colors.cyan} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => router.push('/(main)/(privacy)/denominated-shield' as any)}
            style={styles.addBtn}
          >
            <Ionicons name="add" size={22} color={P01Colors.cyan} />
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={isLoading} onRefresh={onRefresh} tintColor={P01Colors.cyan} />
        }
      >
        {/* Summary Card */}
        {notes.length > 0 && (
          <Animated.View entering={FadeInDown.delay(50)}>
            <LinearGradient
              colors={['#111111', '#0a0a0a']}
              style={styles.summaryCard}
            >
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
            </LinearGradient>
          </Animated.View>
        )}

        {/* Empty State */}
        {notes.length === 0 && (
          <Animated.View entering={FadeInUp.delay(100)}>
            <View style={styles.emptyCard}>
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
            <Ionicons name="information-circle-outline" size={16} color={Colors.textTertiary} />
            <Text style={styles.explainerText}>
              Notes are stored locally on your device. If you delete them, the funds are lost forever.
              Back up your notes before clearing app data.
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
  headerActionBtn: {
    width: 36, height: 36, borderRadius: 9999,
    backgroundColor: Colors.surfaceSecondary,
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
    backgroundColor: P01Colors.cyan,
  },
  emptyActionText: {
    fontSize: 14,
    fontFamily: FontFamily.bold,
    color: '#000',
  },
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
  noteCard: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    padding: Spacing.lg,
    marginBottom: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
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
  noteActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: Spacing.sm,
    marginTop: Spacing.md,
    paddingTop: Spacing.md,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
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

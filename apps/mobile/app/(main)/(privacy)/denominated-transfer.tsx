import React, { useState, useCallback, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Share,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';

import { useDenominatedPoolStore, type StoredNote } from '@/stores/denominatedPoolStore';
import {
  DenominatedPoolProverProvider,
  useDenominatedPoolProver,
} from '@/components/privacy/DenominatedPoolProver';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import { p01Alert } from '@/stores/alertStore';
import { useT } from '@/i18n';

export default function DenominatedTransferScreen() {
  return (
    <DenominatedPoolProverProvider>
      <TransferScreenContent />
    </DenominatedPoolProverProvider>
  );
}

function TransferScreenContent() {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { noteId: paramNoteId } = useLocalSearchParams<{ noteId?: string }>();
  const {
    notes,
    transferNote,
    isLoading,
    isProving,
    progress,
    error,
  } = useDenominatedPoolStore();
  const { generateProof, preloadCircuit } = useDenominatedPoolProver();

  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(paramNoteId ?? null);
  const [result, setResult] = useState<{ txSig: string; shareableNote: string } | null>(null);

  const matureNotes = useMemo(
    () => notes.filter(n => n.status === 'mature'),
    [notes],
  );

  const note = useMemo(
    () => notes.find(n => n.id === selectedNoteId),
    [notes, selectedNoteId],
  );

  // Auto-select if only one mature note
  useEffect(() => {
    if (!paramNoteId && matureNotes.length === 1) {
      setSelectedNoteId(matureNotes[0].id);
    }
  }, [paramNoteId, matureNotes]);

  useEffect(() => { preloadCircuit?.('transfer'); }, []);

  const handleTransfer = useCallback(async () => {
    if (!selectedNoteId) return;
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const res = await transferNote(selectedNoteId, generateProof);
      setResult(res);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      p01Alert(t('alerts.sendFailed'), (err as Error).message || t('alerts.errorGeneric'));
    }
  }, [selectedNoteId, generateProof, transferNote]);

  const handleCopy = useCallback(async () => {
    if (!result) return;
    await Clipboard.setStringAsync(result.shareableNote);
    setTimeout(() => Clipboard.setStringAsync(''), 60000);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    p01Alert(t('alerts.copied'), t('alerts.clipboardClears'));
  }, [result]);

  const handleShare = useCallback(async () => {
    if (!result) return;
    await Share.share({ message: result.shareableNote, title: 'Protocol 01 — Private Note' });
  }, [result]);

  // ─── Result screen ─────────────────────────────────
  if (result) {
    return (
      <View style={[st.container, { paddingTop: insets.top }]}>
        <View style={st.header}>
          <TouchableOpacity onPress={() => router.back()} style={st.backBtn}>
            <Ionicons name="arrow-back" size={22} color={Colors.text} />
          </TouchableOpacity>
          <Text style={st.headerTitle}>{t('denomTransfer.noteSent')}</Text>
          <View style={{ width: 40 }} />
        </View>

        <View style={st.resultContainer}>
          <Animated.View entering={FadeIn.duration(400)} style={st.resultContent}>
            <View style={st.resultIcon}>
              <Ionicons name="checkmark-circle" size={48} color={P01Colors.cyan} />
            </View>
            <Text style={st.resultTitle}>{t('denomTransfer.noteSent')}</Text>
            {note && (
              <Text style={st.resultAmount}>{note.denomination} {note.token}</Text>
            )}
            <Text style={st.resultTx}>Tx: {result.txSig.slice(0, 16)}...</Text>

            <Text style={st.resultHint}>
              {t('denomTransfer.shareWithRecipient')}
            </Text>

            <View style={st.resultActions}>
              <TouchableOpacity style={st.resultBtn} onPress={handleCopy}>
                <Ionicons name="copy-outline" size={18} color={P01Colors.cyan} />
                <Text style={st.resultBtnText}>{t('shieldUnshield.copyNote')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={st.resultBtn} onPress={handleShare}>
                <Ionicons name="share-outline" size={18} color={P01Colors.cyan} />
                <Text style={st.resultBtnText}>{t('common.share')}</Text>
              </TouchableOpacity>
            </View>

            <View style={st.warningRow}>
              <Ionicons name="lock-closed" size={12} color={P01Colors.yellow} />
              <Text style={st.warningText}>{t('shieldUnshield.shareNote')}</Text>
            </View>
          </Animated.View>

          <TouchableOpacity
            style={st.doneBtn}
            onPress={() => router.push('/(main)/(privacy)/denominated-notes' as any)}
          >
            <Text style={st.doneBtnText}>{t('denomTransfer.backToNotes')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ─── Main screen ───────────────────────────────────
  return (
    <View style={[st.container, { paddingTop: insets.top }]}>
      <View style={st.header}>
        <TouchableOpacity onPress={() => router.back()} style={st.backBtn}>
          <Ionicons name="arrow-back" size={22} color={Colors.text} />
        </TouchableOpacity>
        <Text style={st.headerTitle}>{t('denomTransfer.title')}</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView
        style={st.scroll}
        contentContainerStyle={[st.scrollContent, { paddingBottom: 100 + insets.bottom }]}
      >
        {matureNotes.length === 0 ? (
          <Animated.View entering={FadeIn.duration(300)} style={st.emptyState}>
            <Ionicons name="receipt-outline" size={48} color={Colors.textTertiary} />
            <Text style={st.emptyTitle}>{t('shieldUnshield.noMatureNotes')}</Text>
            <Text style={st.emptyDesc}>
              {t('shieldUnshield.depositFirst')}
            </Text>
            <TouchableOpacity
              style={st.emptyBtn}
              onPress={() => router.push('/(main)/(privacy)/denominated-shield' as any)}
            >
              <Text style={st.emptyBtnText}>{t('privacy.deposit')}</Text>
            </TouchableOpacity>
          </Animated.View>
        ) : (
          <>
            <Animated.View entering={FadeInDown.delay(50).duration(300)}>
              <Text style={st.sectionLabel}>{t('denomTransfer.selectNote')}</Text>
              <View style={st.notesList}>
                {matureNotes.map((n) => {
                  const isSelected = n.id === selectedNoteId;
                  return (
                    <TouchableOpacity
                      key={n.id}
                      style={[st.noteCard, isSelected && st.noteCardSelected]}
                      onPress={() => {
                        Haptics.selectionAsync();
                        setSelectedNoteId(n.id);
                      }}
                      activeOpacity={0.7}
                    >
                      <View style={[st.noteIcon, isSelected && st.noteIconSelected]}>
                        <Text style={[st.noteIconText, isSelected && st.noteIconTextSelected]}>
                          {n.token === 'SOL' ? 'S' : '$'}
                        </Text>
                      </View>
                      <View style={st.noteInfo}>
                        <Text style={st.noteAmount}>{n.denomination} {n.token}</Text>
                        <Text style={st.noteId}>{t('denomTransfer.readyToSend')}</Text>
                      </View>
                      <View style={[st.radio, isSelected && st.radioSelected]}>
                        {isSelected && <View style={st.radioDot} />}
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </Animated.View>

            {error && (
              <View style={st.errorCard}>
                <Ionicons name="alert-circle" size={16} color={Colors.error} />
                <Text style={st.errorText}>{error}</Text>
              </View>
            )}
          </>
        )}
      </ScrollView>

      {/* Send button */}
      {matureNotes.length > 0 && (
        <View style={[st.footer, { paddingBottom: 80 + insets.bottom }]}>
          <TouchableOpacity
            style={[st.sendBtn, (!selectedNoteId || isLoading) && st.sendBtnDisabled]}
            onPress={handleTransfer}
            disabled={!selectedNoteId || isLoading}
          >
            {isLoading ? (
              <Text style={st.sendBtnText}>
                {isProving ? t('shieldUnshield.generatingProof') : progress || t('common.processing')}
              </Text>
            ) : (
              <>
                <Ionicons name="paper-plane" size={18} color="#000" />
                <Text style={st.sendBtnText}>
                  {note ? `${t('common.send')} ${note.denomination} ${note.token}` : t('shieldUnshield.sendNote')}
                </Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl, paddingVertical: Spacing.lg,
  },
  backBtn: {
    width: 40, height: 40, borderRadius: 9999,
    backgroundColor: Colors.surfaceSecondary, justifyContent: 'center', alignItems: 'center',
  },
  headerTitle: { color: Colors.text, fontSize: 20, fontFamily: FontFamily.bold },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: Spacing.xl },

  // Section
  sectionLabel: {
    fontSize: 14, fontFamily: FontFamily.medium, color: Colors.textSecondary, marginBottom: 12,
  },

  // Notes list
  notesList: { gap: 8 },
  noteCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 16, borderRadius: 16, backgroundColor: '#0f0f12',
    borderWidth: 1.5, borderColor: 'transparent',
  },
  noteCardSelected: { borderColor: '#8B8BFF' },
  noteIcon: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: 'rgba(139, 139, 255, 0.1)',
    alignItems: 'center', justifyContent: 'center',
  },
  noteIconSelected: { backgroundColor: 'rgba(139, 139, 255, 0.2)' },
  noteIconText: { fontSize: 16, fontFamily: FontFamily.bold, color: '#8B8BFF' },
  noteIconTextSelected: { color: '#8B8BFF' },
  noteInfo: { flex: 1 },
  noteAmount: { fontSize: 16, fontFamily: FontFamily.bold, color: Colors.text },
  noteId: { fontSize: 12, fontFamily: FontFamily.regular, color: Colors.textSecondary, marginTop: 2 },
  radio: {
    width: 22, height: 22, borderRadius: 11,
    borderWidth: 2, borderColor: Colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  radioSelected: { borderColor: '#8B8BFF' },
  radioDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#8B8BFF' },

  // Empty state
  emptyState: {
    alignItems: 'center', justifyContent: 'center',
    paddingVertical: 60, gap: 12,
  },
  emptyTitle: { fontSize: 18, fontFamily: FontFamily.bold, color: Colors.text },
  emptyDesc: {
    fontSize: 14, fontFamily: FontFamily.regular, color: Colors.textSecondary,
    textAlign: 'center', lineHeight: 20, paddingHorizontal: 20,
  },
  emptyBtn: {
    paddingHorizontal: 20, paddingVertical: 10, borderRadius: 12,
    backgroundColor: P01Colors.cyanDim, marginTop: 8,
  },
  emptyBtnText: { fontSize: 14, fontFamily: FontFamily.semibold, color: P01Colors.cyan },

  // Error
  errorCard: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: Colors.errorDim, borderRadius: 12, padding: 12, marginTop: 16,
  },
  errorText: { flex: 1, fontSize: 13, fontFamily: FontFamily.regular, color: Colors.error },

  // Footer
  footer: { paddingHorizontal: Spacing.xl, paddingTop: Spacing.md },
  sendBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 16, borderRadius: 14, backgroundColor: '#8B8BFF',
  },
  sendBtnDisabled: { opacity: 0.4 },
  sendBtnText: { fontSize: 16, fontFamily: FontFamily.bold, color: '#000' },

  // Result
  resultContainer: { flex: 1, justifyContent: 'space-between', paddingHorizontal: Spacing.xl },
  resultContent: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  resultIcon: { marginBottom: 8 },
  resultTitle: { fontSize: 22, fontFamily: FontFamily.bold, color: Colors.text },
  resultAmount: { fontSize: 18, fontFamily: FontFamily.semibold, color: '#8B8BFF' },
  resultTx: { fontSize: 12, fontFamily: FontFamily.mono, color: Colors.textTertiary },
  resultHint: {
    fontSize: 13, fontFamily: FontFamily.regular, color: Colors.textSecondary,
    textAlign: 'center', lineHeight: 19, marginTop: 12, paddingHorizontal: 16,
  },
  resultActions: { flexDirection: 'row', gap: 12, marginTop: 20 },
  resultBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 20, paddingVertical: 12, borderRadius: 12,
    backgroundColor: P01Colors.cyanDim,
  },
  resultBtnText: { fontSize: 14, fontFamily: FontFamily.medium, color: P01Colors.cyan },
  warningRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 16,
  },
  warningText: { fontSize: 12, fontFamily: FontFamily.regular, color: P01Colors.yellow },
  doneBtn: {
    paddingVertical: 16, borderRadius: 14, alignItems: 'center',
    backgroundColor: '#0f0f12', marginBottom: 80,
  },
  doneBtnText: { fontSize: 15, fontFamily: FontFamily.semibold, color: Colors.text },
});

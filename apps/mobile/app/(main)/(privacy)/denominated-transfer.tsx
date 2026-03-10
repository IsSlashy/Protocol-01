import React, { useState, useCallback, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Alert,
  StyleSheet,
  Share,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';

import { useDenominatedPoolStore, type StoredNote } from '@/stores/denominatedPoolStore';
import {
  DenominatedPoolProverProvider,
  useDenominatedPoolProver,
} from '@/components/privacy/DenominatedPoolProver';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';

export default function DenominatedTransferScreen() {
  return (
    <DenominatedPoolProverProvider>
      <TransferScreenContent />
    </DenominatedPoolProverProvider>
  );
}

function TransferScreenContent() {
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
    poolCache,
    refreshPoolInfo,
  } = useDenominatedPoolStore();
  const { generateProof, preloadCircuit } = useDenominatedPoolProver();

  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(paramNoteId ?? null);
  const [showNotePicker, setShowNotePicker] = useState(false);
  const [recipientLabel, setRecipientLabel] = useState('');
  const [result, setResult] = useState<{ txSig: string; shareableNote: string } | null>(null);

  const matureNotes = useMemo(
    () => notes.filter(n => n.status === 'mature'),
    [notes],
  );

  const note = useMemo(
    () => notes.find(n => n.id === selectedNoteId),
    [notes, selectedNoteId],
  );

  // Auto-select if there's exactly one mature note and no param
  useEffect(() => {
    if (!paramNoteId && matureNotes.length === 1) {
      setSelectedNoteId(matureNotes[0].id);
    }
  }, [paramNoteId, matureNotes]);

  useEffect(() => {
    preloadCircuit?.('transfer');
  }, []);

  // Refresh pool info for anonymity set display
  useEffect(() => {
    if (note) refreshPoolInfo(note.poolPDA);
  }, [note?.poolPDA]);

  const poolInfo = note ? poolCache[note.poolPDA] : undefined;
  const anonymitySet = poolInfo?.info ? Number(poolInfo.info.totalShielded) : null;

  const handleTransfer = useCallback(async () => {
    if (!selectedNoteId) return;

    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const res = await transferNote(selectedNoteId, generateProof);
      setResult(res);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      const msg = (err as Error).message || 'Unknown error';
      console.error('[Transfer] FAILED:', msg, err);
      Alert.alert('Transfer Failed', msg);
    }
  }, [selectedNoteId, generateProof, transferNote]);

  const handleCopyNote = useCallback(async () => {
    if (!result) return;
    await Clipboard.setStringAsync(result.shareableNote);
    setTimeout(() => Clipboard.setStringAsync(''), 60000);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Alert.alert('Copied', 'Shareable note data copied to clipboard. Share it securely with the recipient. Clipboard will be cleared in 60 seconds.');
  }, [result]);

  const handleShareNote = useCallback(async () => {
    if (!result) return;
    await Share.share({
      message: result.shareableNote,
      title: 'Protocol 01 — Private Note',
    });
  }, [result]);

  const handleSelectNote = (n: StoredNote) => {
    setSelectedNoteId(n.id);
    setShowNotePicker(false);
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={22} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Send Note</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView style={styles.scrollView} contentContainerStyle={[styles.scrollContent, { paddingBottom: 100 + insets.bottom }]}>
        {/* Note selector */}
        {!result && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Select Note</Text>

            {note ? (
              <TouchableOpacity
                style={styles.selectedNote}
                onPress={() => matureNotes.length > 1 && setShowNotePicker(!showNotePicker)}
                disabled={matureNotes.length <= 1}
              >
                <View style={styles.selectedNoteLeft}>
                  <View style={[styles.tokenIcon, { backgroundColor: P01Colors.cyanDim }]}>
                    <Text style={styles.tokenIconText}>{note.token === 'SOL' ? 'S' : '$'}</Text>
                  </View>
                  <View>
                    <Text style={styles.selectedNoteAmount}>{note.denomination} {note.token}</Text>
                    <Text style={styles.selectedNotePool}>
                      {note.poolPDA.slice(0, 10)}...{note.poolPDA.slice(-4)}
                    </Text>
                  </View>
                </View>
                {matureNotes.length > 1 && (
                  <Ionicons
                    name={showNotePicker ? 'chevron-up' : 'chevron-down'}
                    size={18}
                    color={Colors.textSecondary}
                  />
                )}
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={styles.selectNoteBtn}
                onPress={() => setShowNotePicker(true)}
              >
                <Text style={styles.selectNoteBtnText}>
                  {matureNotes.length === 0 ? 'No mature notes available' : 'Choose a note...'}
                </Text>
                {matureNotes.length > 0 && (
                  <Ionicons name="chevron-down" size={18} color={Colors.textSecondary} />
                )}
              </TouchableOpacity>
            )}

            {/* Dropdown */}
            {showNotePicker && matureNotes.length > 0 && (
              <View style={styles.dropdown}>
                {matureNotes.map(n => (
                  <TouchableOpacity
                    key={n.id}
                    style={[
                      styles.dropdownItem,
                      n.id === selectedNoteId && styles.dropdownItemSelected,
                    ]}
                    onPress={() => handleSelectNote(n)}
                  >
                    <Text style={styles.dropdownAmount}>{n.denomination} {n.token}</Text>
                    <Text style={styles.dropdownId}>ID: {n.id}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>
        )}

        {/* Recipient label (optional, for your records) */}
        {!result && note && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Recipient (optional)</Text>
            <TextInput
              style={styles.recipientInput}
              placeholder="Wallet address or name for your records..."
              placeholderTextColor={Colors.textTertiary}
              value={recipientLabel}
              onChangeText={setRecipientLabel}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={styles.recipientHint}>
              This is for your reference only. The note is a bearer instrument —
              anyone with the shareable link can claim the funds. You will share
              the link after the transfer completes.
            </Text>
          </View>
        )}

        {/* Anonymity set indicator */}
        {note && !result && anonymitySet !== null && (
          <View style={styles.privacyCard}>
            <View style={styles.privacyHeader}>
              <Ionicons name="shield-checkmark" size={18} color={P01Colors.cyan} />
              <Text style={styles.privacyTitle}>Anonymity Set</Text>
            </View>
            <Text style={styles.privacyValue}>
              {anonymitySet} deposit{anonymitySet !== 1 ? 's' : ''} in this pool
            </Text>
            <Text style={styles.privacyExplainer}>
              Your note is indistinguishable from {anonymitySet > 1 ? anonymitySet - 1 : 0} other{anonymitySet > 1 && anonymitySet - 1 !== 1 ? 's' : ''}.
              Larger anonymity sets provide stronger privacy.
            </Text>
          </View>
        )}

        {/* How it works */}
        {!result && (
          <View style={styles.infoCard}>
            <Ionicons name="information-circle" size={18} color={P01Colors.cyan} />
            <Text style={styles.infoText}>
              Transfer generates a new note for the recipient without moving funds.
              The old note is nullified and a new commitment replaces it in the pool.
            </Text>
          </View>
        )}

        {/* Security warning */}
        {!result && note && (
          <View style={styles.warningCard}>
            <Ionicons name="warning" size={18} color={P01Colors.yellow} />
            <Text style={styles.warningText}>
              The shareable link contains full spending authority.
              Only share via secure channels (in person, encrypted messaging).
              Anyone with the link can claim the funds.
            </Text>
          </View>
        )}

        {/* Result */}
        {result && (
          <View style={styles.resultCard}>
            <Ionicons name="checkmark-circle" size={36} color={P01Colors.green} />
            <Text style={styles.resultTitle}>Transfer Complete</Text>
            {note && (
              <Text style={styles.resultAmount}>{note.denomination} {note.token}</Text>
            )}
            <Text style={styles.resultTx}>Tx: {result.txSig.slice(0, 20)}...</Text>

            <View style={styles.resultDivider} />

            <Text style={styles.resultLabel}>Share this note with the recipient:</Text>

            <View style={styles.resultNotePreview}>
              <Text style={styles.resultNoteText} numberOfLines={3}>
                {result.shareableNote.slice(0, 80)}...
              </Text>
            </View>

            <View style={styles.resultActions}>
              <TouchableOpacity style={styles.resultBtn} onPress={handleCopyNote}>
                <Ionicons name="copy" size={18} color={P01Colors.cyan} />
                <Text style={styles.resultBtnText}>Copy</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.resultBtn} onPress={handleShareNote}>
                <Ionicons name="share" size={18} color={P01Colors.cyan} />
                <Text style={styles.resultBtnText}>Share</Text>
              </TouchableOpacity>
            </View>

            <View style={[styles.warningCard, { marginTop: Spacing.lg, marginBottom: 0 }]}>
              <Ionicons name="warning" size={16} color={P01Colors.yellow} />
              <Text style={styles.warningText}>
                This link grants spending authority. Only share via secure channels.
              </Text>
            </View>
          </View>
        )}

        {error && !result && (
          <View style={styles.errorCard}>
            <Ionicons name="alert-circle" size={18} color={Colors.error} />
            <Text style={styles.errorCardText}>{error}</Text>
          </View>
        )}

        {/* Privacy footer */}
        <View style={styles.privacyNote}>
          <Ionicons name="lock-closed" size={14} color={Colors.textTertiary} />
          <Text style={styles.privacyFooterText}>
            Proof is generated on your device. No private data leaves your phone.
          </Text>
        </View>
      </ScrollView>

      {/* Transfer button */}
      {!result && (
        <View style={[styles.footer, { paddingBottom: 80 + insets.bottom }]}>
          <TouchableOpacity
            style={[
              styles.transferBtn,
              (!selectedNoteId || isLoading) && styles.disabledBtn,
            ]}
            onPress={handleTransfer}
            disabled={!selectedNoteId || isLoading}
          >
            {isLoading ? (
              <Text style={styles.transferBtnText}>
                {isProving ? 'Generating proof...' : progress || 'Processing...'}
              </Text>
            ) : (
              <>
                <Ionicons name="swap-horizontal" size={20} color="#000" />
                <Text style={styles.transferBtnText}>Send Note</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      )}

      {/* Done button after result */}
      {result && (
        <View style={[styles.footer, { paddingBottom: 80 + insets.bottom }]}>
          <TouchableOpacity
            style={[styles.transferBtn, { backgroundColor: P01Colors.cyanDim }]}
            onPress={() => router.push('/(main)/(privacy)/denominated-notes' as any)}
          >
            <Text style={[styles.transferBtnText, { color: P01Colors.cyan }]}>Back to Notes</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
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
  scrollView: { flex: 1 },
  scrollContent: { paddingHorizontal: Spacing.xl, paddingBottom: 120 },
  card: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    padding: Spacing.lg, borderWidth: 1, borderColor: Colors.border, marginBottom: Spacing.lg,
  },
  cardTitle: { fontSize: 15, fontFamily: FontFamily.semibold, color: Colors.text, marginBottom: Spacing.md },
  selectedNote: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    padding: Spacing.md, borderRadius: BorderRadius.md,
    backgroundColor: Colors.surfaceSecondary,
  },
  selectedNoteLeft: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  tokenIcon: {
    width: 36, height: 36, borderRadius: 18,
    justifyContent: 'center', alignItems: 'center',
  },
  tokenIconText: { fontSize: 16, fontFamily: FontFamily.bold, color: P01Colors.cyan },
  selectedNoteAmount: { fontSize: 16, fontFamily: FontFamily.bold, color: Colors.text },
  selectedNotePool: { fontSize: 11, fontFamily: FontFamily.mono, color: Colors.textTertiary, marginTop: 2 },
  selectNoteBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    padding: Spacing.md, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border, borderStyle: 'dashed',
  },
  selectNoteBtnText: { fontSize: 14, fontFamily: FontFamily.regular, color: Colors.textTertiary },
  dropdown: {
    marginTop: Spacing.sm, borderRadius: BorderRadius.md,
    backgroundColor: Colors.surfaceSecondary, overflow: 'hidden',
  },
  dropdownItem: {
    padding: Spacing.md, borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  dropdownItemSelected: { backgroundColor: P01Colors.cyanDim },
  dropdownAmount: { fontSize: 14, fontFamily: FontFamily.bold, color: Colors.text },
  dropdownId: { fontSize: 11, fontFamily: FontFamily.mono, color: Colors.textTertiary, marginTop: 2 },
  privacyCard: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    padding: Spacing.lg, borderWidth: 1, borderColor: P01Colors.cyan + '40',
    marginBottom: Spacing.lg,
  },
  privacyHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: Spacing.sm },
  privacyTitle: { fontSize: 14, fontFamily: FontFamily.semibold, color: P01Colors.cyan },
  privacyValue: { fontSize: 18, fontFamily: FontFamily.bold, color: Colors.text, marginBottom: 4 },
  privacyExplainer: { fontSize: 12, fontFamily: FontFamily.regular, color: Colors.textTertiary, lineHeight: 17 },
  infoCard: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    backgroundColor: P01Colors.cyanDim, borderRadius: BorderRadius.md,
    padding: Spacing.md, marginBottom: Spacing.lg,
  },
  infoText: { flex: 1, fontSize: 13, fontFamily: FontFamily.regular, color: Colors.textSecondary, lineHeight: 19 },
  warningCard: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    backgroundColor: P01Colors.yellowDim, borderRadius: BorderRadius.md,
    padding: Spacing.md, marginBottom: Spacing.lg, borderWidth: 1,
    borderColor: 'rgba(255, 204, 0, 0.2)',
  },
  warningText: { flex: 1, fontSize: 12, fontFamily: FontFamily.regular, color: P01Colors.yellow, lineHeight: 17 },
  resultCard: {
    alignItems: 'center', gap: Spacing.sm, padding: Spacing.xl,
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    borderWidth: 1, borderColor: P01Colors.green, marginBottom: Spacing.lg,
  },
  resultTitle: { fontSize: 20, fontFamily: FontFamily.bold, color: Colors.text },
  resultAmount: { fontSize: 16, fontFamily: FontFamily.semibold, color: P01Colors.cyan },
  resultTx: { fontSize: 12, fontFamily: FontFamily.mono, color: Colors.textTertiary },
  resultDivider: { width: '80%', height: 1, backgroundColor: Colors.border, marginVertical: Spacing.sm },
  resultLabel: { fontSize: 13, fontFamily: FontFamily.medium, color: Colors.textSecondary, marginTop: Spacing.sm },
  resultNotePreview: {
    width: '100%', padding: Spacing.md, borderRadius: BorderRadius.md,
    backgroundColor: Colors.surfaceSecondary, marginTop: Spacing.sm,
  },
  resultNoteText: { fontSize: 11, fontFamily: FontFamily.mono, color: Colors.textTertiary },
  resultActions: { flexDirection: 'row', gap: Spacing.md, marginTop: Spacing.md },
  resultBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 20, paddingVertical: 10,
    borderRadius: BorderRadius.md, backgroundColor: P01Colors.cyanDim,
  },
  resultBtnText: { fontSize: 14, fontFamily: FontFamily.medium, color: P01Colors.cyan },
  errorCard: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: Colors.errorDim, borderRadius: BorderRadius.md,
    padding: Spacing.md, marginBottom: Spacing.lg,
  },
  errorCardText: { flex: 1, fontSize: 13, fontFamily: FontFamily.regular, color: Colors.error },
  recipientInput: {
    borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.md,
    padding: Spacing.md, color: Colors.text, fontSize: 14, fontFamily: FontFamily.mono,
    backgroundColor: Colors.surfaceSecondary,
  },
  recipientHint: {
    fontSize: 12, fontFamily: FontFamily.regular, color: Colors.textTertiary,
    marginTop: Spacing.sm, lineHeight: 17,
  },
  privacyNote: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: Spacing.sm,
  },
  privacyFooterText: { fontSize: 11, fontFamily: FontFamily.regular, color: Colors.textTertiary },
  footer: { paddingHorizontal: Spacing.xl, paddingTop: Spacing.md },
  transferBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 16, borderRadius: BorderRadius.lg, backgroundColor: '#8B8BFF',
  },
  disabledBtn: { opacity: 0.4 },
  transferBtnText: { fontSize: 16, fontFamily: FontFamily.bold, color: '#000' },
});

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  StyleSheet,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';

import { useDenominatedPoolStore, type NoteSource } from '@/stores/denominatedPoolStore';
import { decodeShareableNote, ALL_POOLS } from '@/services/denominatedPool';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import { p01Alert } from '@/stores/alertStore';

type ImportSource = 'received' | 'imported_backup';

export default function DenominatedImportScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { importNote } = useDenominatedPoolStore();

  const [noteData, setNoteData] = useState('');
  const [source, setSource] = useState<ImportSource>('received');
  const [preview, setPreview] = useState<{
    token: string;
    denomination: number;
    pool: string;
    poolFound: boolean;
  } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [imported, setImported] = useState(false);

  const handlePaste = useCallback(async () => {
    const text = await Clipboard.getStringAsync();
    if (text) {
      setNoteData(text);
      tryPreview(text);
    }
  }, []);

  const tryPreview = useCallback((text: string) => {
    setPreview(null);
    setPreviewError(null);
    try {
      const decoded = decodeShareableNote(text.trim());

      // Verify pool exists in known config
      const poolFound = ALL_POOLS.some(p => p.poolPDA.toBase58() === decoded.pool);

      setPreview({
        token: decoded.token,
        denomination: decoded.denominationHuman,
        pool: decoded.pool,
        poolFound,
      });

      if (!poolFound) {
        setPreviewError('Warning: This pool address is not in the known pool list. The note may be from a different network.');
      }
    } catch {
      if (text.trim().length > 10) {
        setPreviewError('Invalid note format. Make sure you copied the full note data.');
      }
    }
  }, []);

  const handleTextChange = useCallback((text: string) => {
    setNoteData(text);
    if (text.trim().length > 20) {
      tryPreview(text);
    } else {
      setPreview(null);
      setPreviewError(null);
    }
  }, [tryPreview]);

  const handleImport = useCallback(() => {
    if (!noteData.trim()) {
      p01Alert('Empty', 'Please paste note data first.');
      return;
    }

    try {
      importNote(noteData.trim(), source as NoteSource);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setImported(true);
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      p01Alert('Import Failed', (err as Error).message);
    }
  }, [noteData, importNote, source]);

  if (imported) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={22} color={Colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Import Note</Text>
          <View style={{ width: 40 }} />
        </View>
        <View style={styles.centered}>
          <Ionicons name="checkmark-circle" size={56} color={P01Colors.green} />
          <Text style={styles.successTitle}>Note Imported</Text>
          {preview && (
            <Text style={styles.successDetail}>
              {preview.denomination} {preview.token} note added to your wallet.
            </Text>
          )}
          <Text style={styles.successHint}>
            {source === 'received'
              ? 'The note will mature before you can withdraw or transfer it.'
              : 'Your note has been restored from backup.'}
          </Text>
          <TouchableOpacity
            style={styles.doneBtn}
            onPress={() => router.push('/(main)/(privacy)/denominated-notes' as any)}
          >
            <Text style={styles.doneBtnText}>View Notes</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={22} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Receive Note</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        {/* Source selector */}
        <Text style={styles.label}>Import Source</Text>
        <View style={styles.sourceRow}>
          <TouchableOpacity
            style={[styles.sourceBtn, source === 'received' && styles.sourceBtnActive]}
            onPress={() => setSource('received')}
          >
            <Ionicons
              name="swap-horizontal"
              size={16}
              color={source === 'received' ? P01Colors.cyan : Colors.textTertiary}
            />
            <Text style={[
              styles.sourceBtnText,
              source === 'received' && styles.sourceBtnTextActive,
            ]}>
              Received
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.sourceBtn, source === 'imported_backup' && styles.sourceBtnActive]}
            onPress={() => setSource('imported_backup')}
          >
            <Ionicons
              name="cloud-download"
              size={16}
              color={source === 'imported_backup' ? P01Colors.cyan : Colors.textTertiary}
            />
            <Text style={[
              styles.sourceBtnText,
              source === 'imported_backup' && styles.sourceBtnTextActive,
            ]}>
              Backup Restore
            </Text>
          </TouchableOpacity>
        </View>

        {/* Info */}
        <View style={styles.infoCard}>
          <Ionicons name="information-circle" size={18} color={P01Colors.cyan} />
          <Text style={styles.infoText}>
            {source === 'received'
              ? 'Paste a shareable note received from another user. The note will be added to your local wallet.'
              : 'Restore a note from a previous backup. Use this if you reinstalled the app or cleared data.'}
          </Text>
        </View>

        {/* Input area */}
        <Text style={styles.label}>Note Data</Text>
        <View style={styles.inputWrapper}>
          <TextInput
            style={styles.input}
            value={noteData}
            onChangeText={handleTextChange}
            placeholder="Paste note data here..."
            placeholderTextColor={Colors.textTertiary}
            multiline
            numberOfLines={6}
            textAlignVertical="top"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity style={styles.pasteBtn} onPress={handlePaste}>
            <Ionicons name="clipboard" size={16} color={P01Colors.cyan} />
            <Text style={styles.pasteBtnText}>Paste</Text>
          </TouchableOpacity>
        </View>

        {/* Preview */}
        {preview && (
          <View style={[styles.previewCard, !preview.poolFound && styles.previewCardWarning]}>
            <Ionicons
              name="receipt"
              size={20}
              color={preview.poolFound ? P01Colors.cyan : P01Colors.yellow}
            />
            <View style={styles.previewContent}>
              <Text style={styles.previewTitle}>
                {preview.denomination} {preview.token}
              </Text>
              <Text style={styles.previewPool}>
                Pool: {preview.pool.slice(0, 12)}...{preview.pool.slice(-6)}
              </Text>
              {preview.poolFound && (
                <View style={styles.verifiedRow}>
                  <Ionicons name="checkmark-circle" size={14} color={P01Colors.green} />
                  <Text style={styles.verifiedText}>Known pool verified</Text>
                </View>
              )}
            </View>
            <Ionicons
              name={preview.poolFound ? 'checkmark-circle' : 'alert-circle'}
              size={20}
              color={preview.poolFound ? P01Colors.green : P01Colors.yellow}
            />
          </View>
        )}

        {previewError && (
          <View style={styles.errorCard}>
            <Ionicons name="alert-circle" size={16} color={previewError.startsWith('Warning') ? P01Colors.yellow : Colors.error} />
            <Text style={[
              styles.errorText,
              previewError.startsWith('Warning') && { color: P01Colors.yellow },
            ]}>
              {previewError}
            </Text>
          </View>
        )}

        {/* Privacy note */}
        <View style={styles.privacyNote}>
          <Ionicons name="lock-closed" size={14} color={Colors.textTertiary} />
          <Text style={styles.privacyText}>
            Notes are stored locally on your device only. Never share your note data publicly.
          </Text>
        </View>
      </ScrollView>

      {/* Import button */}
      <View style={[styles.footer, { paddingBottom: Math.max(Spacing.xl, insets.bottom + 96) }]}>
        <TouchableOpacity
          style={[styles.importBtn, !preview && styles.disabledBtn]}
          onPress={handleImport}
          disabled={!preview}
        >
          <Ionicons name="download" size={20} color="#000" />
          <Text style={styles.importBtnText}>
            {source === 'received' ? 'Import Note' : 'Restore Note'}
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
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
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: Spacing.lg },
  successTitle: { fontSize: 22, fontFamily: FontFamily.bold, color: Colors.text },
  successDetail: { fontSize: 14, fontFamily: FontFamily.regular, color: Colors.textSecondary, textAlign: 'center' },
  successHint: { fontSize: 12, fontFamily: FontFamily.regular, color: Colors.textTertiary, textAlign: 'center', paddingHorizontal: 32 },
  doneBtn: {
    paddingHorizontal: 24, paddingVertical: 12, borderRadius: BorderRadius.md,
    backgroundColor: P01Colors.cyanDim, marginTop: Spacing.md,
  },
  doneBtnText: { fontSize: 15, fontFamily: FontFamily.semibold, color: P01Colors.cyan },
  label: { fontSize: 14, fontFamily: FontFamily.semibold, color: Colors.textSecondary, marginBottom: Spacing.sm },
  sourceRow: { flexDirection: 'row', gap: Spacing.sm, marginBottom: Spacing.lg },
  sourceBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: Spacing.md, borderRadius: BorderRadius.md,
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border,
  },
  sourceBtnActive: {
    backgroundColor: P01Colors.cyanDim, borderColor: P01Colors.cyan + '60',
  },
  sourceBtnText: { fontSize: 13, fontFamily: FontFamily.medium, color: Colors.textTertiary },
  sourceBtnTextActive: { color: P01Colors.cyan },
  infoCard: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    backgroundColor: P01Colors.cyanDim, borderRadius: BorderRadius.md,
    padding: Spacing.md, marginBottom: Spacing.xl,
  },
  infoText: { flex: 1, fontSize: 13, fontFamily: FontFamily.regular, color: Colors.textSecondary, lineHeight: 19 },
  inputWrapper: { marginBottom: Spacing.lg },
  input: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    padding: Spacing.lg, color: Colors.text, fontFamily: FontFamily.mono, fontSize: 12,
    borderWidth: 1, borderColor: Colors.border, minHeight: 120,
  },
  pasteBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    position: 'absolute', top: 8, right: 8,
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: BorderRadius.sm,
    backgroundColor: P01Colors.cyanDim,
  },
  pasteBtnText: { fontSize: 12, fontFamily: FontFamily.medium, color: P01Colors.cyan },
  previewCard: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    padding: Spacing.lg, borderWidth: 1, borderColor: P01Colors.cyan, marginBottom: Spacing.lg,
  },
  previewCardWarning: { borderColor: P01Colors.yellow },
  previewContent: { flex: 1 },
  previewTitle: { fontSize: 16, fontFamily: FontFamily.bold, color: Colors.text },
  previewPool: { fontSize: 12, fontFamily: FontFamily.mono, color: Colors.textTertiary, marginTop: 2 },
  verifiedRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  verifiedText: { fontSize: 11, fontFamily: FontFamily.regular, color: P01Colors.green },
  errorCard: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: Colors.errorDim, borderRadius: BorderRadius.md,
    padding: Spacing.md, marginBottom: Spacing.lg,
  },
  errorText: { flex: 1, fontSize: 13, fontFamily: FontFamily.regular, color: Colors.error },
  privacyNote: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: Spacing.sm,
  },
  privacyText: { fontSize: 11, fontFamily: FontFamily.regular, color: Colors.textTertiary },
  footer: { padding: Spacing.xl },
  importBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 16, borderRadius: BorderRadius.lg, backgroundColor: '#8B8BFF',
  },
  disabledBtn: { opacity: 0.4 },
  importBtnText: { fontSize: 16, fontFamily: FontFamily.bold, color: '#000' },
});

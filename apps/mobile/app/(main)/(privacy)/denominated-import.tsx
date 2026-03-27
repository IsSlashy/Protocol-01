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
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';

import { useDenominatedPoolStore, type NoteSource } from '@/stores/denominatedPoolStore';
import { decodeShareableNote, ALL_POOLS } from '@/services/denominatedPool';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import { p01Alert } from '@/stores/alertStore';

export default function DenominatedImportScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { importNote } = useDenominatedPoolStore();

  const [noteData, setNoteData] = useState('');
  const [isBackup, setIsBackup] = useState(false);
  const [preview, setPreview] = useState<{
    token: string;
    denomination: number;
    poolFound: boolean;
  } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [imported, setImported] = useState(false);

  const tryPreview = useCallback((text: string) => {
    setPreview(null);
    setPreviewError(null);
    try {
      const decoded = decodeShareableNote(text.trim());
      const poolFound = ALL_POOLS.some(p => p.poolPDA.toBase58() === decoded.pool);
      setPreview({ token: decoded.token, denomination: decoded.denominationHuman, poolFound });
      if (!poolFound) {
        setPreviewError('Unknown pool — this note may be from a different network.');
      }
    } catch {
      if (text.trim().length > 10) {
        setPreviewError('Invalid note. Make sure you copied the full data.');
      }
    }
  }, []);

  const handlePaste = useCallback(async () => {
    const text = await Clipboard.getStringAsync();
    if (text) {
      setNoteData(text);
      tryPreview(text);
    }
  }, [tryPreview]);

  const handleTextChange = useCallback((text: string) => {
    setNoteData(text);
    if (text.trim().length > 20) tryPreview(text);
    else { setPreview(null); setPreviewError(null); }
  }, [tryPreview]);

  const handleImport = useCallback(() => {
    if (!noteData.trim()) {
      p01Alert('Empty', 'Paste note data first.');
      return;
    }
    try {
      const source: NoteSource = isBackup ? 'imported_backup' : 'received';
      importNote(noteData.trim(), source);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setImported(true);
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      p01Alert('Import Failed', (err as Error).message);
    }
  }, [noteData, importNote, isBackup]);

  // ─── Success screen ────────────────────────────────
  if (imported) {
    return (
      <SafeAreaView style={st.container} edges={['top']}>
        <View style={st.successContainer}>
          <Animated.View entering={FadeIn.duration(400)} style={st.successContent}>
            <View style={st.successIcon}>
              <Ionicons name="checkmark-circle" size={56} color={P01Colors.cyan} />
            </View>
            <Text style={st.successTitle}>Note Received</Text>
            {preview && (
              <Text style={st.successAmount}>
                {preview.denomination} {preview.token}
              </Text>
            )}
            <Text style={st.successHint}>
              {isBackup
                ? 'Your note has been restored from backup.'
                : 'The note will mature before you can send or withdraw it.'}
            </Text>
          </Animated.View>

          <View style={st.successActions}>
            <TouchableOpacity
              style={st.primaryBtn}
              onPress={() => router.push('/(main)/(privacy)/denominated-notes' as any)}
            >
              <Text style={st.primaryBtnText}>View Notes</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={st.ghostBtn}
              onPress={() => router.back()}
            >
              <Text style={st.ghostBtnText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  // ─── Main screen ───────────────────────────────────
  return (
    <SafeAreaView style={st.container} edges={['top']}>
      <View style={st.header}>
        <TouchableOpacity onPress={() => router.back()} style={st.backBtn}>
          <Ionicons name="arrow-back" size={22} color={Colors.text} />
        </TouchableOpacity>
        <Text style={st.headerTitle}>Receive</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView style={st.scroll} contentContainerStyle={st.scrollContent}>
        {/* Big paste area */}
        <Animated.View entering={FadeInDown.duration(300)}>
          <View style={st.pasteCard}>
            <TouchableOpacity style={st.pasteBigBtn} onPress={handlePaste} activeOpacity={0.7}>
              <View style={st.pasteIconWrap}>
                <Ionicons name="clipboard" size={28} color={P01Colors.cyan} />
              </View>
              <Text style={st.pasteTitle}>Paste Note</Text>
              <Text style={st.pasteHint}>
                Tap to paste the note data from your clipboard
              </Text>
            </TouchableOpacity>

            {/* Or type manually */}
            <View style={st.orRow}>
              <View style={st.orLine} />
              <Text style={st.orText}>or paste manually</Text>
              <View style={st.orLine} />
            </View>

            <TextInput
              style={st.input}
              value={noteData}
              onChangeText={handleTextChange}
              placeholder="Paste note data here..."
              placeholderTextColor={Colors.textTertiary}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
        </Animated.View>

        {/* Preview */}
        {preview && (
          <Animated.View entering={FadeIn.duration(200)}>
            <View style={[st.previewCard, !preview.poolFound && st.previewCardWarn]}>
              <View style={st.previewLeft}>
                <Ionicons
                  name={preview.poolFound ? 'checkmark-circle' : 'alert-circle'}
                  size={24}
                  color={preview.poolFound ? P01Colors.cyan : P01Colors.yellow}
                />
              </View>
              <View style={st.previewInfo}>
                <Text style={st.previewAmount}>{preview.denomination} {preview.token}</Text>
                <Text style={st.previewStatus}>
                  {preview.poolFound ? 'Valid note — pool verified' : 'Unknown pool'}
                </Text>
              </View>
            </View>
          </Animated.View>
        )}

        {/* Error */}
        {previewError && !preview?.poolFound && (
          <View style={st.errorCard}>
            <Ionicons name="alert-circle" size={14} color={Colors.error} />
            <Text style={st.errorText}>{previewError}</Text>
          </View>
        )}

        {/* Backup toggle */}
        <TouchableOpacity
          style={st.backupToggle}
          onPress={() => setIsBackup(!isBackup)}
          activeOpacity={0.7}
        >
          <Ionicons
            name={isBackup ? 'checkbox' : 'square-outline'}
            size={20}
            color={isBackup ? P01Colors.cyan : Colors.textTertiary}
          />
          <Text style={st.backupText}>This is a backup restore</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* Import button */}
      <View style={[st.footer, { paddingBottom: Math.max(Spacing.xl, insets.bottom + 96) }]}>
        <TouchableOpacity
          style={[st.importBtn, !preview && st.importBtnDisabled]}
          onPress={handleImport}
          disabled={!preview}
        >
          <Ionicons name="download" size={18} color="#000" />
          <Text style={st.importBtnText}>
            {preview ? `Receive ${preview.denomination} ${preview.token}` : 'Receive Note'}
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },

  // Header
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
  scrollContent: { paddingHorizontal: Spacing.xl, paddingBottom: 120 },

  // Paste card
  pasteCard: {
    backgroundColor: '#0f0f12', borderRadius: 20, padding: 20, marginBottom: Spacing.lg,
  },
  pasteBigBtn: { alignItems: 'center', paddingVertical: 24 },
  pasteIconWrap: {
    width: 56, height: 56, borderRadius: 16,
    backgroundColor: P01Colors.cyanDim,
    alignItems: 'center', justifyContent: 'center', marginBottom: 12,
  },
  pasteTitle: { fontSize: 17, fontFamily: FontFamily.bold, color: Colors.text },
  pasteHint: {
    fontSize: 13, fontFamily: FontFamily.regular, color: Colors.textSecondary,
    marginTop: 4, textAlign: 'center',
  },

  // Or divider
  orRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 16 },
  orLine: { flex: 1, height: 1, backgroundColor: Colors.border },
  orText: { fontSize: 12, fontFamily: FontFamily.regular, color: Colors.textTertiary },

  // Input
  input: {
    backgroundColor: 'rgba(0,0,0,0.3)', borderRadius: 12,
    padding: 14, color: Colors.text, fontFamily: FontFamily.mono, fontSize: 12,
    borderWidth: 1, borderColor: Colors.border, minHeight: 70,
  },

  // Preview
  previewCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: P01Colors.cyanDim, borderRadius: 14, padding: 16, marginBottom: Spacing.lg,
  },
  previewCardWarn: { backgroundColor: P01Colors.yellowDim },
  previewLeft: {},
  previewInfo: { flex: 1 },
  previewAmount: { fontSize: 18, fontFamily: FontFamily.bold, color: Colors.text },
  previewStatus: { fontSize: 12, fontFamily: FontFamily.regular, color: Colors.textSecondary, marginTop: 2 },

  // Error
  errorCard: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: Colors.errorDim, borderRadius: 10, padding: 10, marginBottom: Spacing.lg,
  },
  errorText: { flex: 1, fontSize: 12, fontFamily: FontFamily.regular, color: Colors.error },

  // Backup toggle
  backupToggle: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8,
  },
  backupText: { fontSize: 13, fontFamily: FontFamily.regular, color: Colors.textSecondary },

  // Footer
  footer: { paddingHorizontal: Spacing.xl },
  importBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 16, borderRadius: 14, backgroundColor: '#8B8BFF',
  },
  importBtnDisabled: { opacity: 0.4 },
  importBtnText: { fontSize: 16, fontFamily: FontFamily.bold, color: '#000' },

  // Success
  successContainer: {
    flex: 1, justifyContent: 'space-between', paddingHorizontal: Spacing.xl,
  },
  successContent: {
    flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  successIcon: { marginBottom: 8 },
  successTitle: { fontSize: 22, fontFamily: FontFamily.bold, color: Colors.text },
  successAmount: { fontSize: 18, fontFamily: FontFamily.semibold, color: '#8B8BFF' },
  successHint: {
    fontSize: 13, fontFamily: FontFamily.regular, color: Colors.textSecondary,
    textAlign: 'center', marginTop: 8, lineHeight: 19,
  },
  successActions: { gap: 10, paddingBottom: 80 },
  primaryBtn: {
    paddingVertical: 16, borderRadius: 14, alignItems: 'center',
    backgroundColor: P01Colors.cyan,
  },
  primaryBtnText: { fontSize: 16, fontFamily: FontFamily.bold, color: '#000' },
  ghostBtn: {
    paddingVertical: 16, borderRadius: 14, alignItems: 'center',
    backgroundColor: '#0f0f12',
  },
  ghostBtnText: { fontSize: 15, fontFamily: FontFamily.semibold, color: Colors.text },
});

/**
 * Receive a note — paste the string somebody sent you.
 *
 * 🎯 REBUILT ON THE REALIGNED THEME 2026-08-23, and shortened by one screen.
 *
 * ⛔ THE SUCCESS PAGE IS GONE. Importing landed on a full-screen checkmark with
 * "View Notes" and "Done" — two buttons for one outcome, on a page that told
 * the user nothing the notes list does not already show. The import now returns
 * the user to where they were, which is the list the note just joined.
 *
 * ⛔ AND SO IS THE PASTE CARD. A 56pt tinted disc, a heading, a hint and an
 * "or paste manually" divider stood in front of a text field that did the same
 * job. The field is the affordance; the Paste control sits on its label row.
 *
 * ⚠️ The decode preview is the whole safety story on this screen: an unknown
 * pool means the note belongs to another network, and that has to be visible
 * BEFORE the button is pressed, not after.
 */

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
import { decodeShareableNote, ALL_POOLS, ALL_POOLS_V3 } from '@/services/denominatedPool';
import { Colors, FontFamily, FontSize, BorderRadius, Spacing } from '@/constants/theme';
import { Button } from '@/components/ui';
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
      const poolFound =
        ALL_POOLS_V3.some(p => p.poolPDA.toBase58() === decoded.pool)
        || ALL_POOLS.some(p => p.poolPDA.toBase58() === decoded.pool);
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
      // Resolve the imported note's true on-chain status (mature vs maturing)
      // so the notes list reflects reality on arrival rather than a brief stale
      // 'imported' flash. Read-only, idempotent, non-fatal on error.
      useDenominatedPoolStore.getState().refreshNoteStatuses().catch(() => {});
      // ⛔ No success page. The outcome is a row in the list behind this screen.
      p01Alert(
        'Note received',
        isBackup
          ? 'Restored from backup.'
          : 'It has to mature before you can send or withdraw it.',
        [{ text: 'OK' }],
        'success',
      );
      router.back();
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      p01Alert('Import Failed', (err as Error).message);
    }
  }, [noteData, importNote, isBackup, router]);

  return (
    <SafeAreaView style={st.container} edges={['top']}>
      <View style={st.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={st.backBtn}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="chevron-back" size={22} color={Colors.textSecondary} />
        </TouchableOpacity>
        <Text style={st.headerTitle}>Receive note</Text>
        <View style={st.headerSpacer} />
      </View>

      <ScrollView
        style={st.scroll}
        contentContainerStyle={st.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <Animated.View entering={FadeInDown.duration(250)}>
          <View style={st.fieldHeader}>
            <Text style={st.label}>Note from the sender</Text>
            <TouchableOpacity
              onPress={handlePaste}
              style={st.pasteBtn}
              accessibilityRole="button"
              accessibilityLabel="Paste from clipboard"
            >
              <Ionicons name="clipboard-outline" size={15} color={Colors.primary} />
              <Text style={st.pasteText}>Paste</Text>
            </TouchableOpacity>
          </View>

          <TextInput
            style={[st.input, !!previewError && st.inputError]}
            value={noteData}
            onChangeText={handleTextChange}
            placeholder="Paste the note here"
            placeholderTextColor={Colors.textTertiary}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Note from the sender"
          />

          {/* The error belongs to the field, and it announces itself. */}
          {previewError ? (
            <View style={st.errorRow} accessibilityRole="alert" accessibilityLiveRegion="polite">
              <Ionicons name="alert-circle" size={13} color={Colors.error} />
              <Text style={st.errorText}>{previewError}</Text>
            </View>
          ) : null}
        </Animated.View>

        {preview ? (
          <Animated.View entering={FadeIn.duration(200)}>
            <View style={[st.previewPanel, !preview.poolFound && st.previewPanelWarn]}>
              <Ionicons
                name={preview.poolFound ? 'checkmark-circle-outline' : 'alert-circle-outline'}
                size={20}
                color={preview.poolFound ? Colors.primary : Colors.warning}
              />
              <View style={st.previewInfo}>
                <Text style={st.previewAmount}>
                  {preview.denomination} {preview.token}
                </Text>
                <Text style={st.previewStatus}>
                  {preview.poolFound ? 'Pool recognised' : 'Unknown pool'}
                </Text>
              </View>
            </View>
          </Animated.View>
        ) : null}

        <TouchableOpacity
          style={st.backupToggle}
          onPress={() => setIsBackup(!isBackup)}
          activeOpacity={0.7}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: isBackup }}
          accessibilityLabel="This is a backup restore"
        >
          <Ionicons
            name={isBackup ? 'checkbox' : 'square-outline'}
            size={20}
            color={isBackup ? Colors.primary : Colors.textTertiary}
          />
          <Text style={st.backupText}>This is a backup restore</Text>
        </TouchableOpacity>
      </ScrollView>

      <View style={[st.footer, { paddingBottom: Math.max(Spacing.xl, insets.bottom + 96) }]}>
        <Button
          variant="primary"
          size="lg"
          fullWidth
          disabled={!preview || imported}
          onPress={handleImport}
          icon={<Ionicons name="download-outline" size={18} color={Colors.background} />}
        >
          {preview ? `Receive ${preview.denomination} ${preview.token}` : 'Receive note'}
        </Button>
      </View>
    </SafeAreaView>
  );
}

const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, minHeight: 56,
  },
  backBtn: { width: 44, height: 44, justifyContent: 'center', alignItems: 'center' },
  headerSpacer: { width: 44 },
  headerTitle: {
    flex: 1, color: Colors.text, fontSize: FontSize.xl, fontFamily: FontFamily.displayMedium,
  },

  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: Spacing.xl, paddingTop: Spacing.lg, paddingBottom: 120 },

  fieldHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: Spacing.sm,
  },
  label: {
    fontSize: FontSize.sm, fontFamily: FontFamily.medium, color: Colors.textSecondary,
  },
  pasteBtn: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.xs,
    minHeight: 44, paddingHorizontal: Spacing.sm,
  },
  pasteText: { fontSize: FontSize.sm, fontFamily: FontFamily.medium, color: Colors.primary },

  input: {
    minHeight: 96,
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border,
    padding: Spacing.lg,
    color: Colors.text, fontFamily: FontFamily.mono, fontSize: FontSize.xs,
  },
  inputError: { borderColor: Colors.error },

  errorRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, marginTop: Spacing.sm,
  },
  errorText: {
    flex: 1, fontSize: FontSize.xs, fontFamily: FontFamily.regular, color: Colors.error,
  },

  previewPanel: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.border,
    padding: Spacing.lg, marginTop: Spacing.xl,
  },
  previewPanelWarn: { borderColor: Colors.warning, backgroundColor: Colors.warningDim },
  previewInfo: { flex: 1 },
  previewAmount: {
    fontSize: FontSize.lg, fontFamily: FontFamily.monoMedium, color: Colors.text,
  },
  previewStatus: {
    fontSize: FontSize.xs, fontFamily: FontFamily.regular,
    color: Colors.textSecondary, marginTop: 2,
  },

  backupToggle: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    minHeight: 44, marginTop: Spacing.xl,
  },
  backupText: {
    fontSize: FontSize.sm, fontFamily: FontFamily.regular, color: Colors.textSecondary,
  },

  footer: { paddingHorizontal: Spacing.xl },
});

/**
 * Backup & recovery — the seed phrase, the encrypted archive, and the notes.
 *
 * 🎯 REBUILT ON THE REALIGNED THEME AND THE SHARED KIT 2026-08-23.
 *
 * ⛔ FOUR ROWS WERE PASSING THEIR OWN LABEL AS THEIR DESCRIPTION.
 * "Restore Backup / Restore Backup" appeared under itself; so did the import
 * row. A second line that repeats the first looks like an explanation and
 * therefore stops the reader from looking for one.
 *
 * 🚨 THE PASSWORD ERRORS WERE MODAL ALERTS. "Password must be at least 8
 * characters" and "Passwords do not match" were thrown as `p01Alert` over the
 * form, which dismisses, leaves no trace next to the field, and is announced
 * with no relationship to the input that caused it. They are inline now, under
 * their own field, with `accessibilityRole="alert"` — the rule the extension's
 * `Field` bakes in, applied here by hand because these are raw `TextInput`s.
 *
 * ⛔ AND THE SUCCESS/DANGER COLOURS WERE OFF-PALETTE: `#22c55e` green for a
 * completed backup in a system whose first rule is that there is no green, and
 * `#f87171`/`rgba(252,165,165,…)` for warnings where the palette has one red.
 *
 * ⚠️ NOTHING ABOUT WHAT IS BACKED UP CHANGED. Same store calls, same crypto,
 * same three flows. This is a pass over how they read.
 */

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Modal,
  TextInput,
  StyleSheet,
  Share,
} from 'react-native';
import { useRouter } from 'expo-router';
import { p01Alert } from '@/stores/alertStore';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import * as LocalAuthentication from 'expo-local-authentication';
import * as ScreenCapture from 'expo-screen-capture';

import { Header } from '@/components/common';
import { Button } from '@/components/ui';
import { SettingsRow, SettingsSection } from '@/components/settings';
import { Colors, FontFamily, FontSize, BorderRadius, Spacing, Layout } from '@/constants/theme';
import { useT } from '@/i18n';
import { useWalletStore } from '@/stores/walletStore';
import { useDenominatedPoolStore } from '@/stores/denominatedPoolStore';
import {
  createEncryptedBackup,
  decryptBackup,
  parseBackupMetadata,
  restoreNotes,
  getBackupStatus,
  setBackupStatus,
  BackupMetadata,
  BackupPayload,
} from '@/services/backup';
import { importWallet } from '@/services/solana/wallet';
import { scheduleLocalNotification } from '@/services/notifications';

/* ──────────────────────── Screen ──────────────────────── */

export default function BackupRecoveryScreen() {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { getBackupMnemonic, publicKey } = useWalletStore();
  const { getActiveNotes, exportAllNotes, importNote } = useDenominatedPoolStore();

  // Backup status (persisted)
  const [isBackedUp, setIsBackedUp] = useState(false);
  const [lastBackupAt, setLastBackupAt] = useState<number | null>(null);

  // Seed phrase modal
  const [showSeedModal, setShowSeedModal] = useState(false);
  const [seedPhrase, setSeedPhrase] = useState<string[]>([]);
  const [seedCopied, setSeedCopied] = useState(false);

  // Export modal
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportPassword, setExportPassword] = useState('');
  const [exportConfirmPassword, setExportConfirmPassword] = useState('');
  const [exportHint, setExportHint] = useState('');
  const [exporting, setExporting] = useState(false);
  const [showExportPassword, setShowExportPassword] = useState(false);
  const [exportPasswordError, setExportPasswordError] = useState('');
  const [exportConfirmError, setExportConfirmError] = useState('');

  // Import modal
  const [showImportModal, setShowImportModal] = useState(false);
  const [importData, setImportData] = useState('');
  const [importPassword, setImportPassword] = useState('');
  const [importPreview, setImportPreview] = useState<BackupMetadata | null>(null);
  const [importing, setImporting] = useState(false);
  const [showImportPassword, setShowImportPassword] = useState(false);
  const [importError, setImportError] = useState('');

  // Note stats
  const activeNotes = getActiveNotes();
  const solNoteCount = activeNotes.filter(n => n.token === 'SOL').length;
  const usdcNoteCount = activeNotes.filter(n => n.token === 'USDC').length;
  const totalNoteValue = activeNotes
    .filter(n => n.token === 'SOL')
    .reduce((sum, n) => sum + n.denomination, 0);

  useEffect(() => {
    if (showSeedModal) {
      ScreenCapture.preventScreenCaptureAsync();
    } else {
      ScreenCapture.allowScreenCaptureAsync();
    }
  }, [showSeedModal]);

  // Load persisted backup status
  useEffect(() => {
    getBackupStatus().then(({ backedUp, lastBackupAt: ts }) => {
      setIsBackedUp(backedUp);
      setLastBackupAt(ts);
    });
  }, []);

  // ── Seed Phrase ──

  const handleShowSeedPhrase = async () => {
    // Every wallet is a local seed-phrase keypair now (Privy removed — spec §3 Phase 1).
    try {
      // M8: Always require authentication — fall back to device PIN when biometrics unavailable
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Authenticate to view seed phrase',
        disableDeviceFallback: false, // falls back to device PIN/pattern/password
        cancelLabel: 'Cancel',
      });
      if (!result.success) return;

      const mnemonic = await getBackupMnemonic();
      if (mnemonic) {
        setSeedPhrase(mnemonic.split(' '));
        setShowSeedModal(true);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      } else {
        p01Alert(t('common.error'), t('alerts.errorGeneric'));
      }
    } catch {
      p01Alert(t('common.error'), t('alerts.errorGeneric'));
    }
  };

  const handleCopySeed = async () => {
    if (seedPhrase.length === 0) return;
    await Clipboard.setStringAsync(seedPhrase.join(' '));
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setSeedCopied(true);
    setTimeout(() => setSeedCopied(false), 2000);
    setTimeout(async () => {
      try { await Clipboard.setStringAsync(''); } catch {}
    }, 60000);
  };

  const handleConfirmSeedBackup = async () => {
    setShowSeedModal(false);
    setSeedPhrase([]);
    await setBackupStatus(true);
    setIsBackedUp(true);
    setLastBackupAt(Date.now());
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  // ── Encrypted Export ──

  const handleExportBackup = async () => {
    // Require auth first — always authenticate, fall back to device PIN
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Authenticate to export backup',
        disableDeviceFallback: false,
        cancelLabel: 'Cancel',
      });
      if (!result.success) return;
    } catch {
      p01Alert(t('common.error'), t('alerts.errorGeneric'));
      return;
    }

    setShowExportModal(true);
    setExportPassword('');
    setExportConfirmPassword('');
    setExportHint('');
    setExportPasswordError('');
    setExportConfirmError('');
  };

  const handleCreateBackup = async () => {
    // Errors land under the field that caused them, not in a sheet over the form.
    setExportPasswordError('');
    setExportConfirmError('');

    if (exportPassword.length < 8) {
      setExportPasswordError('At least 8 characters.');
      return;
    }
    if (exportPassword !== exportConfirmPassword) {
      setExportConfirmError('These two do not match.');
      return;
    }

    setExporting(true);
    try {
      const encoded = await createEncryptedBackup(exportPassword, exportHint);

      setExporting(false);
      setShowExportModal(false);
      setIsBackedUp(true);
      setLastBackupAt(Date.now());

      // Offer to copy or share
      p01Alert(
        t('common.success'),
        `Encrypted backup with ${activeNotes.length} note${activeNotes.length !== 1 ? 's' : ''} created successfully.`,
        [
          {
            text: t('common.copied'),
            onPress: async () => {
              await Clipboard.setStringAsync(encoded);
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              setTimeout(async () => {
                try { await Clipboard.setStringAsync(''); } catch {}
              }, 120000);
            },
          },
          {
            text: t('common.share'),
            onPress: () => {
              Share.share({
                message: encoded,
                title: 'Protocol 01 Encrypted Backup',
              });
            },
          },
          { text: t('common.done'), style: 'cancel' },
        ],
      );

      scheduleLocalNotification(
        'Backup Created',
        `Wallet backup with ${activeNotes.length} notes exported successfully.`,
        { category: 'security', action: 'backup_created' },
        { channelId: 'security' },
      ).catch(() => {});
    } catch (err) {
      setExporting(false);
      setExportPasswordError((err as Error).message);
    }
  };

  // ── Encrypted Import ──

  const handleOpenImport = () => {
    setShowImportModal(true);
    setImportData('');
    setImportPassword('');
    setImportPreview(null);
    setImportError('');
  };

  // Parse preview when import data changes
  useEffect(() => {
    if (importData.length > 50) {
      const meta = parseBackupMetadata(importData.trim());
      setImportPreview(meta);
    } else {
      setImportPreview(null);
    }
  }, [importData]);

  const handleRestoreBackup = async () => {
    setImportError('');

    if (!importData.trim()) {
      setImportError('Paste the backup first.');
      return;
    }
    if (!importPassword) {
      setImportError('Enter the password this backup was made with.');
      return;
    }

    setImporting(true);
    try {
      const payload = decryptBackup(importData.trim(), importPassword);

      // Ask user what to restore
      const currentPk = publicKey;
      const isSameWallet = currentPk === payload.publicKey;

      if (isSameWallet) {
        // Same wallet — just import notes
        const imported = restoreNotes(payload);
        setImporting(false);
        setShowImportModal(false);

        p01Alert(
          t('common.success'),
          `${imported} note${imported !== 1 ? 's' : ''} imported from backup.`,
        );
      } else {
        // Different wallet — warn and ask
        setImporting(false);

        p01Alert(
          t('common.warning'),
          `This backup is from wallet ${payload.publicKey.slice(0, 4)}...${payload.publicKey.slice(-4)}. ` +
          `Restoring will replace your current wallet. Continue?`,
          [
            { text: t('common.cancel'), style: 'cancel' },
            {
              text: t('privacy.importNote'),
              onPress: () => {
                const imported = restoreNotes(payload);
                setShowImportModal(false);
                p01Alert(t('common.done'), `${imported} notes imported.`);
              },
            },
            {
              text: t('settings.restoreBackup'),
              style: 'destructive',
              onPress: async () => {
                try {
                  await importWallet(payload.mnemonic);
                  const imported = restoreNotes(payload);
                  setShowImportModal(false);
                  p01Alert(
                    t('common.success'),
                    `Wallet and ${imported} notes restored from backup.`,
                  );
                } catch (err) {
                  p01Alert(t('common.error'), (err as Error).message);
                }
              },
            },
          ],
        );
      }
    } catch (err) {
      setImporting(false);
      setImportError((err as Error).message);
    }
  };

  // ── Note Export (Quick) ──

  const handleExportNotes = async () => {
    const encoded = exportAllNotes();
    if (encoded.length === 0) {
      p01Alert(t('alerts.noNotes'), t('privacy.noBackup'));
      return;
    }

    const data = JSON.stringify(encoded);
    await Clipboard.setStringAsync(data);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    p01Alert(
      t('privacy.noteExported'),
      t('privacy.noteExportedDesc'),
    );
    setTimeout(async () => {
      try { await Clipboard.setStringAsync(''); } catch {}
    }, 60000);
  };

  const handleImportNotes = () => {
    router.push('/(main)/(privacy)/denominated-import' as any);
  };

  // ── Render ──

  return (
    <View style={styles.screen}>
      <Header title={t('settings.backup')} showBack onBackPress={() => router.back()} />

      <ScrollView
        style={styles.flex}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingBottom: Layout.tabBarTotalHeight + insets.bottom + Spacing['3xl'],
        }}
      >
        {/* ── The one fact this screen exists to change. ── */}
        <View style={[styles.status, isBackedUp ? styles.statusGood : styles.statusBad]}>
          <Ionicons
            name={isBackedUp ? 'shield-checkmark-outline' : 'warning-outline'}
            size={20}
            color={isBackedUp ? Colors.primary : Colors.error}
          />
          <View style={styles.statusText}>
            <Text style={[styles.statusTitle, !isBackedUp && styles.statusTitleBad]}>
              {isBackedUp ? 'This wallet is backed up' : 'This wallet is not backed up'}
            </Text>
            <Text style={styles.statusBody}>
              {isBackedUp && lastBackupAt
                ? `${t('settings.lastBackup')}: ${new Date(lastBackupAt).toLocaleDateString()}`
                : 'Lose this device without a backup and the funds and notes on it are gone.'}
            </Text>
          </View>
        </View>

        {/* ── Seed phrase ── */}
        <SettingsSection
          title={t('settings.seedPhrase')}
          footer="Never share it. Anyone who has it can spend everything this wallet holds."
        >
          <SettingsRow
            label={t('settings.seedPhrase')}
            description="12 words. Asks for your device authentication first."
            leftIcon="key-outline"
            rightIcon="lock-closed-outline"
            onPress={handleShowSeedPhrase}
          />
        </SettingsSection>

        {/* ── Encrypted archive ── */}
        <SettingsSection
          title="Encrypted backup"
          footer="Holds the seed phrase and every privacy note, sealed with XSalsa20-Poly1305. Without the password it is unreadable — including by us."
        >
          <SettingsRow
            label={t('settings.exportKeys')}
            description={`Wallet and ${activeNotes.length} note${activeNotes.length !== 1 ? 's' : ''}, password protected`}
            leftIcon="download-outline"
            onPress={handleExportBackup}
          />
          <SettingsRow
            label={t('settings.restoreBackup')}
            description="Paste an archive and its password"
            leftIcon="push-outline"
            onPress={handleOpenImport}
          />
        </SettingsSection>

        {/* ── Privacy notes ── */}
        <SettingsSection title="Privacy notes">
          <View style={styles.stats}>
            <Stat value={String(activeNotes.length)} label="Active" />
            <View style={styles.statRule} />
            <Stat value={String(solNoteCount)} label="SOL" />
            <View style={styles.statRule} />
            <Stat value={String(usdcNoteCount)} label="USDC" />
            <View style={styles.statRule} />
            <Stat value={totalNoteValue.toFixed(2)} label="SOL total" />
          </View>
          <SettingsRow
            label={t('privacy.backupNotes')}
            description={t('privacy.notesStoredLocally')}
            leftIcon="document-text-outline"
            rightIcon="copy-outline"
            onPress={handleExportNotes}
          />
          <SettingsRow
            label={t('privacy.importNote')}
            description="Bring a note in from another device"
            leftIcon="add-circle-outline"
            onPress={handleImportNotes}
          />
        </SettingsSection>
      </ScrollView>

      {/* ════════════ Seed phrase ════════════ */}
      <Modal
        visible={showSeedModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => { setShowSeedModal(false); setSeedPhrase([]); }}
      >
        <View style={[styles.modal, { paddingTop: insets.top }]}>
          <SheetHeader
            title={t('settings.seedPhrase')}
            onClose={() => { setShowSeedModal(false); setSeedPhrase([]); }}
          />

          <ScrollView style={styles.modalBody} keyboardShouldPersistTaps="handled">
            <View style={styles.seedWarning}>
              <Ionicons name="eye-off-outline" size={18} color={Colors.error} />
              <Text style={styles.seedWarningText}>
                Do not photograph this and do not type it into anything but a wallet you own.
                Screenshots are blocked while it is on screen.
              </Text>
            </View>

            <View style={styles.seedGrid}>
              {seedPhrase.map((word, index) => (
                <View key={index} style={styles.seedCell}>
                  <Text style={styles.seedIndex}>{index + 1}</Text>
                  <Text style={styles.seedWord}>{word}</Text>
                </View>
              ))}
            </View>

            <View style={styles.modalActions}>
              <Button
                variant="secondary"
                fullWidth
                onPress={handleCopySeed}
                icon={
                  <Ionicons
                    name={seedCopied ? 'checkmark' : 'copy-outline'}
                    size={18}
                    color={seedCopied ? Colors.primary : Colors.text}
                  />
                }
              >
                {seedCopied ? t('common.copied') : t('onboarding.copyAll')}
              </Button>
              <Button fullWidth size="lg" onPress={handleConfirmSeedBackup}>
                I have written it down
              </Button>
            </View>
          </ScrollView>
        </View>
      </Modal>

      {/* ════════════ Export ════════════ */}
      <Modal
        visible={showExportModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowExportModal(false)}
      >
        <View style={[styles.modal, { paddingTop: insets.top }]}>
          <SheetHeader title={t('settings.exportKeys')} onClose={() => setShowExportModal(false)} />

          <ScrollView style={styles.modalBody} keyboardShouldPersistTaps="handled">
            <Text style={styles.modalBlurb}>
              One sealed blob containing your seed phrase, {activeNotes.length} privacy note
              {activeNotes.length !== 1 ? 's' : ''}
              {totalNoteValue > 0 ? ` worth ${totalNoteValue.toFixed(2)} SOL` : ''}, and your
              settings. The password is the only key to it.
            </Text>

            <Field
              label="Backup password"
              value={exportPassword}
              onChangeText={(v) => { setExportPassword(v); setExportPasswordError(''); }}
              placeholder="At least 8 characters"
              secure={!showExportPassword}
              onToggleSecure={() => setShowExportPassword(!showExportPassword)}
              error={exportPasswordError}
            />

            <Field
              label="Confirm password"
              value={exportConfirmPassword}
              onChangeText={(v) => { setExportConfirmPassword(v); setExportConfirmError(''); }}
              placeholder="Type it again"
              secure={!showExportPassword}
              error={exportConfirmError}
            />

            <Field
              label="Hint (optional)"
              value={exportHint}
              onChangeText={setExportHint}
              placeholder="Something only you would read correctly"
            />

            <View style={styles.modalActions}>
              <Button fullWidth size="lg" loading={exporting} onPress={handleCreateBackup}>
                {t('settings.backupNow')}
              </Button>
            </View>
          </ScrollView>
        </View>
      </Modal>

      {/* ════════════ Import ════════════ */}
      <Modal
        visible={showImportModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowImportModal(false)}
      >
        <View style={[styles.modal, { paddingTop: insets.top }]}>
          <SheetHeader title={t('settings.restoreBackup')} onClose={() => setShowImportModal(false)} />

          <ScrollView style={styles.modalBody} keyboardShouldPersistTaps="handled">
            <Field
              label="Backup"
              value={importData}
              onChangeText={(v) => { setImportData(v); setImportError(''); }}
              placeholder="Paste the encrypted backup"
              multiline
            />

            {importPreview ? (
              <View style={styles.preview}>
                <Ionicons name="checkmark-circle-outline" size={16} color={Colors.primary} />
                <Text style={styles.previewText}>
                  Readable archive from {new Date(importPreview.createdAt).toLocaleDateString()}
                  {importPreview.hint ? ` · hint: ${importPreview.hint}` : ''}
                </Text>
              </View>
            ) : null}

            <Field
              label="Backup password"
              value={importPassword}
              onChangeText={(v) => { setImportPassword(v); setImportError(''); }}
              placeholder="The password this archive was made with"
              secure={!showImportPassword}
              onToggleSecure={() => setShowImportPassword(!showImportPassword)}
              error={importError}
            />

            <View style={styles.modalActions}>
              <Button
                fullWidth
                size="lg"
                loading={importing}
                disabled={!importPreview}
                onPress={handleRestoreBackup}
              >
                {t('settings.restoreBackup')}
              </Button>
            </View>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

/* ──────────────────────── Pieces ──────────────────────── */

const Stat: React.FC<{ value: string; label: string }> = ({ value, label }) => (
  <View style={styles.stat}>
    <Text style={styles.statValue}>{value}</Text>
    <Text style={styles.statLabel}>{label}</Text>
  </View>
);

const SheetHeader: React.FC<{ title: string; onClose: () => void }> = ({ title, onClose }) => (
  <View style={styles.sheetHeader}>
    <Text style={styles.sheetTitle}>{title}</Text>
    <TouchableOpacity
      onPress={onClose}
      style={styles.sheetClose}
      accessibilityRole="button"
      accessibilityLabel="Close"
    >
      <Ionicons name="close" size={22} color={Colors.textSecondary} />
    </TouchableOpacity>
  </View>
);

/**
 * ⚠️ A visible label, always. A placeholder is not a label: it disappears the
 * moment the field is used, which is exactly when the user needs it.
 */
const Field: React.FC<{
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  secure?: boolean;
  onToggleSecure?: () => void;
  multiline?: boolean;
  error?: string;
}> = ({ label, value, onChangeText, placeholder, secure, onToggleSecure, multiline, error }) => (
  <View style={styles.field}>
    <Text style={styles.fieldLabel}>{label}</Text>
    <View style={styles.fieldRow}>
      <TextInput
        style={[
          styles.input,
          multiline && styles.inputMultiline,
          !!error && styles.inputError,
        ]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={Colors.textTertiary}
        secureTextEntry={secure}
        multiline={multiline}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={label}
      />
      {onToggleSecure ? (
        <TouchableOpacity
          onPress={onToggleSecure}
          style={styles.eye}
          accessibilityRole="button"
          accessibilityLabel={secure ? 'Show password' : 'Hide password'}
        >
          <Ionicons name={secure ? 'eye-outline' : 'eye-off-outline'} size={20} color={Colors.textTertiary} />
        </TouchableOpacity>
      ) : null}
    </View>
    {error ? (
      <Text style={styles.fieldError} accessibilityRole="alert">{error}</Text>
    ) : null}
  </View>
);

/* ──────────────────────── Styles ──────────────────────── */

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.background },
  flex: { flex: 1 },

  /* Status */
  status: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.md,
    marginTop: Spacing.lg,
    marginHorizontal: Spacing.xl,
    padding: Spacing.lg,
    borderRadius: BorderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  statusGood: { borderColor: Colors.primaryMuted, backgroundColor: Colors.primaryDim },
  statusBad: { borderColor: Colors.error, backgroundColor: Colors.errorDim },
  statusText: { flex: 1, minWidth: 0 },
  statusTitle: {
    color: Colors.text,
    fontSize: FontSize.md,
    fontFamily: FontFamily.medium,
  },
  statusTitleBad: { color: Colors.error },
  statusBody: {
    color: Colors.textSecondary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    lineHeight: 19,
    marginTop: 2,
  },

  /* Note stats */
  stats: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.lg,
    paddingHorizontal: Spacing.sm,
  },
  stat: { flex: 1, alignItems: 'center' },
  statValue: {
    color: Colors.text,
    fontSize: FontSize.xl,
    fontFamily: FontFamily.mono,
  },
  statLabel: {
    color: Colors.textTertiary,
    fontSize: FontSize.xs,
    fontFamily: FontFamily.regular,
    marginTop: 3,
  },
  statRule: {
    width: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
    marginVertical: Spacing.xs,
    backgroundColor: Colors.borderSoft,
  },

  /* Sheets */
  modal: { flex: 1, backgroundColor: Colors.background },
  modalBody: { flex: 1, paddingHorizontal: Spacing.xl },
  modalBlurb: {
    color: Colors.textSecondary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    lineHeight: 20,
    marginTop: Spacing.md,
  },
  modalActions: {
    marginTop: Spacing['2xl'],
    marginBottom: Spacing['4xl'],
    gap: Spacing.md,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.borderSoft,
  },
  sheetTitle: {
    color: Colors.text,
    fontSize: FontSize.xl,
    fontFamily: FontFamily.displayMedium,
  },
  sheetClose: {
    width: 44,
    height: 44,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },

  /* Seed */
  seedWarning: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.md,
    marginTop: Spacing.lg,
    padding: Spacing.lg,
    borderRadius: BorderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.error,
    backgroundColor: Colors.errorDim,
  },
  seedWarningText: {
    flex: 1,
    color: Colors.error,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    lineHeight: 19,
  },
  seedGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
    marginTop: Spacing.xl,
  },
  seedCell: {
    flexBasis: '31%',
    flexGrow: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSoft,
    backgroundColor: Colors.surfaceSecondary,
  },
  seedIndex: {
    color: Colors.textTertiary,
    fontSize: FontSize.xs,
    fontFamily: FontFamily.mono,
    minWidth: 14,
  },
  seedWord: {
    flex: 1,
    color: Colors.text,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.mono,
  },

  /* Fields */
  field: { marginTop: Spacing.xl },
  fieldLabel: {
    color: Colors.textTertiary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    marginBottom: Spacing.sm,
  },
  fieldRow: { flexDirection: 'row', alignItems: 'center' },
  input: {
    flex: 1,
    minHeight: 48,
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    color: Colors.text,
    fontFamily: FontFamily.mono,
    fontSize: FontSize.sm,
  },
  inputMultiline: { minHeight: 110, textAlignVertical: 'top' },
  inputError: { borderColor: Colors.error },
  eye: {
    position: 'absolute',
    right: 4,
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fieldError: {
    color: Colors.error,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    marginTop: Spacing.sm,
  },

  /* Import preview */
  preview: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
    marginTop: Spacing.md,
  },
  previewText: {
    flex: 1,
    color: Colors.textSecondary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    lineHeight: 19,
  },
});

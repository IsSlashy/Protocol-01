import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Modal,
  TextInput,
  ActivityIndicator,
  StyleSheet,
  Share,
} from 'react-native';
import { useRouter } from 'expo-router';
import { p01Alert } from '@/stores/alertStore';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import * as LocalAuthentication from 'expo-local-authentication';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';

import * as ScreenCapture from 'expo-screen-capture';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
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

/* ──────────────────────── Glass Card ──────────────────────── */

const GlassCard: React.FC<{ children: React.ReactNode; delay?: number; style?: object }> = ({
  children,
  delay = 0,
  style,
}) => (
  <Animated.View entering={FadeInDown.delay(delay).duration(350)} style={[styles.glassOuter, style]}>
    <View style={styles.glassBlur}>
      {children}
    </View>
  </Animated.View>
);

const SectionTitle: React.FC<{ title: string; delay?: number }> = ({ title, delay = 0 }) => (
  <Animated.Text entering={FadeInDown.delay(delay).duration(300)} style={styles.sectionTitle}>
    {title}
  </Animated.Text>
);

const GlassDivider: React.FC = () => <View style={styles.divider} />;

/* ──────────────────────── Screen ──────────────────────── */

export default function BackupRecoveryScreen() {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { getBackupMnemonic, publicKey, isPrivyWallet } = useWalletStore();
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

  // Import modal
  const [showImportModal, setShowImportModal] = useState(false);
  const [importData, setImportData] = useState('');
  const [importPassword, setImportPassword] = useState('');
  const [importPreview, setImportPreview] = useState<BackupMetadata | null>(null);
  const [importing, setImporting] = useState(false);
  const [showImportPassword, setShowImportPassword] = useState(false);

  // Note stats
  const activeNotes = getActiveNotes();
  const solNoteCount = activeNotes.filter(n => n.token === 'SOL').length;
  const usdcNoteCount = activeNotes.filter(n => n.token === 'USDC').length;
  const totalNoteValue = activeNotes
    .filter(n => n.token === 'SOL')
    .reduce((sum, n) => sum + n.denomination, 0);

  // H3: Block screenshots when seed phrase modal is visible
  // TEMP: disabled for demo recording
  useEffect(() => {
    // if (showSeedModal) {
    //   ScreenCapture.preventScreenCaptureAsync();
    // } else {
    //   ScreenCapture.allowScreenCaptureAsync();
    // }
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
    if (isPrivyWallet) {
      p01Alert(
        t('common.warning'),
        'Your wallet is managed by Privy. The private key is secured by Privy\'s infrastructure and cannot be exported as a seed phrase.\n\nUse the Encrypted Backup feature below to back up your privacy pool notes.',
        [{ text: t('common.ok') }],
      );
      return;
    }
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
  };

  const handleCreateBackup = async () => {
    if (exportPassword.length < 8) {
      p01Alert(t('common.warning'), 'Password must be at least 8 characters.');
      return;
    }
    if (exportPassword !== exportConfirmPassword) {
      p01Alert(t('common.error'), 'Passwords do not match.');
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
      p01Alert(t('common.error'), (err as Error).message);
    }
  };

  // ── Encrypted Import ──

  const handleOpenImport = () => {
    setShowImportModal(true);
    setImportData('');
    setImportPassword('');
    setImportPreview(null);
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
    if (!importData.trim()) {
      p01Alert(t('common.error'), t('alerts.errorGeneric'));
      return;
    }
    if (!importPassword) {
      p01Alert(t('common.error'), t('alerts.errorGeneric'));
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
      p01Alert(t('common.error'), (err as Error).message);
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
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <Animated.View entering={FadeInDown.delay(50).duration(300)} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton} accessibilityRole="button" accessibilityLabel="Go back">
          <Ionicons name="arrow-back" size={20} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('settings.backup')}</Text>
        <View style={{ width: 40 }} />
      </Animated.View>

      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 120 }}>
        {/* Backup Status Card */}
        <GlassCard delay={100}>
          <View style={styles.statusRow}>
            <View style={[styles.statusIcon, { backgroundColor: isBackedUp ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)' }]}>
              <Ionicons
                name={isBackedUp ? 'shield-checkmark' : 'shield-outline'}
                size={24}
                color={isBackedUp ? '#22c55e' : '#ef4444'}
              />
            </View>
            <View style={{ flex: 1, marginLeft: Spacing.lg }}>
              <Text style={styles.rowLabel}>
                {isBackedUp ? t('settings.backup') : t('settings.backupNow')}
              </Text>
              <Text style={styles.rowDescription}>
                {isBackedUp && lastBackupAt
                  ? `${t('settings.lastBackup')}: ${new Date(lastBackupAt).toLocaleDateString()}`
                  : t('settings.backupNow')}
              </Text>
            </View>
          </View>
        </GlassCard>

        {/* Warning if not backed up */}
        {!isBackedUp && (
          <Animated.View entering={FadeInDown.delay(150).duration(350)} style={styles.warningOuter}>
            <View style={[styles.glassBlur, { padding: Spacing.lg }]}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                <View style={styles.warningIcon}>
                  <Ionicons name="warning" size={22} color="#ef4444" />
                </View>
                <View style={{ flex: 1, marginLeft: Spacing.md }}>
                  <Text style={styles.warningTitle}>Back Up Your Wallet</Text>
                  <Text style={styles.warningDescription}>
                    If you lose this device without a backup, your funds and privacy notes are gone forever.
                  </Text>
                </View>
              </View>
            </View>
          </Animated.View>
        )}

        {/* ── SEED PHRASE ── */}
        <SectionTitle title={t('settings.seedPhrase').toUpperCase()} delay={200} />
        <GlassCard delay={220}>
          <TouchableOpacity style={styles.actionRow} onPress={handleShowSeedPhrase} activeOpacity={0.7}>
            <View style={[styles.actionIcon, { backgroundColor: 'rgba(57, 197, 187, 0.15)' }]}>
              <Ionicons name="key" size={20} color={P01Colors.cyan} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowLabel}>{t('settings.seedPhrase')}</Text>
              <Text style={styles.rowDescription}>{t('settings.viewKeys')}</Text>
            </View>
            <Ionicons name="lock-closed" size={16} color={Colors.textTertiary} />
          </TouchableOpacity>
        </GlassCard>

        <Animated.View entering={FadeInDown.delay(240).duration(300)} style={styles.tipOuter}>
          <View style={[styles.glassBlur, { padding: Spacing.md }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Ionicons name="eye-off" size={14} color="#eab308" />
              <Text style={styles.tipText}>
                Never share your seed phrase. Write it down and store it offline.
              </Text>
            </View>
          </View>
        </Animated.View>

        {/* ── ENCRYPTED BACKUP ── */}
        <SectionTitle title="ENCRYPTED BACKUP" delay={280} />
        <GlassCard delay={300}>
          <TouchableOpacity style={styles.actionRow} onPress={handleExportBackup} activeOpacity={0.7}>
            <View style={[styles.actionIcon, { backgroundColor: 'rgba(59, 130, 246, 0.15)' }]}>
              <Ionicons name="download-outline" size={20} color={P01Colors.blue} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowLabel}>{t('settings.exportKeys')}</Text>
              <Text style={styles.rowDescription}>
                Wallet + {activeNotes.length} note{activeNotes.length !== 1 ? 's' : ''} — password protected
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={Colors.textTertiary} />
          </TouchableOpacity>
          <GlassDivider />
          <TouchableOpacity style={styles.actionRow} onPress={handleOpenImport} activeOpacity={0.7}>
            <View style={[styles.actionIcon, { backgroundColor: 'rgba(255, 119, 168, 0.15)' }]}>
              <Ionicons name="push-outline" size={20} color={P01Colors.pink} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowLabel}>{t('settings.restoreBackup')}</Text>
              <Text style={styles.rowDescription}>{t('settings.restoreBackup')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={Colors.textTertiary} />
          </TouchableOpacity>
        </GlassCard>

        {/* ── PRIVACY NOTES ── */}
        <SectionTitle title="PRIVACY NOTES" delay={360} />
        <GlassCard delay={380}>
          <View style={styles.noteStatsRow}>
            <View style={styles.noteStat}>
              <Text style={styles.noteStatValue}>{activeNotes.length}</Text>
              <Text style={styles.noteStatLabel}>Active Notes</Text>
            </View>
            <View style={[styles.noteStatDivider]} />
            <View style={styles.noteStat}>
              <Text style={styles.noteStatValue}>{solNoteCount}</Text>
              <Text style={styles.noteStatLabel}>SOL Notes</Text>
            </View>
            <View style={[styles.noteStatDivider]} />
            <View style={styles.noteStat}>
              <Text style={styles.noteStatValue}>{usdcNoteCount}</Text>
              <Text style={styles.noteStatLabel}>USDC Notes</Text>
            </View>
            <View style={[styles.noteStatDivider]} />
            <View style={styles.noteStat}>
              <Text style={styles.noteStatValue}>{totalNoteValue.toFixed(2)}</Text>
              <Text style={styles.noteStatLabel}>SOL Total</Text>
            </View>
          </View>
          <GlassDivider />
          <TouchableOpacity style={styles.actionRow} onPress={handleExportNotes} activeOpacity={0.7}>
            <View style={[styles.actionIcon, { backgroundColor: 'rgba(57, 197, 187, 0.15)' }]}>
              <Ionicons name="document-text-outline" size={20} color={P01Colors.cyan} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowLabel}>{t('privacy.backupNotes')}</Text>
              <Text style={styles.rowDescription}>{t('privacy.notesStoredLocally')}</Text>
            </View>
            <Ionicons name="copy-outline" size={16} color={Colors.textTertiary} />
          </TouchableOpacity>
          <GlassDivider />
          <TouchableOpacity style={styles.actionRow} onPress={handleImportNotes} activeOpacity={0.7}>
            <View style={[styles.actionIcon, { backgroundColor: 'rgba(255, 119, 168, 0.15)' }]}>
              <Ionicons name="add-circle-outline" size={20} color={P01Colors.pink} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowLabel}>{t('privacy.importNote')}</Text>
              <Text style={styles.rowDescription}>{t('privacy.import')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={Colors.textTertiary} />
          </TouchableOpacity>
        </GlassCard>

        {/* Info Card */}
        <Animated.View entering={FadeInDown.delay(450).duration(350)} style={styles.infoOuter}>
          <View style={styles.glassBlur}>
            <View style={styles.infoContent}>
              <Ionicons name="information-circle" size={20} color={P01Colors.cyan} />
              <Text style={styles.infoText}>
                Encrypted backups include your seed phrase and all privacy pool notes. They are protected with XSalsa20-Poly1305 encryption. Without the password, the backup is unreadable.
              </Text>
            </View>
          </View>
        </Animated.View>
      </ScrollView>

      {/* ════════════ Seed Phrase Modal ════════════ */}
      <Modal
        visible={showSeedModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => { setShowSeedModal(false); setSeedPhrase([]); }}
      >
        <View style={[styles.modalContainer, { paddingTop: insets.top }]}>
          <View style={styles.header}>
            <TouchableOpacity onPress={() => { setShowSeedModal(false); setSeedPhrase([]); }} style={styles.backButton}>
              <Ionicons name="close" size={20} color={Colors.text} />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>{t('settings.seedPhrase')}</Text>
            <View style={{ width: 40 }} />
          </View>

          <ScrollView style={{ flex: 1, paddingHorizontal: Spacing.lg }}>
            {/* Warning */}
            <Animated.View entering={FadeInUp.delay(100).duration(350)} style={styles.modalWarningOuter}>
              <View style={[styles.glassBlur, { padding: Spacing.lg }]}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Ionicons name="warning" size={20} color="#ef4444" />
                  <Text style={styles.modalWarningText}>
                    Do not share this phrase. Anyone with it can steal your funds.
                  </Text>
                </View>
              </View>
            </Animated.View>

            {/* Seed Grid */}
            <Animated.View entering={FadeInUp.delay(200).duration(350)} style={styles.seedGridOuter}>
              <View style={styles.glassBlur}>
                <View style={{ padding: Spacing.lg }}>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                    {seedPhrase.map((word, index) => (
                      <View key={index} style={styles.seedWordWrapper}>
                        <View style={styles.seedWordCell}>
                          <Text style={styles.seedWordIndex}>{index + 1}.</Text>
                          <Text style={styles.seedWordText}>{word}</Text>
                        </View>
                      </View>
                    ))}
                  </View>
                </View>
              </View>
            </Animated.View>

            {/* Copy */}
            <Animated.View entering={FadeInUp.delay(300).duration(350)}>
              <TouchableOpacity style={styles.secondaryButton} onPress={handleCopySeed} activeOpacity={0.7}>
                <Ionicons name={seedCopied ? 'checkmark' : 'copy-outline'} size={18} color={seedCopied ? P01Colors.cyan : Colors.text} />
                <Text style={[styles.secondaryButtonText, seedCopied && { color: P01Colors.cyan }]}>
                  {seedCopied ? t('common.copied') : t('common.paste')}
                </Text>
              </TouchableOpacity>
            </Animated.View>

            {/* Confirm */}
            <Animated.View entering={FadeInUp.delay(400).duration(350)}>
              <TouchableOpacity style={styles.primaryButton} onPress={handleConfirmSeedBackup} activeOpacity={0.8}>
                <Text style={styles.primaryButtonText}>{t('common.done')}</Text>
              </TouchableOpacity>
            </Animated.View>
          </ScrollView>
        </View>
      </Modal>

      {/* ════════════ Export Modal ════════════ */}
      <Modal
        visible={showExportModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowExportModal(false)}
      >
        <View style={[styles.modalContainer, { paddingTop: insets.top }]}>
          <View style={styles.header}>
            <TouchableOpacity onPress={() => setShowExportModal(false)} style={styles.backButton}>
              <Ionicons name="close" size={20} color={Colors.text} />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>{t('settings.exportKeys')}</Text>
            <View style={{ width: 40 }} />
          </View>

          <ScrollView style={{ flex: 1, paddingHorizontal: Spacing.lg }} keyboardShouldPersistTaps="handled">
            {/* Summary */}
            <Animated.View entering={FadeInUp.delay(100)} style={styles.exportSummary}>
              <View style={styles.glassBlur}>
                <View style={{ padding: Spacing.lg }}>
                  <Text style={styles.exportSummaryTitle}>Backup Contents</Text>
                  <View style={styles.exportItem}>
                    <Ionicons name="key" size={16} color={P01Colors.cyan} />
                    <Text style={styles.exportItemText}>Wallet seed phrase</Text>
                  </View>
                  <View style={styles.exportItem}>
                    <Ionicons name="shield-half" size={16} color={P01Colors.cyan} />
                    <Text style={styles.exportItemText}>
                      {activeNotes.length} privacy note{activeNotes.length !== 1 ? 's' : ''}
                      {totalNoteValue > 0 ? ` (${totalNoteValue.toFixed(2)} SOL)` : ''}
                    </Text>
                  </View>
                  <View style={styles.exportItem}>
                    <Ionicons name="settings" size={16} color={P01Colors.cyan} />
                    <Text style={styles.exportItemText}>App settings</Text>
                  </View>
                </View>
              </View>
            </Animated.View>

            {/* Password */}
            <Animated.View entering={FadeInUp.delay(200)}>
              <Text style={styles.inputLabel}>Backup Password</Text>
              <View style={styles.passwordRow}>
                <TextInput
                  style={[styles.input, { flex: 1 }]}
                  value={exportPassword}
                  onChangeText={setExportPassword}
                  placeholder="Min. 8 characters"
                  placeholderTextColor={Colors.textTertiary}
                  secureTextEntry={!showExportPassword}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <TouchableOpacity onPress={() => setShowExportPassword(!showExportPassword)} style={styles.eyeButton}>
                  <Ionicons name={showExportPassword ? 'eye-off' : 'eye'} size={20} color={Colors.textTertiary} />
                </TouchableOpacity>
              </View>

              <Text style={styles.inputLabel}>Confirm Password</Text>
              <TextInput
                style={styles.input}
                value={exportConfirmPassword}
                onChangeText={setExportConfirmPassword}
                placeholder="Re-enter password"
                placeholderTextColor={Colors.textTertiary}
                secureTextEntry={!showExportPassword}
                autoCapitalize="none"
                autoCorrect={false}
              />

              <Text style={styles.inputLabel}>Password Hint (optional)</Text>
              <TextInput
                style={styles.input}
                value={exportHint}
                onChangeText={setExportHint}
                placeholder="e.g. 'favorite movie'"
                placeholderTextColor={Colors.textTertiary}
                autoCapitalize="none"
              />
            </Animated.View>

            {/* Create */}
            <Animated.View entering={FadeInUp.delay(300)}>
              <TouchableOpacity
                style={[styles.primaryButton, exporting && { opacity: 0.6 }]}
                onPress={handleCreateBackup}
                activeOpacity={0.8}
                disabled={exporting}
              >
                {exporting ? (
                  <ActivityIndicator color={Colors.background} />
                ) : (
                  <Text style={styles.primaryButtonText}>{t('settings.backupNow')}</Text>
                )}
              </TouchableOpacity>
            </Animated.View>
          </ScrollView>
        </View>
      </Modal>

      {/* ════════════ Import Modal ════════════ */}
      <Modal
        visible={showImportModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowImportModal(false)}
      >
        <View style={[styles.modalContainer, { paddingTop: insets.top }]}>
          <View style={styles.header}>
            <TouchableOpacity onPress={() => setShowImportModal(false)} style={styles.backButton}>
              <Ionicons name="close" size={20} color={Colors.text} />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>{t('settings.restoreBackup')}</Text>
            <View style={{ width: 40 }} />
          </View>

          <ScrollView style={{ flex: 1, paddingHorizontal: Spacing.lg }} keyboardShouldPersistTaps="handled">
            <Animated.View entering={FadeInUp.delay(100)}>
              <Text style={styles.inputLabel}>Backup Data</Text>
              <TextInput
                style={[styles.input, { minHeight: 100, textAlignVertical: 'top' }]}
                value={importData}
                onChangeText={setImportData}
                placeholder="Paste your encrypted backup here..."
                placeholderTextColor={Colors.textTertiary}
                multiline
                autoCapitalize="none"
                autoCorrect={false}
              />
            </Animated.View>

            {/* Preview */}
            {importPreview && (
              <Animated.View entering={FadeInUp.delay(150)} style={styles.previewOuter}>
                <View style={styles.glassBlur}>
                  <View style={{ padding: Spacing.md }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
                      <Ionicons name="checkmark-circle" size={16} color="#22c55e" />
                      <Text style={[styles.rowLabel, { marginLeft: 8, fontSize: 14 }]}>Valid Backup Detected</Text>
                    </View>
                    <Text style={styles.previewLine}>
                      Created: {new Date(importPreview.createdAt).toLocaleDateString()}
                    </Text>
                    {importPreview.hint ? (
                      <Text style={styles.previewLine}>
                        Hint: {importPreview.hint}
                      </Text>
                    ) : null}
                  </View>
                </View>
              </Animated.View>
            )}

            <Animated.View entering={FadeInUp.delay(200)}>
              <Text style={styles.inputLabel}>Backup Password</Text>
              <View style={styles.passwordRow}>
                <TextInput
                  style={[styles.input, { flex: 1 }]}
                  value={importPassword}
                  onChangeText={setImportPassword}
                  placeholder="Enter backup password"
                  placeholderTextColor={Colors.textTertiary}
                  secureTextEntry={!showImportPassword}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <TouchableOpacity onPress={() => setShowImportPassword(!showImportPassword)} style={styles.eyeButton}>
                  <Ionicons name={showImportPassword ? 'eye-off' : 'eye'} size={20} color={Colors.textTertiary} />
                </TouchableOpacity>
              </View>
            </Animated.View>

            <Animated.View entering={FadeInUp.delay(300)}>
              <TouchableOpacity
                style={[styles.primaryButton, (importing || !importPreview) && { opacity: 0.5 }]}
                onPress={handleRestoreBackup}
                activeOpacity={0.8}
                disabled={importing || !importPreview}
              >
                {importing ? (
                  <ActivityIndicator color={Colors.background} />
                ) : (
                  <Text style={styles.primaryButtonText}>{t('settings.restoreBackup')}</Text>
                )}
              </TouchableOpacity>
            </Animated.View>
          </ScrollView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

/* ──────────────────────── Styles ──────────────────────── */

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },

  /* Header */
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.lg,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: BorderRadius.full,
    backgroundColor: '#0f0f12',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    color: Colors.text,
    fontSize: 18,
    fontFamily: FontFamily.semibold,
  },

  /* Section */
  sectionTitle: {
    color: Colors.textSecondary,
    fontSize: 12,
    fontFamily: FontFamily.semibold,
    letterSpacing: 1,
    paddingHorizontal: Spacing.lg,
    marginBottom: Spacing.sm,
    marginTop: Spacing.lg,
  },

  /* Glass Card */
  glassOuter: {
    marginHorizontal: Spacing.lg,
    borderRadius: BorderRadius.xl,
    overflow: 'hidden',
  },
  glassBlur: { backgroundColor: '#0f0f12' },
  divider: { height: 1, backgroundColor: 'rgba(255, 255, 255, 0.06)', marginHorizontal: Spacing.lg },

  /* Status */
  statusRow: { padding: Spacing.lg, flexDirection: 'row', alignItems: 'center' },
  statusIcon: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },

  /* Rows */
  rowLabel: { color: Colors.text, fontSize: 16, fontFamily: FontFamily.medium },
  rowDescription: { color: Colors.textSecondary, fontSize: 13, marginTop: 2 },

  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.md + 2,
    paddingHorizontal: Spacing.lg,
    gap: Spacing.md,
  },
  actionIcon: {
    width: 38,
    height: 38,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },

  /* Warning */
  warningOuter: {
    marginHorizontal: Spacing.lg,
    marginTop: Spacing.md,
    borderRadius: BorderRadius.xl,
    overflow: 'hidden',
  },
  warningIcon: {
    width: 40,
    height: 40,
    borderRadius: BorderRadius.full,
    backgroundColor: 'rgba(239, 68, 68, 0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  warningTitle: { color: '#f87171', fontSize: 16, fontFamily: FontFamily.semibold, marginBottom: 4 },
  warningDescription: { color: 'rgba(252, 165, 165, 0.8)', fontSize: 14, lineHeight: 20 },

  /* Tip */
  tipOuter: {
    marginHorizontal: Spacing.lg,
    marginTop: Spacing.sm,
    borderRadius: BorderRadius.md,
    overflow: 'hidden',
  },
  tipText: { color: '#eab308', fontSize: 12, marginLeft: Spacing.sm, flex: 1 },

  /* Note Stats */
  noteStatsRow: {
    flexDirection: 'row',
    paddingVertical: Spacing.lg,
    paddingHorizontal: Spacing.md,
  },
  noteStat: { flex: 1, alignItems: 'center' },
  noteStatValue: { color: Colors.text, fontSize: 18, fontFamily: FontFamily.bold },
  noteStatLabel: { color: Colors.textTertiary, fontSize: 11, fontFamily: FontFamily.medium, marginTop: 2 },
  noteStatDivider: { width: 1, backgroundColor: 'rgba(255, 255, 255, 0.06)', marginVertical: 4 },

  /* Info */
  infoOuter: {
    marginHorizontal: Spacing.lg,
    marginTop: Spacing.lg,
    borderRadius: BorderRadius.xl,
    overflow: 'hidden',
  },
  infoContent: { flexDirection: 'row', alignItems: 'flex-start', padding: Spacing.lg },
  infoText: { color: Colors.textSecondary, fontSize: 13, marginLeft: Spacing.md, flex: 1, lineHeight: 20 },

  /* Modal */
  modalContainer: { flex: 1, backgroundColor: '#09090b' },
  modalWarningOuter: {
    marginBottom: Spacing.xl,
    borderRadius: BorderRadius.lg,
    overflow: 'hidden',
  },
  modalWarningText: { color: '#f87171', fontSize: 14, marginLeft: Spacing.sm, flex: 1 },

  /* Seed Grid */
  seedGridOuter: {
    marginBottom: Spacing.xl,
    borderRadius: BorderRadius.xl,
    overflow: 'hidden',
  },
  seedWordWrapper: { width: '33.33%', padding: Spacing.sm },
  seedWordCell: {
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderRadius: BorderRadius.md,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
  },
  seedWordIndex: { color: Colors.textSecondary, fontSize: 12, width: 20 },
  seedWordText: { color: Colors.text, fontFamily: FontFamily.mono, fontSize: 14, flex: 1 },

  /* Buttons */
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.md + 2,
    borderRadius: BorderRadius.md,
    marginBottom: Spacing.md,
    backgroundColor: '#0f0f12',
    gap: Spacing.sm,
  },
  secondaryButtonText: { fontFamily: FontFamily.semibold, color: Colors.text },
  primaryButton: {
    backgroundColor: P01Colors.cyan,
    paddingVertical: Spacing.md + 2,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
    marginBottom: Spacing.xl,
    shadowColor: P01Colors.cyan,
    shadowOpacity: 0.3,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  primaryButtonText: { color: Colors.background, fontFamily: FontFamily.semibold, fontSize: 16 },

  /* Export Modal */
  exportSummary: {
    marginBottom: Spacing.xl,
    borderRadius: BorderRadius.xl,
    overflow: 'hidden',
  },
  exportSummaryTitle: {
    color: Colors.text,
    fontFamily: FontFamily.semibold,
    fontSize: 16,
    marginBottom: Spacing.md,
  },
  exportItem: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginBottom: 6 },
  exportItemText: { color: Colors.textSecondary, fontSize: 14 },

  /* Inputs */
  inputLabel: {
    color: Colors.textSecondary,
    fontSize: 12,
    fontFamily: FontFamily.semibold,
    letterSpacing: 0.5,
    marginBottom: 6,
    marginTop: Spacing.md,
  },
  input: {
    backgroundColor: '#0f0f12',
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    color: Colors.text,
    fontFamily: FontFamily.mono,
    fontSize: 14,
  },
  passwordRow: { flexDirection: 'row', alignItems: 'center', gap: 0 },
  eyeButton: {
    position: 'absolute',
    right: 12,
    padding: 4,
  },

  /* Import Preview */
  previewOuter: {
    marginTop: Spacing.md,
    borderRadius: BorderRadius.lg,
    overflow: 'hidden',
  },
  previewLine: { color: Colors.textSecondary, fontSize: 13, marginTop: 4 },
});

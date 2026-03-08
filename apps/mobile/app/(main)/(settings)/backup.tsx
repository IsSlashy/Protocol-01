import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Alert,
  Modal,
  StyleSheet,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import * as LocalAuthentication from 'expo-local-authentication';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';

import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import { useWalletStore } from '../../../stores/walletStore';

/* ──────────────────────── Glass Card ──────────────────────── */

interface GlassCardProps {
  children: React.ReactNode;
  delay?: number;
  style?: object;
}

const GlassCard: React.FC<GlassCardProps> = ({ children, delay = 0, style }) => (
  <Animated.View entering={FadeInDown.delay(delay).duration(350)} style={[styles.glassOuter, style]}>
    <BlurView intensity={14} tint="dark" style={styles.glassBlur}>
      <LinearGradient
        colors={['rgba(57, 197, 187, 0.06)', 'rgba(255, 119, 168, 0.03)', 'transparent']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      {children}
    </BlurView>
  </Animated.View>
);

/* ──────────────────────── Section Title ──────────────────────── */

const SectionTitle: React.FC<{ title: string; delay?: number }> = ({ title, delay = 0 }) => (
  <Animated.Text
    entering={FadeInDown.delay(delay).duration(300)}
    style={styles.sectionTitle}
  >
    {title}
  </Animated.Text>
);

/* ──────────────────────── Divider ──────────────────────── */

const GlassDivider: React.FC = () => (
  <View style={styles.divider} />
);

/* ──────────────────────── Screen ──────────────────────── */

export default function BackupRecoveryScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { getBackupMnemonic } = useWalletStore();

  const [isBackedUp, setIsBackedUp] = useState(false);
  const [showSeedModal, setShowSeedModal] = useState(false);
  const [seedPhrase, setSeedPhrase] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  const handleShowSeedPhrase = async () => {
    try {
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const isEnrolled = await LocalAuthentication.isEnrolledAsync();

      if (hasHardware && isEnrolled) {
        const result = await LocalAuthentication.authenticateAsync({
          promptMessage: 'Authenticate to view seed phrase',
          fallbackLabel: 'Use PIN',
        });

        if (!result.success) {
          return;
        }
      }

      const mnemonic = await getBackupMnemonic();
      if (mnemonic) {
        setSeedPhrase(mnemonic.split(' '));
        setShowSeedModal(true);
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      } else {
        Alert.alert('Error', 'Could not retrieve seed phrase. Please try again.');
      }
    } catch (error) {
      console.error('Auth error:', error);
      Alert.alert('Authentication Failed', 'Please try again.');
    }
  };

  const handleCopySeed = async () => {
    if (seedPhrase.length === 0) return;
    await Clipboard.setStringAsync(seedPhrase.join(' '));
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    // Auto-clear clipboard after 60 seconds for security
    setTimeout(async () => {
      try {
        await Clipboard.setStringAsync('');
      } catch (_) {}
    }, 60000);
  };

  const handleConfirmBackup = () => {
    setShowSeedModal(false);
    setIsBackedUp(true);
    setSeedPhrase([]);
    Alert.alert(
      'Backup Confirmed',
      'Great! Make sure you store your seed phrase in a secure location.',
      [{ text: 'OK' }]
    );
  };

  const handleExportBackup = () => {
    Alert.alert(
      'Export Encrypted Backup',
      'Encrypted backups will be available in a future update. Your seed phrase is currently the safest way to back up your wallet.',
      [{ text: 'OK' }]
    );
  };

  const handleImportBackup = () => {
    Alert.alert(
      'Import Backup',
      'To restore your wallet, please use the "Import Wallet" option from the welcome screen.',
      [{ text: 'OK' }]
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <Animated.View entering={FadeInDown.delay(50).duration(300)} style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="arrow-back" size={20} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Backup & Recovery</Text>
        <View style={{ width: 40 }} />
      </Animated.View>

      <ScrollView
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 120 }}
      >
        {/* Warning Card */}
        <Animated.View entering={FadeInDown.delay(100).duration(350)} style={styles.warningOuter}>
          <BlurView intensity={14} tint="dark" style={[styles.glassBlur, { padding: Spacing.lg }]}>
            <LinearGradient
              colors={['rgba(239, 68, 68, 0.08)', 'rgba(239, 68, 68, 0.03)', 'transparent']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />
            <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
              <View style={styles.warningIcon}>
                <Ionicons name="warning" size={24} color="#ef4444" />
              </View>
              <View style={{ flex: 1, marginLeft: Spacing.md }}>
                <Text style={styles.warningTitle}>
                  Important: Back Up Your Wallet
                </Text>
                <Text style={styles.warningDescription}>
                  If you lose access to your device and haven't backed up your seed phrase, you will permanently lose access to your funds.
                </Text>
              </View>
            </View>
          </BlurView>
        </Animated.View>

        {/* Backup Status */}
        <GlassCard delay={200} style={{ marginBottom: Spacing['2xl'] }}>
          <View style={styles.statusRow}>
            <View style={[
              styles.statusIcon,
              { backgroundColor: isBackedUp ? 'rgba(34, 197, 94, 0.2)' : 'rgba(234, 179, 8, 0.2)' },
            ]}>
              <Ionicons
                name={isBackedUp ? 'shield-checkmark' : 'shield-outline'}
                size={24}
                color={isBackedUp ? '#22c55e' : '#eab308'}
              />
            </View>
            <View style={{ flex: 1, marginLeft: Spacing.lg }}>
              <Text style={styles.rowLabel}>
                {isBackedUp ? 'Wallet Backed Up' : 'Backup Recommended'}
              </Text>
              <Text style={styles.rowDescription}>
                {isBackedUp
                  ? 'Your wallet is securely backed up'
                  : 'Create a backup to protect your funds'}
              </Text>
            </View>
          </View>
        </GlassCard>

        {/* SEED PHRASE */}
        <SectionTitle title="SEED PHRASE" delay={280} />
        <GlassCard delay={300}>
          <TouchableOpacity
            style={styles.seedRow}
            onPress={handleShowSeedPhrase}
            activeOpacity={0.7}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
              <View style={styles.seedIcon}>
                <Ionicons name="key" size={20} color={P01Colors.cyan} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowLabel}>Show Seed Phrase</Text>
                <Text style={styles.rowDescription}>
                  View your 12-word recovery phrase
                </Text>
              </View>
            </View>
            <Ionicons name="lock-closed" size={18} color={Colors.textTertiary} />
          </TouchableOpacity>
        </GlassCard>

        {/* Warning about seed phrase */}
        <Animated.View entering={FadeInDown.delay(350).duration(350)} style={styles.seedWarningOuter}>
          <BlurView intensity={14} tint="dark" style={[styles.glassBlur, { padding: Spacing.md }]}>
            <LinearGradient
              colors={['rgba(234, 179, 8, 0.06)', 'rgba(234, 179, 8, 0.02)', 'transparent']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Ionicons name="eye-off" size={16} color="#eab308" />
              <Text style={styles.seedWarningText}>
                Never share your seed phrase. Anyone with it can access your funds.
              </Text>
            </View>
          </BlurView>
        </Animated.View>

        {/* BACKUP OPTIONS */}
        <SectionTitle title="BACKUP OPTIONS" delay={380} />
        <GlassCard delay={400}>
          <TouchableOpacity
            style={styles.optionRow}
            onPress={handleExportBackup}
            activeOpacity={0.7}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
              <View style={[styles.optionIcon, { backgroundColor: 'rgba(59, 130, 246, 0.2)' }]}>
                <Ionicons name="download-outline" size={20} color={P01Colors.blue} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowLabel}>Export Encrypted Backup</Text>
                <Text style={styles.rowDescription}>
                  Save password-protected backup file
                </Text>
              </View>
            </View>
            <Ionicons name="chevron-forward" size={20} color={Colors.textTertiary} />
          </TouchableOpacity>
          <GlassDivider />
          <TouchableOpacity
            style={styles.optionRow}
            onPress={handleImportBackup}
            activeOpacity={0.7}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
              <View style={[styles.optionIcon, { backgroundColor: 'rgba(255, 119, 168, 0.2)' }]}>
                <Ionicons name="push-outline" size={20} color={P01Colors.pink} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowLabel}>Import Backup</Text>
                <Text style={styles.rowDescription}>
                  Restore from encrypted backup file
                </Text>
              </View>
            </View>
            <Ionicons name="chevron-forward" size={20} color={Colors.textTertiary} />
          </TouchableOpacity>
        </GlassCard>

        {/* Info Card */}
        <Animated.View entering={FadeInDown.delay(500).duration(350)} style={styles.infoOuter}>
          <BlurView intensity={14} tint="dark" style={styles.glassBlur}>
            <LinearGradient
              colors={['rgba(57, 197, 187, 0.06)', 'rgba(255, 119, 168, 0.03)', 'transparent']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />
            <View style={styles.infoContent}>
              <Ionicons name="information-circle" size={20} color={P01Colors.cyan} />
              <Text style={styles.infoText}>
                Your seed phrase is the only way to recover your wallet. Store it securely offline, never screenshot it, and never share it with anyone.
              </Text>
            </View>
          </BlurView>
        </Animated.View>
      </ScrollView>

      {/* Seed Phrase Modal */}
      <Modal
        visible={showSeedModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => {
          setShowSeedModal(false);
          setSeedPhrase([]);
        }}
      >
        <View style={[styles.modalContainer, { paddingTop: insets.top }]}>
          {/* Modal Header */}
          <View style={styles.header}>
            <TouchableOpacity
              onPress={() => {
                setShowSeedModal(false);
                setSeedPhrase([]);
              }}
              style={styles.backButton}
              accessibilityRole="button"
              accessibilityLabel="Close seed phrase modal"
            >
              <Ionicons name="close" size={20} color={Colors.text} />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>Seed Phrase</Text>
            <View style={{ width: 40 }} />
          </View>

          <ScrollView style={{ flex: 1, paddingHorizontal: Spacing.lg }}>
            {/* Warning */}
            <Animated.View entering={FadeInUp.delay(100).duration(350)} style={styles.modalWarningOuter}>
              <BlurView intensity={14} tint="dark" style={[styles.glassBlur, { padding: Spacing.lg }]}>
                <LinearGradient
                  colors={['rgba(239, 68, 68, 0.08)', 'rgba(239, 68, 68, 0.03)', 'transparent']}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={StyleSheet.absoluteFill}
                  pointerEvents="none"
                />
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Ionicons name="warning" size={20} color="#ef4444" />
                  <Text style={styles.modalWarningText}>
                    Do not share this phrase with anyone. Anyone with access to it can steal your funds.
                  </Text>
                </View>
              </BlurView>
            </Animated.View>

            {/* Seed Words Grid */}
            <Animated.View entering={FadeInUp.delay(200).duration(350)} style={styles.seedGridOuter}>
              <BlurView intensity={14} tint="dark" style={styles.glassBlur}>
                <LinearGradient
                  colors={['rgba(57, 197, 187, 0.06)', 'rgba(255, 119, 168, 0.03)', 'transparent']}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={StyleSheet.absoluteFill}
                  pointerEvents="none"
                />
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
              </BlurView>
            </Animated.View>

            {/* Copy Button */}
            <Animated.View entering={FadeInUp.delay(300).duration(350)}>
              <TouchableOpacity
                style={styles.copyButton}
                onPress={handleCopySeed}
                activeOpacity={0.7}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Ionicons
                    name={copied ? 'checkmark' : 'copy-outline'}
                    size={18}
                    color={copied ? P01Colors.cyan : Colors.text}
                  />
                  <Text style={[styles.copyButtonText, { color: copied ? P01Colors.cyan : Colors.text }]}>
                    {copied ? 'Copied!' : 'Copy to Clipboard'}
                  </Text>
                </View>
              </TouchableOpacity>
            </Animated.View>

            {/* I've Backed Up Button */}
            <Animated.View entering={FadeInUp.delay(400).duration(350)}>
              <TouchableOpacity
                style={styles.confirmButton}
                onPress={handleConfirmBackup}
                activeOpacity={0.8}
              >
                <Text style={styles.confirmButtonText}>
                  I've Saved My Seed Phrase
                </Text>
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
  container: {
    flex: 1,
    backgroundColor: 'transparent',
  },

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
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.07)',
  },
  headerTitle: {
    color: Colors.text,
    fontSize: 18,
    fontFamily: FontFamily.semibold,
  },

  /* Section Title */
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
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.07)',
  },
  glassBlur: {
    backgroundColor: 'rgba(12, 12, 14, 0.65)',
  },

  /* Divider */
  divider: {
    height: 1,
    backgroundColor: 'rgba(57, 197, 187, 0.07)',
    marginHorizontal: Spacing.lg,
  },

  /* Warning Card */
  warningOuter: {
    marginHorizontal: Spacing.lg,
    marginBottom: Spacing['2xl'],
    borderRadius: BorderRadius.xl,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.2)',
  },
  warningIcon: {
    width: 40,
    height: 40,
    borderRadius: BorderRadius.full,
    backgroundColor: 'rgba(239, 68, 68, 0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  warningTitle: {
    color: '#f87171',
    fontSize: 16,
    fontFamily: FontFamily.semibold,
    marginBottom: 4,
  },
  warningDescription: {
    color: 'rgba(252, 165, 165, 0.8)',
    fontSize: 14,
    lineHeight: 20,
  },

  /* Backup Status */
  statusRow: {
    padding: Spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },

  /* Row styles */
  rowLabel: {
    color: Colors.text,
    fontSize: 16,
    fontFamily: FontFamily.medium,
  },
  rowDescription: {
    color: Colors.textSecondary,
    fontSize: 14,
    marginTop: 2,
  },

  /* Seed Phrase section */
  seedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.lg,
    paddingHorizontal: Spacing.lg,
  },
  seedIcon: {
    width: 40,
    height: 40,
    borderRadius: BorderRadius.md,
    backgroundColor: 'rgba(57, 197, 187, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: Spacing.md,
  },

  /* Seed warning (yellow) */
  seedWarningOuter: {
    marginHorizontal: Spacing.lg,
    marginTop: Spacing.md,
    marginBottom: Spacing['2xl'],
    borderRadius: BorderRadius.md,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(234, 179, 8, 0.2)',
  },
  seedWarningText: {
    color: '#eab308',
    fontSize: 12,
    marginLeft: Spacing.sm,
    flex: 1,
  },

  /* Backup Options */
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.lg,
    paddingHorizontal: Spacing.lg,
  },
  optionIcon: {
    width: 40,
    height: 40,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: Spacing.md,
  },

  /* Info Card */
  infoOuter: {
    marginHorizontal: Spacing.lg,
    marginTop: Spacing.lg,
    borderRadius: BorderRadius.xl,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.07)',
  },
  infoContent: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: Spacing.lg,
  },
  infoText: {
    color: Colors.textSecondary,
    fontSize: 14,
    marginLeft: Spacing.md,
    flex: 1,
    lineHeight: 20,
  },

  /* Modal */
  modalContainer: {
    flex: 1,
    backgroundColor: '#09090b',
  },
  modalWarningOuter: {
    marginBottom: Spacing['2xl'],
    borderRadius: BorderRadius.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.2)',
  },
  modalWarningText: {
    color: '#f87171',
    fontSize: 14,
    marginLeft: Spacing.sm,
    flex: 1,
  },
  seedGridOuter: {
    marginBottom: Spacing['2xl'],
    borderRadius: BorderRadius.xl,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.07)',
  },
  seedWordWrapper: {
    width: '33.33%',
    padding: Spacing.sm,
  },
  seedWordCell: {
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderRadius: BorderRadius.md,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
  },
  seedWordIndex: {
    color: Colors.textSecondary,
    fontSize: 12,
    width: 20,
  },
  seedWordText: {
    color: Colors.text,
    fontFamily: FontFamily.mono,
    fontSize: 14,
    flex: 1,
  },
  copyButton: {
    paddingVertical: Spacing.lg,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
    marginBottom: Spacing.lg,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.07)',
  },
  copyButtonText: {
    fontFamily: FontFamily.semibold,
    marginLeft: Spacing.sm,
  },
  confirmButton: {
    backgroundColor: P01Colors.cyan,
    paddingVertical: Spacing.lg,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
    shadowColor: P01Colors.cyan,
    shadowOpacity: 0.3,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  confirmButtonText: {
    color: Colors.background,
    fontFamily: FontFamily.semibold,
    fontSize: 16,
  },
});

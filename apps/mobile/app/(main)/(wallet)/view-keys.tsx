/**
 * View Keys Management Screen
 *
 * Allows users to:
 * - Generate viewing keys from their shielded wallet
 * - Share incoming viewing keys with auditors
 * - Import external viewing keys for watch-only mode
 */

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Modal,
  TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import * as ScreenCapture from 'expo-screen-capture';
import QRCode from 'react-native-qrcode-svg';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { bytesToHex } from '@noble/hashes/utils.js';

import { useShieldedStore } from '@/stores/shieldedStore';
import { p01Alert } from '@/stores/alertStore';
import { getOrCreateStealthKeys } from '@/services/stealth/keys';
import { Colors, FontFamily, BorderRadius, Spacing } from '@/constants/theme';

// P-01 Design System Colors
const P01 = {
  cyan: '#39c5bb',
  cyanDim: 'rgba(57, 197, 187, 0.15)',
  pink: '#39c5bb',
  pinkDim: 'rgba(255, 119, 168, 0.15)',
  blue: '#3b82f6',
  blueDim: 'rgba(59, 130, 246, 0.15)',
  yellow: '#d9a24a',
  yellowDim: 'rgba(255, 204, 0, 0.15)',
};

// Key types
type KeyType = 'fvk' | 'ivk' | 'ovk';

interface ViewingKey {
  type: KeyType;
  label: string;
  key: string;
  createdAt: number;
  permissions: string[];
}

export default function ViewKeysScreen() {
  const router = useRouter();
  const { isInitialized, zkAddress } = useShieldedStore();

  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedKeys, setGeneratedKeys] = useState<ViewingKey[]>([]);
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [selectedKey, setSelectedKey] = useState<ViewingKey | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importKey, setImportKey] = useState('');

  useEffect(() => {
    if (showKeyModal) {
      ScreenCapture.preventScreenCaptureAsync();
    } else {
      ScreenCapture.allowScreenCaptureAsync();
    }
  }, [showKeyModal]);

  // Check initialization
  useEffect(() => {
    if (!isInitialized) {
      p01Alert(
        'Shielded Wallet Required',
        'Please initialize your shielded wallet first.',
        [{ text: 'OK', onPress: () => router.back() }]
      );
    }
  }, [isInitialized]);

  const generateViewingKey = async (type: KeyType) => {
    // Only the Incoming Viewing Key has a real cryptographic basis in this
    // ECDH stealth scheme: it IS the X25519 viewing secret, which is what
    // lets a holder detect/decrypt incoming stealth payments. Full and
    // Outgoing viewing keys (Zcash-style) don't exist here yet.
    if (type !== 'ivk') {
      p01Alert(
        'Coming soon',
        `${type === 'fvk' ? 'Full' : 'Outgoing'} Viewing Keys aren't available yet. ` +
        `Use the Incoming Viewing Key to let an auditor detect payments you receive.`,
      );
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsGenerating(true);

    try {
      // Real derivation: the IVK is the user's persistent X25519 viewing
      // secret key (32 bytes → 64 hex chars, matching the import validator).
      const keys = await getOrCreateStealthKeys();
      const ivkHex = bytesToHex(keys.viewingSecretKey.slice(0, 32));

      const newKey: ViewingKey = {
        type: 'ivk',
        label: 'Incoming Viewing Key',
        key: `IVK_${ivkHex}`,
        createdAt: Date.now(),
        // Honest about the current scheme: this secret detects incoming payments
        // AND can spend them (view/spend are not yet separated — see redesign doc).
        permissions: ['Detects incoming payments', 'Can also SPEND received funds'],
      };

      setGeneratedKeys(prev => [...prev.filter(k => k.type !== 'ivk'), newKey]);
      setSelectedKey(newKey);
      setShowKeyModal(true);

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      p01Alert('Error', 'Failed to derive incoming viewing key');
    } finally {
      setIsGenerating(false);
    }
  };

  const copyKey = async (key: string) => {
    await Clipboard.setStringAsync(key);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    p01Alert('Copied', 'Viewing key copied to clipboard. It will be cleared in 60 seconds.');
    // Security: Auto-clear clipboard after 60 seconds
    setTimeout(async () => {
      try {
        const current = await Clipboard.getStringAsync();
        if (current === key) {
          await Clipboard.setStringAsync('');
        }
      } catch (_) {}
    }, 60000);
  };

  // Gate any export of the key behind an explicit spend-risk confirmation.
  // In the current stealth scheme this key can spend received funds, so handing
  // it out is equivalent to handing out spend authority.
  const confirmThenExpose = (onConfirm: () => void) => {
    p01Alert(
      'This key can spend your funds',
      'Anyone you share this key with can SPEND the stealth payments you receive — not just view them. Only continue if you fully trust the recipient.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'I understand, continue', style: 'destructive', onPress: onConfirm },
      ],
    );
  };

  const shareKey = async (viewingKey: ViewingKey) => {
    confirmThenExpose(() => copyKey(viewingKey.key));
  };

  const handleImport = () => {
    if (!importKey.trim()) {
      p01Alert('Error', 'Please enter a viewing key');
      return;
    }

    // Validate key format
    const keyMatch = importKey.match(/^(FVK|IVK|OVK)_[a-f0-9]{64}$/i);
    if (!keyMatch) {
      p01Alert('Invalid Key', 'The viewing key format is invalid');
      return;
    }

    const type = importKey.slice(0, 3).toLowerCase() as KeyType;
    const labels: Record<KeyType, string> = {
      fvk: 'Imported Full Viewing Key',
      ivk: 'Imported Incoming Key',
      ovk: 'Imported Outgoing Key',
    };

    const permissions: Record<KeyType, string[]> = {
      fvk: ['View all transactions', 'View balance', 'Detect spent notes'],
      ivk: ['View incoming only', 'View balance'],
      ovk: ['View outgoing only'],
    };

    const newKey: ViewingKey = {
      type,
      label: labels[type],
      key: importKey,
      createdAt: Date.now(),
      permissions: permissions[type],
    };

    setGeneratedKeys(prev => [...prev, newKey]);
    setShowImportModal(false);
    setImportKey('');

    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    p01Alert('Success', 'Viewing key imported successfully');
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color="#eae7df" />
        </TouchableOpacity>
        <View style={styles.headerTitle}>
          <Ionicons name="key" size={20} color={P01.cyan} />
          <Text style={styles.headerText}>View Keys</Text>
        </View>
        <TouchableOpacity onPress={() => setShowImportModal(true)} style={styles.importButton}>
          <Ionicons name="download-outline" size={22} color={P01.cyan} />
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.content} contentContainerStyle={styles.scrollContent}>
        {/* Info Banner */}
        <Animated.View entering={FadeInDown.delay(100)}>
          <View style={styles.infoBanner}>
            <Ionicons name="information-circle" size={24} color={P01.cyan} />
            <View style={styles.infoBannerContent}>
              <Text style={styles.infoBannerTitle}>What are Viewing Keys?</Text>
              <Text style={styles.infoBannerText}>
                A viewing key lets someone detect payments you receive. IMPORTANT: in the
                current scheme this key can ALSO spend those funds — it is not yet view-only.
                Treat it like a secret key and share only with someone you fully trust.
              </Text>
            </View>
          </View>
        </Animated.View>

        {/* Generate Keys Section */}
        <Animated.View entering={FadeInDown.delay(200)}>
          <Text style={styles.sectionTitle}>GENERATE NEW KEY</Text>

          {/* Full Viewing Key */}
          <TouchableOpacity
            style={styles.keyOptionCard}
            onPress={() => generateViewingKey('fvk')}
            disabled={isGenerating}
          >
            <LinearGradient
              colors={[P01.cyanDim, 'transparent']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={styles.keyOptionGradient}
            >
              <View style={[styles.keyOptionIcon, { backgroundColor: P01.cyanDim }]}>
                <Ionicons name="eye" size={24} color={P01.cyan} />
              </View>
              <View style={styles.keyOptionContent}>
                <Text style={styles.keyOptionTitle}>Full Viewing Key</Text>
                <Text style={styles.keyOptionDesc}>
                  View all transactions, balance, and spent notes
                </Text>
                <View style={styles.permissionTags}>
                  <View style={[styles.tag, { backgroundColor: P01.yellowDim }]}>
                    <Text style={[styles.tagText, { color: P01.yellow }]}>Coming soon</Text>
                  </View>
                </View>
              </View>
              <Ionicons name="chevron-forward" size={20} color={Colors.textTertiary} />
            </LinearGradient>
          </TouchableOpacity>

          {/* Incoming Viewing Key */}
          <TouchableOpacity
            style={styles.keyOptionCard}
            onPress={() => generateViewingKey('ivk')}
            disabled={isGenerating}
          >
            <LinearGradient
              colors={[P01.blueDim, 'transparent']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={styles.keyOptionGradient}
            >
              <View style={[styles.keyOptionIcon, { backgroundColor: P01.blueDim }]}>
                <Ionicons name="arrow-down" size={24} color={P01.blue} />
              </View>
              <View style={styles.keyOptionContent}>
                <Text style={styles.keyOptionTitle}>Incoming Viewing Key</Text>
                <Text style={styles.keyOptionDesc}>
                  View only incoming transactions and balance
                </Text>
                <View style={styles.permissionTags}>
                  <View style={[styles.tag, { backgroundColor: P01.blueDim }]}>
                    <Text style={[styles.tagText, { color: P01.blue }]}>Receive Only</Text>
                  </View>
                </View>
              </View>
              <Ionicons name="chevron-forward" size={20} color={Colors.textTertiary} />
            </LinearGradient>
          </TouchableOpacity>

          {/* Outgoing Viewing Key */}
          <TouchableOpacity
            style={styles.keyOptionCard}
            onPress={() => generateViewingKey('ovk')}
            disabled={isGenerating}
          >
            <LinearGradient
              colors={[P01.pinkDim, 'transparent']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={styles.keyOptionGradient}
            >
              <View style={[styles.keyOptionIcon, { backgroundColor: P01.pinkDim }]}>
                <Ionicons name="arrow-up" size={24} color={P01.pink} />
              </View>
              <View style={styles.keyOptionContent}>
                <Text style={styles.keyOptionTitle}>Outgoing Viewing Key</Text>
                <Text style={styles.keyOptionDesc}>
                  View only outgoing transactions (for sender records)
                </Text>
                <View style={styles.permissionTags}>
                  <View style={[styles.tag, { backgroundColor: P01.yellowDim }]}>
                    <Text style={[styles.tagText, { color: P01.yellow }]}>Coming soon</Text>
                  </View>
                </View>
              </View>
              <Ionicons name="chevron-forward" size={20} color={Colors.textTertiary} />
            </LinearGradient>
          </TouchableOpacity>
        </Animated.View>

        {/* Generated Keys */}
        {generatedKeys.length > 0 && (
          <Animated.View entering={FadeInDown.delay(300)}>
            <Text style={styles.sectionTitle}>YOUR VIEWING KEYS</Text>
            {generatedKeys.map((key, index) => (
              <TouchableOpacity
                key={index}
                style={styles.savedKeyCard}
                onPress={() => {
                  setSelectedKey(key);
                  setShowKeyModal(true);
                }}
              >
                <View style={styles.savedKeyIcon}>
                  <Ionicons
                    name={key.type === 'fvk' ? 'eye' : key.type === 'ivk' ? 'arrow-down' : 'arrow-up'}
                    size={20}
                    color={P01.cyan}
                  />
                </View>
                <View style={styles.savedKeyContent}>
                  <Text style={styles.savedKeyTitle}>{key.label}</Text>
                  <Text style={styles.savedKeyDate}>
                    Created {new Date(key.createdAt).toLocaleDateString()}
                  </Text>
                </View>
                <TouchableOpacity onPress={() => shareKey(key)}>
                  <Ionicons name="share-outline" size={20} color={P01.cyan} />
                </TouchableOpacity>
              </TouchableOpacity>
            ))}
          </Animated.View>
        )}

        {/* Warning */}
        <Animated.View entering={FadeInDown.delay(400)} style={styles.warningCard}>
          <Ionicons name="warning" size={20} color={P01.yellow} />
          <Text style={styles.warningText}>
            ⚠ This key can SPEND the stealth payments you receive, not just view them.
            Anyone you give it to can take those funds. Only share with someone you fully
            trust, and never publicly.
          </Text>
        </Animated.View>
      </ScrollView>

      {/* Key Detail Modal */}
      <Modal
        visible={showKeyModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowKeyModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            {selectedKey && (
              <>
                <View style={styles.modalHeader}>
                  <View style={[styles.modalIcon, { backgroundColor: P01.cyanDim }]}>
                    <Ionicons name="key" size={28} color={P01.cyan} />
                  </View>
                  <View>
                    <Text style={styles.modalTitle}>{selectedKey.label}</Text>
                    <Text style={styles.modalSubtitle}>
                      {selectedKey.permissions.join(' • ')}
                    </Text>
                  </View>
                </View>

                {/* QR Code */}
                <View style={styles.qrContainer}>
                  <QRCode
                    value={selectedKey.key}
                    size={180}
                    backgroundColor="#eae7df"
                    color="#000000"
                  />
                </View>

                {/* Key Text */}
                <View style={styles.keyTextContainer}>
                  <Text style={styles.keyText} numberOfLines={3}>
                    {selectedKey.key}
                  </Text>
                </View>

                {/* Actions */}
                <View style={styles.modalActions}>
                  <TouchableOpacity
                    style={styles.modalActionButton}
                    onPress={() => confirmThenExpose(() => copyKey(selectedKey.key))}
                  >
                    <Ionicons name="copy" size={20} color={P01.cyan} />
                    <Text style={styles.modalActionText}>Copy</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.modalActionButton}
                    onPress={() => shareKey(selectedKey)}
                  >
                    <Ionicons name="share" size={20} color={P01.cyan} />
                    <Text style={styles.modalActionText}>Share</Text>
                  </TouchableOpacity>
                </View>

                <TouchableOpacity
                  style={styles.closeButton}
                  onPress={() => setShowKeyModal(false)}
                >
                  <Text style={styles.closeButtonText}>Done</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </Modal>

      {/* Import Modal */}
      <Modal
        visible={showImportModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowImportModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <View style={[styles.modalIcon, { backgroundColor: P01.blueDim }]}>
                <Ionicons name="download" size={28} color={P01.blue} />
              </View>
              <View>
                <Text style={styles.modalTitle}>Import Viewing Key</Text>
                <Text style={styles.modalSubtitle}>Watch-only access to another wallet</Text>
              </View>
            </View>

            <TextInput
              style={styles.importInput}
              value={importKey}
              onChangeText={setImportKey}
              placeholder="Paste viewing key here..."
              placeholderTextColor={Colors.textTertiary}
              multiline
              numberOfLines={4}
              autoCapitalize="none"
              autoCorrect={false}
            />

            <View style={styles.importActions}>
              <TouchableOpacity
                style={styles.cancelButton}
                onPress={() => {
                  setShowImportModal(false);
                  setImportKey('');
                }}
              >
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.importButton2, !importKey && styles.buttonDisabled]}
                onPress={handleImport}
                disabled={!importKey}
              >
                <Text style={styles.importButtonText}>Import</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Loading Overlay */}
      {isGenerating && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color={P01.cyan} />
          <Text style={styles.loadingText}>Generating viewing key...</Text>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  backButton: {
    padding: 8,
    marginLeft: -8,
  },
  headerTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerText: {
    fontSize: 18,
    fontFamily: FontFamily.bold,
    color: '#eae7df',
  },
  importButton: {
    padding: 8,
  },
  content: {
    flex: 1,
  },
  scrollContent: {
    padding: Spacing.md,
    paddingBottom: 40,
  },
  infoBanner: {
    flexDirection: 'row',
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    padding: Spacing.md,
    marginBottom: Spacing.lg,
    gap: 12,
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.2)',
  },
  infoBannerContent: {
    flex: 1,
  },
  infoBannerTitle: {
    fontSize: 14,
    fontFamily: FontFamily.bold,
    color: '#eae7df',
    marginBottom: 4,
  },
  infoBannerText: {
    fontSize: 13,
    fontFamily: FontFamily.regular,
    color: 'rgba(234, 231, 223, 0.62)',
    lineHeight: 20,
  },
  sectionTitle: {
    fontSize: 11,
    fontFamily: FontFamily.bold,
    color: 'rgba(234, 231, 223, 0.40)',
    letterSpacing: 1,
    marginBottom: Spacing.md,
    marginTop: Spacing.md,
  },
  keyOptionCard: {
    marginBottom: Spacing.sm,
    borderRadius: BorderRadius.lg,
    overflow: 'hidden',
  },
  keyOptionGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.md,
    backgroundColor: Colors.surface,
    gap: 12,
  },
  keyOptionIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyOptionContent: {
    flex: 1,
  },
  keyOptionTitle: {
    fontSize: 15,
    fontFamily: FontFamily.semibold,
    color: '#eae7df',
  },
  keyOptionDesc: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: 'rgba(234, 231, 223, 0.62)',
    marginTop: 2,
  },
  permissionTags: {
    flexDirection: 'row',
    marginTop: 8,
    gap: 6,
  },
  tag: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  tagText: {
    fontSize: 10,
    fontFamily: FontFamily.semibold,
  },
  savedKeyCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.sm,
    gap: 12,
  },
  savedKeyIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: P01.cyanDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  savedKeyContent: {
    flex: 1,
  },
  savedKeyTitle: {
    fontSize: 14,
    fontFamily: FontFamily.medium,
    color: '#eae7df',
  },
  savedKeyDate: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: 'rgba(234, 231, 223, 0.40)',
    marginTop: 2,
  },
  warningCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: P01.yellowDim,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginTop: Spacing.lg,
    gap: 10,
    borderWidth: 1,
    borderColor: 'rgba(255, 204, 0, 0.3)',
  },
  warningText: {
    flex: 1,
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: 'rgba(234, 231, 223, 0.62)',
    lineHeight: 18,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.8)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: BorderRadius.xl,
    borderTopRightRadius: BorderRadius.xl,
    padding: Spacing.lg,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: Spacing.lg,
  },
  modalIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalTitle: {
    fontSize: 18,
    fontFamily: FontFamily.bold,
    color: '#eae7df',
  },
  modalSubtitle: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: 'rgba(234, 231, 223, 0.62)',
    marginTop: 2,
  },
  qrContainer: {
    alignItems: 'center',
    backgroundColor: '#eae7df',
    borderRadius: BorderRadius.lg,
    padding: Spacing.lg,
    marginBottom: Spacing.lg,
  },
  keyTextContainer: {
    backgroundColor: Colors.background,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.lg,
  },
  keyText: {
    fontSize: 11,
    fontFamily: FontFamily.mono,
    color: 'rgba(234, 231, 223, 0.62)',
    lineHeight: 18,
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: Spacing.xl,
    marginBottom: Spacing.lg,
  },
  modalActionButton: {
    alignItems: 'center',
    gap: 4,
  },
  modalActionText: {
    fontSize: 12,
    fontFamily: FontFamily.medium,
    color: P01.cyan,
  },
  closeButton: {
    backgroundColor: P01.cyan,
    borderRadius: BorderRadius.md,
    paddingVertical: Spacing.md,
    alignItems: 'center',
  },
  closeButtonText: {
    fontSize: 16,
    fontFamily: FontFamily.bold,
    color: '#000000',
  },
  importInput: {
    backgroundColor: Colors.background,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    fontSize: 13,
    fontFamily: FontFamily.mono,
    color: '#eae7df',
    minHeight: 100,
    textAlignVertical: 'top',
    marginBottom: Spacing.lg,
  },
  importActions: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  cancelButton: {
    flex: 1,
    backgroundColor: Colors.background,
    borderRadius: BorderRadius.md,
    paddingVertical: Spacing.md,
    alignItems: 'center',
  },
  cancelButtonText: {
    fontSize: 16,
    fontFamily: FontFamily.bold,
    color: '#eae7df',
  },
  importButton2: {
    flex: 1,
    backgroundColor: P01.blue,
    borderRadius: BorderRadius.md,
    paddingVertical: Spacing.md,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  importButtonText: {
    fontSize: 16,
    fontFamily: FontFamily.bold,
    color: '#eae7df',
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.8)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    fontSize: 14,
    fontFamily: FontFamily.medium,
    color: '#eae7df',
    marginTop: Spacing.md,
  },
});

/**
 * Protocol 01 - QR Scan Screen
 *
 * Scan QR codes to add mesh contacts
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';

import { useMeshStore, MeshContact } from '@/stores/meshStore';
import { useContactsStore } from '@/stores/contactsStore';
import { QRScanner } from '@/components/mesh/QRScanner';

const COLORS = {
  primary: '#39c5bb',
  cyan: '#00D1FF',
  purple: '#9945FF',
  background: '#050505',
  surface: '#0a0a0a',
  surfaceSecondary: '#111111',
  text: '#ffffff',
  textSecondary: '#a0a0a0',
  textTertiary: '#666666',
};

export default function QRScanScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [scannedContact, setScannedContact] = useState<MeshContact | null>(null);
  const [showScanner, setShowScanner] = useState(true);

  const { addContactFromQR, error, clearError } = useMeshStore();
  const { addContact: addSolanaContact, contacts: solanaContacts } = useContactsStore();

  const handleScan = async (data: string) => {
    if (Platform.OS !== 'web') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }

    const contact = await addContactFromQR(data);

    if (contact) {
      // Also add to Solana contacts store as a P-01 user
      // This allows messaging via the classic Solana mode
      const existsInSolana = solanaContacts.some(c => c.address === contact.address);
      if (!existsInSolana) {
        try {
          await addSolanaContact(contact.address, contact.alias, {
            isP01User: true,
            contactSource: 'p01_qr',
            p01PublicKey: contact.publicKey,
          });
        } catch (e) {
          // Contact might already exist, ignore error
          console.log('Contact may already exist in Solana store:', e);
        }
      }

      setScannedContact(contact);
      setShowScanner(false);
    } else {
      Alert.alert(
        'Invalid QR Code',
        'This QR code is not a valid P-01 address.',
        [{ text: 'Try Again', onPress: () => setShowScanner(true) }]
      );
    }
  };

  const handleClose = () => {
    router.back();
  };

  if (showScanner) {
    return (
      <QRScanner
        onScan={handleScan}
        onClose={handleClose}
        title="Add Contact"
        subtitle="Scan a P-01 QR code to add a contact"
      />
    );
  }

  // Show success screen
  return (
    <View style={styles.container}>
      <LinearGradient
        colors={['rgba(0, 255, 136, 0.05)', 'transparent']}
        style={styles.gradient}
      />

      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity onPress={handleClose} style={styles.closeButton}>
          <Ionicons name="close" size={24} color={COLORS.text} />
        </TouchableOpacity>
      </View>

      {scannedContact && (
        <View style={styles.content}>
          {/* Success Animation */}
          <Animated.View entering={FadeIn} style={styles.successIcon}>
            <LinearGradient
              colors={[COLORS.primary + '30', COLORS.cyan + '20']}
              style={styles.successGradient}
            >
              <Ionicons name="checkmark-circle" size={64} color={COLORS.primary} />
            </LinearGradient>
          </Animated.View>

          {/* Contact Info */}
          <Animated.View entering={FadeInDown.delay(200)} style={styles.contactCard}>
            <View style={styles.avatarContainer}>
              <LinearGradient
                colors={[COLORS.cyan + '30', COLORS.purple + '30']}
                style={styles.avatarGradient}
              >
                <Text style={styles.avatarText}>
                  {scannedContact.alias.charAt(0).toUpperCase()}
                </Text>
              </LinearGradient>
            </View>

            <Text style={styles.contactName}>{scannedContact.alias}</Text>

            <View style={styles.addressContainer}>
              <Text style={styles.addressText}>
                {scannedContact.address.slice(0, 8)}...{scannedContact.address.slice(-8)}
              </Text>
            </View>

            <View style={styles.addedBadge}>
              <Ionicons name="shield-checkmark" size={14} color={COLORS.primary} />
              <Text style={styles.addedText}>P-01 User Added</Text>
            </View>
            <View style={styles.capabilitiesBadge}>
              <View style={styles.capabilityItem}>
                <Ionicons name="chatbubble" size={12} color={COLORS.cyan} />
                <Text style={styles.capabilityText}>Chat</Text>
              </View>
              <View style={styles.capabilityItem}>
                <Ionicons name="wallet" size={12} color={COLORS.cyan} />
                <Text style={styles.capabilityText}>Crypto</Text>
              </View>
            </View>
          </Animated.View>

          {/* Info */}
          <Animated.View entering={FadeInDown.delay(300)} style={styles.infoCard}>
            <Ionicons name="information-circle" size={20} color={COLORS.cyan} />
            <Text style={styles.infoText}>
              This contact has been saved. When you're both nearby with Bluetooth enabled,
              you'll be able to send messages and crypto directly.
            </Text>
          </Animated.View>

          {/* Actions */}
          <Animated.View entering={FadeInDown.delay(400)} style={styles.actions}>
            <TouchableOpacity
              onPress={() => {
                setShowScanner(true);
                setScannedContact(null);
              }}
              style={styles.scanAnotherButton}
            >
              <Ionicons name="scan-outline" size={20} color={COLORS.cyan} />
              <Text style={styles.scanAnotherText}>Scan Another</Text>
            </TouchableOpacity>

            <TouchableOpacity onPress={handleClose} style={styles.doneButton}>
              <LinearGradient
                colors={[COLORS.primary, COLORS.cyan]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={styles.doneGradient}
              >
                <Text style={styles.doneText}>Done</Text>
              </LinearGradient>
            </TouchableOpacity>
          </Animated.View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  gradient: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 400,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  closeButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: COLORS.surfaceSecondary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  content: {
    flex: 1,
    paddingHorizontal: 24,
    alignItems: 'center',
    paddingTop: 40,
  },
  successIcon: {
    marginBottom: 32,
  },
  successGradient: {
    width: 120,
    height: 120,
    borderRadius: 60,
    justifyContent: 'center',
    alignItems: 'center',
  },
  contactCard: {
    backgroundColor: COLORS.surfaceSecondary,
    borderRadius: 24,
    padding: 24,
    alignItems: 'center',
    width: '100%',
    borderWidth: 1,
    borderColor: COLORS.primary + '20',
  },
  avatarContainer: {
    marginBottom: 16,
  },
  avatarGradient: {
    width: 80,
    height: 80,
    borderRadius: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: {
    color: COLORS.text,
    fontSize: 32,
    fontWeight: 'bold',
  },
  contactName: {
    color: COLORS.text,
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  addressContainer: {
    backgroundColor: COLORS.surface,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    marginBottom: 16,
  },
  addressText: {
    color: COLORS.textSecondary,
    fontSize: 13,
    fontFamily: 'monospace',
  },
  addedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
  },
  addedText: {
    color: COLORS.primary,
    fontSize: 14,
    fontWeight: '600',
  },
  capabilitiesBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  capabilityItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  capabilityText: {
    color: COLORS.cyan,
    fontSize: 12,
    fontWeight: '500',
  },
  infoCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: COLORS.surfaceSecondary,
    borderRadius: 16,
    padding: 16,
    marginTop: 24,
    gap: 12,
  },
  infoText: {
    flex: 1,
    color: COLORS.textSecondary,
    fontSize: 13,
    lineHeight: 20,
  },
  actions: {
    marginTop: 32,
    width: '100%',
    gap: 12,
  },
  scanAnotherButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.cyan + '40',
    gap: 8,
  },
  scanAnotherText: {
    color: COLORS.cyan,
    fontSize: 16,
    fontWeight: '600',
  },
  doneButton: {
    borderRadius: 16,
    overflow: 'hidden',
  },
  doneGradient: {
    paddingVertical: 16,
    alignItems: 'center',
  },
  doneText: {
    color: '#000',
    fontSize: 16,
    fontWeight: 'bold',
  },
});

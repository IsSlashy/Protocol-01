/**
 * Protocol 01 - QR Share Screen
 *
 * Share your mesh identity via QR code
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Share,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';

import { useMeshStore } from '@/stores/meshStore';
import { QRCodeGenerator } from '@/components/mesh/QRCodeGenerator';

const COLORS = {
  primary: '#39c5bb',
  cyan: '#00D1FF',
  purple: '#9945FF',
  background: '#050505',
  surface: '#0a0a0a',
  surfaceSecondary: '#111111',
  border: '#1f1f1f',
  text: '#ffffff',
  textSecondary: '#a0a0a0',
  textTertiary: '#666666',
};

export default function QRShareScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [copied, setCopied] = useState(false);

  const { identity } = useMeshStore();

  if (!identity) {
    return (
      <View style={[styles.container, styles.centerContent]}>
        <Text style={styles.errorText}>Identity not initialized</Text>
      </View>
    );
  }

  // Generate QR data
  const qrData = `p01://connect?address=${identity.publicKey}&alias=${encodeURIComponent(identity.alias)}&pubkey=${identity.publicKey}`;

  const handleCopy = async () => {
    await Clipboard.setStringAsync(identity.publicKey);
    setCopied(true);
    if (Platform.OS !== 'web') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    setTimeout(() => setCopied(false), 2000);
  };

  const handleShare = async () => {
    try {
      await Share.share({
        message: `Connect with me on Protocol 01!\n\nMy address: ${identity.publicKey}\n\nOr scan my QR code in the app.`,
        title: 'Share P-01 Address',
      });
    } catch (error) {
      console.error('Share failed:', error);
    }
  };

  return (
    <View style={styles.container}>
      <LinearGradient
        colors={['rgba(0, 209, 255, 0.05)', 'transparent']}
        style={styles.gradient}
      />

      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color={COLORS.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>My QR Code</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={styles.content}>
        {/* QR Code Card */}
        <Animated.View entering={FadeIn.delay(100)} style={styles.qrCard}>
          <View style={styles.qrContainer}>
            <QRCodeGenerator
              value={qrData}
              size={220}
              color="#000000"
              backgroundColor="#ffffff"
            />
          </View>

          <View style={styles.identityInfo}>
            <Text style={styles.aliasText}>{identity.alias}</Text>
            <TouchableOpacity onPress={handleCopy} style={styles.addressContainer}>
              <Text style={styles.addressText}>
                {identity.publicKey.slice(0, 12)}...{identity.publicKey.slice(-12)}
              </Text>
              <Ionicons
                name={copied ? 'checkmark' : 'copy-outline'}
                size={16}
                color={copied ? COLORS.primary : COLORS.textSecondary}
              />
            </TouchableOpacity>
          </View>
        </Animated.View>

        {/* Instructions */}
        <Animated.View entering={FadeInDown.delay(200)} style={styles.instructions}>
          <Text style={styles.instructionsTitle}>How to connect</Text>
          <View style={styles.step}>
            <View style={styles.stepNumber}>
              <Text style={styles.stepNumberText}>1</Text>
            </View>
            <Text style={styles.stepText}>
              Have your friend open P-01 and go to Mesh mode
            </Text>
          </View>
          <View style={styles.step}>
            <View style={styles.stepNumber}>
              <Text style={styles.stepNumberText}>2</Text>
            </View>
            <Text style={styles.stepText}>
              They scan this QR code to add you as a contact
            </Text>
          </View>
          <View style={styles.step}>
            <View style={styles.stepNumber}>
              <Text style={styles.stepNumberText}>3</Text>
            </View>
            <Text style={styles.stepText}>
              When both devices are nearby, connect via Bluetooth
            </Text>
          </View>
        </Animated.View>

        {/* Actions */}
        <Animated.View entering={FadeInDown.delay(300)} style={styles.actions}>
          <TouchableOpacity onPress={handleShare} style={styles.shareButton}>
            <LinearGradient
              colors={[COLORS.cyan, COLORS.purple]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={styles.shareGradient}
            >
              <Ionicons name="share-outline" size={20} color="#000" />
              <Text style={styles.shareText}>Share Address</Text>
            </LinearGradient>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => router.push('/(main)/(social)/qr-scan')}
            style={styles.scanButton}
          >
            <Ionicons name="scan-outline" size={20} color={COLORS.cyan} />
            <Text style={styles.scanText}>Scan QR Code</Text>
          </TouchableOpacity>
        </Animated.View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  centerContent: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  gradient: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 300,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: COLORS.surfaceSecondary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: 'bold',
  },
  content: {
    flex: 1,
    paddingHorizontal: 24,
  },
  qrCard: {
    backgroundColor: COLORS.surfaceSecondary,
    borderRadius: 24,
    padding: 24,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.cyan + '20',
  },
  qrContainer: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 16,
    marginBottom: 20,
  },
  logoContainer: {
    backgroundColor: COLORS.surface,
    borderRadius: 8,
    padding: 8,
  },
  identityInfo: {
    alignItems: 'center',
  },
  aliasText: {
    color: COLORS.text,
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  addressContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    gap: 8,
  },
  addressText: {
    color: COLORS.textSecondary,
    fontSize: 13,
    fontFamily: 'monospace',
  },
  instructions: {
    marginTop: 24,
    backgroundColor: COLORS.surfaceSecondary,
    borderRadius: 16,
    padding: 20,
  },
  instructionsTitle: {
    color: COLORS.textSecondary,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 1,
    marginBottom: 16,
    textTransform: 'uppercase',
  },
  step: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  stepNumber: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: COLORS.cyan + '20',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  stepNumberText: {
    color: COLORS.cyan,
    fontSize: 12,
    fontWeight: 'bold',
  },
  stepText: {
    flex: 1,
    color: COLORS.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  actions: {
    marginTop: 24,
    gap: 12,
  },
  shareButton: {
    borderRadius: 16,
    overflow: 'hidden',
  },
  shareGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    gap: 8,
  },
  shareText: {
    color: '#000',
    fontSize: 16,
    fontWeight: 'bold',
  },
  scanButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.cyan + '40',
    gap: 8,
  },
  scanText: {
    color: COLORS.cyan,
    fontSize: 16,
    fontWeight: '600',
  },
  errorText: {
    color: COLORS.textSecondary,
    fontSize: 16,
  },
});

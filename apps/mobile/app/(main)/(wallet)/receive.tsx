import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Share,
  StyleSheet,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';

import { useWalletStore } from '@/stores/walletStore';
import { Colors, FontFamily, BorderRadius, Spacing } from '@/constants/theme';

// P-01 Design System Colors - NO purple allowed
const P01 = {
  cyan: '#39c5bb',
  cyanDim: 'rgba(57, 197, 187, 0.15)',
  pink: '#ff77a8',
  pinkDim: 'rgba(255, 119, 168, 0.15)',
};
import { QRCodeGenerator } from '@/components/mesh/QRCodeGenerator';

export default function ReceiveScreen() {
  const router = useRouter();
  const { publicKey, formattedPublicKey } = useWalletStore();

  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (publicKey) {
      await Clipboard.setStringAsync(publicKey);
      setCopied(true);
      if (Platform.OS !== 'web') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleShare = async () => {
    if (publicKey) {
      try {
        await Share.share({
          message: `My Solana address: ${publicKey}`,
        });
      } catch (error) {
        console.error('Error sharing:', error);
      }
    }
  };

  const formatAddressMultiline = (address: string) => {
    if (!address) return '';
    const mid = Math.floor(address.length / 2);
    return `${address.slice(0, mid)}\n${address.slice(mid)}`;
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <Animated.View entering={FadeInDown.delay(100)} style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
        >
          <Ionicons name="arrow-back" size={24} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Receive SOL</Text>
        <View style={styles.backButton} />
      </Animated.View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* QR Code Section */}
        <Animated.View entering={FadeInUp.delay(200)} style={styles.qrSection}>
          <View style={styles.qrContainer}>
            {publicKey ? (
              <QRCodeGenerator
                value={`solana:${publicKey}`}
                size={200}
                color="#000000"
                backgroundColor="#ffffff"
              />
            ) : (
              <View style={styles.qrPlaceholder}>
                <Text style={styles.qrPlaceholderText}>Loading...</Text>
              </View>
            )}
          </View>

          {/* Network Badge */}
          <View style={styles.networkBadge}>
            <View style={styles.networkDot} />
            <Text style={styles.networkText}>Solana Devnet</Text>
          </View>
        </Animated.View>

        {/* Address Card */}
        <Animated.View entering={FadeInUp.delay(300)} style={styles.addressCard}>
          <Text style={styles.addressLabel}>YOUR WALLET ADDRESS</Text>
          <Text style={styles.addressText} selectable>
            {publicKey}
          </Text>

          {/* Action Buttons */}
          <View style={styles.actionButtons}>
            <TouchableOpacity
              style={[styles.actionButton, copied && styles.actionButtonActive]}
              onPress={handleCopy}
            >
              <Ionicons
                name={copied ? 'checkmark' : 'copy-outline'}
                size={20}
                color={copied ? Colors.background : Colors.primary}
              />
              <Text style={[styles.actionButtonText, copied && styles.actionButtonTextActive]}>
                {copied ? 'Copied!' : 'Copy Address'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.actionButton} onPress={handleShare}>
              <Ionicons name="share-outline" size={20} color={Colors.primary} />
              <Text style={styles.actionButtonText}>Share</Text>
            </TouchableOpacity>
          </View>
        </Animated.View>

        {/* Info Card */}
        <Animated.View entering={FadeInUp.delay(400)} style={styles.infoCard}>
          <View style={styles.infoRow}>
            <Ionicons name="information-circle" size={20} color={Colors.primary} />
            <Text style={styles.infoTitle}>Receiving SOL</Text>
          </View>
          <Text style={styles.infoText}>
            Share your address or QR code with the sender. Transactions on
            Solana are typically confirmed within 1-2 seconds.
          </Text>
        </Animated.View>

        {/* Tips */}
        <Animated.View entering={FadeInUp.delay(500)} style={styles.tipsCard}>
          <Text style={styles.tipsTitle}>Tips</Text>
          <View style={styles.tipRow}>
            <Ionicons name="checkmark-circle" size={16} color={Colors.success} />
            <Text style={styles.tipText}>
              Always verify the address before sending
            </Text>
          </View>
          <View style={styles.tipRow}>
            <Ionicons name="checkmark-circle" size={16} color={Colors.success} />
            <Text style={styles.tipText}>
              This address can receive SOL and SPL tokens
            </Text>
          </View>
          <View style={styles.tipRow}>
            <Ionicons name="checkmark-circle" size={16} color={Colors.success} />
            <Text style={styles.tipText}>
              You're on Devnet - use the faucet for test SOL
            </Text>
          </View>
        </Animated.View>
      </ScrollView>
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
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.surfaceSecondary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    color: Colors.text,
    fontSize: 18,
    fontFamily: FontFamily.semibold,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: Spacing.xl,
    paddingBottom: Spacing['5xl'],
  },
  qrSection: {
    alignItems: 'center',
    marginBottom: Spacing['2xl'],
  },
  qrContainer: {
    backgroundColor: Colors.text,
    borderRadius: BorderRadius.xl,
    padding: Spacing.lg,
    marginBottom: Spacing.lg,
  },
  qrPlaceholder: {
    width: 200,
    height: 200,
    backgroundColor: Colors.text,
    position: 'relative',
    justifyContent: 'center',
    alignItems: 'center',
  },
  qrCorner: {
    position: 'absolute',
    width: 40,
    height: 40,
    borderWidth: 6,
    borderColor: '#000',
    borderRadius: 4,
  },
  qrCornerTL: { top: 0, left: 0, borderRightWidth: 0, borderBottomWidth: 0 },
  qrCornerTR: { top: 0, right: 0, borderLeftWidth: 0, borderBottomWidth: 0 },
  qrCornerBL: { bottom: 0, left: 0, borderRightWidth: 0, borderTopWidth: 0 },
  qrCornerBR: { bottom: 0, right: 0, borderLeftWidth: 0, borderTopWidth: 0 },
  qrLogo: {
    width: 48,
    height: 48,
    borderRadius: BorderRadius.md,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  qrLogoText: {
    color: Colors.text,
    fontSize: 24,
    fontFamily: FontFamily.bold,
  },
  qrPattern: {
    position: 'absolute',
    top: 48,
    left: 48,
    right: 48,
    bottom: 48,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    zIndex: 0,
  },
  qrDot: {
    width: 8,
    height: 8,
    margin: 2,
    borderRadius: 1,
  },
  networkBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: P01.pinkDim,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderRadius: BorderRadius.full,
    gap: Spacing.xs,
  },
  networkDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: P01.pink,
  },
  networkText: {
    color: P01.pink,
    fontSize: 13,
    fontFamily: FontFamily.medium,
  },
  addressCard: {
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.xl,
    marginBottom: Spacing.xl,
  },
  addressLabel: {
    color: Colors.textTertiary,
    fontSize: 11,
    fontFamily: FontFamily.semibold,
    letterSpacing: 1,
    marginBottom: Spacing.md,
  },
  addressText: {
    color: Colors.text,
    fontSize: 13,
    fontFamily: FontFamily.mono,
    lineHeight: 22,
    marginBottom: Spacing.xl,
  },
  actionButtons: {
    flexDirection: 'row',
    gap: Spacing.md,
  },
  actionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.md,
    borderRadius: BorderRadius.lg,
    backgroundColor: Colors.surfaceTertiary,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  actionButtonActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  actionButtonText: {
    color: Colors.text,
    fontSize: 14,
    fontFamily: FontFamily.medium,
  },
  actionButtonTextActive: {
    color: Colors.background,
  },
  infoCard: {
    backgroundColor: Colors.primaryDim,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.2)',
    padding: Spacing.lg,
    marginBottom: Spacing.xl,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginBottom: Spacing.sm,
  },
  infoTitle: {
    color: Colors.primary,
    fontSize: 14,
    fontFamily: FontFamily.semibold,
  },
  infoText: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontFamily: FontFamily.regular,
    lineHeight: 20,
  },
  tipsCard: {
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.lg,
  },
  tipsTitle: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontFamily: FontFamily.semibold,
    marginBottom: Spacing.md,
  },
  tipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginBottom: Spacing.sm,
  },
  tipText: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontFamily: FontFamily.regular,
  },
});

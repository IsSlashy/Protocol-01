import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Share,
  StyleSheet,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';
import QRCode from 'react-native-qrcode-svg';

import { useWalletStore } from '@/stores/walletStore';
import { useAutoShieldStore } from '@/stores/autoShieldStore';
import { getMetaAddress } from '@/services/stealth/keys';
import { getCluster } from '@/services/solana/connection';
import { Colors, FontFamily, BorderRadius, Spacing } from '@/constants/theme';

// P-01 Design System Colors
const P01 = {
  cyan: '#39c5bb',
  cyanDim: 'rgba(57, 197, 187, 0.15)',
  pink: '#ff77a8',
  pinkDim: 'rgba(255, 119, 168, 0.15)',
};

export default function ReceiveScreen() {
  const router = useRouter();
  const { publicKey } = useWalletStore();
  const { generateReceiveAddress, isGenerating, load } = useAutoShieldStore();

  const [copied, setCopied] = useState(false);
  const [copiedMeta, setCopiedMeta] = useState(false);
  const [stealthAddress, setStealthAddress] = useState<string | null>(null);
  const [metaAddress, setMetaAddress] = useState<string | null>(null);
  const [showPublic, setShowPublic] = useState(false);

  // Generate the one-time stealth address + load meta-address once per screen
  // open. Cached across Public↔Private toggles so flipping back doesn't churn a
  // brand-new address each time (re-enter the screen for a fresh one).
  useEffect(() => {
    let mounted = true;
    (async () => {
      await load();
      if (!showPublic && publicKey && !stealthAddress) {
        try {
          const addr = await generateReceiveAddress();
          if (mounted) setStealthAddress(addr);
        } catch (err) {
          console.error('[Receive] Failed to generate stealth address:', err);
        }
        try {
          const meta = await getMetaAddress();
          if (mounted) setMetaAddress(meta);
        } catch {}
      }
    })();
    return () => { mounted = false; };
  }, [showPublic, publicKey, stealthAddress]);

  const displayAddress = showPublic ? publicKey : stealthAddress;
  const isPrivate = !showPublic && !!stealthAddress;

  const handleCopy = async () => {
    if (displayAddress) {
      await Clipboard.setStringAsync(displayAddress);
      setCopied(true);
      if (Platform.OS !== 'web') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      // Auto-clear clipboard after 60s (security)
      setTimeout(async () => {
        try { await Clipboard.setStringAsync(''); } catch {}
      }, 60_000);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleShare = async () => {
    if (displayAddress) {
      try {
        await Share.share({
          message: displayAddress,
        });
      } catch (error) {
        console.error('Error sharing:', error);
      }
    }
  };

  const handleNewAddress = async () => {
    if (!publicKey) return;
    try {
      const addr = await generateReceiveAddress();
      setStealthAddress(addr);
      if (Platform.OS !== 'web') {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }
    } catch {}
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <Animated.View entering={FadeInDown.delay(100)} style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
          accessibilityRole="button"
          accessibilityLabel="Go back"
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
        {/* Privacy Mode Toggle */}
        <Animated.View entering={FadeInUp.delay(150)} style={styles.modeToggle}>
          <TouchableOpacity
            style={[styles.modeButton, !showPublic && styles.modeButtonActive]}
            onPress={() => setShowPublic(false)}
          >
            <Ionicons
              name="shield-checkmark"
              size={16}
              color={!showPublic ? Colors.background : Colors.textSecondary}
            />
            <Text style={[styles.modeButtonText, !showPublic && styles.modeButtonTextActive]}>
              Private
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.modeButton, showPublic && styles.modeButtonActive]}
            onPress={() => setShowPublic(true)}
          >
            <Ionicons
              name="eye-outline"
              size={16}
              color={showPublic ? Colors.background : Colors.textSecondary}
            />
            <Text style={[styles.modeButtonText, showPublic && styles.modeButtonTextActive]}>
              Public
            </Text>
          </TouchableOpacity>
        </Animated.View>

        {/* QR Code Section */}
        <Animated.View entering={FadeInUp.delay(200)} style={styles.qrSection}>
          <View style={styles.qrContainer} accessibilityLabel="QR code for receive address" accessibilityRole="image">
            {displayAddress ? (
              <QRCode
                value={`solana:${displayAddress}`}
                size={200}
                color="#000000"
                backgroundColor="#ffffff"
              />
            ) : (
              <View style={styles.qrPlaceholder}>
                <ActivityIndicator size="large" color={Colors.primary} />
                <Text style={styles.qrPlaceholderText}>Generating...</Text>
              </View>
            )}
          </View>

          {/* Badges */}
          <View style={styles.badgeRow}>
            {isPrivate && (
              <View style={[styles.badge, styles.privacyBadge]}>
                <Ionicons name="shield-checkmark" size={14} color={P01.cyan} />
                <Text style={[styles.badgeText, { color: P01.cyan }]}>Auto-shields</Text>
              </View>
            )}
            <View style={styles.badge}>
              <View style={[styles.networkDot, { backgroundColor: P01.pink }]} />
              <Text style={[styles.badgeText, { color: P01.pink }]}>
                Solana {getCluster() === 'mainnet-beta' ? 'Mainnet' : getCluster() === 'devnet' ? 'Devnet' : 'Testnet'}
              </Text>
            </View>
          </View>
        </Animated.View>

        {/* Address Card */}
        <Animated.View entering={FadeInUp.delay(300)} style={styles.addressCard}>
          <Text style={styles.addressLabel}>
            {isPrivate ? 'ONE-TIME PRIVATE ADDRESS' : 'YOUR WALLET ADDRESS'}
          </Text>
          <Text style={styles.addressText} selectable>
            {displayAddress || 'Generating...'}
          </Text>

          {/* Action Buttons */}
          <View style={styles.actionButtons}>
            <TouchableOpacity
              style={[styles.actionButton, copied && styles.actionButtonActive]}
              onPress={handleCopy}
              disabled={!displayAddress}
              accessibilityRole="button"
              accessibilityLabel={copied ? 'Address copied' : 'Copy address'}
            >
              <Ionicons
                name={copied ? 'checkmark' : 'copy-outline'}
                size={20}
                color={copied ? Colors.background : Colors.primary}
              />
              <Text style={[styles.actionButtonText, copied && styles.actionButtonTextActive]}>
                {copied ? 'Copied!' : 'Copy'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.actionButton} onPress={handleShare} disabled={!displayAddress} accessibilityRole="button" accessibilityLabel="Share address">
              <Ionicons name="share-outline" size={20} color={Colors.primary} />
              <Text style={styles.actionButtonText}>Share</Text>
            </TouchableOpacity>

            {isPrivate && (
              <TouchableOpacity
                style={styles.actionButton}
                onPress={handleNewAddress}
                disabled={isGenerating}
                accessibilityRole="button"
                accessibilityLabel="Generate new address"
              >
                <Ionicons name="refresh-outline" size={20} color={Colors.primary} />
                <Text style={styles.actionButtonText}>New</Text>
              </TouchableOpacity>
            )}
          </View>
        </Animated.View>

        {/* P01 ID — persistent stealth address for P01-to-P01 transfers */}
        {isPrivate && metaAddress && (
          <Animated.View entering={FadeInUp.delay(350)}>
            <TouchableOpacity
              style={styles.metaRow}
              onPress={async () => {
                await Clipboard.setStringAsync(metaAddress);
                setCopiedMeta(true);
                if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                setTimeout(async () => { try { await Clipboard.setStringAsync(''); } catch {} }, 60_000);
                setTimeout(() => setCopiedMeta(false), 2000);
              }}
            >
              <Ionicons name="finger-print" size={16} color={P01.cyan} />
              <Text style={styles.metaLabel}>
                {copiedMeta ? 'P01 ID copied!' : 'Copy P01 ID (for P01 users)'}
              </Text>
              <Ionicons name={copiedMeta ? 'checkmark' : 'copy-outline'} size={14} color={P01.cyan} />
            </TouchableOpacity>
          </Animated.View>
        )}

        {/* Privacy Info */}
        {isPrivate ? (
          <Animated.View entering={FadeInUp.delay(400)} style={styles.infoCard}>
            <View style={styles.infoRow}>
              <Ionicons name="shield-checkmark" size={20} color={P01.cyan} />
              <Text style={[styles.infoTitle, { color: P01.cyan }]}>Private Receive</Text>
            </View>
            <Text style={styles.infoText}>
              This is a one-time address. Funds sent here will be automatically
              shielded into your privacy pool. Your main wallet is never exposed.
            </Text>
          </Animated.View>
        ) : (
          <Animated.View entering={FadeInUp.delay(400)} style={styles.infoCard}>
            <View style={styles.infoRow}>
              <Ionicons name="warning" size={20} color={P01.pink} />
              <Text style={[styles.infoTitle, { color: P01.pink }]}>Public Address</Text>
            </View>
            <Text style={styles.infoText}>
              This is your main wallet address. Sending to this address is visible
              on-chain and can be linked to your identity. Use Private mode instead.
            </Text>
          </Animated.View>
        )}

        {/* Tips */}
        <Animated.View entering={FadeInUp.delay(500)} style={styles.tipsCard}>
          <Text style={styles.tipsTitle}>How it works</Text>
          <View style={styles.tipRow}>
            <Ionicons name="checkmark-circle" size={16} color={Colors.success} />
            <Text style={styles.tipText}>
              {isPrivate
                ? 'Fresh address generated each time — never reused'
                : 'Always verify the address before sending'}
            </Text>
          </View>
          <View style={styles.tipRow}>
            <Ionicons name="checkmark-circle" size={16} color={Colors.success} />
            <Text style={styles.tipText}>
              {isPrivate
                ? 'Funds auto-shield to your privacy pool (~60s)'
                : 'This address can receive SOL and SPL tokens'}
            </Text>
          </View>
          <View style={styles.tipRow}>
            <Ionicons name="checkmark-circle" size={16} color={Colors.success} />
            <Text style={styles.tipText}>
              {isPrivate
                ? 'Your real wallet is never visible to the sender'
                : 'Transactions are visible on-chain to everyone'}
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
  modeToggle: {
    flexDirection: 'row',
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.lg,
    padding: 4,
    marginBottom: Spacing.xl,
  },
  modeButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.xs,
    paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md,
  },
  modeButtonActive: {
    backgroundColor: Colors.primary,
  },
  modeButtonText: {
    color: Colors.textSecondary,
    fontSize: 14,
    fontFamily: FontFamily.semibold,
  },
  modeButtonTextActive: {
    color: Colors.background,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: Spacing.xl,
    paddingBottom: 120,
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
    justifyContent: 'center',
    alignItems: 'center',
    gap: Spacing.md,
  },
  qrPlaceholderText: {
    color: Colors.textTertiary,
    fontSize: 14,
  },
  badgeRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: P01.pinkDim,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderRadius: BorderRadius.full,
    gap: Spacing.xs,
  },
  privacyBadge: {
    backgroundColor: P01.cyanDim,
  },
  badgeText: {
    fontSize: 13,
    fontFamily: FontFamily.medium,
  },
  networkDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
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
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.md,
    marginBottom: Spacing.xl,
  },
  metaLabel: {
    color: P01.cyan,
    fontSize: 13,
    fontFamily: FontFamily.medium,
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
    flex: 1,
  },
});

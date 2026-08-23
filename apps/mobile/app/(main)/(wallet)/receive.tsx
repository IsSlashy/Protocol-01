/**
 * Receive SOL — a one-time private address, or the public one.
 *
 * 🎯 RESTYLED AND CUT DOWN 2026-08-23.
 *   - ⛔ THE LOCAL `P01` PALETTE IS DELETED, including a `pinkDim` that was
 *     still the literal old pink rgba. The network badge, the info card and the
 *     P01 ID row all read it, so three separate elements on this screen were
 *     off-palette in a way no theme edit could fix.
 *   - the labels were "ONE-TIME PRIVATE ADDRESS" and "YOUR WALLET ADDRESS" in
 *     caps with letterspacing. Sentence case.
 *   - the QR was drawn with a `#000000` on `#eae7df` pair written inline.
 *     Same two colours, from the tokens that hold them.
 *   - ⛔ THE "HOW IT WORKS" CARD IS GONE. Three green-tick bullets restating
 *     the mode the user had already chosen at the top of the screen, and in
 *     public mode the last one ("Transactions are visible on-chain to
 *     everyone") duplicated the warning immediately above it. One statement per
 *     mode, in the place the mode is explained.
 *
 * ⚠️ The two badges under the QR became one line of text. "Auto-shields" said
 * the same thing as the Private tab being selected and the paragraph below it.
 */

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
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import QRCode from 'react-native-qrcode-svg';

import { useWalletStore } from '@/stores/walletStore';
import { useAutoShieldStore } from '@/stores/autoShieldStore';
import { getMetaAddress } from '@/services/stealth/keys';
import { getCluster } from '@/services/solana/connection';
import { Colors, FontFamily, FontSize, BorderRadius, Spacing, Layout } from '@/constants/theme';

export default function ReceiveScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
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

  const cluster = getCluster();
  const networkLabel =
    cluster === 'mainnet-beta' ? 'Solana mainnet'
      : cluster === 'devnet' ? 'Solana devnet'
        : 'Solana testnet';

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
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="chevron-back" size={22} color={Colors.textSecondary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} accessibilityRole="header">Receive SOL</Text>
        <View style={styles.backButton} />
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: Layout.tabBarTotalHeight + insets.bottom + Spacing['2xl'] },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Which address the sender gets */}
        <View style={styles.modeToggle}>
          <TouchableOpacity
            style={[styles.modeButton, !showPublic && styles.modeButtonActive]}
            onPress={() => setShowPublic(false)}
            accessibilityRole="button"
            accessibilityState={{ selected: !showPublic }}
            accessibilityLabel="Private address"
          >
            <Text style={[styles.modeButtonText, !showPublic && styles.modeButtonTextActive]}>
              Private
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.modeButton, showPublic && styles.modeButtonActive]}
            onPress={() => setShowPublic(true)}
            accessibilityRole="button"
            accessibilityState={{ selected: showPublic }}
            accessibilityLabel="Public address"
          >
            <Text style={[styles.modeButtonText, showPublic && styles.modeButtonTextActive]}>
              Public
            </Text>
          </TouchableOpacity>
        </View>

        {/* QR */}
        <View style={styles.qrSection}>
          <View
            style={styles.qrContainer}
            accessibilityLabel="QR code for receive address"
            accessibilityRole="image"
          >
            {displayAddress ? (
              <QRCode
                value={`solana:${displayAddress}`}
                size={200}
                color={Colors.background}
                backgroundColor={Colors.text}
              />
            ) : (
              <View style={styles.qrPlaceholder}>
                <ActivityIndicator size="large" color={Colors.background} />
              </View>
            )}
          </View>
          <Text style={styles.network}>{networkLabel}</Text>
        </View>

        {/* The address itself */}
        <View style={styles.addressCard}>
          <Text style={styles.addressLabel}>
            {isPrivate ? 'One-time address' : 'Your wallet address'}
          </Text>
          <Text style={styles.addressText} selectable>
            {displayAddress || 'Generating…'}
          </Text>

          <View style={styles.actionButtons}>
            <TouchableOpacity
              style={styles.actionButton}
              onPress={handleCopy}
              disabled={!displayAddress}
              accessibilityRole="button"
              accessibilityLabel={copied ? 'Address copied' : 'Copy address'}
              accessibilityState={{ disabled: !displayAddress }}
            >
              <Ionicons
                name={copied ? 'checkmark' : 'copy-outline'}
                size={18}
                color={copied ? Colors.primary : Colors.text}
              />
              <Text style={styles.actionButtonText}>{copied ? 'Copied' : 'Copy'}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.actionButton}
              onPress={handleShare}
              disabled={!displayAddress}
              accessibilityRole="button"
              accessibilityLabel="Share address"
              accessibilityState={{ disabled: !displayAddress }}
            >
              <Ionicons name="share-outline" size={18} color={Colors.text} />
              <Text style={styles.actionButtonText}>Share</Text>
            </TouchableOpacity>

            {isPrivate ? (
              <TouchableOpacity
                style={styles.actionButton}
                onPress={handleNewAddress}
                disabled={isGenerating}
                accessibilityRole="button"
                accessibilityLabel="Generate a new one-time address"
                accessibilityState={{ disabled: isGenerating, busy: isGenerating }}
              >
                <Ionicons name="refresh-outline" size={18} color={Colors.text} />
                <Text style={styles.actionButtonText}>New</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>

        {/* P01 ID — the persistent stealth address, for P01-to-P01 transfers */}
        {isPrivate && metaAddress ? (
          <TouchableOpacity
            style={styles.metaRow}
            onPress={async () => {
              await Clipboard.setStringAsync(metaAddress);
              setCopiedMeta(true);
              if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              setTimeout(async () => { try { await Clipboard.setStringAsync(''); } catch {} }, 60_000);
              setTimeout(() => setCopiedMeta(false), 2000);
            }}
            accessibilityRole="button"
            accessibilityLabel="Copy your P01 ID"
          >
            <Ionicons
              name={copiedMeta ? 'checkmark' : 'finger-print-outline'}
              size={16}
              color={copiedMeta ? Colors.primary : Colors.textSecondary}
            />
            <Text style={styles.metaLabel}>
              {copiedMeta ? 'P01 ID copied' : 'Copy your P01 ID, for other Styx users'}
            </Text>
          </TouchableOpacity>
        ) : null}

        {/* One statement per mode. */}
        {isPrivate ? (
          <View style={styles.note}>
            <Text style={styles.noteText}>
              A fresh address, used once. Funds sent here are shielded into your pool
              automatically, and the sender never handles your wallet address.
            </Text>
          </View>
        ) : (
          <View style={[styles.note, styles.noteCaution]}>
            <Ionicons name="eye-outline" size={16} color={Colors.yellow} />
            <Text style={styles.noteText}>
              Your main wallet address. Anything sent here is visible on chain and sits beside
              everything else this wallet has ever done.
            </Text>
          </View>
        )}
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
    paddingHorizontal: Spacing.md,
    minHeight: 56,
  },
  backButton: {
    width: 44,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    color: Colors.text,
    fontSize: FontSize.xl,
    fontFamily: FontFamily.displayMedium,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: Spacing.xl,
  },
  modeToggle: {
    flexDirection: 'row',
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    padding: 4,
    marginTop: Spacing.lg,
    marginBottom: Spacing['3xl'],
  },
  modeButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    borderRadius: BorderRadius.md,
  },
  modeButtonActive: {
    backgroundColor: Colors.primary,
  },
  modeButtonText: {
    color: Colors.textSecondary,
    fontSize: FontSize.md,
    fontFamily: FontFamily.medium,
  },
  modeButtonTextActive: {
    color: Colors.background,
  },
  qrSection: {
    alignItems: 'center',
    marginBottom: Spacing['3xl'],
    gap: Spacing.md,
  },
  qrContainer: {
    backgroundColor: Colors.text,
    borderRadius: BorderRadius.xl,
    padding: Spacing.lg,
  },
  qrPlaceholder: {
    width: 200,
    height: 200,
    justifyContent: 'center',
    alignItems: 'center',
  },
  network: {
    color: Colors.textTertiary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
  },
  addressCard: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    padding: Spacing.lg,
    marginBottom: Spacing.lg,
  },
  addressLabel: {
    color: Colors.textSecondary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    marginBottom: Spacing.sm,
  },
  addressText: {
    color: Colors.text,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.mono,
    lineHeight: 21,
    marginBottom: Spacing.lg,
  },
  actionButtons: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  actionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    minHeight: 44,
    borderRadius: BorderRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  actionButtonText: {
    color: Colors.text,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.medium,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    minHeight: 44,
    marginBottom: Spacing.lg,
  },
  metaLabel: {
    color: Colors.textSecondary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
  },
  note: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
    padding: Spacing.md,
    borderRadius: BorderRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSoft,
    backgroundColor: Colors.surfaceSecondary,
  },
  noteCaution: {
    borderColor: Colors.yellow,
    backgroundColor: Colors.warningDim,
  },
  noteText: {
    flex: 1,
    color: Colors.textSecondary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    lineHeight: 20,
  },
});

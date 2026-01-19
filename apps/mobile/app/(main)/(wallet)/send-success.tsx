import React, { useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Share,
  StyleSheet,
  Platform,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withDelay,
  withSequence,
  FadeIn,
  FadeInUp,
} from 'react-native-reanimated';

import { Colors, FontFamily, BorderRadius, Spacing, Shadows } from '@/constants/theme';

// P-01 Design System Colors - NO purple allowed
const P01 = {
  cyan: '#39c5bb',
  cyanBright: '#00ffe5',
  cyanDim: 'rgba(57, 197, 187, 0.15)',
};
import { getExplorerUrl } from '@/services/solana/connection';

export default function SendSuccessScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    signature: string;
    amount: string;
    recipient: string;
  }>();

  const { signature = '', amount = '0', recipient = '' } = params;

  // Animations
  const checkScale = useSharedValue(0);
  const ringScale = useSharedValue(0.5);
  const ringOpacity = useSharedValue(0);

  useEffect(() => {
    if (Platform.OS !== 'web') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }

    // Animate in
    ringOpacity.value = withDelay(100, withSpring(1));
    ringScale.value = withDelay(100, withSpring(1));
    checkScale.value = withDelay(300, withSpring(1, { damping: 8 }));
  }, []);

  const checkAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: checkScale.value }],
  }));

  const ringAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: ringScale.value }],
    opacity: ringOpacity.value,
  }));

  const handleShare = async () => {
    try {
      const explorerUrl = getExplorerUrl(signature, 'tx');
      await Share.share({
        message: `I just sent ${amount} SOL on Solana! View transaction: ${explorerUrl}`,
      });
    } catch (error) {
      console.error('Error sharing:', error);
    }
  };

  const handleViewExplorer = () => {
    const url = getExplorerUrl(signature, 'tx');
    Linking.openURL(url);
  };

  const handleCopySignature = async () => {
    await Clipboard.setStringAsync(signature);
    if (Platform.OS !== 'web') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  };

  const handleBackToWallet = () => {
    router.replace('/(main)/(wallet)');
  };

  const truncateSignature = (sig: string) => {
    if (sig.length <= 16) return sig;
    return `${sig.slice(0, 8)}...${sig.slice(-8)}`;
  };

  const truncateAddress = (address: string) => {
    if (address.length <= 16) return address;
    return `${address.slice(0, 6)}...${address.slice(-6)}`;
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        {/* Success Animation */}
        <View style={styles.animationContainer}>
          {/* Outer Ring */}
          <Animated.View style={[styles.outerRing, ringAnimatedStyle]} />

          {/* Inner Ring */}
          <Animated.View style={[styles.innerRing, ringAnimatedStyle]}>
            <Animated.View style={[styles.checkContainer, checkAnimatedStyle]}>
              <LinearGradient
                colors={[P01.cyan, P01.cyanBright]}
                style={styles.checkGradient}
              >
                <Ionicons name="checkmark" size={48} color={Colors.background} />
              </LinearGradient>
            </Animated.View>
          </Animated.View>
        </View>

        {/* Success Text */}
        <Animated.View entering={FadeInUp.delay(400)} style={styles.textContainer}>
          <Text style={styles.successTitle}>Transaction Sent!</Text>
          <Text style={styles.successSubtitle}>
            Your SOL has been sent successfully
          </Text>
        </Animated.View>

        {/* Transaction Details */}
        <Animated.View entering={FadeInUp.delay(500)} style={styles.detailsCard}>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Amount</Text>
            <Text style={styles.detailValue}>{amount} SOL</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>To</Text>
            <Text style={styles.detailValueMono}>{truncateAddress(recipient)}</Text>
          </View>
          <View style={styles.divider} />
          <TouchableOpacity style={styles.detailRow} onPress={handleCopySignature}>
            <Text style={styles.detailLabel}>Signature</Text>
            <View style={styles.signatureRow}>
              <Text style={styles.detailValueMono}>{truncateSignature(signature)}</Text>
              <Ionicons name="copy-outline" size={14} color={Colors.textSecondary} />
            </View>
          </TouchableOpacity>
          <View style={styles.divider} />
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Status</Text>
            <View style={styles.statusBadge}>
              <View style={styles.statusDot} />
              <Text style={styles.statusText}>Confirmed</Text>
            </View>
          </View>
        </Animated.View>

        {/* Action Buttons */}
        <Animated.View entering={FadeInUp.delay(600)} style={styles.actionsContainer}>
          <View style={styles.actionButtonsRow}>
            <TouchableOpacity style={styles.secondaryButton} onPress={handleViewExplorer}>
              <Ionicons name="open-outline" size={20} color={Colors.primary} />
              <Text style={styles.secondaryButtonText}>View on Explorer</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.secondaryButton} onPress={handleShare}>
              <Ionicons name="share-outline" size={20} color={Colors.primary} />
              <Text style={styles.secondaryButtonText}>Share</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity style={styles.primaryButton} onPress={handleBackToWallet}>
            <Text style={styles.primaryButtonText}>Back to Wallet</Text>
          </TouchableOpacity>
        </Animated.View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.xl,
  },
  animationContainer: {
    width: 140,
    height: 140,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing['3xl'],
  },
  outerRing: {
    position: 'absolute',
    width: 140,
    height: 140,
    borderRadius: 70,
    borderWidth: 2,
    borderColor: 'rgba(57, 197, 187, 0.2)',
  },
  innerRing: {
    width: 110,
    height: 110,
    borderRadius: 55,
    backgroundColor: Colors.primaryDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkContainer: {
    width: 80,
    height: 80,
  },
  checkGradient: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
    ...Shadows.glow,
  },
  textContainer: {
    alignItems: 'center',
    marginBottom: Spacing['3xl'],
  },
  successTitle: {
    color: Colors.primary,
    fontSize: 28,
    fontFamily: FontFamily.bold,
    marginBottom: Spacing.sm,
  },
  successSubtitle: {
    color: Colors.textSecondary,
    fontSize: 15,
    fontFamily: FontFamily.regular,
  },
  detailsCard: {
    width: '100%',
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.xl,
    marginBottom: Spacing['3xl'],
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.sm,
  },
  detailLabel: {
    color: Colors.textSecondary,
    fontSize: 14,
    fontFamily: FontFamily.regular,
  },
  detailValue: {
    color: Colors.text,
    fontSize: 14,
    fontFamily: FontFamily.semibold,
  },
  detailValueMono: {
    color: Colors.text,
    fontSize: 13,
    fontFamily: FontFamily.mono,
  },
  signatureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
  },
  divider: {
    height: 1,
    backgroundColor: Colors.border,
    marginVertical: Spacing.xs,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.successDim,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderRadius: BorderRadius.full,
    gap: Spacing.xs,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Colors.success,
  },
  statusText: {
    color: Colors.success,
    fontSize: 12,
    fontFamily: FontFamily.medium,
  },
  actionsContainer: {
    width: '100%',
    gap: Spacing.md,
  },
  actionButtonsRow: {
    flexDirection: 'row',
    gap: Spacing.md,
  },
  secondaryButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.lg,
    borderRadius: BorderRadius.lg,
    backgroundColor: Colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  secondaryButtonText: {
    color: Colors.text,
    fontSize: 14,
    fontFamily: FontFamily.medium,
  },
  primaryButton: {
    backgroundColor: Colors.primary,
    paddingVertical: Spacing.lg,
    borderRadius: BorderRadius.lg,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: Colors.background,
    fontSize: 16,
    fontFamily: FontFamily.semibold,
  },
});

import React, { useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  FadeInDown,
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  withSpring,
} from 'react-native-reanimated';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';

const AnimatedTouchable = Animated.createAnimatedComponent(TouchableOpacity);

interface ShieldedBalanceCardProps {
  isLoading: boolean;
  shieldedBalance: number;
  showBalance: boolean;
  zkAddress: string | null;
  onRefresh: () => void;
  onCopyAddress: () => void;
}

// --- Shimmer placeholder shown while loading ---
function ShimmerPlaceholder() {
  const shimmerOpacity = useSharedValue(0.3);

  useEffect(() => {
    shimmerOpacity.value = withRepeat(
      withSequence(
        withTiming(0.8, { duration: 800 }),
        withTiming(0.3, { duration: 800 }),
      ),
      -1,
      false,
    );
  }, []);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: shimmerOpacity.value,
  }));

  return (
    <View style={shimmerStyles.container}>
      <Animated.View style={[shimmerStyles.barWide, animatedStyle]} />
      <Animated.View style={[shimmerStyles.barMedium, animatedStyle]} />
      <Animated.View style={[shimmerStyles.barNarrow, animatedStyle]} />
    </View>
  );
}

const shimmerStyles = StyleSheet.create({
  container: {
    alignItems: 'center',
    gap: 10,
    paddingVertical: Spacing.xl,
  },
  barWide: {
    width: '55%',
    height: 28,
    borderRadius: 6,
    backgroundColor: Colors.border,
  },
  barMedium: {
    width: '35%',
    height: 14,
    borderRadius: 4,
    backgroundColor: Colors.border,
  },
  barNarrow: {
    width: '70%',
    height: 44,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.border,
  },
});

// --- Private status pill with pulsing green dot ---
function PrivateStatusPill() {
  const dotOpacity = useSharedValue(1);

  useEffect(() => {
    dotOpacity.value = withRepeat(
      withSequence(
        withTiming(0.3, { duration: 1000 }),
        withTiming(1, { duration: 1000 }),
      ),
      -1,
      false,
    );
  }, []);

  const dotStyle = useAnimatedStyle(() => ({
    opacity: dotOpacity.value,
  }));

  return (
    <View style={styles.pillContainer}>
      <Animated.View style={[styles.pillDot, dotStyle]} />
      <Text style={styles.pillText}>PRIVATE</Text>
    </View>
  );
}

// --- Main component ---
export default function ShieldedBalanceCard({
  isLoading,
  shieldedBalance,
  showBalance,
  zkAddress,
  onRefresh,
  onCopyAddress,
}: ShieldedBalanceCardProps) {
  const copyScale = useSharedValue(1);

  const formatBalance = () => {
    if (!showBalance) return '****';
    return `${shieldedBalance.toFixed(4)} SOL`;
  };

  const handleCopyPress = () => {
    copyScale.value = withSequence(
      withSpring(0.9, { damping: 15, stiffness: 300 }),
      withSpring(1, { damping: 12, stiffness: 200 }),
    );
    onCopyAddress();
  };

  const copyAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: copyScale.value }],
  }));

  return (
    <Animated.View entering={FadeInDown.delay(100)} style={styles.outerBorder}>
      <LinearGradient
        colors={[Colors.surface, Colors.background]}
        style={styles.card}
      >
        {/* Header row */}
        <View style={styles.header}>
          <View style={styles.label}>
            <Ionicons name="shield" size={18} color={P01Colors.cyan} />
            <Text style={styles.labelText}>Shielded Balance</Text>
          </View>
          <TouchableOpacity onPress={onRefresh} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Ionicons
              name="refresh"
              size={18}
              color={Colors.textSecondary}
              style={isLoading ? { opacity: 0.4 } : undefined}
            />
          </TouchableOpacity>
        </View>

        {isLoading ? (
          <ShimmerPlaceholder />
        ) : (
          <>
            {/* Large centered balance */}
            <View style={styles.balanceSection}>
              <Text style={styles.balanceValue}>{formatBalance()}</Text>
              <PrivateStatusPill />
            </View>

            {/* Subtle description */}
            <Text style={styles.subtext}>
              Fully private &middot; Zero-knowledge protected
            </Text>

            {/* ZK Address card */}
            <View style={styles.zkCard}>
              <View style={styles.zkHeader}>
                <Text style={styles.zkLabel}>ZK Address</Text>
              </View>
              <View style={styles.zkBody}>
                <Text style={styles.zkAddress} numberOfLines={1} ellipsizeMode="middle">
                  {zkAddress || 'Initializing...'}
                </Text>
                <AnimatedTouchable
                  onPress={handleCopyPress}
                  style={[styles.copyButton, copyAnimatedStyle]}
                  activeOpacity={0.7}
                >
                  <Ionicons name="copy-outline" size={14} color={P01Colors.cyan} />
                  <Text style={styles.copyText}>Copy</Text>
                </AnimatedTouchable>
              </View>
            </View>
          </>
        )}
      </LinearGradient>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  outerBorder: {
    borderRadius: BorderRadius.lg + 1,
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.4)',
  },
  card: {
    padding: Spacing.xl,
    borderRadius: BorderRadius.lg,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.sm,
  },
  label: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  labelText: {
    fontSize: 14,
    fontFamily: FontFamily.medium,
    color: Colors.textSecondary,
  },

  // Balance
  balanceSection: {
    alignItems: 'center',
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.md,
  },
  balanceValue: {
    fontSize: 42,
    fontFamily: FontFamily.bold,
    color: Colors.textPrimary,
    letterSpacing: -1,
    textAlign: 'center',
  },

  // Private pill
  pillContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 10,
    backgroundColor: 'rgba(16, 185, 129, 0.1)',
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: BorderRadius.full,
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.2)',
  },
  pillDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: P01Colors.green,
  },
  pillText: {
    fontSize: 11,
    fontFamily: FontFamily.semibold,
    color: P01Colors.green,
    letterSpacing: 1.5,
  },

  // Subtext
  subtext: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    textAlign: 'center',
    marginBottom: Spacing.lg,
  },

  // ZK Address card
  zkCard: {
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
    borderRadius: BorderRadius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
    gap: 8,
  },
  zkHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  zkLabel: {
    fontSize: 11,
    fontFamily: FontFamily.semibold,
    color: Colors.textTertiary,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  zkBody: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  zkAddress: {
    flex: 1,
    fontSize: 13,
    fontFamily: FontFamily.mono,
    color: Colors.textPrimary,
    opacity: 0.85,
  },
  copyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: P01Colors.cyanDim,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: BorderRadius.sm,
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.25)',
  },
  copyText: {
    fontSize: 12,
    fontFamily: FontFamily.medium,
    color: P01Colors.cyan,
  },
});

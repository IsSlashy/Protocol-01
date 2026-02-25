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
} from 'react-native-reanimated';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';

interface ConfidentialBalanceCardProps {
  isLoading: boolean;
  isInitialized: boolean;
  confidentialBalance: number;
  showBalance: boolean;
  onRefresh: () => void;
  tokenSymbol?: string;
}

function ShimmerBar({ width, delay }: { width: number | string; delay: number }) {
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
    <Animated.View
      style={[
        {
          height: 14,
          width: width as any,
          borderRadius: 7,
          backgroundColor: 'rgba(59, 130, 246, 0.2)',
          marginVertical: 4,
          alignSelf: 'center',
        },
        animatedStyle,
      ]}
    />
  );
}

function PulsingDot() {
  const dotOpacity = useSharedValue(1);

  useEffect(() => {
    dotOpacity.value = withRepeat(
      withSequence(
        withTiming(0.3, { duration: 1200 }),
        withTiming(1, { duration: 1200 }),
      ),
      -1,
      false,
    );
  }, []);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: dotOpacity.value,
  }));

  return (
    <Animated.View style={[styles.pulsingDot, animatedStyle]} />
  );
}

export default function ConfidentialBalanceCard({
  isLoading,
  isInitialized,
  confidentialBalance,
  showBalance,
  onRefresh,
  tokenSymbol = 'SOL',
}: ConfidentialBalanceCardProps) {
  const displayDecimals = tokenSymbol === 'USDC' ? 2 : 4;
  const formatBalance = () => {
    if (!showBalance) return '****';
    return `${confidentialBalance.toFixed(displayDecimals)} ${tokenSymbol}`;
  };

  const showShimmer = isLoading && !isInitialized;

  return (
    <Animated.View entering={FadeInDown.delay(100)} style={styles.outerWrapper}>
      {/* Gradient border layer */}
      <LinearGradient
        colors={['rgba(59, 130, 246, 0.30)', 'rgba(59, 130, 246, 0.08)', 'rgba(59, 130, 246, 0.20)']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.borderGradient}
      >
        {/* Inner card background */}
        <LinearGradient
          colors={['#111118', '#0d0d12', '#0a0a0c']}
          start={{ x: 0, y: 0 }}
          end={{ x: 0.5, y: 1 }}
          style={styles.card}
        >
          {/* Header row */}
          <View style={styles.header}>
            <View style={styles.label}>
              <Ionicons name="shield-checkmark" size={16} color={P01Colors.blue} />
              <Text style={styles.labelText}>Confidential Balance</Text>
            </View>
            <TouchableOpacity onPress={onRefresh} hitSlop={12} activeOpacity={0.6}>
              <Ionicons
                name="refresh"
                size={16}
                color={Colors.textSecondary}
                style={isLoading ? { opacity: 0.4 } : undefined}
              />
            </TouchableOpacity>
          </View>

          {/* Balance / Shimmer */}
          {showShimmer ? (
            <View style={styles.shimmerContainer}>
              <ShimmerBar width={180} delay={0} />
              <ShimmerBar width={120} delay={200} />
              <ShimmerBar width={90} delay={400} />
            </View>
          ) : (
            <>
              {/* Large centered balance */}
              <Text style={styles.balanceValue}>{formatBalance()}</Text>

              {/* QUANTUM-RESISTANT badge */}
              <View style={styles.badgeWrapper}>
                <LinearGradient
                  colors={['rgba(59, 130, 246, 0.12)', 'rgba(59, 130, 246, 0.04)']}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.badge}
                >
                  <PulsingDot />
                  <Text style={styles.badgeText}>QUANTUM-RESISTANT</Text>
                </LinearGradient>
              </View>

              {/* Descriptor text */}
              <Text style={styles.descriptor}>
                Poseidon commitment-based | zkSPL
              </Text>
            </>
          )}
        </LinearGradient>
      </LinearGradient>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  outerWrapper: {
    borderRadius: BorderRadius.lg + 1,
    overflow: 'hidden',
  },
  borderGradient: {
    padding: 1,
    borderRadius: BorderRadius.lg + 1,
  },
  card: {
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.xl,
    paddingHorizontal: Spacing.lg,
    borderRadius: BorderRadius.lg,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.lg,
  },
  label: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  labelText: {
    fontSize: 13,
    fontFamily: FontFamily.medium,
    color: Colors.textSecondary,
    letterSpacing: 0.2,
  },
  shimmerContainer: {
    alignItems: 'center',
    paddingVertical: 24,
    gap: 6,
  },
  balanceValue: {
    fontSize: 42,
    fontFamily: FontFamily.bold,
    color: Colors.textPrimary,
    textAlign: 'center',
    marginTop: Spacing.sm,
    marginBottom: Spacing.lg,
    letterSpacing: -0.5,
  },
  badgeWrapper: {
    alignItems: 'center',
    marginBottom: Spacing.md,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: BorderRadius.full,
    borderWidth: 1,
    borderColor: 'rgba(59, 130, 246, 0.18)',
  },
  pulsingDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: P01Colors.blue,
  },
  badgeText: {
    fontSize: 11,
    fontFamily: FontFamily.mono,
    color: P01Colors.blue,
    letterSpacing: 1.5,
  },
  descriptor: {
    fontSize: 11,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    textAlign: 'center',
    letterSpacing: 0.3,
  },
});

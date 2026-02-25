import React, { useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  FadeInDown,
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';

interface PendingCreditsCardProps {
  count: number;
}

const AMBER = '#fbbf24';
const AMBER_DIM = 'rgba(251, 191, 36, 0.15)';

export default function PendingCreditsCard({ count }: PendingCreditsCardProps) {
  const borderOpacity = useSharedValue(0.2);
  const iconRotation = useSharedValue(0);

  useEffect(() => {
    if (count <= 0) return;

    // Pulse border opacity between 0.2 and 0.5
    borderOpacity.value = withRepeat(
      withTiming(0.5, { duration: 1500 }),
      -1,
      true,
    );

    // Wobble hourglass icon +-15 degrees
    iconRotation.value = withRepeat(
      withSequence(
        withTiming(15, { duration: 600 }),
        withTiming(-15, { duration: 1200 }),
        withTiming(0, { duration: 600 }),
      ),
      -1,
      false,
    );
  }, [count]);

  const animatedBorderStyle = useAnimatedStyle(() => ({
    borderColor: `rgba(251, 191, 36, ${borderOpacity.value})`,
  }));

  const animatedIconStyle = useAnimatedStyle(() => ({
    transform: [{ rotateZ: `${iconRotation.value}deg` }],
  }));

  if (count <= 0) return null;

  return (
    <Animated.View entering={FadeInDown.delay(300)}>
      <Text style={styles.sectionTitle}>PENDING CREDITS</Text>
      <Animated.View style={[styles.card, animatedBorderStyle]}>
        {/* Left amber accent border */}
        <View style={styles.accentBorder} />

        {/* Gradient-tinted background layer */}
        <View style={styles.gradientBg} />

        {/* Animated hourglass icon in circle */}
        <View style={styles.iconCircle}>
          <Animated.View style={animatedIconStyle}>
            <Ionicons name="hourglass" size={20} color={AMBER} />
          </Animated.View>
        </View>

        {/* Info text */}
        <View style={styles.info}>
          <Text style={styles.countText}>
            {count} pending credit{count > 1 ? 's' : ''}
          </Text>
          <Text style={styles.subtext}>
            Awaiting apply — you need the amount and salt from the sender
          </Text>
        </View>

        {/* Action hint chevron */}
        <View style={styles.chevronContainer}>
          <Ionicons name="chevron-forward" size={16} color="rgba(251, 191, 36, 0.5)" />
        </View>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  sectionTitle: {
    fontSize: 11,
    fontFamily: FontFamily.bold,
    color: Colors.textTertiary,
    letterSpacing: 1,
    marginTop: Spacing.md,
    marginBottom: Spacing.sm,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    paddingLeft: Spacing.md + 3, // account for accent border
    gap: 12,
    borderWidth: 1,
    borderColor: 'rgba(251, 191, 36, 0.2)',
    overflow: 'hidden',
    position: 'relative',
  },
  accentBorder: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 3,
    backgroundColor: AMBER,
    borderTopLeftRadius: BorderRadius.md,
    borderBottomLeftRadius: BorderRadius.md,
  },
  gradientBg: {
    position: 'absolute',
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(251, 191, 36, 0.05)',
  },
  iconCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: AMBER_DIM,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(251, 191, 36, 0.25)',
  },
  info: {
    flex: 1,
  },
  countText: {
    fontSize: 16,
    fontFamily: FontFamily.bold,
    color: AMBER,
  },
  subtext: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    marginTop: 3,
    lineHeight: 17,
  },
  chevronContainer: {
    paddingLeft: Spacing.xs,
  },
});

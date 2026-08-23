/**
 * StreamingIndicator — a dot that says something is live.
 *
 * 🎯 REBUILT ON THE REALIGNED THEME 2026-08-23, and made much quieter.
 *
 * 🚨 WHAT IT WAS: FOUR looping animations at once — a pulse, a scale, an
 * opacity fade and an expanding ripple — driving a hot-pink dot that also
 * carried a 6px drop shadow of itself, plus a fifth interpolation fading the
 * amount text in and out so the number a user was reading changed brightness
 * while they read it. That is not an indicator, it is a light show, and it ran
 * for as long as the screen was open.
 *
 * What survives is the one thing the component is for: a slow two-second pulse
 * on a single accent dot. Everything else was the neon house style the brand
 * is removing.
 *
 * ⚠️ Every prop is unchanged, including `size`, `label` and `showRate`, so no
 * call site has to move.
 */

import React, { useEffect, useRef } from 'react';
import { View, Text, Animated, Easing, StyleSheet, ViewProps } from 'react-native';

import { Colors, FontFamily, FontSize, BorderRadius, Spacing } from '@/constants/theme';

interface StreamingIndicatorProps extends ViewProps {
  amount?: number;
  symbol?: string;
  ratePerSecond?: number;
  isActive?: boolean;
  size?: 'sm' | 'md' | 'lg';
  showRate?: boolean;
  label?: string;
}

const DOT: Record<'sm' | 'md' | 'lg', number> = { sm: 6, md: 8, lg: 10 };

export const StreamingIndicator: React.FC<StreamingIndicatorProps> = ({
  amount,
  symbol,
  ratePerSecond,
  isActive = true,
  size = 'md',
  showRate = true,
  label,
  className,
  style,
  ...props
}) => {
  const pulse = useRef(new Animated.Value(1)).current;
  const dot = DOT[size];

  useEffect(() => {
    if (!isActive) {
      pulse.setValue(0.4);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.35,
          duration: 1000,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1000,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [isActive]);

  const theDot = (
    <Animated.View
      style={[
        styles.dot,
        { width: dot, height: dot, borderRadius: dot / 2, opacity: pulse },
        !isActive && styles.dotIdle,
      ]}
    />
  );

  // Label mode — used inline inside a card.
  if (label !== undefined) {
    return (
      <View style={[styles.labelRow, style]} className={className} {...props}>
        {theDot}
        {label ? <Text style={styles.labelText}>{label}</Text> : null}
      </View>
    );
  }

  // Full mode — the dot, the amount and the rate.
  return (
    <View style={[styles.panel, style]} className={className} {...props}>
      {theDot}
      <View style={styles.panelBody}>
        <Text style={[styles.amount, sizeAmount[size]]}>
          {amount?.toFixed(6)} {symbol}
        </Text>
        {showRate && ratePerSecond !== undefined && (
          <Text style={styles.rate}>
            {isActive ? 'Streaming' : 'Paused'} at {ratePerSecond.toFixed(8)}/sec
          </Text>
        )}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  dot: { backgroundColor: Colors.primary },
  dotIdle: { backgroundColor: Colors.textTertiary },

  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  labelText: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.xs,
    color: Colors.primary,
  },

  panel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.md,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  panelBody: { flex: 1, minWidth: 0 },
  // An amount is mono, and it does not fade while somebody is reading it.
  amount: {
    fontFamily: FontFamily.mono,
    color: Colors.text,
  },
  rate: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
    marginTop: 2,
  },
});

const sizeAmount = StyleSheet.create({
  sm: { fontSize: FontSize.sm },
  md: { fontSize: FontSize.md },
  lg: { fontSize: FontSize.xl },
});

export default StreamingIndicator;

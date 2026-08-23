/**
 * StreamProgress — a bar that fills.
 *
 * 🎯 RETONED 2026-08-23. The track was `rgba(255, 119, 168, 0.2)` and the fill
 * emitted an 8px cyan drop shadow that pulsed on a loop while the bar was
 * partly full. Two things were wrong with that: the pink is retired, and a
 * glow is the neon language the brand is removing — a progress bar does not
 * need to give off light to read as in-progress.
 *
 * ⚠️ `showGlow` is still accepted so no call site has to change. It now
 * controls the same thing it always meant — whether the bar animates while it
 * is between 0 and 100 — minus the shadow.
 */

import React, { useEffect, useRef } from 'react';
import { View, Animated, StyleSheet, ViewProps } from 'react-native';

import { Colors, BorderRadius } from '@/constants/theme';

interface StreamProgressProps extends ViewProps {
  progress: number; // 0-100
  height?: number;
  animated?: boolean;
  /** Legacy name. There is no glow; this gates the subtle in-flight pulse. */
  showGlow?: boolean;
}

export const StreamProgress: React.FC<StreamProgressProps> = ({
  progress,
  height = 6,
  animated = true,
  showGlow = true,
  className,
  style,
  ...props
}) => {
  const animatedWidth = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (animated) {
      Animated.spring(animatedWidth, {
        toValue: progress,
        useNativeDriver: false,
        tension: 50,
        friction: 8,
      }).start();
    } else {
      animatedWidth.setValue(progress);
    }
  }, [progress, animated]);

  useEffect(() => {
    if (showGlow && progress > 0 && progress < 100) {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 0.7,
            duration: 900,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 900,
            useNativeDriver: true,
          }),
        ])
      );
      pulse.start();
      return () => pulse.stop();
    }
  }, [progress, showGlow]);

  const widthInterpolate = animatedWidth.interpolate({
    inputRange: [0, 100],
    outputRange: ['0%', '100%'],
  });

  return (
    <View
      style={[styles.track, { height, borderRadius: height / 2 }, style]}
      className={className}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(progress) }}
      {...props}
    >
      <Animated.View
        style={[
          styles.fill,
          { width: widthInterpolate, borderRadius: height / 2 },
          showGlow && progress > 0 && progress < 100 ? { opacity: pulseAnim } : null,
        ]}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  track: {
    width: '100%',
    overflow: 'hidden',
    backgroundColor: Colors.surfaceTertiary,
    borderRadius: BorderRadius.full,
  },
  fill: {
    height: '100%',
    backgroundColor: Colors.primary,
  },
});

export default StreamProgress;

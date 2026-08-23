/**
 * Loader — three dots, a pulse, or a bounce.
 *
 * 🎯 RETUNED ON THE REALIGNED THEME 2026-08-23. The dots were `#39c5bb`
 * written out four times as a literal; they are `Colors.primary` now, so a
 * future accent change reaches them. The label reads `Colors.textSecondary`
 * through the theme instead of a Tailwind class name.
 *
 * ♿ The whole component is one accessibility node announcing itself as busy.
 * Three independently animating dots used to be three unlabelled views, which
 * a screen reader either skipped or read as nothing at all.
 */

import React, { useEffect, useRef } from 'react';
import { View, Animated, Easing, Text, StyleSheet } from 'react-native';

import { Colors, Spacing, FontFamily, FontSize } from '@/constants/theme';

type LoaderSize = 'sm' | 'md' | 'lg';
type LoaderVariant = 'ghost' | 'pulse' | 'dots';

interface LoaderProps {
  size?: LoaderSize;
  variant?: LoaderVariant;
  label?: string;
  className?: string;
}

const sizeStyles: Record<LoaderSize, { container: number; dot: number; text: number }> = {
  sm: { container: 24, dot: 4, text: FontSize.xs },
  md: { container: 40, dot: 6, text: FontSize.sm },
  lg: { container: 60, dot: 8, text: FontSize.md },
};

const GhostLoader: React.FC<{ size: LoaderSize }> = ({ size }) => {
  const opacity1 = useRef(new Animated.Value(0.3)).current;
  const opacity2 = useRef(new Animated.Value(0.3)).current;
  const opacity3 = useRef(new Animated.Value(0.3)).current;
  const scale = useRef(new Animated.Value(1)).current;

  const sizeStyle = sizeStyles[size];

  useEffect(() => {
    const animate = (animatedValue: Animated.Value, delay: number) => {
      return Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(animatedValue, {
            toValue: 1,
            duration: 600,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(animatedValue, {
            toValue: 0.3,
            duration: 600,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ])
      );
    };

    const scaleAnimation = Animated.loop(
      Animated.sequence([
        Animated.timing(scale, {
          toValue: 1.1,
          duration: 800,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(scale, {
          toValue: 1,
          duration: 800,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    );

    const animations = [
      animate(opacity1, 0),
      animate(opacity2, 200),
      animate(opacity3, 400),
      scaleAnimation,
    ];

    animations.forEach((anim) => anim.start());

    return () => {
      animations.forEach((anim) => anim.stop());
    };
  }, []);

  const dot = {
    width: sizeStyle.dot,
    height: sizeStyle.dot,
    borderRadius: sizeStyle.dot / 2,
    backgroundColor: Colors.primary,
  };

  return (
    <Animated.View
      style={[
        styles.center,
        {
          width: sizeStyle.container,
          height: sizeStyle.container,
          transform: [{ scale }],
        },
      ]}
    >
      <View style={styles.dotRow}>
        <Animated.View style={[dot, { opacity: opacity1 }]} />
        <Animated.View style={[dot, { opacity: opacity2 }]} />
        <Animated.View style={[dot, { opacity: opacity3 }]} />
      </View>
    </Animated.View>
  );
};

const PulseLoader: React.FC<{ size: LoaderSize }> = ({ size }) => {
  const scale = useRef(new Animated.Value(0.5)).current;
  const opacity = useRef(new Animated.Value(1)).current;

  const sizeStyle = sizeStyles[size];

  useEffect(() => {
    const animation = Animated.loop(
      Animated.parallel([
        Animated.sequence([
          Animated.timing(scale, {
            toValue: 1.5,
            duration: 1000,
            easing: Easing.out(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(scale, {
            toValue: 0.5,
            duration: 0,
            useNativeDriver: true,
          }),
        ]),
        Animated.sequence([
          Animated.timing(opacity, {
            toValue: 0,
            duration: 1000,
            easing: Easing.out(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(opacity, {
            toValue: 1,
            duration: 0,
            useNativeDriver: true,
          }),
        ]),
      ])
    );

    animation.start();
    return () => animation.stop();
  }, []);

  return (
    <View
      style={[styles.center, { width: sizeStyle.container, height: sizeStyle.container }]}
    >
      <Animated.View
        style={{
          width: sizeStyle.container,
          height: sizeStyle.container,
          borderRadius: sizeStyle.container / 2,
          backgroundColor: Colors.primary,
          transform: [{ scale }],
          opacity,
        }}
      />
    </View>
  );
};

const DotsLoader: React.FC<{ size: LoaderSize }> = ({ size }) => {
  const translateY1 = useRef(new Animated.Value(0)).current;
  const translateY2 = useRef(new Animated.Value(0)).current;
  const translateY3 = useRef(new Animated.Value(0)).current;

  const sizeStyle = sizeStyles[size];
  const bounceHeight = sizeStyle.dot * 2;

  useEffect(() => {
    const animate = (animatedValue: Animated.Value, delay: number) => {
      return Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(animatedValue, {
            toValue: -bounceHeight,
            duration: 300,
            easing: Easing.out(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(animatedValue, {
            toValue: 0,
            duration: 300,
            easing: Easing.in(Easing.ease),
            useNativeDriver: true,
          }),
        ])
      );
    };

    const animations = [
      animate(translateY1, 0),
      animate(translateY2, 150),
      animate(translateY3, 300),
    ];

    animations.forEach((anim) => anim.start());
    return () => animations.forEach((anim) => anim.stop());
  }, []);

  const dotStyle = {
    width: sizeStyle.dot,
    height: sizeStyle.dot,
    borderRadius: sizeStyle.dot / 2,
    backgroundColor: Colors.primary,
  };

  return (
    <View
      style={[
        styles.dotRow,
        styles.center,
        { width: sizeStyle.container, height: sizeStyle.container },
      ]}
    >
      <Animated.View style={[dotStyle, { transform: [{ translateY: translateY1 }] }]} />
      <Animated.View style={[dotStyle, { transform: [{ translateY: translateY2 }] }]} />
      <Animated.View style={[dotStyle, { transform: [{ translateY: translateY3 }] }]} />
    </View>
  );
};

export const Loader: React.FC<LoaderProps> = ({
  size = 'md',
  variant = 'ghost',
  label,
  className,
}) => {
  const sizeStyle = sizeStyles[size];

  const LoaderComponent = {
    ghost: GhostLoader,
    pulse: PulseLoader,
    dots: DotsLoader,
  }[variant];

  return (
    <View
      style={styles.center}
      className={className}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label ?? 'Loading'}
      accessibilityState={{ busy: true }}
    >
      <LoaderComponent size={size} />
      {label ? (
        <Text style={[styles.label, { fontSize: sizeStyle.text }]}>{label}</Text>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  dotRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
  },
  label: {
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    marginTop: Spacing.sm,
  },
});

export default Loader;

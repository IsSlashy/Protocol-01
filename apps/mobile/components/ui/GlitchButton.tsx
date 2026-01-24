/**
 * GlitchButton - Button with cyber glitch animation effect
 *
 * Used in custom alert modals for that Protocol 01 aesthetic.
 */

import React, { useEffect, useRef, useCallback } from 'react';
import {
  TouchableOpacity,
  Text,
  View,
  Animated,
  Easing,
  TouchableOpacityProps,
} from 'react-native';
import * as Haptics from 'expo-haptics';

type ButtonVariant = 'primary' | 'danger' | 'ghost';

interface GlitchButtonProps extends Omit<TouchableOpacityProps, 'onPress'> {
  variant?: ButtonVariant;
  onPress?: () => void;
  children: string;
  fullWidth?: boolean;
}

const variantStyles: Record<ButtonVariant, {
  container: string;
  text: string;
  glitchColor: string;
}> = {
  primary: {
    container: 'bg-p01-cyan',
    text: 'text-p01-void font-semibold',
    glitchColor: '#00ffe5',
  },
  danger: {
    container: 'bg-p01-red',
    text: 'text-white font-semibold',
    glitchColor: '#ff6699',
  },
  ghost: {
    container: 'bg-transparent border border-p01-border',
    text: 'text-p01-gray font-medium',
    glitchColor: '#39c5bb',
  },
};

export const GlitchButton: React.FC<GlitchButtonProps> = ({
  variant = 'primary',
  onPress,
  children,
  fullWidth = false,
  disabled,
  ...props
}) => {
  const glitchAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const glitchOpacity = useRef(new Animated.Value(0)).current;

  const styles = variantStyles[variant];

  // Subtle glitch pulse animation
  useEffect(() => {
    const glitchLoop = Animated.loop(
      Animated.sequence([
        Animated.delay(2000 + Math.random() * 3000),
        Animated.parallel([
          Animated.sequence([
            Animated.timing(glitchAnim, {
              toValue: 1,
              duration: 50,
              easing: Easing.step0,
              useNativeDriver: true,
            }),
            Animated.timing(glitchAnim, {
              toValue: -1,
              duration: 50,
              easing: Easing.step0,
              useNativeDriver: true,
            }),
            Animated.timing(glitchAnim, {
              toValue: 0.5,
              duration: 30,
              easing: Easing.step0,
              useNativeDriver: true,
            }),
            Animated.timing(glitchAnim, {
              toValue: 0,
              duration: 30,
              easing: Easing.step0,
              useNativeDriver: true,
            }),
          ]),
          Animated.sequence([
            Animated.timing(glitchOpacity, {
              toValue: 0.7,
              duration: 50,
              useNativeDriver: true,
            }),
            Animated.timing(glitchOpacity, {
              toValue: 0,
              duration: 100,
              useNativeDriver: true,
            }),
          ]),
        ]),
      ])
    );
    glitchLoop.start();

    return () => glitchLoop.stop();
  }, [glitchAnim, glitchOpacity]);

  const handlePress = useCallback(() => {
    // Haptic feedback
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    // Press animation with glitch
    Animated.sequence([
      Animated.timing(scaleAnim, {
        toValue: 0.95,
        duration: 50,
        useNativeDriver: true,
      }),
      Animated.parallel([
        Animated.timing(scaleAnim, {
          toValue: 1,
          duration: 100,
          useNativeDriver: true,
        }),
        Animated.sequence([
          Animated.timing(glitchAnim, {
            toValue: 3,
            duration: 30,
            useNativeDriver: true,
          }),
          Animated.timing(glitchAnim, {
            toValue: -2,
            duration: 40,
            useNativeDriver: true,
          }),
          Animated.timing(glitchAnim, {
            toValue: 1,
            duration: 30,
            useNativeDriver: true,
          }),
          Animated.timing(glitchAnim, {
            toValue: 0,
            duration: 50,
            useNativeDriver: true,
          }),
        ]),
      ]),
    ]).start();

    onPress?.();
  }, [onPress, scaleAnim, glitchAnim]);

  const glitchTranslateX = glitchAnim.interpolate({
    inputRange: [-1, 0, 1],
    outputRange: [-2, 0, 2],
  });

  return (
    <TouchableOpacity
      onPress={handlePress}
      disabled={disabled}
      activeOpacity={0.9}
      {...props}
    >
      <Animated.View
        className={`
          ${styles.container}
          ${fullWidth ? 'w-full' : ''}
          ${disabled ? 'opacity-50' : ''}
          px-6 py-3.5 rounded-xl items-center justify-center overflow-hidden
        `}
        style={{
          transform: [
            { scale: scaleAnim },
            { translateX: glitchTranslateX },
          ],
          shadowColor: styles.glitchColor,
          shadowOpacity: variant !== 'ghost' ? 0.3 : 0,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 4 },
          elevation: variant !== 'ghost' ? 8 : 0,
        }}
      >
        {/* Main text */}
        <Text className={`${styles.text} text-base tracking-wide`}>
          {children}
        </Text>

        {/* Glitch overlay - cyan shifted */}
        <Animated.View
          className="absolute inset-0 items-center justify-center"
          style={{
            opacity: glitchOpacity,
            transform: [{ translateX: 2 }],
          }}
        >
          <Text
            className="text-base font-semibold tracking-wide"
            style={{ color: '#00ffe5' }}
          >
            {children}
          </Text>
        </Animated.View>

        {/* Glitch overlay - pink shifted */}
        <Animated.View
          className="absolute inset-0 items-center justify-center"
          style={{
            opacity: glitchOpacity,
            transform: [{ translateX: -2 }],
          }}
        >
          <Text
            className="text-base font-semibold tracking-wide"
            style={{ color: '#ff77a8' }}
          >
            {children}
          </Text>
        </Animated.View>

        {/* Scan line effect - uses translateY instead of top for native driver */}
        <Animated.View
          className="absolute left-0 right-0 h-[1px] bg-white/20"
          style={{
            opacity: glitchOpacity,
            transform: [{
              translateY: glitchAnim.interpolate({
                inputRange: [-1, 0, 1],
                outputRange: [-10, 0, 10],
              }),
            }],
          }}
        />
      </Animated.View>
    </TouchableOpacity>
  );
};

export default GlitchButton;

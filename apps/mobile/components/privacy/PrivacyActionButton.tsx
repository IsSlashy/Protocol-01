import React from 'react';
import { Pressable, Text, ActivityIndicator, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { useSharedValue, useAnimatedStyle, withSpring } from 'react-native-reanimated';
import { Colors, FontFamily } from '@/constants/theme';

interface PrivacyActionButtonProps {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  color: string;
  dimColor: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
}

function lightenColor(hex: string, amount: number): string {
  const clamp = (v: number) => Math.min(255, Math.max(0, v));
  const c = hex.replace('#', '');
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  const lr = clamp(r + Math.round((255 - r) * amount));
  const lg = clamp(g + Math.round((255 - g) * amount));
  const lb = clamp(b + Math.round((255 - b) * amount));
  return `#${lr.toString(16).padStart(2, '0')}${lg.toString(16).padStart(2, '0')}${lb.toString(16).padStart(2, '0')}`;
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export default function PrivacyActionButton({
  icon,
  label,
  color,
  dimColor,
  onPress,
  disabled = false,
  loading = false,
}: PrivacyActionButtonProps) {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = () => {
    if (!disabled && !loading) {
      scale.value = withSpring(0.9, { damping: 15, stiffness: 300 });
    }
  };

  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 15, stiffness: 300 });
  };

  const effectiveColor = disabled ? Colors.textTertiary : color;
  const brighterColor = disabled ? Colors.textTertiary : lightenColor(color, 0.35);

  return (
    <AnimatedPressable
      style={[
        styles.button,
        animatedStyle,
        disabled && styles.disabled,
      ]}
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={disabled || loading}
    >
      <View
        style={[
          styles.iconShadow,
          !disabled && {
            shadowColor: color,
            shadowOffset: { width: 0, height: 4 },
            shadowOpacity: 0.35,
            shadowRadius: 10,
            elevation: 8,
          },
        ]}
      >
        <LinearGradient
          colors={disabled ? [dimColor, dimColor] : [brighterColor, effectiveColor]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.iconCircle}
        >
          {loading ? (
            <ActivityIndicator size="small" color="#eae7df" />
          ) : (
            <Ionicons name={icon} size={22} color="#eae7df" />
          )}
        </LinearGradient>
      </View>

      <Text style={[styles.label, { color: effectiveColor }]} numberOfLines={1}>
        {loading ? 'Loading...' : label}
      </Text>
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 76,
    height: 80,
    borderRadius: 20,
    gap: 6,
  },
  iconShadow: {
    borderRadius: 22,
  },
  iconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontSize: 11,
    fontFamily: FontFamily.medium,
  },
  disabled: {
    opacity: 0.4,
  },
});

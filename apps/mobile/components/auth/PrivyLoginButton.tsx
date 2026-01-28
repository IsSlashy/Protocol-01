/**
 * P-01 Privy Login Button Component
 *
 * Custom styled authentication buttons with P-01 cyberpunk design.
 * Supports all Privy login methods: Email, SMS, Google, Apple, Twitter, Wallet
 */

import React from 'react';
import {
  TouchableOpacity,
  Text,
  View,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withSequence,
  interpolateColor,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';

// P-01 Colors
const P01 = {
  cyan: '#39c5bb',
  cyanDim: 'rgba(57, 197, 187, 0.15)',
  cyanBright: '#00ffe5',
  pink: '#ff2d7a',
  pinkDim: 'rgba(255, 45, 122, 0.15)',
  void: '#0a0a0c',
  surface: '#151518',
  border: '#2a2a30',
  textPrimary: '#ffffff',
  textSecondary: '#888892',
};

type LoginMethod = 'email' | 'sms' | 'google' | 'apple' | 'twitter' | 'wallet';

interface PrivyLoginButtonProps {
  method: LoginMethod;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'outline';
}

const methodConfig: Record<LoginMethod, {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  color: string;
}> = {
  email: { icon: 'mail', label: 'Continue with Email', color: P01.cyan },
  sms: { icon: 'phone-portrait', label: 'Continue with Phone', color: P01.cyan },
  google: { icon: 'logo-google', label: 'Continue with Google', color: '#4285F4' },
  apple: { icon: 'logo-apple', label: 'Continue with Apple', color: '#ffffff' },
  twitter: { icon: 'logo-twitter', label: 'Continue with X', color: '#1DA1F2' },
  wallet: { icon: 'wallet', label: 'Create New Wallet', color: P01.pink },
};

const AnimatedTouchable = Animated.createAnimatedComponent(TouchableOpacity);

export function PrivyLoginButton({
  method,
  onPress,
  loading = false,
  disabled = false,
  variant = 'secondary',
}: PrivyLoginButtonProps) {
  const config = methodConfig[method];
  const scale = useSharedValue(1);
  const glowOpacity = useSharedValue(0);

  const handlePressIn = () => {
    scale.value = withSpring(0.97, { damping: 15 });
    glowOpacity.value = withSpring(1);
  };

  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 15 });
    glowOpacity.value = withSpring(0);
  };

  const handlePress = async () => {
    if (disabled || loading) return;
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onPress();
  };

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const glowStyle = useAnimatedStyle(() => ({
    opacity: glowOpacity.value * 0.5,
  }));

  const isPrimary = variant === 'primary';
  const bgColor = isPrimary ? config.color : P01.surface;
  const borderColor = isPrimary ? config.color : P01.border;
  const textColor = isPrimary ? P01.void : P01.textPrimary;

  return (
    <AnimatedTouchable
      onPress={handlePress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={disabled || loading}
      activeOpacity={0.9}
      style={[
        styles.button,
        animatedStyle,
        {
          backgroundColor: bgColor,
          borderColor: borderColor,
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      {/* Glow effect */}
      <Animated.View
        style={[
          styles.glow,
          glowStyle,
          { backgroundColor: config.color },
        ]}
      />

      {/* Content */}
      <View style={styles.content}>
        {loading ? (
          <ActivityIndicator size="small" color={textColor} />
        ) : (
          <>
            <View
              style={[
                styles.iconContainer,
                { backgroundColor: `${config.color}20` },
              ]}
            >
              <Ionicons name={config.icon} size={20} color={config.color} />
            </View>
            <Text style={[styles.label, { color: textColor }]}>
              {config.label}
            </Text>
            <Ionicons
              name="chevron-forward"
              size={18}
              color={P01.textSecondary}
            />
          </>
        )}
      </View>
    </AnimatedTouchable>
  );
}

/**
 * Divider with "OR" text
 */
export function AuthDivider() {
  return (
    <View style={styles.divider}>
      <View style={styles.dividerLine} />
      <Text style={styles.dividerText}>OR</Text>
      <View style={styles.dividerLine} />
    </View>
  );
}

/**
 * Social login buttons grid
 */
interface SocialLoginGridProps {
  onGooglePress: () => void;
  onApplePress: () => void;
  onTwitterPress: () => void;
  loading?: LoginMethod | null;
}

export function SocialLoginGrid({
  onGooglePress,
  onApplePress,
  onTwitterPress,
  loading,
}: SocialLoginGridProps) {
  return (
    <View style={styles.socialGrid}>
      <SocialButton
        icon="logo-google"
        color="#4285F4"
        onPress={onGooglePress}
        loading={loading === 'google'}
      />
      <SocialButton
        icon="logo-apple"
        color="#ffffff"
        onPress={onApplePress}
        loading={loading === 'apple'}
      />
      <SocialButton
        icon="logo-twitter"
        color="#1DA1F2"
        onPress={onTwitterPress}
        loading={loading === 'twitter'}
      />
    </View>
  );
}

interface SocialButtonProps {
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  onPress: () => void;
  loading?: boolean;
}

function SocialButton({ icon, color, onPress, loading }: SocialButtonProps) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={loading}
      activeOpacity={0.8}
      style={styles.socialButton}
    >
      {loading ? (
        <ActivityIndicator size="small" color={color} />
      ) : (
        <Ionicons name={icon} size={24} color={color} />
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 12,
    overflow: 'hidden',
  },
  glow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: 12,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  iconContainer: {
    width: 36,
    height: 36,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  label: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 24,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: P01.border,
  },
  dividerText: {
    color: P01.textSecondary,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 2,
    marginHorizontal: 16,
  },
  socialGrid: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 16,
  },
  socialButton: {
    width: 56,
    height: 56,
    borderRadius: 12,
    backgroundColor: P01.surface,
    borderWidth: 1,
    borderColor: P01.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export default PrivyLoginButton;

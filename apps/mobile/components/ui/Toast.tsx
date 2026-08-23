/**
 * Toast — a short-lived message at the top of the screen.
 *
 * 🚨 THE TINTS WERE FRAMEWORK COLOURS. `bg-yellow-500/20`, `#ef4444`,
 * `#eab308`, `#3b82f6` — the theme sweep could not see any of them, so a
 * success toast was on-brand and the other three were not. All four types now
 * read `Colors.*`, which means one accent for success, amber for caution only,
 * and the desaturated red for failure.
 *
 * ⛔ No coloured fill behind the whole toast either. It is a panel with a
 * hairline rule and a coloured icon, like the rest of the system; the icon is
 * enough to tell four states apart without repainting the surface.
 *
 * ♿ It announces itself (`accessibilityRole="alert"`) instead of appearing
 * silently and vanishing after three seconds.
 */

import React, { useEffect, useRef } from 'react';
import { View, Text, Animated, TouchableOpacity, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { Colors, Spacing, FontFamily, FontSize, BorderRadius } from '@/constants/theme';

type ToastType = 'success' | 'error' | 'warning' | 'info';

interface ToastProps {
  visible: boolean;
  type?: ToastType;
  title: string;
  message?: string;
  duration?: number;
  onDismiss: () => void;
  action?: {
    label: string;
    onPress: () => void;
  };
}

const TOAST_ICON: Record<ToastType, { icon: keyof typeof Ionicons.glyphMap; color: string }> = {
  success: { icon: 'checkmark-circle', color: Colors.primary },
  error: { icon: 'close-circle', color: Colors.error },
  warning: { icon: 'warning', color: Colors.yellow },
  info: { icon: 'information-circle', color: Colors.textSecondary },
};

export const Toast: React.FC<ToastProps> = ({
  visible,
  type = 'info',
  title,
  message,
  duration = 3000,
  onDismiss,
  action,
}) => {
  const insets = useSafeAreaInsets();
  const translateY = useRef(new Animated.Value(-100)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  const tone = TOAST_ICON[type];

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.spring(translateY, {
          toValue: 0,
          damping: 15,
          stiffness: 200,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();

      if (duration > 0) {
        const timer = setTimeout(() => {
          dismissToast();
        }, duration);
        return () => clearTimeout(timer);
      }
    }
  }, [visible]);

  const dismissToast = () => {
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: -100,
        duration: 200,
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start(() => {
      onDismiss();
    });
  };

  if (!visible) return null;

  return (
    <Animated.View
      style={[
        styles.wrap,
        {
          top: insets.top + Spacing.sm,
          transform: [{ translateY }],
          opacity,
        },
      ]}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <View style={styles.panel}>
        <Ionicons name={tone.icon} size={20} color={tone.color} style={styles.icon} />

        <View style={styles.body}>
          <Text style={styles.title}>{title}</Text>
          {message ? <Text style={styles.message}>{message}</Text> : null}
          {action ? (
            <TouchableOpacity
              onPress={() => {
                action.onPress();
                dismissToast();
              }}
              style={styles.action}
              accessibilityRole="button"
              accessibilityLabel={action.label}
            >
              <Text style={styles.actionLabel}>{action.label}</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        <TouchableOpacity
          onPress={dismissToast}
          style={styles.close}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
        >
          <Ionicons name="close" size={18} color={Colors.textTertiary} />
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: Spacing.lg,
    right: Spacing.lg,
    zIndex: 50,
  },
  panel: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: Spacing.lg,
    borderRadius: BorderRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  icon: {
    marginRight: Spacing.md,
    marginTop: 1,
  },
  body: {
    flex: 1,
  },
  title: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.md,
    color: Colors.text,
  },
  message: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginTop: 2,
    lineHeight: 19,
  },
  action: {
    minHeight: 44,
    justifyContent: 'center',
  },
  actionLabel: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    color: Colors.primary,
  },
  close: {
    width: 44,
    height: 44,
    marginTop: -Spacing.md,
    marginRight: -Spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export default Toast;

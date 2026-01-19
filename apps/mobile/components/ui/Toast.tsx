import React, { useEffect, useRef } from 'react';
import { View, Text, Animated, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

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

const toastStyles: Record<
  ToastType,
  { bg: string; icon: keyof typeof Ionicons.glyphMap; iconColor: string }
> = {
  success: {
    bg: 'bg-p01-cyan/20',
    icon: 'checkmark-circle',
    iconColor: '#39c5bb',
  },
  error: {
    bg: 'bg-red-500/20',
    icon: 'close-circle',
    iconColor: '#ef4444',
  },
  warning: {
    bg: 'bg-yellow-500/20',
    icon: 'warning',
    iconColor: '#eab308',
  },
  info: {
    bg: 'bg-blue-500/20',
    icon: 'information-circle',
    iconColor: '#3b82f6',
  },
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

  const style = toastStyles[type];

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
      className="absolute left-4 right-4 z-50"
      style={{
        top: insets.top + 10,
        transform: [{ translateY }],
        opacity,
      }}
    >
      <View
        className={`
          ${style.bg}
          border border-p01-border
          rounded-xl
          p-4
          flex-row items-start
        `}
        style={{
          shadowColor: '#000',
          shadowOpacity: 0.3,
          shadowRadius: 10,
          shadowOffset: { width: 0, height: 4 },
          elevation: 8,
        }}
      >
        <Ionicons
          name={style.icon}
          size={24}
          color={style.iconColor}
          style={{ marginRight: 12 }}
        />

        <View className="flex-1">
          <Text className="text-white font-semibold text-base">{title}</Text>
          {message && (
            <Text className="text-p01-text-secondary text-sm mt-1">
              {message}
            </Text>
          )}
          {action && (
            <TouchableOpacity
              onPress={() => {
                action.onPress();
                dismissToast();
              }}
              className="mt-2"
            >
              <Text className="text-p01-cyan font-semibold text-sm">
                {action.label}
              </Text>
            </TouchableOpacity>
          )}
        </View>

        <TouchableOpacity
          onPress={dismissToast}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="close" size={20} color="#888892" />
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
};

export default Toast;

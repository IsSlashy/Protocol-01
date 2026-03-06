import React, { useCallback } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
} from 'react-native-reanimated';
import { Colors, FontSize, FontFamily } from '@/constants/theme';

interface QuickActionButtonProps {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  description?: string;
  onPress: () => void;
  variant?: 'default' | 'highlighted' | 'compact';
  disabled?: boolean;
  color?: string;
}

const AnimatedTouchable = Animated.createAnimatedComponent(TouchableOpacity);

export const QuickActionButton: React.FC<QuickActionButtonProps> = ({
  icon,
  label,
  description,
  onPress,
  variant = 'default',
  disabled = false,
  color = Colors.yellow,
}) => {
  const isCompact = variant === 'compact';
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = useCallback(() => {
    scale.value = withSpring(0.95, { damping: 15, stiffness: 300 });
  }, []);

  const handlePressOut = useCallback(() => {
    scale.value = withSpring(1, { damping: 10, stiffness: 200 });
  }, []);

  return (
    <AnimatedTouchable
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={disabled}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel={description ? `${label}, ${description}` : label}
      accessibilityState={{ disabled }}
      style={[
        animatedStyle,
        {
          flex: 1,
          minHeight: isCompact ? 56 : 90,
          opacity: disabled ? 0.5 : 1,
          borderRadius: 16,
          overflow: 'hidden',
          borderWidth: 1,
          borderColor: `${color}25`,
        },
      ]}
    >
      <BlurView
        intensity={15}
        tint="dark"
        style={{
          flex: 1,
          padding: isCompact ? 12 : 16,
          flexDirection: isCompact ? 'row' : 'column',
          alignItems: 'center',
          justifyContent: isCompact ? 'flex-start' : 'center',
          backgroundColor: 'rgba(21, 21, 24, 0.6)',
        }}
      >
        <View
          style={{
            width: isCompact ? 40 : 44,
            height: isCompact ? 40 : 44,
            borderRadius: isCompact ? 12 : 14,
            backgroundColor: `${color}18`,
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: isCompact ? 0 : 10,
            marginRight: isCompact ? 12 : 0,
          }}
        >
          <Ionicons name={icon} size={isCompact ? 20 : 22} color={color} />
        </View>

        <View style={{ alignItems: isCompact ? 'flex-start' : 'center' }}>
          <Text
            style={{
              color: Colors.text,
              fontSize: isCompact ? FontSize.md : FontSize.sm,
              fontFamily: FontFamily.semibold,
            }}
          >
            {label}
          </Text>
          {description && (
            <Text
              style={{
                color: Colors.textSecondary,
                fontSize: FontSize.xs,
                marginTop: 2,
              }}
              numberOfLines={1}
            >
              {description}
            </Text>
          )}
        </View>

        {isCompact && (
          <View style={{ marginLeft: 'auto' }}>
            <Ionicons name="chevron-forward" size={18} color={Colors.textTertiary} />
          </View>
        )}
      </BlurView>
    </AnimatedTouchable>
  );
};

export default QuickActionButton;

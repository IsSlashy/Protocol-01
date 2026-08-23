import React from 'react';
import { Text, Pressable, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  withSpring,
  useSharedValue,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';

import { Colors, Spacing, FontFamily, FontSize, BorderRadius } from '../../constants/theme';

interface WordChipProps {
  word: string;
  index?: number;
  selected?: boolean;
  disabled?: boolean;
  showIndex?: boolean;
  variant?: 'pool' | 'selected' | 'correct' | 'incorrect';
  onPress?: () => void;
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export const WordChip: React.FC<WordChipProps> = ({
  word,
  index,
  selected = false,
  disabled = false,
  showIndex = false,
  variant = 'pool',
  onPress,
}) => {
  const scale = useSharedValue(1);

  const handlePressIn = () => {
    scale.value = withSpring(0.95);
  };

  const handlePressOut = () => {
    scale.value = withSpring(1);
  };

  const handlePress = () => {
    if (!disabled && onPress) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      onPress();
    }
  };

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const getVariantStyles = () => {
    switch (variant) {
      case 'selected':
        return {
          bg: Colors.primaryDim,
          border: Colors.primary,
          text: Colors.primary,
        };
      case 'correct':
        return {
          bg: Colors.successDim,
          border: Colors.primary,
          text: Colors.primary,
        };
      case 'incorrect':
        return {
          bg: Colors.errorDim,
          border: Colors.error,
          text: Colors.error,
        };
      default:
        return {
          bg: selected ? Colors.surfaceTertiary : Colors.surface,
          border: Colors.border,
          text: selected ? Colors.textTertiary : Colors.text,
        };
    }
  };

  const styles = getVariantStyles();

  return (
    <AnimatedPressable
      style={[
        animatedStyle,
        {
          // 44pt is the floor for anything you can tap. These chips were 40.
          minHeight: 44,
          justifyContent: 'center',
          paddingHorizontal: Spacing.lg,
          paddingVertical: Spacing.md,
          borderRadius: BorderRadius.md,
          borderWidth: 1,
          margin: Spacing.xs,
          backgroundColor: styles.bg,
          borderColor: styles.border,
          opacity: disabled || selected ? 0.5 : 1,
        },
      ]}
      onPress={handlePress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={disabled || selected}
      accessibilityRole="button"
      accessibilityLabel={word}
      accessibilityState={{ disabled: disabled || selected, selected }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        {showIndex && index !== undefined && (
          <Text
            style={{
              color: Colors.textTertiary,
              fontFamily: FontFamily.mono,
              fontSize: FontSize.xs,
              marginRight: Spacing.sm,
            }}
          >
            {index + 1}
          </Text>
        )}
        <Text style={{ fontFamily: FontFamily.mono, color: styles.text, fontSize: FontSize.sm }}>
          {word}
        </Text>
      </View>
    </AnimatedPressable>
  );
};

export default WordChip;

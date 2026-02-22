import React from 'react';
import { Text, Pressable, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  withSpring,
  useSharedValue,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';

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
          bg: 'rgba(57, 197, 187, 0.2)',
          border: '#39c5bb',
          text: '#39c5bb',
        };
      case 'correct':
        return {
          bg: 'rgba(57, 197, 187, 0.3)',
          border: '#39c5bb',
          text: '#39c5bb',
        };
      case 'incorrect':
        return {
          bg: 'rgba(239, 68, 68, 0.2)',
          border: '#ef4444',
          text: '#ef4444',
        };
      default:
        return {
          bg: selected ? '#2a2a30' : '#151518',
          border: '#2a2a30',
          text: selected ? '#555560' : '#ffffff',
        };
    }
  };

  const styles = getVariantStyles();

  return (
    <AnimatedPressable
      style={[
        animatedStyle,
        {
          paddingHorizontal: 16,
          paddingVertical: 10,
          borderRadius: 12,
          borderWidth: 1,
          margin: 4,
          backgroundColor: styles.bg,
          borderColor: styles.border,
          opacity: disabled || selected ? 0.5 : 1,
        },
      ]}
      onPress={handlePress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={disabled || selected}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        {showIndex && index !== undefined && (
          <Text style={{ color: '#39c5bb', fontSize: 11, marginRight: 8 }}>
            {index + 1}.
          </Text>
        )}
        <Text style={{ fontWeight: '500', color: styles.text, fontSize: 14 }}>
          {word}
        </Text>
      </View>
    </AnimatedPressable>
  );
};

export default WordChip;

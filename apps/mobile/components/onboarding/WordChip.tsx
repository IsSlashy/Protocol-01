import React from 'react';
import { Text, Pressable, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  withSpring,
  useSharedValue,
  withTiming,
  runOnJS,
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
          container: 'bg-[#39c5bb]/20 border-[#39c5bb]',
          text: 'text-[#39c5bb]',
        };
      case 'correct':
        return {
          container: 'bg-[#39c5bb]/30 border-[#39c5bb]',
          text: 'text-[#39c5bb]',
        };
      case 'incorrect':
        return {
          container: 'bg-red-500/20 border-red-500',
          text: 'text-red-500',
        };
      default:
        return {
          container: selected
            ? 'bg-[#2a2a30] border-[#2a2a30] opacity-50'
            : 'bg-[#151518] border-[#2a2a30]',
          text: selected ? 'text-[#555560]' : 'text-white',
        };
    }
  };

  const styles = getVariantStyles();

  return (
    <AnimatedPressable
      style={animatedStyle}
      onPress={handlePress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={disabled || selected}
      className={`
        px-4 py-2.5 rounded-xl border m-1
        ${styles.container}
        ${disabled ? 'opacity-50' : ''}
      `}
    >
      <View className="flex-row items-center">
        {showIndex && index !== undefined && (
          <Text className="text-[#39c5bb] text-xs mr-2">{index + 1}.</Text>
        )}
        <Text className={`font-medium ${styles.text}`}>{word}</Text>
      </View>
    </AnimatedPressable>
  );
};

export default WordChip;

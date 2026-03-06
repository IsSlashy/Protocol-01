import React, { useCallback } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  FadeIn,
  useSharedValue,
  useAnimatedStyle,
  withSpring,
} from 'react-native-reanimated';
import { Colors, FontSize, FontFamily } from '@/constants/theme';

interface SuggestionChipProps {
  label: string;
  onPress: () => void;
  icon?: keyof typeof Ionicons.glyphMap;
  index?: number;
}

const AnimatedTouchable = Animated.createAnimatedComponent(TouchableOpacity);

export const SuggestionChip: React.FC<SuggestionChipProps> = ({
  label,
  onPress,
  icon,
  index = 0,
}) => {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = useCallback(() => {
    scale.value = withSpring(0.93, { damping: 15, stiffness: 300 });
  }, []);

  const handlePressOut = useCallback(() => {
    scale.value = withSpring(1, { damping: 10, stiffness: 200 });
  }, []);

  return (
    <Animated.View entering={FadeIn.delay(index * 80).duration(300)}>
      <AnimatedTouchable
        onPress={onPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint="Send this suggestion to the agent"
        style={[
          animatedStyle,
          {
            flexDirection: 'row',
            alignItems: 'center',
            borderRadius: 999,
            paddingHorizontal: 14,
            paddingVertical: 9,
            marginRight: 8,
            backgroundColor: 'rgba(57, 197, 187, 0.08)',
            borderWidth: 1,
            borderColor: 'rgba(57, 197, 187, 0.2)',
          },
        ]}
      >
        {icon && (
          <View style={{ marginRight: 6 }}>
            <Ionicons name={icon} size={14} color={Colors.primary} />
          </View>
        )}
        <Text
          style={{
            color: Colors.primary,
            fontSize: FontSize.sm,
            fontFamily: FontFamily.medium,
          }}
        >
          {label}
        </Text>
      </AnimatedTouchable>
    </Animated.View>
  );
};

export default SuggestionChip;

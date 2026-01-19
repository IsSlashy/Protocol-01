import React, { useEffect } from 'react';
import { View, Text, Dimensions } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withDelay,
  Easing,
  FadeIn,
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

interface FeatureSlideProps {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  description: string;
  color: string;
  isActive: boolean;
}

export const FeatureSlide: React.FC<FeatureSlideProps> = ({
  icon,
  title,
  description,
  color,
  isActive,
}) => {
  const iconScale = useSharedValue(0);
  const titleOpacity = useSharedValue(0);
  const descOpacity = useSharedValue(0);

  useEffect(() => {
    if (isActive) {
      iconScale.value = withTiming(1, { duration: 500, easing: Easing.out(Easing.back) });
      titleOpacity.value = withDelay(200, withTiming(1, { duration: 400 }));
      descOpacity.value = withDelay(400, withTiming(1, { duration: 400 }));
    } else {
      iconScale.value = 0;
      titleOpacity.value = 0;
      descOpacity.value = 0;
    }
  }, [isActive]);

  const iconStyle = useAnimatedStyle(() => ({
    transform: [{ scale: iconScale.value }],
  }));

  const titleStyle = useAnimatedStyle(() => ({
    opacity: titleOpacity.value,
    transform: [{ translateY: (1 - titleOpacity.value) * 20 }],
  }));

  const descStyle = useAnimatedStyle(() => ({
    opacity: descOpacity.value,
    transform: [{ translateY: (1 - descOpacity.value) * 20 }],
  }));

  return (
    <View
      className="flex-1 items-center justify-center px-8"
      style={{ width: SCREEN_WIDTH }}
    >
      {/* Icon container with glow */}
      <Animated.View
        style={[
          iconStyle,
          {
            shadowColor: color,
            shadowOpacity: 0.5,
            shadowRadius: 30,
            shadowOffset: { width: 0, height: 0 },
            elevation: 10,
          },
        ]}
        className="mb-12"
      >
        <View
          className="w-32 h-32 rounded-full items-center justify-center"
          style={{
            backgroundColor: `${color}15`,
            borderWidth: 2,
            borderColor: `${color}40`,
          }}
        >
          <Ionicons name={icon} size={56} color={color} />
        </View>
      </Animated.View>

      {/* Title */}
      <Animated.Text
        style={[
          titleStyle,
          {
            textShadowColor: color,
            textShadowOffset: { width: 0, height: 0 },
            textShadowRadius: 15,
          },
        ]}
        className="text-3xl font-bold text-white text-center mb-4"
      >
        {title}
      </Animated.Text>

      {/* Description */}
      <Animated.Text
        style={descStyle}
        className="text-lg text-[#888892] text-center leading-7 px-4"
      >
        {description}
      </Animated.Text>
    </View>
  );
};

export default FeatureSlide;

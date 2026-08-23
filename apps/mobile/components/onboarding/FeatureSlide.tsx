/**
 * FeatureSlide — one page of the onboarding carousel.
 *
 * 🚨 IT WAS STYLED IN CLASSES THAT DO NOT RESOLVE. `text-white` on the title
 * (the brand's text is warm paper, never white) and, on the description,
 * `text-[rgba(234, 231, 223, 0.62)]` — an arbitrary Tailwind value containing
 * SPACES, which the class parser cannot read, so that line has been rendering
 * in the platform default colour rather than the muted grey somebody intended.
 * A class that silently does nothing is worse than a wrong colour: nothing
 * about the source says it is broken. Both are `StyleSheet` + tokens now.
 *
 * ⛔ The 30pt coloured drop-shadow behind the icon and the 15pt `textShadow`
 * glow on the title are gone with the rest of the neon. The icon still takes
 * the caller's `color`, tinted into its own disc, which is the whole of what
 * the glow was trying to say.
 */

import React, { useEffect } from 'react';
import { View, StyleSheet, Dimensions } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withDelay,
  Easing,
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';

import { Colors, Spacing, FontFamily, FontSize } from '../../constants/theme';

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
      iconScale.value = withTiming(1, { duration: 500, easing: Easing.out(Easing.back as any) });
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
    <View style={[styles.slide, { width: SCREEN_WIDTH }]}>
      <Animated.View style={[iconStyle as any, styles.iconWrap]}>
        <View style={[styles.iconDisc, { borderColor: color }]}>
          <Ionicons name={icon} size={52} color={color} />
        </View>
      </Animated.View>

      <Animated.Text style={[titleStyle as any, styles.title]} accessibilityRole="header">
        {title}
      </Animated.Text>

      <Animated.Text style={[descStyle as any, styles.description]}>
        {description}
      </Animated.Text>
    </View>
  );
};

const styles = StyleSheet.create({
  slide: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing['3xl'],
  },
  iconWrap: {
    marginBottom: Spacing['5xl'],
  },
  iconDisc: {
    width: 120,
    height: 120,
    borderRadius: 60,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surface,
    borderWidth: 1,
  },
  title: {
    color: Colors.text,
    fontFamily: FontFamily.display,
    fontSize: FontSize['3xl'],
    textAlign: 'center',
    marginBottom: Spacing.lg,
  },
  description: {
    color: Colors.textSecondary,
    fontFamily: FontFamily.regular,
    fontSize: FontSize.lg,
    lineHeight: 28,
    textAlign: 'center',
    paddingHorizontal: Spacing.lg,
  },
});

export default FeatureSlide;

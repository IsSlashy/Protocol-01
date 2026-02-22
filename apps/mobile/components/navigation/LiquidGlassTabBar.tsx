import React, { useEffect } from 'react';
import {
  View,
  TouchableOpacity,
  StyleSheet,
  Platform,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
} from 'react-native-reanimated';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { Colors, FontFamily } from '../../constants/theme';

const TAB_BAR_HEIGHT = 64;
const HORIZONTAL_MARGIN = 16;
const BOTTOM_MARGIN = 16;
const PILL_VERTICAL_PADDING = 6;
const PILL_HEIGHT = TAB_BAR_HEIGHT - PILL_VERTICAL_PADDING * 2;
const PILL_HORIZONTAL_INSET = 8;
const BORDER_RADIUS = 24;
const PILL_BORDER_RADIUS = 18;

const SPRING_CONFIG = {
  damping: 20,
  stiffness: 180,
  mass: 0.8,
};

export function LiquidGlassTabBar({
  state,
  descriptors,
  navigation,
}: BottomTabBarProps) {
  const insets = useSafeAreaInsets();

  // Filter out routes with href: null
  const visibleRoutes = state.routes.filter((route) => {
    const options = descriptors[route.key].options;
    return (options as any).href !== null;
  });

  // Find active index within visible routes
  const activeRoute = state.routes[state.index];
  const activeVisibleIndex = visibleRoutes.findIndex(
    (r) => r.key === activeRoute.key
  );

  const pillPosition = useSharedValue(0);
  const pillWidth = useSharedValue(0);

  // Update pill position when active tab changes
  useEffect(() => {
    if (activeVisibleIndex < 0) return;
    // We need to compute position based on equal division
    // The pill position is calculated once we know the container width
    // For now we store the index and compute in animated style
    pillPosition.value = withSpring(activeVisibleIndex, SPRING_CONFIG);
  }, [activeVisibleIndex]);

  const [containerWidth, setContainerWidth] = React.useState(0);
  const tabCount = visibleRoutes.length;
  const tabWidth = containerWidth > 0 ? containerWidth / tabCount : 0;
  const computedPillWidth = tabWidth > 0 ? tabWidth - PILL_HORIZONTAL_INSET * 2 : 0;

  // Update shared value for pill width
  useEffect(() => {
    pillWidth.value = computedPillWidth;
  }, [computedPillWidth]);

  const pillAnimatedStyle = useAnimatedStyle(() => {
    const pw = pillWidth.value;
    const tw = pw + PILL_HORIZONTAL_INSET * 2;
    return {
      transform: [
        {
          translateX:
            pillPosition.value * tw + PILL_HORIZONTAL_INSET,
        },
      ],
      width: pw,
    };
  });

  return (
    <View
      style={[
        styles.outerContainer,
        { bottom: BOTTOM_MARGIN + insets.bottom },
      ]}
    >
      <View
        style={styles.glassContainer}
        onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}
      >
        {/* Glass background */}
        <BlurView
          intensity={25}
          tint="dark"
          style={StyleSheet.absoluteFill}
        />
        {/* Dark overlay for depth */}
        <View style={[StyleSheet.absoluteFill, styles.overlay]} />

        {/* Animated indicator pill */}
        {containerWidth > 0 && (
          <Animated.View
            style={[styles.pill, pillAnimatedStyle]}
          >
            <BlurView
              intensity={10}
              tint="dark"
              style={StyleSheet.absoluteFill}
            />
            <View
              style={[StyleSheet.absoluteFill, styles.pillOverlay]}
            />
          </Animated.View>
        )}

        {/* Tab buttons */}
        {visibleRoutes.map((route, index) => {
          const { options } = descriptors[route.key];
          const isFocused = activeVisibleIndex === index;
          const color = isFocused ? Colors.primary : Colors.textTertiary;
          const label =
            (options.tabBarLabel as string) ??
            options.title ??
            route.name;

          const onPress = () => {
            if (Platform.OS !== 'web') {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            }

            const event = navigation.emit({
              type: 'tabPress',
              target: route.key,
              canPreventDefault: true,
            });

            if (!isFocused && !event.defaultPrevented) {
              navigation.navigate(route.name, route.params);
            }
          };

          const onLongPress = () => {
            navigation.emit({
              type: 'tabLongPress',
              target: route.key,
            });
          };

          // Render icon from options
          const renderIcon = () => {
            if (options.tabBarIcon) {
              return options.tabBarIcon({
                focused: isFocused,
                color,
                size: 24,
              });
            }
            return (
              <Ionicons name="ellipse-outline" size={24} color={color} />
            );
          };

          return (
            <TouchableOpacity
              key={route.key}
              accessibilityRole="button"
              accessibilityState={isFocused ? { selected: true } : {}}
              accessibilityLabel={options.tabBarAccessibilityLabel}
              onPress={onPress}
              onLongPress={onLongPress}
              style={styles.tab}
              activeOpacity={0.7}
            >
              {renderIcon()}
              <Animated.Text
                style={[
                  styles.label,
                  { color },
                ]}
                numberOfLines={1}
              >
                {label}
              </Animated.Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  outerContainer: {
    position: 'absolute',
    left: HORIZONTAL_MARGIN,
    right: HORIZONTAL_MARGIN,
  },
  glassContainer: {
    height: TAB_BAR_HEIGHT,
    borderRadius: BORDER_RADIUS,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.12)',
    flexDirection: 'row',
    alignItems: 'center',
  },
  overlay: {
    backgroundColor: 'rgba(10, 10, 12, 0.65)',
  },
  pill: {
    position: 'absolute',
    top: PILL_VERTICAL_PADDING,
    height: PILL_HEIGHT,
    borderRadius: PILL_BORDER_RADIUS,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.2)',
  },
  pillOverlay: {
    backgroundColor: 'rgba(57, 197, 187, 0.08)',
    borderRadius: PILL_BORDER_RADIUS,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
    height: TAB_BAR_HEIGHT,
    gap: 3,
  },
  label: {
    fontFamily: FontFamily.medium,
    fontSize: 11,
  },
});

import React, { useCallback, useEffect } from 'react';
import {
  View,
  StyleSheet,
  Platform,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  interpolate,
  Extrapolation,
  runOnJS,
  SharedValue,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { Colors, FontFamily } from '../../constants/theme';

// Conditional native glass (safe for Android/web)
let GlassView: any = null;
let GlassContainer: any = null;
let isNativeLiquidGlass = false;
try {
  const glassEffect = require('expo-glass-effect');
  GlassView = glassEffect.GlassView;
  GlassContainer = glassEffect.GlassContainer;
  isNativeLiquidGlass =
    glassEffect.isLiquidGlassAvailable?.() &&
    glassEffect.isGlassEffectAPIAvailable?.();
} catch {}

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

const SNAP_SPRING = {
  damping: 22,
  stiffness: 220,
  mass: 0.6,
};

// ─── Animated Tab Button ───
// Separate component so each tab has its own useAnimatedStyle hook
function AnimatedTab({
  route,
  options,
  isFocused,
  hoverIndex,
  isDragging,
  tabIndex,
}: {
  route: any;
  options: any;
  isFocused: boolean;
  hoverIndex: SharedValue<number>;
  isDragging: SharedValue<number>;
  tabIndex: number;
}) {
  const color = isFocused ? Colors.primary : Colors.textTertiary;
  const label =
    (options.tabBarLabel as string) ??
    options.title ??
    route.name;

  const renderIcon = () => {
    if (options.tabBarIcon) {
      return options.tabBarIcon({ focused: isFocused, color, size: 24 });
    }
    return <Ionicons name="ellipse-outline" size={24} color={color} />;
  };

  // Scale up when finger hovers over this tab during drag
  const scaleStyle = useAnimatedStyle(() => {
    if (isDragging.value === 0) {
      return { transform: [{ scale: withTiming(1, { duration: 200 }) }] };
    }
    const distance = Math.abs(hoverIndex.value - tabIndex);
    const scale = interpolate(
      distance,
      [0, 0.4, 1.2],
      [1.2, 1.08, 1],
      Extrapolation.CLAMP
    );
    return { transform: [{ scale }] };
  });

  return (
    <Animated.View style={[styles.tab, scaleStyle as any]}>
      {renderIcon()}
      <Animated.Text
        style={[styles.label, { color }]}
        numberOfLines={1}
      >
        {label}
      </Animated.Text>
    </Animated.View>
  );
}

// ─── Main Component ───
export function LiquidGlassTabBar({
  state,
  descriptors,
  navigation,
}: BottomTabBarProps) {
  const insets = useSafeAreaInsets();

  // Filter out hidden routes (settings is accessed via header gear icon)
  const visibleRoutes = state.routes.filter((route) => {
    const options = descriptors[route.key].options;
    if ((options as any).href === null) return false;
    if (route.name === '(settings)') return false;
    return true;
  });

  // Find active index within visible routes
  const activeRoute = state.routes[state.index];
  const activeVisibleIndex = visibleRoutes.findIndex(
    (r) => r.key === activeRoute.key
  );

  const pillPosition = useSharedValue(activeVisibleIndex >= 0 ? activeVisibleIndex : 0);
  const pillWidth = useSharedValue(0);
  const isDragging = useSharedValue(0); // 0 = not dragging, 1 = dragging
  const hoverIndex = useSharedValue(activeVisibleIndex >= 0 ? activeVisibleIndex : 0);
  const pillScale = useSharedValue(1);
  const lastHapticIndex = useSharedValue(-1);

  const [containerWidth, setContainerWidth] = React.useState(0);
  const tabCount = visibleRoutes.length;
  const tabWidth = containerWidth > 0 ? containerWidth / tabCount : 0;
  const computedPillWidth = tabWidth > 0 ? tabWidth - PILL_HORIZONTAL_INSET * 2 : 0;

  // Sync pill to active tab on navigation
  useEffect(() => {
    if (activeVisibleIndex < 0) return;
    pillPosition.value = withSpring(activeVisibleIndex, SPRING_CONFIG);
    hoverIndex.value = activeVisibleIndex;
  }, [activeVisibleIndex]);

  useEffect(() => {
    pillWidth.value = computedPillWidth;
  }, [computedPillWidth]);

  // ─── Gesture callbacks (must be stable refs for runOnJS) ───

  const triggerHaptic = useCallback(() => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  }, []);

  const triggerMediumHaptic = useCallback(() => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
  }, []);

  const navigateToTab = useCallback((index: number) => {
    const route = visibleRoutes[index];
    if (!route) return;
    const isFocused = activeVisibleIndex === index;
    if (!isFocused) {
      navigation.navigate(route.name, route.params);
    }
  }, [visibleRoutes, activeVisibleIndex, navigation]);

  // ─── Worklet: get tab index from X position ───
  const twShared = useSharedValue(tabWidth);
  const tcShared = useSharedValue(tabCount);
  useEffect(() => {
    twShared.value = tabWidth;
    tcShared.value = tabCount;
  }, [tabWidth, tabCount]);

  // ─── Pan gesture — drag/scrub across tabs ───
  const panGesture = Gesture.Pan()
    .activeOffsetX([-10, 10])
    .failOffsetY([-20, 20])
    .onStart((e) => {
      'worklet';
      if (twShared.value <= 0) return;
      isDragging.value = 1;
      pillScale.value = withSpring(1.08, SNAP_SPRING);
      const idx = Math.max(0, Math.min(tcShared.value - 1, e.x / twShared.value));
      hoverIndex.value = idx;
      pillPosition.value = idx;
      lastHapticIndex.value = Math.floor(idx);
      runOnJS(triggerMediumHaptic)();
    })
    .onUpdate((e) => {
      'worklet';
      if (twShared.value <= 0) return;
      const idx = Math.max(0, Math.min(tcShared.value - 1, e.x / twShared.value));
      hoverIndex.value = idx;
      // Smooth follow — slight spring for liquid feel
      pillPosition.value = idx;
      // Haptic tick when crossing tab boundaries
      const rounded = Math.round(idx);
      if (rounded !== lastHapticIndex.value) {
        lastHapticIndex.value = rounded;
        runOnJS(triggerHaptic)();
      }
    })
    .onEnd((e) => {
      'worklet';
      if (twShared.value <= 0) return;
      const rawIdx = Math.max(0, Math.min(tcShared.value - 1, e.x / twShared.value));
      const snapped = Math.max(0, Math.min(tcShared.value - 1, Math.floor(rawIdx)));
      isDragging.value = 0;
      hoverIndex.value = snapped;
      pillPosition.value = withSpring(snapped, SNAP_SPRING);
      pillScale.value = withSpring(1, SNAP_SPRING);
      runOnJS(navigateToTab)(snapped);
      runOnJS(triggerMediumHaptic)();
    })
    .onFinalize(() => {
      'worklet';
      isDragging.value = 0;
      pillScale.value = withSpring(1, SNAP_SPRING);
    });

  // ─── Tap gesture — quick tap on a tab ───
  const tapGesture = Gesture.Tap()
    .onEnd((e) => {
      'worklet';
      if (twShared.value <= 0) return;
      const tapped = Math.max(0, Math.min(tcShared.value - 1,
        Math.floor(e.x / twShared.value)
      ));
      pillPosition.value = withSpring(tapped, SPRING_CONFIG);
      hoverIndex.value = tapped;
      runOnJS(triggerHaptic)();
      runOnJS(navigateToTab)(tapped);
    });

  // Pan takes priority over tap (tap only fires if no horizontal movement)
  const composedGesture = Gesture.Exclusive(panGesture, tapGesture);

  // ─── Animated styles ───

  const pillAnimatedStyle = useAnimatedStyle(() => {
    const pw = pillWidth.value;
    const tw = pw + PILL_HORIZONTAL_INSET * 2;
    return {
      transform: [
        { translateX: pillPosition.value * tw + PILL_HORIZONTAL_INSET },
        { scaleX: pillScale.value },
        { scaleY: pillScale.value },
      ],
      width: pw,
    } as any;
  });

  // Pill glow intensifies during drag
  const pillGlowStyle = useAnimatedStyle(() => {
    const glowOpacity = interpolate(
      isDragging.value,
      [0, 1],
      [0.15, 0.35],
      Extrapolation.CLAMP
    );
    return {
      shadowOpacity: glowOpacity,
    };
  });

  // ─── Tab renderer ───
  const renderTabs = () =>
    visibleRoutes.map((route, index) => {
      const { options } = descriptors[route.key];
      const isFocused = activeVisibleIndex === index;

      return (
        <AnimatedTab
          key={route.key}
          route={route}
          options={options}
          isFocused={isFocused}
          hoverIndex={hoverIndex}
          isDragging={isDragging}
          tabIndex={index}
        />
      );
    });

  // ─── Native Liquid Glass path (iOS 26+) ───
  if (isNativeLiquidGlass && GlassContainer && GlassView) {
    return (
      <View
        style={[
          styles.outerContainer,
          { bottom: BOTTOM_MARGIN + insets.bottom },
        ]}
      >
        <GlassContainer spacing={4}>
          <GestureDetector gesture={composedGesture}>
            <Animated.View
              style={styles.nativeGlassBarOuter}
              onLayout={(e: any) => setContainerWidth(e.nativeEvent.layout.width)}
            >
              <GlassView
                glassEffectStyle="regular"
                tintColor="rgba(57, 197, 187, 0.06)"
                style={styles.nativeGlassBar}
              >
                {/* Native glass pill indicator */}
                {containerWidth > 0 && (
                  <Animated.View style={[styles.nativePillWrapper, pillAnimatedStyle as any]}>
                    <GlassView
                      glassEffectStyle="clear"
                      tintColor="rgba(57, 197, 187, 0.15)"
                      isInteractive
                      style={styles.nativePill}
                    />
                  </Animated.View>
                )}

                {/* Tab buttons */}
                {renderTabs()}
              </GlassView>
            </Animated.View>
          </GestureDetector>
        </GlassContainer>
      </View>
    );
  }

  // ─── Enhanced BlurView fallback (Android + older iOS) ───
  return (
    <View
      style={[
        styles.outerContainer,
        styles.outerShadow,
        { bottom: BOTTOM_MARGIN + insets.bottom },
      ]}
    >
      <GestureDetector gesture={composedGesture}>
        <Animated.View
          style={styles.glassContainer}
          onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}
        >
          {/* Layer 1: Background — blur on iOS, solid on Android */}
          {Platform.OS === 'ios' ? (
            <BlurView
              intensity={40}
              tint="dark"
              style={StyleSheet.absoluteFill}
            />
          ) : (
            <View style={[StyleSheet.absoluteFill, styles.androidBg]} />
          )}

          {/* Layer 2: Semi-transparent overlay (iOS only, Android bg already dark) */}
          {Platform.OS === 'ios' && (
            <View style={[StyleSheet.absoluteFill, styles.overlay]} />
          )}

          {/* Layer 3: Top edge specular highlight */}
          <LinearGradient
            colors={['rgba(255, 255, 255, 0.08)', 'transparent']}
            style={styles.topHighlight}
            pointerEvents="none"
          />

          {/* Layer 4: Bottom inner shadow for depth */}
          <LinearGradient
            colors={['transparent', 'rgba(0, 0, 0, 0.15)']}
            style={styles.bottomShadow}
            pointerEvents="none"
          />

          {/* Animated indicator pill */}
          {containerWidth > 0 && (
            <Animated.View
              style={[
                styles.pill,
                Platform.OS === 'ios' && styles.pillShadow,
                pillAnimatedStyle as any,
                Platform.OS === 'ios' && (pillGlowStyle as any),
              ]}
            >
              <View
                style={[StyleSheet.absoluteFill, styles.pillOverlay]}
              />
              {/* Pill top highlight */}
              <LinearGradient
                colors={['rgba(57, 197, 187, 0.12)', 'transparent']}
                style={styles.pillHighlight}
                pointerEvents="none"
              />
            </Animated.View>
          )}

          {/* Tab buttons */}
          {renderTabs()}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  outerContainer: {
    position: 'absolute',
    left: HORIZONTAL_MARGIN,
    right: HORIZONTAL_MARGIN,
  },
  outerShadow: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 24,
    elevation: 12,
  },
  glassContainer: {
    height: TAB_BAR_HEIGHT,
    borderRadius: BORDER_RADIUS,
    overflow: 'hidden',
    borderWidth: 0.5,
    borderColor: 'rgba(57, 197, 187, 0.18)',
    flexDirection: 'row',
    alignItems: 'center',
  },
  overlay: {
    backgroundColor: 'rgba(10, 10, 12, 0.35)',
  },
  androidBg: {
    backgroundColor: 'rgba(10, 10, 12, 0.92)',
  },
  topHighlight: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 1.5,
  },
  bottomShadow: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 12,
  },
  pill: {
    position: 'absolute',
    top: PILL_VERTICAL_PADDING,
    height: PILL_HEIGHT,
    borderRadius: PILL_BORDER_RADIUS,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.25)',
  },
  pillShadow: {
    shadowColor: 'rgba(57, 197, 187, 1)',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 4,
  },
  pillOverlay: {
    backgroundColor: 'rgba(57, 197, 187, 0.12)',
    borderRadius: PILL_BORDER_RADIUS,
  },
  pillHighlight: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 8,
    borderTopLeftRadius: PILL_BORDER_RADIUS,
    borderTopRightRadius: PILL_BORDER_RADIUS,
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
  // Native Liquid Glass styles
  nativeGlassBarOuter: {
    height: TAB_BAR_HEIGHT,
    borderRadius: BORDER_RADIUS,
  },
  nativeGlassBar: {
    flex: 1,
    borderRadius: BORDER_RADIUS,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 0.5,
    borderColor: 'rgba(57, 197, 187, 0.08)',
  },
  nativePillWrapper: {
    position: 'absolute',
    top: PILL_VERTICAL_PADDING,
    height: PILL_HEIGHT,
    borderRadius: PILL_BORDER_RADIUS,
    overflow: 'hidden',
  },
  nativePill: {
    flex: 1,
    borderRadius: PILL_BORDER_RADIUS,
  },
});

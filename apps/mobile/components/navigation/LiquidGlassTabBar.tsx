import React, { useCallback, useEffect } from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import Animated, {
  useSharedValue, useAnimatedStyle, withSpring,
  runOnJS,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { Colors, FontFamily } from '../../constants/theme';

// Native glass (iOS 26+)
let GlassView: any = null;
let GlassContainer: any = null;
let isNativeLiquidGlass = false;
try {
  const g = require('expo-glass-effect');
  GlassView = g.GlassView;
  GlassContainer = g.GlassContainer;
  isNativeLiquidGlass = g.isLiquidGlassAvailable?.() && g.isGlassEffectAPIAvailable?.();
} catch {}

const BAR_H = 62;
const MARGIN_H = 20;
const MARGIN_B = 16;
const PILL_PAD = 5;
const PILL_H = BAR_H - PILL_PAD * 2;
const PILL_INSET = 6;
const BAR_RADIUS = 22;
const PILL_RADIUS = 17;

const SPRING = { damping: 22, stiffness: 200, mass: 0.7 };
const SNAP = { damping: 24, stiffness: 240, mass: 0.5 };

// ─── Tab ─────────────────────────────────────────────────────────────────────

function AnimatedTab({
  route, options, isFocused,
}: {
  route: any; options: any; isFocused: boolean;
}) {
  const color = isFocused ? Colors.primary : Colors.textTertiary;
  const label = (options.tabBarLabel as string) ?? options.title ?? route.name;

  return (
    <View style={st.tab}>
      {options.tabBarIcon
        ? options.tabBarIcon({ focused: isFocused, color, size: 22 })
        : <Ionicons name="ellipse-outline" size={22} color={color} />}
      <Animated.Text style={[st.label, { color }]} numberOfLines={1}>
        {label}
      </Animated.Text>
    </View>
  );
}

// ─── Tab Bar ─────────────────────────────────────────────────────────────────

export function LiquidGlassTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();

  const visibleRoutes = state.routes.filter(r => {
    const opts = descriptors[r.key].options;
    if ((opts as any).href === null) return false;
    if (r.name === '(settings)') return false;
    return true;
  });

  const activeRoute = state.routes[state.index];
  const activeIdx = visibleRoutes.findIndex(r => r.key === activeRoute.key);

  const pillPos = useSharedValue(activeIdx >= 0 ? activeIdx : 0);
  const pillW = useSharedValue(0);
  const lastHaptic = useSharedValue(-1);

  const [cWidth, setCWidth] = React.useState(0);
  const tabCount = visibleRoutes.length;
  const tabW = cWidth > 0 ? cWidth / tabCount : 0;
  const computedPillW = tabW > 0 ? tabW - PILL_INSET * 2 : 0;

  useEffect(() => {
    if (activeIdx < 0) return;
    pillPos.value = withSpring(activeIdx, SPRING);
  }, [activeIdx]);

  useEffect(() => { pillW.value = computedPillW; }, [computedPillW]);

  const twS = useSharedValue(tabW);
  const tcS = useSharedValue(tabCount);
  useEffect(() => { twS.value = tabW; tcS.value = tabCount; }, [tabW, tabCount]);

  const hapticLight = useCallback(() => {
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, []);
  const hapticMed = useCallback(() => {
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  }, []);
  const navTo = useCallback((i: number) => {
    const r = visibleRoutes[i];
    if (r && activeIdx !== i) navigation.navigate(r.name, r.params);
  }, [visibleRoutes, activeIdx, navigation]);

  // ── Gestures ──

  const pan = Gesture.Pan()
    .activeOffsetX([-10, 10]).failOffsetY([-20, 20])
    .onStart(e => {
      'worklet';
      if (twS.value <= 0) return;
      const idx = Math.max(0, Math.min(tcS.value - 1, e.x / twS.value));
      pillPos.value = idx;
      lastHaptic.value = Math.floor(idx);
      runOnJS(hapticMed)();
    })
    .onUpdate(e => {
      'worklet';
      if (twS.value <= 0) return;
      const idx = Math.max(0, Math.min(tcS.value - 1, e.x / twS.value));
      pillPos.value = idx;
      const r = Math.round(idx);
      if (r !== lastHaptic.value) { lastHaptic.value = r; runOnJS(hapticLight)(); }
    })
    .onEnd(e => {
      'worklet';
      if (twS.value <= 0) return;
      const raw = Math.max(0, Math.min(tcS.value - 1, e.x / twS.value));
      const snap = Math.max(0, Math.min(tcS.value - 1, Math.floor(raw)));
      pillPos.value = withSpring(snap, SNAP);
      runOnJS(navTo)(snap); runOnJS(hapticMed)();
    });

  const tap = Gesture.Tap().onEnd(e => {
    'worklet';
    if (twS.value <= 0) return;
    const i = Math.max(0, Math.min(tcS.value - 1, Math.floor(e.x / twS.value)));
    pillPos.value = withSpring(i, SPRING);
    runOnJS(hapticLight)(); runOnJS(navTo)(i);
  });

  const gesture = Gesture.Exclusive(pan, tap);

  // ── Animated styles ──

  const pillStyle = useAnimatedStyle(() => {
    const pw = pillW.value;
    const tw = pw + PILL_INSET * 2;
    return {
      transform: [{ translateX: pillPos.value * tw + PILL_INSET }],
      width: pw,
    } as any;
  });

  // ── Tabs ──

  const tabs = visibleRoutes.map((route, i) => (
    <AnimatedTab key={route.key} route={route} options={descriptors[route.key].options}
      isFocused={activeIdx === i} />
  ));

  // ── Native glass (iOS 26+) ──

  if (isNativeLiquidGlass && GlassContainer && GlassView) {
    return (
      <View style={[st.outer, { bottom: MARGIN_B + insets.bottom }]}>
        <GlassContainer spacing={4}>
          <GestureDetector gesture={gesture}>
            <Animated.View style={st.nativeOuter}
              onLayout={(e: any) => setCWidth(e.nativeEvent.layout.width)}>
              <GlassView glassEffectStyle="regular" tintColor="rgba(255,255,255,0.04)" style={st.nativeBar}>
                {cWidth > 0 && (
                  <Animated.View style={[st.nativePillWrap, pillStyle as any]}>
                    <GlassView glassEffectStyle="clear" tintColor="rgba(255,255,255,0.1)" isInteractive style={st.nativePill} />
                  </Animated.View>
                )}
                {tabs}
              </GlassView>
            </Animated.View>
          </GestureDetector>
        </GlassContainer>
      </View>
    );
  }

  // ── Blur fallback ──

  return (
    <View style={[st.outer, st.shadow, { bottom: MARGIN_B + insets.bottom }]}>
      <GestureDetector gesture={gesture}>
        <Animated.View style={st.bar} onLayout={e => setCWidth(e.nativeEvent.layout.width)}>
          {/* Background — solid on Android (blur kills perf), blur on iOS */}
          {Platform.OS === 'ios' ? (
            <>
              <BlurView intensity={50} tint="dark" style={StyleSheet.absoluteFill} />
              <View style={[StyleSheet.absoluteFill, st.tint]} />
            </>
          ) : (
            <View style={[StyleSheet.absoluteFill, st.androidBg]} />
          )}

          {/* Pill */}
          {cWidth > 0 && (
            <Animated.View style={[st.pill, pillStyle as any]}>
              <View style={[StyleSheet.absoluteFill, st.pillFill]} />
            </Animated.View>
          )}

          {/* Tabs */}
          {tabs}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const st = StyleSheet.create({
  outer: {
    position: 'absolute', left: MARGIN_H, right: MARGIN_H,
  },
  shadow: {
    shadowColor: '#000', shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35, shadowRadius: 20, elevation: 10,
  },
  bar: {
    height: BAR_H, borderRadius: BAR_RADIUS, overflow: 'hidden',
    borderWidth: 0.5, borderColor: 'rgba(57, 197, 187, 0.15)',
    flexDirection: 'row', alignItems: 'center',
  },
  tint: {
    backgroundColor: 'rgba(10, 10, 12, 0.45)',
  },
  androidBg: {
    backgroundColor: 'rgba(15, 15, 18, 0.95)',
  },

  // Pill
  pill: {
    position: 'absolute', top: PILL_PAD, height: PILL_H,
    borderRadius: PILL_RADIUS, overflow: 'hidden',
  },
  pillFill: {
    backgroundColor: 'rgba(57, 197, 187, 0.12)',
    borderRadius: PILL_RADIUS,
  },

  // Tab
  tab: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    zIndex: 1, height: BAR_H, gap: 2,
  },
  label: {
    fontFamily: FontFamily.medium, fontSize: 10,
  },

  // Native glass
  nativeOuter: { height: BAR_H, borderRadius: BAR_RADIUS },
  nativeBar: {
    flex: 1, borderRadius: BAR_RADIUS, flexDirection: 'row',
    alignItems: 'center', borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.06)',
  },
  nativePillWrap: {
    position: 'absolute', top: PILL_PAD, height: PILL_H,
    borderRadius: PILL_RADIUS, overflow: 'hidden',
  },
  nativePill: { flex: 1, borderRadius: PILL_RADIUS },
});

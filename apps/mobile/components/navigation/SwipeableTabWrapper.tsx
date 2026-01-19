/**
 * Protocol 01 - Swipeable Tab Wrapper
 *
 * Wraps tab content to enable swipe navigation between main tabs
 * Uses edge swipe zones for reliable gesture detection
 */

import React, { useCallback } from 'react';
import { Platform, StyleSheet, View, Dimensions } from 'react-native';
import { useRouter } from 'expo-router';
import {
  Gesture,
  GestureDetector,
} from 'react-native-gesture-handler';
import { runOnJS, useSharedValue } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const EDGE_WIDTH = 25;
const SWIPE_THRESHOLD = 50;

// Define the tab order
const TABS = [
  { name: '(wallet)', path: '/(main)/(wallet)' },
  { name: '(streams)', path: '/(main)/(streams)' },
  { name: '(social)', path: '/(main)/(social)' },
  { name: '(agent)', path: '/(main)/(agent)' },
];

interface SwipeableTabWrapperProps {
  children: React.ReactNode;
  currentTab: string;
}

export function SwipeableTabWrapper({ children, currentTab }: SwipeableTabWrapperProps) {
  const router = useRouter();
  const currentIndex = TABS.findIndex(tab => tab.name === currentTab);
  const canGoLeft = currentIndex < TABS.length - 1;
  const canGoRight = currentIndex > 0;

  const navigateToNext = useCallback(() => {
    if (canGoLeft) {
      if (Platform.OS !== 'web') {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      }
      router.replace(TABS[currentIndex + 1].path as any);
    }
  }, [currentIndex, router, canGoLeft]);

  const navigateToPrev = useCallback(() => {
    if (canGoRight) {
      if (Platform.OS !== 'web') {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      }
      router.replace(TABS[currentIndex - 1].path as any);
    }
  }, [currentIndex, router, canGoRight]);

  // Left edge pan gesture (swipe right to go to previous tab)
  const leftEdgePan = Gesture.Pan()
    .onEnd((event) => {
      'worklet';
      if (event.translationX > SWIPE_THRESHOLD && event.velocityX > 0) {
        runOnJS(navigateToPrev)();
      }
    });

  // Right edge pan gesture (swipe left to go to next tab)
  const rightEdgePan = Gesture.Pan()
    .onEnd((event) => {
      'worklet';
      if (event.translationX < -SWIPE_THRESHOLD && event.velocityX < 0) {
        runOnJS(navigateToNext)();
      }
    });

  return (
    <View style={styles.container}>
      {children}

      {/* Left edge swipe zone */}
      {canGoRight && (
        <GestureDetector gesture={leftEdgePan}>
          <View style={styles.leftEdge} />
        </GestureDetector>
      )}

      {/* Right edge swipe zone */}
      {canGoLeft && (
        <GestureDetector gesture={rightEdgePan}>
          <View style={styles.rightEdge} />
        </GestureDetector>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  leftEdge: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: EDGE_WIDTH,
    backgroundColor: 'transparent',
  },
  rightEdge: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: EDGE_WIDTH,
    backgroundColor: 'transparent',
  },
});

export default SwipeableTabWrapper;

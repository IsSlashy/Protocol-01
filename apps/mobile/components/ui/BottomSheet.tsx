/**
 * BottomSheet — a panel that slides up over the screen.
 *
 * 🎯 RESTYLED ON THE REALIGNED THEME 2026-08-23. The gesture and snap-point
 * behaviour is untouched; what changed is that the surface, the rule, the grab
 * handle and the title now read tokens instead of Tailwind names, the title is
 * set in the display face like every other heading in the app, and the close
 * control is a real 44pt target with a label a screen reader can announce
 * (it was a bare 24px icon with no name at all).
 */

import React, { useCallback, useEffect, useRef } from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  Animated,
  Dimensions,
  PanResponder,
  TouchableWithoutFeedback,
  ScrollView,
  StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { Colors, Spacing, FontFamily, FontSize, BorderRadius } from '@/constants/theme';

interface BottomSheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  snapPoints?: number[];
  initialSnapIndex?: number;
  children: React.ReactNode;
}

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

export const BottomSheet: React.FC<BottomSheetProps> = ({
  visible,
  onClose,
  title,
  snapPoints = [0.5, 0.9],
  initialSnapIndex = 0,
  children,
}) => {
  const insets = useSafeAreaInsets();
  const translateY = useRef(new Animated.Value(SCREEN_HEIGHT)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;
  const currentSnapIndex = useRef(initialSnapIndex);

  const snapPointsPixels = snapPoints.map((point) => SCREEN_HEIGHT * (1 - point));

  const animateToSnapPoint = useCallback(
    (index: number) => {
      currentSnapIndex.current = index;
      Animated.spring(translateY, {
        toValue: snapPointsPixels[index],
        damping: 20,
        stiffness: 200,
        useNativeDriver: true,
      }).start();
    },
    [snapPointsPixels, translateY]
  );

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gestureState) => {
        return Math.abs(gestureState.dy) > 5;
      },
      onPanResponderMove: (_, gestureState) => {
        const newY = snapPointsPixels[currentSnapIndex.current] + gestureState.dy;
        if (newY >= 0) {
          translateY.setValue(newY);
        }
      },
      onPanResponderRelease: (_, gestureState) => {
        const currentY = snapPointsPixels[currentSnapIndex.current] + gestureState.dy;
        const velocity = gestureState.vy;

        if (velocity > 0.5 || currentY > SCREEN_HEIGHT * 0.7) {
          closeSheet();
          return;
        }

        let closestIndex = 0;
        let minDistance = Math.abs(currentY - snapPointsPixels[0]);

        snapPointsPixels.forEach((point, index) => {
          const distance = Math.abs(currentY - point);
          if (distance < minDistance) {
            minDistance = distance;
            closestIndex = index;
          }
        });

        if (velocity < -0.5 && closestIndex < snapPointsPixels.length - 1) {
          closestIndex++;
        } else if (velocity > 0.5 && closestIndex > 0) {
          closestIndex--;
        }

        animateToSnapPoint(closestIndex);
      },
    })
  ).current;

  const openSheet = useCallback(() => {
    Animated.parallel([
      Animated.spring(translateY, {
        toValue: snapPointsPixels[initialSnapIndex],
        damping: 20,
        stiffness: 200,
        useNativeDriver: true,
      }),
      Animated.timing(backdropOpacity, {
        toValue: 1,
        duration: 300,
        useNativeDriver: true,
      }),
    ]).start();
  }, [initialSnapIndex, snapPointsPixels, translateY, backdropOpacity]);

  const closeSheet = useCallback(() => {
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: SCREEN_HEIGHT,
        duration: 250,
        useNativeDriver: true,
      }),
      Animated.timing(backdropOpacity, {
        toValue: 0,
        duration: 250,
        useNativeDriver: true,
      }),
    ]).start(() => {
      onClose();
    });
  }, [translateY, backdropOpacity, onClose]);

  useEffect(() => {
    if (visible) {
      openSheet();
    }
  }, [visible, openSheet]);

  if (!visible) return null;

  return (
    <Modal transparent visible={visible} animationType="none" onRequestClose={closeSheet}>
      <View style={styles.root}>
        <TouchableWithoutFeedback onPress={closeSheet} accessibilityLabel="Close">
          <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]} />
        </TouchableWithoutFeedback>

        <Animated.View
          style={[
            styles.sheet,
            {
              transform: [{ translateY }],
              height: SCREEN_HEIGHT,
              paddingBottom: insets.bottom,
            },
          ]}
          {...panResponder.panHandlers}
        >
          <View style={styles.handleRow}>
            <View style={styles.handle} />
          </View>

          {title && (
            <View style={styles.header}>
              <Text style={styles.title} numberOfLines={1}>
                {title}
              </Text>
              <TouchableOpacity
                onPress={closeSheet}
                style={styles.close}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                accessibilityRole="button"
                accessibilityLabel="Close"
              >
                <Ionicons name="close" size={22} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>
          )}

          <ScrollView
            style={styles.body}
            contentContainerStyle={styles.bodyContent}
            showsVerticalScrollIndicator={false}
            bounces={false}
          >
            {children}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
};

/**
 * The scrim behind a modal: the ground colour at 72%, derived from the token
 * rather than written out, so a change to the ink reaches it. `b8` is 0.72 in
 * the 8-digit hex form React Native accepts.
 */
const SCRIM = `${Colors.background}b8`;

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: SCRIM,
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    backgroundColor: Colors.surface,
    borderTopLeftRadius: BorderRadius['2xl'],
    borderTopRightRadius: BorderRadius['2xl'],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  handleRow: {
    alignItems: 'center',
    paddingTop: Spacing.md,
    paddingBottom: Spacing.sm,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.borderLight,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: Spacing['2xl'],
    paddingRight: Spacing.md,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  title: {
    flex: 1,
    fontFamily: FontFamily.displayMedium,
    fontSize: FontSize.xl,
    color: Colors.text,
  },
  close: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    flex: 1,
  },
  bodyContent: {
    paddingHorizontal: Spacing['2xl'],
    paddingTop: Spacing.lg,
  },
});

export default BottomSheet;

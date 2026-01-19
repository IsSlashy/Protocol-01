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
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

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
    <Modal transparent visible={visible} animationType="none">
      <View className="flex-1">
        <TouchableWithoutFeedback onPress={closeSheet}>
          <Animated.View
            className="absolute inset-0 bg-black/60"
            style={{ opacity: backdropOpacity }}
          />
        </TouchableWithoutFeedback>

        <Animated.View
          className="absolute left-0 right-0 bg-p01-surface rounded-t-3xl"
          style={{
            transform: [{ translateY }],
            height: SCREEN_HEIGHT,
            paddingBottom: insets.bottom,
          }}
          {...panResponder.panHandlers}
        >
          <View className="items-center pt-3 pb-2">
            <View className="w-10 h-1 bg-p01-border rounded-full" />
          </View>

          {title && (
            <View className="flex-row items-center justify-between px-6 py-4 border-b border-p01-border">
              <Text className="text-white text-lg font-semibold">{title}</Text>
              <TouchableOpacity
                onPress={closeSheet}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Ionicons name="close" size={24} color="#888892" />
              </TouchableOpacity>
            </View>
          )}

          <ScrollView
            className="flex-1 px-6"
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

export default BottomSheet;

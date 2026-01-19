import React, { useEffect, useRef } from 'react';
import { View, Animated, ViewProps } from 'react-native';

interface StreamProgressProps extends ViewProps {
  progress: number; // 0-100
  height?: number;
  animated?: boolean;
  showGlow?: boolean;
}

export const StreamProgress: React.FC<StreamProgressProps> = ({
  progress,
  height = 8,
  animated = true,
  showGlow = true,
  className,
  ...props
}) => {
  const animatedWidth = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (animated) {
      Animated.spring(animatedWidth, {
        toValue: progress,
        useNativeDriver: false,
        tension: 50,
        friction: 8,
      }).start();
    } else {
      animatedWidth.setValue(progress);
    }
  }, [progress, animated]);

  useEffect(() => {
    if (showGlow && progress > 0 && progress < 100) {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.2,
            duration: 1000,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 1000,
            useNativeDriver: true,
          }),
        ])
      );
      pulse.start();
      return () => pulse.stop();
    }
  }, [progress, showGlow]);

  const widthInterpolate = animatedWidth.interpolate({
    inputRange: [0, 100],
    outputRange: ['0%', '100%'],
  });

  return (
    <View
      className={`w-full rounded-full overflow-hidden ${className || ''}`}
      style={{ height, backgroundColor: 'rgba(255, 119, 168, 0.2)' }}
      {...props}
    >
      <Animated.View
        style={[
          {
            height: '100%',
            width: widthInterpolate,
            borderRadius: 999,
            backgroundColor: '#ff77a8',
          },
          showGlow && progress > 0 && progress < 100
            ? {
                shadowColor: '#ff77a8',
                shadowOpacity: 0.8,
                shadowRadius: 8,
                shadowOffset: { width: 0, height: 0 },
                transform: [{ scaleY: pulseAnim }],
              }
            : {},
        ]}
      />
    </View>
  );
};

export default StreamProgress;

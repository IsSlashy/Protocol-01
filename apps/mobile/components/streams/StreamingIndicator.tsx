import React, { useEffect, useRef } from 'react';
import { View, Text, Animated, Easing, ViewProps } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

interface StreamingIndicatorProps extends ViewProps {
  amount?: number;
  symbol?: string;
  ratePerSecond?: number;
  isActive?: boolean;
  size?: 'sm' | 'md' | 'lg';
  showRate?: boolean;
  label?: string;
}

const ACCENT_PINK = '#ff77a8';

const sizeStyles = {
  sm: {
    container: 'px-3 py-2',
    dot: 6,
    amountText: 'text-sm',
    rateText: 'text-xs',
    gap: 'gap-1.5',
  },
  md: {
    container: 'px-4 py-3',
    dot: 8,
    amountText: 'text-base',
    rateText: 'text-sm',
    gap: 'gap-2',
  },
  lg: {
    container: 'px-5 py-4',
    dot: 10,
    amountText: 'text-xl',
    rateText: 'text-base',
    gap: 'gap-2.5',
  },
};

export const StreamingIndicator: React.FC<StreamingIndicatorProps> = ({
  amount,
  symbol,
  ratePerSecond,
  isActive = true,
  size = 'md',
  showRate = true,
  label,
  className,
  ...props
}) => {
  const pulseAnim = useRef(new Animated.Value(0.3)).current;
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const rippleAnim = useRef(new Animated.Value(0)).current;
  const opacityAnim = useRef(new Animated.Value(1)).current;

  const sizeStyle = sizeStyles[size];

  useEffect(() => {
    if (isActive) {
      const pulseAnimation = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 800,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 0.3,
            duration: 800,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ])
      );

      const scaleAnimation = Animated.loop(
        Animated.sequence([
          Animated.timing(scaleAnim, {
            toValue: 1.5,
            duration: 800,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(scaleAnim, {
            toValue: 1,
            duration: 800,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ])
      );

      const opacityAnimation = Animated.loop(
        Animated.sequence([
          Animated.timing(opacityAnim, {
            toValue: 0.4,
            duration: 800,
            useNativeDriver: true,
          }),
          Animated.timing(opacityAnim, {
            toValue: 1,
            duration: 800,
            useNativeDriver: true,
          }),
        ])
      );

      const rippleAnimation = Animated.loop(
        Animated.sequence([
          Animated.timing(rippleAnim, {
            toValue: 1,
            duration: 1500,
            easing: Easing.out(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(rippleAnim, {
            toValue: 0,
            duration: 0,
            useNativeDriver: true,
          }),
        ])
      );

      pulseAnimation.start();
      scaleAnimation.start();
      opacityAnimation.start();
      rippleAnimation.start();

      return () => {
        pulseAnimation.stop();
        scaleAnimation.stop();
        opacityAnimation.stop();
        rippleAnimation.stop();
      };
    }
  }, [isActive]);

  const rippleScale = rippleAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 2.5],
  });

  const rippleOpacity = rippleAnim.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [0.5, 0.2, 0],
  });

  // Simple label mode (for badges)
  if (label !== undefined) {
    return (
      <View
        className={`flex-row items-center ${sizeStyle.gap} ${className || ''}`}
        {...props}
      >
        <View className="relative">
          {/* Outer pulse ring */}
          <Animated.View
            style={{
              position: 'absolute',
              width: sizeStyle.dot * 2,
              height: sizeStyle.dot * 2,
              borderRadius: sizeStyle.dot,
              backgroundColor: ACCENT_PINK,
              transform: [{ scale: scaleAnim }],
              opacity: opacityAnim.interpolate({
                inputRange: [0.4, 1],
                outputRange: [0.3, 0],
              }),
              left: -sizeStyle.dot / 2,
              top: -sizeStyle.dot / 2,
            }}
          />
          {/* Inner dot */}
          <Animated.View
            style={{
              width: sizeStyle.dot,
              height: sizeStyle.dot,
              borderRadius: sizeStyle.dot / 2,
              backgroundColor: ACCENT_PINK,
              opacity: opacityAnim,
              shadowColor: ACCENT_PINK,
              shadowOpacity: 0.8,
              shadowRadius: 6,
              shadowOffset: { width: 0, height: 0 },
            }}
          />
        </View>
        {label && (
          <Text
            className={`font-semibold ${sizeStyle.rateText}`}
            style={{ color: ACCENT_PINK }}
          >
            {label}
          </Text>
        )}
      </View>
    );
  }

  // Full mode with amount and rate
  return (
    <View
      className={`
        flex-row items-center
        rounded-xl
        ${sizeStyle.container}
        ${className || ''}
      `}
      style={{ backgroundColor: 'rgba(255, 119, 168, 0.1)', borderWidth: 1, borderColor: 'rgba(255, 119, 168, 0.3)' }}
      {...props}
    >
      <View className="relative items-center justify-center mr-3">
        {isActive && (
          <Animated.View
            className="absolute rounded-full"
            style={{
              width: sizeStyle.dot * 2,
              height: sizeStyle.dot * 2,
              backgroundColor: ACCENT_PINK,
              transform: [{ scale: rippleScale }],
              opacity: rippleOpacity,
            }}
          />
        )}
        <Animated.View
          className="rounded-full"
          style={{
            width: sizeStyle.dot,
            height: sizeStyle.dot,
            backgroundColor: ACCENT_PINK,
            opacity: pulseAnim,
            transform: [{ scale: scaleAnim }],
            shadowColor: ACCENT_PINK,
            shadowOpacity: 0.8,
            shadowRadius: 6,
            shadowOffset: { width: 0, height: 0 },
          }}
        />
      </View>

      <View className="flex-1">
        <View className="flex-row items-center">
          <Animated.Text
            className={`font-bold ${sizeStyle.amountText}`}
            style={{
              color: ACCENT_PINK,
              opacity: isActive
                ? pulseAnim.interpolate({
                    inputRange: [0.3, 1],
                    outputRange: [0.7, 1],
                  })
                : 0.5,
            }}
          >
            {amount?.toFixed(6)} {symbol}
          </Animated.Text>
          {isActive && (
            <View className="ml-2">
              <Ionicons name="pulse" size={16} color={ACCENT_PINK} />
            </View>
          )}
        </View>
        {showRate && ratePerSecond !== undefined && (
          <Text className={`text-p01-text-secondary ${sizeStyle.rateText}`}>
            {isActive ? 'Streaming' : 'Paused'} at {ratePerSecond.toFixed(8)}/sec
          </Text>
        )}
      </View>
    </View>
  );
};

export default StreamingIndicator;

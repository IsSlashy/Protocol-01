import React, { useEffect, useRef } from 'react';
import { View, Animated, Easing, Text } from 'react-native';

type LoaderSize = 'sm' | 'md' | 'lg';
type LoaderVariant = 'ghost' | 'pulse' | 'dots';

interface LoaderProps {
  size?: LoaderSize;
  variant?: LoaderVariant;
  label?: string;
  className?: string;
}

const sizeStyles: Record<LoaderSize, { container: number; dot: number; text: string }> = {
  sm: { container: 24, dot: 4, text: 'text-xs' },
  md: { container: 40, dot: 6, text: 'text-sm' },
  lg: { container: 60, dot: 8, text: 'text-base' },
};

const GhostLoader: React.FC<{ size: LoaderSize }> = ({ size }) => {
  const opacity1 = useRef(new Animated.Value(0.3)).current;
  const opacity2 = useRef(new Animated.Value(0.3)).current;
  const opacity3 = useRef(new Animated.Value(0.3)).current;
  const scale = useRef(new Animated.Value(1)).current;

  const sizeStyle = sizeStyles[size];

  useEffect(() => {
    const animate = (animatedValue: Animated.Value, delay: number) => {
      return Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(animatedValue, {
            toValue: 1,
            duration: 600,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(animatedValue, {
            toValue: 0.3,
            duration: 600,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ])
      );
    };

    const scaleAnimation = Animated.loop(
      Animated.sequence([
        Animated.timing(scale, {
          toValue: 1.1,
          duration: 800,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(scale, {
          toValue: 1,
          duration: 800,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    );

    const animations = [
      animate(opacity1, 0),
      animate(opacity2, 200),
      animate(opacity3, 400),
      scaleAnimation,
    ];

    animations.forEach((anim) => anim.start());

    return () => {
      animations.forEach((anim) => anim.stop());
    };
  }, []);

  return (
    <Animated.View
      style={{
        width: sizeStyle.container,
        height: sizeStyle.container,
        transform: [{ scale }],
      }}
      className="items-center justify-center"
    >
      <View className="flex-row items-center gap-1">
        <Animated.View
          style={{
            width: sizeStyle.dot,
            height: sizeStyle.dot,
            borderRadius: sizeStyle.dot / 2,
            backgroundColor: '#39c5bb',
            opacity: opacity1,
          }}
        />
        <Animated.View
          style={{
            width: sizeStyle.dot,
            height: sizeStyle.dot,
            borderRadius: sizeStyle.dot / 2,
            backgroundColor: '#39c5bb',
            opacity: opacity2,
          }}
        />
        <Animated.View
          style={{
            width: sizeStyle.dot,
            height: sizeStyle.dot,
            borderRadius: sizeStyle.dot / 2,
            backgroundColor: '#39c5bb',
            opacity: opacity3,
          }}
        />
      </View>
    </Animated.View>
  );
};

const PulseLoader: React.FC<{ size: LoaderSize }> = ({ size }) => {
  const scale = useRef(new Animated.Value(0.5)).current;
  const opacity = useRef(new Animated.Value(1)).current;

  const sizeStyle = sizeStyles[size];

  useEffect(() => {
    const animation = Animated.loop(
      Animated.parallel([
        Animated.sequence([
          Animated.timing(scale, {
            toValue: 1.5,
            duration: 1000,
            easing: Easing.out(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(scale, {
            toValue: 0.5,
            duration: 0,
            useNativeDriver: true,
          }),
        ]),
        Animated.sequence([
          Animated.timing(opacity, {
            toValue: 0,
            duration: 1000,
            easing: Easing.out(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(opacity, {
            toValue: 1,
            duration: 0,
            useNativeDriver: true,
          }),
        ]),
      ])
    );

    animation.start();
    return () => animation.stop();
  }, []);

  return (
    <View
      style={{
        width: sizeStyle.container,
        height: sizeStyle.container,
      }}
      className="items-center justify-center"
    >
      <Animated.View
        style={{
          width: sizeStyle.container,
          height: sizeStyle.container,
          borderRadius: sizeStyle.container / 2,
          backgroundColor: '#39c5bb',
          transform: [{ scale }],
          opacity,
        }}
      />
    </View>
  );
};

const DotsLoader: React.FC<{ size: LoaderSize }> = ({ size }) => {
  const translateY1 = useRef(new Animated.Value(0)).current;
  const translateY2 = useRef(new Animated.Value(0)).current;
  const translateY3 = useRef(new Animated.Value(0)).current;

  const sizeStyle = sizeStyles[size];
  const bounceHeight = sizeStyle.dot * 2;

  useEffect(() => {
    const animate = (animatedValue: Animated.Value, delay: number) => {
      return Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(animatedValue, {
            toValue: -bounceHeight,
            duration: 300,
            easing: Easing.out(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(animatedValue, {
            toValue: 0,
            duration: 300,
            easing: Easing.in(Easing.ease),
            useNativeDriver: true,
          }),
        ])
      );
    };

    const animations = [
      animate(translateY1, 0),
      animate(translateY2, 150),
      animate(translateY3, 300),
    ];

    animations.forEach((anim) => anim.start());
    return () => animations.forEach((anim) => anim.stop());
  }, []);

  const dotStyle = {
    width: sizeStyle.dot,
    height: sizeStyle.dot,
    borderRadius: sizeStyle.dot / 2,
    backgroundColor: '#39c5bb',
  };

  return (
    <View
      style={{
        width: sizeStyle.container,
        height: sizeStyle.container,
      }}
      className="flex-row items-center justify-center gap-1"
    >
      <Animated.View style={[dotStyle, { transform: [{ translateY: translateY1 }] }]} />
      <Animated.View style={[dotStyle, { transform: [{ translateY: translateY2 }] }]} />
      <Animated.View style={[dotStyle, { transform: [{ translateY: translateY3 }] }]} />
    </View>
  );
};

export const Loader: React.FC<LoaderProps> = ({
  size = 'md',
  variant = 'ghost',
  label,
  className,
}) => {
  const sizeStyle = sizeStyles[size];

  const LoaderComponent = {
    ghost: GhostLoader,
    pulse: PulseLoader,
    dots: DotsLoader,
  }[variant];

  return (
    <View className={`items-center justify-center ${className || ''}`}>
      <LoaderComponent size={size} />
      {label && (
        <Text className={`text-p01-text-secondary ${sizeStyle.text} mt-2`}>
          {label}
        </Text>
      )}
    </View>
  );
};

export default Loader;

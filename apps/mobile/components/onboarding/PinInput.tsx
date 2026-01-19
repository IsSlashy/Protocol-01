import React, { useState, useRef, useEffect } from 'react';
import { View, Text, TextInput, Pressable, Keyboard } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSequence,
  withTiming,
  withSpring,
  Easing,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';

interface PinInputProps {
  length?: number;
  value: string;
  onChange: (value: string) => void;
  onComplete?: (pin: string) => void;
  error?: boolean;
  secureEntry?: boolean;
}

export const PinInput: React.FC<PinInputProps> = ({
  length = 6,
  value,
  onChange,
  onComplete,
  error = false,
  secureEntry = true,
}) => {
  const inputRef = useRef<TextInput>(null);
  const shakeX = useSharedValue(0);
  const dotScales = useRef(Array(length).fill(null).map(() => useSharedValue(1))).current;

  useEffect(() => {
    if (error) {
      // Shake animation
      shakeX.value = withSequence(
        withTiming(-10, { duration: 50 }),
        withTiming(10, { duration: 50 }),
        withTiming(-10, { duration: 50 }),
        withTiming(10, { duration: 50 }),
        withTiming(0, { duration: 50 })
      );
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  }, [error]);

  useEffect(() => {
    // Animate the current dot
    if (value.length > 0 && value.length <= length) {
      const index = value.length - 1;
      dotScales[index].value = withSequence(
        withSpring(1.3, { damping: 10 }),
        withSpring(1, { damping: 10 })
      );
    }
  }, [value]);

  const handleChange = (text: string) => {
    const numericText = text.replace(/[^0-9]/g, '').slice(0, length);
    onChange(numericText);

    if (numericText.length === length && onComplete) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onComplete(numericText);
    }
  };

  const handlePress = () => {
    inputRef.current?.focus();
  };

  const containerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: shakeX.value }],
  }));

  return (
    <View className="w-full">
      {/* Hidden input */}
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={handleChange}
        keyboardType="number-pad"
        maxLength={length}
        autoFocus
        className="absolute opacity-0 w-0 h-0"
        caretHidden
      />

      {/* Visual PIN display */}
      <Pressable onPress={handlePress}>
        <Animated.View
          style={containerStyle}
          className="flex-row justify-center items-center gap-3"
        >
          {Array(length)
            .fill(null)
            .map((_, index) => {
              const isFilled = index < value.length;
              const isActive = index === value.length;

              const dotAnimStyle = useAnimatedStyle(() => ({
                transform: [{ scale: dotScales[index].value }],
              }));

              return (
                <Animated.View
                  key={index}
                  style={dotAnimStyle}
                  className={`
                    w-14 h-14 rounded-2xl items-center justify-center
                    ${error
                      ? 'bg-red-500/20 border-2 border-red-500'
                      : isFilled
                        ? 'bg-[#39c5bb]/20 border-2 border-[#39c5bb]'
                        : isActive
                          ? 'bg-[#151518] border-2 border-[#39c5bb]/50'
                          : 'bg-[#151518] border-2 border-[#2a2a30]'
                    }
                  `}
                >
                  {isFilled && (
                    secureEntry ? (
                      <View
                        className={`w-4 h-4 rounded-full ${
                          error ? 'bg-red-500' : 'bg-[#39c5bb]'
                        }`}
                      />
                    ) : (
                      <Text className={`text-2xl font-bold ${
                        error ? 'text-red-500' : 'text-[#39c5bb]'
                      }`}>
                        {value[index]}
                      </Text>
                    )
                  )}
                </Animated.View>
              );
            })}
        </Animated.View>
      </Pressable>

      {/* Keypad hint */}
      <Text className="text-center text-[#555560] text-sm mt-6">
        Enter a {length}-digit PIN
      </Text>
    </View>
  );
};

export default PinInput;

/**
 * PinInput — six boxes and a hidden field.
 *
 * 🚨 IT DECLARED ITS OWN RED. `#ef4444` for the error border, the error dot and
 * the error digit; the theme's red is `#e0574f`, desaturated on purpose so it
 * stops vibrating against near-black ink. Same story for the surface, the
 * border and the accent: six literals, none reachable by a theme sweep. Tokens
 * now.
 *
 * ⚠️ The hidden `TextInput` keeps its real 1×1 size and its `autoFocus`. That
 * is not a style detail — a zero-sized input does not open the keyboard on
 * Android.
 */
import React, { useRef, useEffect } from 'react';
import { View, Text, TextInput, Pressable } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSequence,
  withTiming,
  withSpring,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';

import { Colors, Spacing, FontFamily, FontSize, BorderRadius } from '../../constants/theme';

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

  // Force focus after mount — autoFocus is unreliable inside modals on Android
  useEffect(() => {
    const timer = setTimeout(() => {
      inputRef.current?.focus();
    }, 300);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (error) {
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
    <View style={{ width: '100%' }}>
      {/* Hidden input — needs real size on Android or keyboard won't open */}
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={handleChange}
        keyboardType="number-pad"
        maxLength={length}
        autoFocus
        style={{ position: 'absolute', opacity: 0, width: 1, height: 1, top: 0, left: 0 }}
        caretHidden
      />

      {/* Visual PIN display */}
      <Pressable onPress={handlePress}>
        <Animated.View
          style={[
            containerStyle,
            {
              flexDirection: 'row',
              justifyContent: 'center',
              alignItems: 'center',
              gap: 12,
            },
          ]}
        >
          {Array(length)
            .fill(null)
            .map((_, index) => {
              const isFilled = index < value.length;
              const isActive = index === value.length;

              const dotAnimStyle = useAnimatedStyle(() => ({
                transform: [{ scale: dotScales[index].value }],
              }));

              const getBorderColor = () => {
                if (error) return Colors.error;
                if (isFilled) return Colors.primary;
                if (isActive) return Colors.primaryMuted;
                return Colors.border;
              };

              const getBgColor = () => {
                if (error) return Colors.errorDim;
                if (isFilled) return Colors.primaryDim;
                return Colors.surface;
              };

              return (
                <Animated.View
                  key={index}
                  style={[
                    dotAnimStyle,
                    {
                      width: 56,
                      height: 56,
                      borderRadius: BorderRadius.lg,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: getBgColor(),
                      borderWidth: 1,
                      borderColor: getBorderColor(),
                    },
                  ]}
                >
                  {isFilled && (
                    secureEntry ? (
                      <View
                        style={{
                          width: 14,
                          height: 14,
                          borderRadius: 7,
                          backgroundColor: error ? Colors.error : Colors.primary,
                        }}
                      />
                    ) : (
                      <Text
                        style={{
                          fontSize: FontSize['2xl'],
                          fontFamily: FontFamily.medium,
                          color: error ? Colors.error : Colors.primary,
                        }}
                      >
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
      <Text
        style={{
          textAlign: 'center',
          color: Colors.textTertiary,
          fontFamily: FontFamily.regular,
          fontSize: FontSize.sm,
          marginTop: Spacing['2xl'],
        }}
      >
        Enter a {length}-digit PIN
      </Text>
    </View>
  );
};

export default PinInput;

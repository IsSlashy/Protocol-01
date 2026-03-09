import React, { useRef, useEffect, useCallback } from 'react';
import { View, Text, TextInput, Pressable, Platform } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSequence,
  withTiming,
  withSpring,
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
                if (error) return '#ef4444';
                if (isFilled) return '#39c5bb';
                if (isActive) return 'rgba(57, 197, 187, 0.5)';
                return '#2a2a30';
              };

              const getBgColor = () => {
                if (error) return 'rgba(239, 68, 68, 0.2)';
                if (isFilled) return 'rgba(57, 197, 187, 0.2)';
                return '#151518';
              };

              return (
                <Animated.View
                  key={index}
                  style={[
                    dotAnimStyle,
                    {
                      width: 56,
                      height: 56,
                      borderRadius: 16,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: getBgColor(),
                      borderWidth: 2,
                      borderColor: getBorderColor(),
                    },
                  ]}
                >
                  {isFilled && (
                    secureEntry ? (
                      <View
                        style={{
                          width: 16,
                          height: 16,
                          borderRadius: 8,
                          backgroundColor: error ? '#ef4444' : '#39c5bb',
                        }}
                      />
                    ) : (
                      <Text
                        style={{
                          fontSize: 24,
                          fontWeight: 'bold',
                          color: error ? '#ef4444' : '#39c5bb',
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
      <Text style={{ textAlign: 'center', color: '#555560', fontSize: 14, marginTop: 24 }}>
        Enter a {length}-digit PIN
      </Text>
    </View>
  );
};

export default PinInput;

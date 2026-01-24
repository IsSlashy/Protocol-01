/**
 * AlertModal - Custom styled alert to replace Alert.alert
 *
 * Features:
 * - Glitch button animations
 * - Protocol 01 cyber aesthetic
 * - Smooth entrance/exit animations
 */

import React, { useEffect, useRef } from 'react';
import {
  Modal,
  View,
  Text,
  Animated,
  Easing,
  Dimensions,
  TouchableWithoutFeedback,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { GlitchButton } from './GlitchButton';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

export interface AlertButton {
  text: string;
  style?: 'default' | 'cancel' | 'destructive';
  onPress?: () => void;
}

export interface AlertModalProps {
  visible: boolean;
  title: string;
  message?: string;
  buttons?: AlertButton[];
  icon?: 'warning' | 'error' | 'success' | 'info' | 'question';
  onDismiss?: () => void;
}

const iconConfig: Record<string, { name: keyof typeof Ionicons.glyphMap; color: string }> = {
  warning: { name: 'warning', color: '#ffcc00' },
  error: { name: 'alert-circle', color: '#ff3366' },
  success: { name: 'checkmark-circle', color: '#39c5bb' },
  info: { name: 'information-circle', color: '#39c5bb' },
  question: { name: 'help-circle', color: '#ff77a8' },
};

export const AlertModal: React.FC<AlertModalProps> = ({
  visible,
  title,
  message,
  buttons = [{ text: 'OK', style: 'default' }],
  icon,
  onDismiss,
}) => {
  const scaleAnim = useRef(new Animated.Value(0.8)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;
  const translateYAnim = useRef(new Animated.Value(20)).current;
  const glitchLineAnim = useRef(new Animated.Value(0)).current;
  const borderGlowAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      // Enter animation
      Animated.parallel([
        Animated.spring(scaleAnim, {
          toValue: 1,
          friction: 8,
          tension: 65,
          useNativeDriver: true,
        }),
        Animated.timing(opacityAnim, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.spring(translateYAnim, {
          toValue: 0,
          friction: 8,
          tension: 65,
          useNativeDriver: true,
        }),
      ]).start();

      // Border glow pulse
      Animated.loop(
        Animated.sequence([
          Animated.timing(borderGlowAnim, {
            toValue: 1,
            duration: 1500,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: false,
          }),
          Animated.timing(borderGlowAnim, {
            toValue: 0,
            duration: 1500,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: false,
          }),
        ])
      ).start();

      // Glitch line animation
      Animated.loop(
        Animated.sequence([
          Animated.delay(1000 + Math.random() * 2000),
          Animated.timing(glitchLineAnim, {
            toValue: 1,
            duration: 100,
            useNativeDriver: true,
          }),
          Animated.timing(glitchLineAnim, {
            toValue: 0,
            duration: 50,
            useNativeDriver: true,
          }),
        ])
      ).start();
    } else {
      // Exit animation
      Animated.parallel([
        Animated.timing(scaleAnim, {
          toValue: 0.8,
          duration: 150,
          useNativeDriver: true,
        }),
        Animated.timing(opacityAnim, {
          toValue: 0,
          duration: 150,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible, scaleAnim, opacityAnim, translateYAnim, glitchLineAnim, borderGlowAnim]);

  const handleButtonPress = (button: AlertButton) => {
    button.onPress?.();
    onDismiss?.();
  };

  const getButtonVariant = (style?: string) => {
    if (style === 'destructive') return 'danger';
    if (style === 'cancel') return 'ghost';
    return 'primary';
  };

  const iconInfo = icon ? iconConfig[icon] : null;

  const borderColor = borderGlowAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['rgba(57, 197, 187, 0.2)', 'rgba(57, 197, 187, 0.5)'],
  });

  const shadowOpacity = borderGlowAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.2, 0.5],
  });

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onDismiss}
      statusBarTranslucent
    >
      <TouchableWithoutFeedback onPress={onDismiss}>
        <View className="flex-1 items-center justify-center">
          {/* Background blur */}
          <BlurView
            intensity={30}
            tint="dark"
            className="absolute inset-0"
            style={{ backgroundColor: 'rgba(0, 0, 0, 0.7)' }}
          />

          <TouchableWithoutFeedback>
            <Animated.View
              className="w-[85%] max-w-sm bg-p01-surface rounded-2xl overflow-hidden"
              style={{
                opacity: opacityAnim,
                transform: [
                  { scale: scaleAnim },
                  { translateY: translateYAnim },
                ],
              }}
            >
              {/* Animated border */}
              <Animated.View
                className="absolute inset-0 rounded-2xl"
                style={{
                  borderWidth: 1,
                  borderColor,
                  shadowColor: '#39c5bb',
                  shadowRadius: 20,
                  shadowOpacity,
                }}
              />

              {/* Top accent line */}
              <View className="h-[2px] bg-p01-cyan" />

              {/* Content */}
              <View className="px-6 py-6">
                {/* Icon */}
                {iconInfo && (
                  <View className="items-center mb-4">
                    <View
                      className="w-14 h-14 rounded-full items-center justify-center"
                      style={{ backgroundColor: `${iconInfo.color}15` }}
                    >
                      <Ionicons
                        name={iconInfo.name}
                        size={32}
                        color={iconInfo.color}
                      />
                    </View>
                  </View>
                )}

                {/* Title */}
                <Text className="text-white text-lg font-semibold text-center mb-2">
                  {title}
                </Text>

                {/* Message */}
                {message && (
                  <Text className="text-p01-gray text-center text-sm leading-5 mb-6">
                    {message}
                  </Text>
                )}

                {/* Glitch scan line */}
                <Animated.View
                  className="absolute left-0 right-0 h-[1px] bg-p01-cyan/30"
                  style={{
                    opacity: glitchLineAnim,
                    transform: [{
                      translateY: glitchLineAnim.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0, 80],
                      }),
                    }],
                  }}
                />

                {/* Buttons */}
                <View className="gap-3">
                  {buttons.map((button, index) => (
                    <GlitchButton
                      key={index}
                      variant={getButtonVariant(button.style)}
                      onPress={() => handleButtonPress(button)}
                      fullWidth
                    >
                      {button.text}
                    </GlitchButton>
                  ))}
                </View>
              </View>

              {/* Bottom corner accents */}
              <View className="absolute bottom-0 left-0 w-8 h-[2px] bg-p01-cyan/50" />
              <View className="absolute bottom-0 left-0 w-[2px] h-8 bg-p01-cyan/50" />
              <View className="absolute bottom-0 right-0 w-8 h-[2px] bg-p01-cyan/50" />
              <View className="absolute bottom-0 right-0 w-[2px] h-8 bg-p01-cyan/50" />
            </Animated.View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
};

export default AlertModal;

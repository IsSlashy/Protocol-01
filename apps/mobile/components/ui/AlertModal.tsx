/**
 * AlertModal — Protocol 01 styled alert dialog.
 *
 * Driven by the global useAlertStore. Mount once in _layout.tsx.
 * Replaces all native Alert.alert() calls with the P01 cyber aesthetic.
 */

import React, { useEffect, useRef } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  StyleSheet,
  Animated,
  Easing,
  Platform,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useAlertStore, type AlertButton } from '@/stores/alertStore';
import { Colors, FontFamily, P01Colors } from '@/constants/theme';

// ---------------------------------------------------------------------------
// Icon mapping
// ---------------------------------------------------------------------------
const iconConfig: Record<string, { name: keyof typeof Ionicons.glyphMap; color: string }> = {
  warning: { name: 'warning', color: '#eab308' },
  error: { name: 'alert-circle', color: '#ff3366' },
  success: { name: 'checkmark-circle', color: P01Colors.cyan },
  info: { name: 'information-circle', color: P01Colors.cyan },
  question: { name: 'help-circle', color: P01Colors.pink },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function AlertModal() {
  const { visible, title, message, buttons, icon, dismiss } = useAlertStore();

  const scaleAnim = useRef(new Animated.Value(0.85)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;
  const borderGlow = useRef(new Animated.Value(0)).current;
  const scanLine = useRef(new Animated.Value(-40)).current;

  useEffect(() => {
    if (visible) {
      scaleAnim.setValue(0.85);
      opacityAnim.setValue(0);
      Animated.parallel([
        Animated.spring(scaleAnim, { toValue: 1, friction: 8, tension: 65, useNativeDriver: true }),
        Animated.timing(opacityAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
      ]).start();

      // Border glow pulse
      Animated.loop(
        Animated.sequence([
          Animated.timing(borderGlow, { toValue: 1, duration: 1500, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
          Animated.timing(borderGlow, { toValue: 0, duration: 1500, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
        ]),
      ).start();

      // Scan line sweep
      Animated.loop(
        Animated.sequence([
          Animated.delay(800 + Math.random() * 1500),
          Animated.timing(scanLine, { toValue: 120, duration: 300, useNativeDriver: true }),
          Animated.timing(scanLine, { toValue: -40, duration: 0, useNativeDriver: true }),
        ]),
      ).start();
    } else {
      borderGlow.stopAnimation();
      scanLine.stopAnimation();
    }
  }, [visible]);

  const handleButton = (btn: AlertButton) => {
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    dismiss();
    // Slight delay so modal closes before callback runs
    setTimeout(() => btn.onPress?.(), 150);
  };

  const borderColor = borderGlow.interpolate({
    inputRange: [0, 1],
    outputRange: ['rgba(57, 197, 187, 0.15)', 'rgba(57, 197, 187, 0.45)'],
  });

  const iconInfo = icon ? iconConfig[icon] : null;

  return (
    <Modal visible={visible} transparent animationType="none" statusBarTranslucent onRequestClose={dismiss}>
      <TouchableWithoutFeedback onPress={dismiss}>
        <View style={s.overlay}>
          <BlurView intensity={25} tint="dark" style={StyleSheet.absoluteFill} />
          <View style={s.backdropTint} />

          <TouchableWithoutFeedback>
            <Animated.View style={[s.card, { opacity: opacityAnim, transform: [{ scale: scaleAnim }] }]}>
              {/* Animated border glow */}
              <Animated.View style={[s.borderGlow, { borderColor }]} />

              {/* Top accent line */}
              <View style={s.accentLine} />

              {/* Scan line effect */}
              <Animated.View style={[s.scanLine, { transform: [{ translateY: scanLine }] }]} />

              {/* Content */}
              <View style={s.content}>
                {/* Icon */}
                {iconInfo && (
                  <View style={s.iconRow}>
                    <View style={[s.iconCircle, { backgroundColor: `${iconInfo.color}18` }]}>
                      <Ionicons name={iconInfo.name} size={32} color={iconInfo.color} />
                    </View>
                  </View>
                )}

                {/* Title */}
                <Text style={s.title}>{title}</Text>

                {/* Message */}
                {!!message && <Text style={s.message}>{message}</Text>}

                {/* Buttons */}
                <View style={s.buttonsWrap}>
                  {buttons.map((btn, i) => {
                    const isDestructive = btn.style === 'destructive';
                    const isCancel = btn.style === 'cancel';
                    const isPrimary = !isDestructive && !isCancel;

                    return (
                      <TouchableOpacity
                        key={i}
                        onPress={() => handleButton(btn)}
                        activeOpacity={0.8}
                        style={[
                          s.button,
                          isPrimary && s.buttonPrimary,
                          isDestructive && s.buttonDestructive,
                          isCancel && s.buttonCancel,
                        ]}
                      >
                        <Text
                          style={[
                            s.buttonText,
                            isPrimary && s.buttonTextPrimary,
                            isDestructive && s.buttonTextDestructive,
                            isCancel && s.buttonTextCancel,
                          ]}
                        >
                          {btn.text}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              {/* Corner accents */}
              <View style={[s.corner, s.cornerBL]} />
              <View style={[s.corner, s.cornerBLV]} />
              <View style={[s.corner, s.cornerBR]} />
              <View style={[s.corner, s.cornerBRV]} />
            </Animated.View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const s = StyleSheet.create({
  overlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backdropTint: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
  },
  card: {
    width: '85%',
    maxWidth: 360,
    backgroundColor: Colors.surface ?? '#111113',
    borderRadius: 20,
    overflow: 'hidden',
  },
  borderGlow: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 20,
    borderWidth: 1,
  },
  accentLine: {
    height: 2,
    backgroundColor: P01Colors.cyan,
  },
  scanLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: 'rgba(57, 197, 187, 0.18)',
  },
  content: {
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 24,
  },
  iconRow: {
    alignItems: 'center',
    marginBottom: 16,
  },
  iconCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 18,
    fontFamily: FontFamily.bold,
    color: Colors.text,
    textAlign: 'center',
    marginBottom: 8,
  },
  message: {
    fontSize: 14,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 24,
  },
  buttonsWrap: {
    gap: 10,
  },
  button: {
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonPrimary: {
    backgroundColor: P01Colors.cyan,
  },
  buttonDestructive: {
    backgroundColor: '#ff3366',
  },
  buttonCancel: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  buttonText: {
    fontSize: 15,
    fontFamily: FontFamily.bold,
    letterSpacing: 0.3,
  },
  buttonTextPrimary: {
    color: '#0a0a0c',
  },
  buttonTextDestructive: {
    color: '#fff',
  },
  buttonTextCancel: {
    color: Colors.textTertiary,
  },
  // Corner accents
  corner: {
    position: 'absolute',
    backgroundColor: `${P01Colors.cyan}80`,
  },
  cornerBL: { bottom: 0, left: 0, width: 24, height: 2 },
  cornerBLV: { bottom: 0, left: 0, width: 2, height: 24 },
  cornerBR: { bottom: 0, right: 0, width: 24, height: 2 },
  cornerBRV: { bottom: 0, right: 0, width: 2, height: 24 },
});

export { AlertModal };

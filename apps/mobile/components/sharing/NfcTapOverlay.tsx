/**
 * NfcTapOverlay — hold the phones together.
 *
 * 🎯 REALIGNED ON constants/theme.ts 2026-08-23.
 *
 * ⛔ THE GLOW IS GONE. A 140pt cyan disc pulsed its opacity from 0.3 to 0.8
 * behind the icon: light emitted by the interface, which is the neon language
 * the brand is removing, and the brightest object on a screen whose job is to
 * say "hold still". The gentle scale pulse stays, because it is the only signal
 * that the phone is still listening.
 */

import React, { useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
  Easing,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, FontFamily, FontSize, BorderRadius, Spacing } from '@/constants/theme';

interface Props {
  pin?: string;
  isSender: boolean;
  onCancel: () => void;
}

export default function NfcTapOverlay({ pin, isSender, onCancel }: Props) {
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.15,
          duration: 1000,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 1000,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );

    pulse.start();

    return () => {
      pulse.stop();
    };
  }, []);

  return (
    <View style={styles.container}>
      {/* Pulsing NFC icon */}
      <Animated.View
        style={[styles.iconOuter, { transform: [{ scale: pulseAnim }] }]}
      >
        <View style={styles.iconInner}>
          <Ionicons name="phone-portrait-outline" size={40} color={Colors.primary} />
        </View>
      </Animated.View>

      <Text style={styles.title}>
        {isSender ? 'Ready to share' : 'Ready to receive'}
      </Text>
      <Text style={styles.subtitle}>
        Hold the phones back to back, near the NFC antenna.
      </Text>

      {pin && (
        <View style={styles.pinBox}>
          <Text style={styles.pinLabel}>
            {isSender ? 'Give this code to the receiver' : 'Enter this code on the sender'}
          </Text>
          <Text style={styles.pinCode}>{pin}</Text>
        </View>
      )}

      <TouchableOpacity
        style={styles.cancelBtn}
        onPress={onCancel}
        accessibilityRole="button"
        accessibilityLabel="Cancel"
      >
        <Text style={styles.cancelText}>Cancel</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.xl,
    backgroundColor: Colors.background,
  },
  iconOuter: {
    width: 120,
    height: 120,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing['2xl'],
  },
  iconInner: {
    width: 96,
    height: 96,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.surface,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.primaryMuted,
  },
  title: {
    fontSize: FontSize['2xl'],
    fontFamily: FontFamily.display,
    color: Colors.text,
    marginBottom: Spacing.sm,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: FontSize.md,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginBottom: Spacing['2xl'],
    lineHeight: 22,
  },
  pinBox: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    padding: Spacing.xl,
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    marginBottom: Spacing['2xl'],
    width: '100%',
  },
  pinLabel: {
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    marginBottom: Spacing.md,
    textAlign: 'center',
  },
  pinCode: {
    fontSize: FontSize['3xl'],
    fontFamily: FontFamily.monoMedium,
    color: Colors.text,
    letterSpacing: 8,
  },
  cancelBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: Spacing.xl,
    borderRadius: BorderRadius.md,
  },
  cancelText: { fontSize: FontSize.md, fontFamily: FontFamily.medium, color: Colors.textSecondary },
});

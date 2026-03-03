/**
 * NfcTapOverlay — Full-screen animation prompting users to tap phones together
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
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';

interface Props {
  pin?: string;
  isSender: boolean;
  onCancel: () => void;
}

export default function NfcTapOverlay({ pin, isSender, onCancel }: Props) {
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const glowAnim = useRef(new Animated.Value(0.3)).current;

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

    const glow = Animated.loop(
      Animated.sequence([
        Animated.timing(glowAnim, {
          toValue: 0.8,
          duration: 1200,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(glowAnim, {
          toValue: 0.3,
          duration: 1200,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );

    pulse.start();
    glow.start();

    return () => {
      pulse.stop();
      glow.stop();
    };
  }, []);

  return (
    <View style={styles.container}>
      {/* Pulsing NFC icon */}
      <Animated.View
        style={[styles.iconOuter, { transform: [{ scale: pulseAnim }] }]}
      >
        <Animated.View style={[styles.iconGlow, { opacity: glowAnim }]} />
        <View style={styles.iconInner}>
          <Ionicons name="phone-portrait" size={48} color={P01Colors.cyan} />
        </View>
      </Animated.View>

      <Text style={styles.title}>
        {isSender ? 'Ready to Share' : 'Ready to Receive'}
      </Text>
      <Text style={styles.subtitle}>
        Hold the phones back-to-back, near the NFC antenna area.
      </Text>

      {pin && (
        <View style={styles.pinBox}>
          <Text style={styles.pinLabel}>
            {isSender ? 'Share this code with the receiver:' : 'Enter this code on the sender:'}
          </Text>
          <Text style={styles.pinCode}>{pin}</Text>
        </View>
      )}

      <TouchableOpacity style={styles.cancelBtn} onPress={onCancel}>
        <Ionicons name="close" size={18} color={Colors.error} />
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
    width: 140,
    height: 140,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.xl,
  },
  iconGlow: {
    position: 'absolute',
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: P01Colors.cyan,
  },
  iconInner: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: P01Colors.cyanDim,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: P01Colors.cyan + '60',
  },
  title: {
    fontSize: 22,
    fontFamily: FontFamily.bold,
    color: Colors.text,
    marginBottom: Spacing.sm,
  },
  subtitle: {
    fontSize: 14,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginBottom: Spacing.xl,
    lineHeight: 20,
  },
  pinBox: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    padding: Spacing.lg,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: P01Colors.cyan + '40',
    marginBottom: Spacing.xl,
    width: '100%',
  },
  pinLabel: {
    fontSize: 13,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    marginBottom: Spacing.md,
  },
  pinCode: {
    fontSize: 36,
    fontFamily: FontFamily.mono,
    color: P01Colors.cyan,
    letterSpacing: 8,
  },
  cancelBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.errorDim,
  },
  cancelText: { fontSize: 15, fontFamily: FontFamily.semibold, color: Colors.error },
});

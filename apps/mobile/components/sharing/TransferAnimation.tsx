/**
 * TransferAnimation — dots moving between two phones while the note is in
 * flight.
 *
 * 🎯 REALIGNED ON constants/theme.ts 2026-08-23.
 *
 * ⛔ THE TRANSPORT BADGE WAS COLOUR-CODED BLUE FOR BLE AND PINK FOR NFC. The
 * pink was the retired accent, still reachable through `P01Colors.pink`, and
 * neither colour said anything the word next to it did not. One accent.
 *
 * ⚠️ The claim under the animation is about the TRANSPORT and stays: BLE is
 * X25519 + XSalsa20-Poly1305 between the two devices. It says nothing about
 * what the chain can see, and it must not start to.
 */

import React, { useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Animated,
  Easing,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, FontFamily, FontSize, BorderRadius, Spacing } from '@/constants/theme';

interface Props {
  isSending: boolean;
  transport: 'ble' | 'nfc';
  peerName?: string;
}

function AnimatedDot({ delay, isSending }: { delay: number; isSending: boolean }) {
  const translateX = useRef(new Animated.Value(isSending ? -40 : 40)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const startX = isSending ? -40 : 40;
    const endX = isSending ? 40 : -40;

    const anim = Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.parallel([
          Animated.timing(translateX, {
            toValue: endX,
            duration: 1000,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.sequence([
            Animated.timing(opacity, {
              toValue: 1,
              duration: 300,
              useNativeDriver: true,
            }),
            Animated.timing(opacity, {
              toValue: 1,
              duration: 400,
              useNativeDriver: true,
            }),
            Animated.timing(opacity, {
              toValue: 0,
              duration: 300,
              useNativeDriver: true,
            }),
          ]),
        ]),
        Animated.timing(translateX, {
          toValue: startX,
          duration: 0,
          useNativeDriver: true,
        }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [isSending, delay]);

  return (
    <Animated.View
      style={[
        styles.dot,
        {
          transform: [{ translateX }],
          opacity,
        },
      ]}
    />
  );
}

export default function TransferAnimation({ isSending, transport, peerName }: Props) {
  const scaleAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(scaleAnim, {
          toValue: 1.05,
          duration: 1500,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(scaleAnim, {
          toValue: 1,
          duration: 1500,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    pulse.start();
    return () => pulse.stop();
  }, []);

  const transportIcon = transport === 'ble' ? 'bluetooth' : 'phone-portrait-outline';

  return (
    <View style={styles.container}>
      {/* Transport badge */}
      <View style={styles.badge}>
        <Ionicons name={transportIcon} size={14} color={Colors.textSecondary} />
        <Text style={styles.badgeText}>
          {transport === 'ble' ? 'Bluetooth' : 'NFC'}
        </Text>
      </View>

      {/* Phone animation */}
      <Animated.View style={[styles.phonesRow, { transform: [{ scale: scaleAnim }] }]}>
        {/* Sender phone */}
        <View style={[styles.phoneBox, isSending && styles.phoneBoxActive]}>
          <Ionicons name="phone-portrait-outline" size={32} color={isSending ? Colors.primary : Colors.textSecondary} />
          <Text style={styles.phoneLabel}>{isSending ? 'You' : peerName || 'Peer'}</Text>
        </View>

        {/* Animated dots */}
        <View style={styles.dotsContainer}>
          <AnimatedDot delay={0} isSending={isSending} />
          <AnimatedDot delay={250} isSending={isSending} />
          <AnimatedDot delay={500} isSending={isSending} />
        </View>

        {/* Receiver phone */}
        <View style={[styles.phoneBox, !isSending && styles.phoneBoxActive]}>
          <Ionicons name="phone-portrait-outline" size={32} color={!isSending ? Colors.primary : Colors.textSecondary} />
          <Text style={styles.phoneLabel}>{!isSending ? 'You' : peerName || 'Peer'}</Text>
        </View>
      </Animated.View>

      {/* Status text */}
      <View style={styles.statusRow} accessibilityLiveRegion="polite">
        <Ionicons name="lock-closed-outline" size={14} color={Colors.textSecondary} />
        <Text style={styles.statusText}>
          {isSending ? 'Sending the encrypted note…' : 'Receiving the encrypted note…'}
        </Text>
      </View>

      <Text style={styles.hint}>
        The link between the two devices is end-to-end encrypted.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    paddingVertical: Spacing.xl,
    gap: Spacing.lg,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: 20,
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  badgeText: {
    fontSize: FontSize.xs, fontFamily: FontFamily.medium, color: Colors.textSecondary,
  },
  phonesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: Spacing.lg,
  },
  phoneBox: {
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.lg,
    paddingHorizontal: Spacing.xl,
    borderRadius: BorderRadius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  phoneBoxActive: {
    borderColor: Colors.primaryMuted,
  },
  phoneLabel: {
    fontSize: FontSize.xs,
    fontFamily: FontFamily.medium,
    color: Colors.textSecondary,
  },
  dotsContainer: {
    width: 80,
    height: 20,
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'row',
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.primary,
    position: 'absolute',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statusText: {
    fontSize: FontSize.md,
    fontFamily: FontFamily.medium,
    color: Colors.text,
  },
  hint: {
    fontSize: FontSize.xs,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    textAlign: 'center',
    lineHeight: 16,
    paddingHorizontal: Spacing.xl,
  },
});

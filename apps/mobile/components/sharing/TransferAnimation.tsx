/**
 * TransferAnimation — Full-screen overlay shown during active BLE/NFC data transfer
 *
 * Shows animated dots flowing between two phone icons (sender → receiver).
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
import { Colors, FontFamily, Spacing, P01Colors } from '@/constants/theme';

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

  const transportIcon = transport === 'ble' ? 'bluetooth' : 'phone-portrait';
  const transportColor = transport === 'ble' ? P01Colors.blue : P01Colors.pink;

  return (
    <View style={styles.container}>
      {/* Transport badge */}
      <View style={[styles.badge, { backgroundColor: transportColor + '20' }]}>
        <Ionicons name={transportIcon} size={14} color={transportColor} />
        <Text style={[styles.badgeText, { color: transportColor }]}>
          {transport === 'ble' ? 'Bluetooth' : 'NFC'}
        </Text>
      </View>

      {/* Phone animation */}
      <Animated.View style={[styles.phonesRow, { transform: [{ scale: scaleAnim }] }]}>
        {/* Sender phone */}
        <View style={[styles.phoneBox, isSending && styles.phoneBoxActive]}>
          <Ionicons name="phone-portrait" size={36} color={isSending ? P01Colors.cyan : Colors.textSecondary} />
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
          <Ionicons name="phone-portrait" size={36} color={!isSending ? P01Colors.cyan : Colors.textSecondary} />
          <Text style={styles.phoneLabel}>{!isSending ? 'You' : peerName || 'Peer'}</Text>
        </View>
      </Animated.View>

      {/* Status text */}
      <View style={styles.statusRow}>
        <Ionicons name="lock-closed" size={14} color={P01Colors.green} />
        <Text style={styles.statusText}>
          {isSending ? 'Sending encrypted note...' : 'Receiving encrypted note...'}
        </Text>
      </View>

      <Text style={styles.hint}>
        End-to-end encrypted. Only you and the recipient can read this note.
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
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  badgeText: { fontSize: 12, fontFamily: FontFamily.semibold },
  phonesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: Spacing.lg,
  },
  phoneBox: {
    alignItems: 'center',
    gap: 6,
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderRadius: 16,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  phoneBoxActive: {
    borderColor: P01Colors.cyan + '60',
    backgroundColor: P01Colors.cyanDim,
  },
  phoneLabel: {
    fontSize: 11,
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
    backgroundColor: P01Colors.cyan,
    position: 'absolute',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statusText: {
    fontSize: 15,
    fontFamily: FontFamily.semibold,
    color: Colors.text,
  },
  hint: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    textAlign: 'center',
    paddingHorizontal: Spacing.xl,
  },
});

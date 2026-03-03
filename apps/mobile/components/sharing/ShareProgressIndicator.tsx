/**
 * ShareProgressIndicator — Animated step progress for BLE/NFC sharing flow
 *
 * Steps: Connect → Verify → Encrypt → Send → Done
 * Active step pulses with a glow animation.
 */

import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, Easing } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, FontFamily, P01Colors, Spacing } from '@/constants/theme';
import type { ShareSessionState } from '@/services/sharing/types';

const STEPS = [
  { key: 'connect', label: 'Connect', icon: 'link' as const },
  { key: 'verify', label: 'Verify', icon: 'shield-checkmark' as const },
  { key: 'encrypt', label: 'Encrypt', icon: 'lock-closed' as const },
  { key: 'transfer', label: 'Transfer', icon: 'paper-plane' as const },
  { key: 'done', label: 'Done', icon: 'checkmark-circle' as const },
];

function stateToStepIndex(state: ShareSessionState): number {
  switch (state) {
    case 'scanning':
    case 'connecting':
    case 'key-exchange':
      return 0;
    case 'verifying-fingerprint':
      return 1;
    case 'encrypting':
    case 'decrypting':
      return 2;
    case 'sending':
    case 'receiving':
    case 'importing':
      return 3;
    case 'success':
      return 4;
    default:
      return -1;
  }
}

function stateLabel(state: ShareSessionState): string {
  switch (state) {
    case 'scanning': return 'Scanning for devices...';
    case 'connecting': return 'Connecting...';
    case 'key-exchange': return 'Exchanging keys...';
    case 'verifying-fingerprint': return 'Verify fingerprint';
    case 'encrypting': return 'Encrypting note...';
    case 'decrypting': return 'Decrypting note...';
    case 'sending': return 'Sending encrypted note...';
    case 'receiving': return 'Receiving note...';
    case 'importing': return 'Importing note...';
    case 'success': return 'Transfer complete!';
    case 'error': return 'Transfer failed';
    default: return '';
  }
}

function PulsingCircle({
  icon,
  color,
  isActive,
  isCompleted,
}: {
  icon: string;
  color: string;
  isActive: boolean;
  isCompleted: boolean;
}) {
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const glowAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (isActive) {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.2,
            duration: 800,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 800,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ]),
      );
      const glow = Animated.loop(
        Animated.sequence([
          Animated.timing(glowAnim, {
            toValue: 0.4,
            duration: 800,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(glowAnim, {
            toValue: 0,
            duration: 800,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ]),
      );
      pulse.start();
      glow.start();
      return () => { pulse.stop(); glow.stop(); };
    } else {
      pulseAnim.setValue(1);
      glowAnim.setValue(0);
    }
  }, [isActive]);

  return (
    <View style={circleStyles.wrapper}>
      {isActive && (
        <Animated.View
          style={[
            circleStyles.glow,
            {
              opacity: glowAnim,
              backgroundColor: color,
              transform: [{ scale: pulseAnim }],
            },
          ]}
        />
      )}
      <Animated.View
        style={[
          circleStyles.circle,
          {
            borderColor: color,
            backgroundColor: isCompleted ? color + '25' : 'transparent',
            transform: [{ scale: isActive ? pulseAnim : 1 }],
          },
        ]}
      >
        {isCompleted ? (
          <Ionicons name="checkmark" size={14} color={color} />
        ) : (
          <Ionicons name={icon as any} size={14} color={color} />
        )}
      </Animated.View>
    </View>
  );
}

const circleStyles = StyleSheet.create({
  wrapper: { width: 36, height: 36, justifyContent: 'center', alignItems: 'center' },
  glow: {
    position: 'absolute',
    width: 36,
    height: 36,
    borderRadius: 18,
  },
  circle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1.5,
    justifyContent: 'center',
    alignItems: 'center',
  },
});

interface Props {
  state: ShareSessionState;
}

export default function ShareProgressIndicator({ state }: Props) {
  const activeIndex = stateToStepIndex(state);
  const label = stateLabel(state);

  return (
    <View style={styles.outer}>
      <View style={styles.container}>
        {STEPS.map((step, i) => {
          const isCompleted = i < activeIndex;
          const isActive = i === activeIndex;
          const color = isCompleted
            ? P01Colors.green
            : isActive
            ? P01Colors.cyan
            : Colors.textTertiary;

          return (
            <React.Fragment key={step.key}>
              {i > 0 && (
                <View
                  style={[
                    styles.line,
                    { backgroundColor: isCompleted ? P01Colors.green : Colors.border },
                  ]}
                />
              )}
              <View style={styles.step}>
                <PulsingCircle
                  icon={step.icon}
                  color={color}
                  isActive={isActive}
                  isCompleted={isCompleted}
                />
                <Text style={[styles.stepLabel, { color }]}>{step.label}</Text>
              </View>
            </React.Fragment>
          );
        })}
      </View>
      {label ? (
        <Text style={[
          styles.statusLabel,
          state === 'success' && { color: P01Colors.green },
          state === 'error' && { color: Colors.error },
        ]}>
          {label}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  outer: { alignItems: 'center', paddingVertical: Spacing.md },
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.md,
  },
  step: { alignItems: 'center', gap: 4 },
  line: { flex: 1, height: 1.5, marginHorizontal: 2 },
  stepLabel: { fontSize: 10, fontFamily: FontFamily.medium },
  statusLabel: {
    marginTop: Spacing.sm,
    fontSize: 13,
    fontFamily: FontFamily.medium,
    color: P01Colors.cyan,
  },
});

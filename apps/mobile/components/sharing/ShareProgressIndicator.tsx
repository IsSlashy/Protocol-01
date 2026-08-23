/**
 * ShareProgressIndicator — where the transfer has got to.
 *
 * Steps: Connect → Verify → Encrypt → Transfer → Done.
 *
 * 🎯 REALIGNED ON constants/theme.ts 2026-08-23.
 *
 * ⛔ THE GLOW BEHIND THE ACTIVE STEP IS GONE — a coloured disc pulsing its
 * opacity under the circle, which is the neon treatment the brand is removing.
 * The scale pulse is what says "this one is happening"; the light did not add a
 * second fact, it just emitted.
 *
 * ⛔ AND COMPLETED IS NO LONGER A DIFFERENT COLOUR FROM ACTIVE. Completed was
 * the retired green, active was cyan, and pending was grey: three colours for
 * one axis. Done and doing are both the accent; the checkmark is what separates
 * them, and it survives a screenshot in greyscale.
 */

import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, Easing } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, FontFamily, FontSize, Spacing } from '@/constants/theme';
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
    case 'scanning': return 'Scanning for devices…';
    case 'connecting': return 'Connecting…';
    case 'key-exchange': return 'Exchanging keys…';
    case 'verifying-fingerprint': return 'Verify the code';
    case 'encrypting': return 'Encrypting the note…';
    case 'decrypting': return 'Decrypting the note…';
    case 'sending': return 'Sending the encrypted note…';
    case 'receiving': return 'Receiving the note…';
    case 'importing': return 'Importing the note…';
    case 'success': return 'Transfer complete';
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

  useEffect(() => {
    if (isActive) {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.12,
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
      pulse.start();
      return () => { pulse.stop(); };
    } else {
      pulseAnim.setValue(1);
    }
  }, [isActive]);

  return (
    <View style={circleStyles.wrapper}>
      <Animated.View
        style={[
          circleStyles.circle,
          {
            borderColor: color,
            transform: [{ scale: isActive ? pulseAnim : 1 }],
          },
          isCompleted && circleStyles.circleCompleted,
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
  circle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  circleCompleted: { backgroundColor: Colors.primaryDim },
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
          // Reached or reaching is the accent; not yet is quiet. One axis, two
          // states, and the checkmark inside the circle carries the third fact.
          const color = isCompleted || isActive ? Colors.primary : Colors.textTertiary;

          return (
            <React.Fragment key={step.key}>
              {i > 0 && (
                <View
                  style={[
                    styles.line,
                    { backgroundColor: isCompleted ? Colors.primary : Colors.border },
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
        <Text
          style={[styles.statusLabel, state === 'error' && styles.statusLabelError]}
          accessibilityLiveRegion="polite"
        >
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
  line: { flex: 1, height: 1, marginHorizontal: 2 },
  stepLabel: { fontSize: 10, fontFamily: FontFamily.medium },
  statusLabel: {
    marginTop: Spacing.sm,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
  },
  statusLabelError: { color: Colors.error },
});

import React, { useEffect } from 'react';
import { View, Text, Modal, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  withSpring,
  FadeIn,
} from 'react-native-reanimated';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';

type Operation = 'shield' | 'unshield' | 'import' | 'deposit' | 'withdraw' | 'transfer' | 'sweep';

interface ZkProgressOverlayProps {
  visible: boolean;
  operation: Operation | null;
  progressStep: number;
  progressMessage: string;
  /** Step labels — defaults to ['Prepare', 'ZK Proof', 'Submit', 'Done'] */
  stepLabels?: string[];
  /** Step thresholds — defaults to [10, 50, 85, 100] */
  stepThresholds?: number[];
}

const OPERATION_CONFIG: Record<
  Operation,
  { icon: keyof typeof Ionicons.glyphMap; color: string; dimColor: string; title: string }
> = {
  shield: { icon: 'arrow-down', color: P01Colors.cyan, dimColor: P01Colors.cyanDim, title: 'Shielding SOL' },
  unshield: { icon: 'arrow-up', color: P01Colors.pink, dimColor: P01Colors.pinkDim, title: 'Unshielding SOL' },
  import: { icon: 'download', color: P01Colors.yellow, dimColor: P01Colors.yellowDim, title: 'Importing Note' },
  deposit: { icon: 'arrow-down', color: P01Colors.cyan, dimColor: P01Colors.cyanDim, title: 'Depositing SOL' },
  withdraw: { icon: 'arrow-up', color: P01Colors.pink, dimColor: P01Colors.pinkDim, title: 'Withdrawing SOL' },
  transfer: { icon: 'flash', color: P01Colors.blue, dimColor: P01Colors.blueDim, title: 'Sending Transfer' },
  sweep: { icon: 'arrow-undo', color: P01Colors.cyanBright, dimColor: P01Colors.cyanDim, title: 'Private Sweep' },
};

const DEFAULT_LABELS = ['Prepare', 'ZK Proof', 'Submit', 'Done'];
const DEFAULT_THRESHOLDS = [10, 50, 85, 100];

/**
 * Returns a brighter version of a hex color by blending toward white.
 */
function brighten(hex: string, amount = 0.35): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const br = Math.min(255, Math.round(r + (255 - r) * amount));
  const bg = Math.min(255, Math.round(g + (255 - g) * amount));
  const bb = Math.min(255, Math.round(b + (255 - b) * amount));
  return `#${br.toString(16).padStart(2, '0')}${bg.toString(16).padStart(2, '0')}${bb.toString(16).padStart(2, '0')}`;
}

/**
 * Converts a hex color to rgba string.
 */
function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export default function ZkProgressOverlay({
  visible,
  operation,
  progressStep,
  progressMessage,
  stepLabels = DEFAULT_LABELS,
  stepThresholds = DEFAULT_THRESHOLDS,
}: ZkProgressOverlayProps) {
  // -- Animated values --
  const glowOpacity = useSharedValue(0.3);
  const completionScale = useSharedValue(0);

  // Pulsing glow ring around icon
  useEffect(() => {
    glowOpacity.value = withRepeat(
      withSequence(
        withTiming(0.8, { duration: 1200 }),
        withTiming(0.3, { duration: 1200 }),
      ),
      -1,
      false,
    );
  }, []);

  // Completion checkmark scale-in
  useEffect(() => {
    if (progressStep >= 100) {
      completionScale.value = withSpring(1, { damping: 12, stiffness: 180, mass: 0.8 });
    } else {
      completionScale.value = 0;
    }
  }, [progressStep]);

  const glowStyle = useAnimatedStyle(() => ({
    opacity: glowOpacity.value,
  }));

  const completionStyle = useAnimatedStyle(() => ({
    transform: [{ scale: completionScale.value }],
    opacity: completionScale.value,
  }));

  if (!operation) return null;

  const config = OPERATION_CONFIG[operation];
  const isComplete = progressStep >= 100;
  const brighterColor = brighten(config.color, 0.4);

  /**
   * Determine step state:
   * - 'done': progressStep >= threshold for this step
   * - 'active': progressStep >= previous threshold but < this threshold (current step)
   * - 'pending': not yet reached
   */
  const getStepState = (index: number): 'done' | 'active' | 'pending' => {
    if (progressStep >= stepThresholds[index]) return 'done';
    const prevThreshold = index > 0 ? stepThresholds[index - 1] : 0;
    if (progressStep >= prevThreshold) return 'active';
    return 'pending';
  };

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={() => {}}>
      <View style={styles.overlay}>
        <View style={[styles.modal, { borderColor: hexToRgba(config.color, 0.15) }]}>

          {/* Icon with pulsing glow ring */}
          {!isComplete ? (
            <View style={styles.iconWrapper}>
              <Animated.View
                style={[
                  styles.glowRing,
                  { backgroundColor: hexToRgba(config.color, 0.2) },
                  glowStyle,
                ]}
              />
              <View style={[styles.iconCircle, { backgroundColor: config.dimColor }]}>
                <Ionicons name={config.icon} size={32} color={config.color} />
              </View>
            </View>
          ) : (
            <Animated.View style={[styles.completionIcon, completionStyle]}>
              <Ionicons name="checkmark-circle" size={72} color={P01Colors.green} />
            </Animated.View>
          )}

          {/* Title */}
          <Text style={styles.title}>
            {isComplete ? 'Complete' : config.title}
          </Text>

          {/* Progress bar with gradient fill */}
          <View style={styles.barContainer}>
            <View style={styles.barTrack}>
              <View style={[styles.barFillWrapper, { width: `${Math.min(progressStep, 100)}%` }]}>
                <LinearGradient
                  colors={[config.color, brighterColor] as [string, string]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 0 }}
                  style={styles.barGradient}
                />
                {/* Glow on the fill */}
                <View
                  style={[
                    styles.barGlow,
                    {
                      shadowColor: config.color,
                      backgroundColor: 'transparent',
                    },
                  ]}
                />
              </View>
            </View>
            <Text style={styles.percent}>{Math.round(progressStep)}%</Text>
          </View>

          {/* Status message */}
          <Text style={[styles.status, { color: config.color }]} numberOfLines={2}>
            {progressMessage}
          </Text>

          {/* Step indicator: circles connected by lines */}
          <View style={styles.stepsRow}>
            {stepLabels.map((label, i) => {
              const state = getStepState(i);
              const isDone = state === 'done';
              const isActive = state === 'active';
              const dotSize = isActive ? 14 : 10;

              return (
                <React.Fragment key={label}>
                  {/* Connector line between steps */}
                  {i > 0 && (
                    <View style={styles.connectorWrapper}>
                      <View
                        style={[
                          styles.connectorLine,
                          isDone && { backgroundColor: config.color },
                        ]}
                      />
                    </View>
                  )}

                  {/* Step dot + label */}
                  <View style={styles.stepColumn}>
                    <View style={styles.dotContainer}>
                      {/* Active ring */}
                      {isActive && (
                        <View
                          style={[
                            styles.activeRing,
                            { borderColor: hexToRgba(config.color, 0.4) },
                          ]}
                        />
                      )}
                      <View
                        style={[
                          styles.stepDot,
                          { width: dotSize, height: dotSize, borderRadius: dotSize / 2 },
                          isDone && { backgroundColor: config.color },
                          isActive && {
                            backgroundColor: config.color,
                          },
                        ]}
                      />
                    </View>
                    <Text
                      style={[
                        styles.stepLabel,
                        (isDone || isActive) && { color: Colors.textPrimary },
                      ]}
                    >
                      {label}
                    </Text>
                  </View>
                </React.Fragment>
              );
            })}
          </View>

          {/* Warning message with phone icon */}
          {!isComplete && (
            <View style={styles.warningRow}>
              <Ionicons
                name="phone-portrait-outline"
                size={14}
                color={Colors.textTertiary}
                style={styles.warningIcon}
              />
              <Text style={styles.warningText}>Please keep the app open</Text>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  /* ---- Overlay / Modal ---- */
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.92)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.xl,
  },
  modal: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    padding: Spacing['3xl'],
    width: '100%',
    maxWidth: 360,
    alignItems: 'center',
  },

  /* ---- Icon with glow ring ---- */
  iconWrapper: {
    width: 88,
    height: 88,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.xl,
  },
  glowRing: {
    position: 'absolute',
    width: 88,
    height: 88,
    borderRadius: 44,
  },
  iconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },

  /* ---- Completion checkmark ---- */
  completionIcon: {
    marginBottom: Spacing.xl,
    alignItems: 'center',
    justifyContent: 'center',
  },

  /* ---- Title ---- */
  title: {
    fontSize: 22,
    fontFamily: FontFamily.bold,
    color: Colors.textPrimary,
    marginBottom: Spacing.xl,
    letterSpacing: 0.3,
  },

  /* ---- Progress bar ---- */
  barContainer: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    marginBottom: Spacing.lg,
  },
  barTrack: {
    flex: 1,
    height: 10,
    backgroundColor: Colors.background,
    borderRadius: 5,
    overflow: 'hidden',
  },
  barFillWrapper: {
    height: '100%',
    borderRadius: 5,
    overflow: 'hidden',
    position: 'relative',
  },
  barGradient: {
    flex: 1,
    borderRadius: 5,
  },
  barGlow: {
    position: 'absolute',
    top: -2,
    left: 0,
    right: 0,
    bottom: -2,
    borderRadius: 5,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 6,
    elevation: 4,
  },
  percent: {
    fontSize: 14,
    fontFamily: FontFamily.bold,
    color: Colors.textSecondary,
    minWidth: 42,
    textAlign: 'right',
  },

  /* ---- Status text ---- */
  status: {
    fontSize: 14,
    fontFamily: FontFamily.medium,
    textAlign: 'center',
    marginBottom: Spacing.xl,
    lineHeight: 20,
  },

  /* ---- Step indicator ---- */
  stepsRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'center',
    width: '100%',
    marginBottom: Spacing.lg,
    paddingHorizontal: Spacing.xs,
  },
  connectorWrapper: {
    flex: 1,
    justifyContent: 'center',
    paddingTop: 7, // vertically center with 14px dot
  },
  connectorLine: {
    height: 2,
    backgroundColor: Colors.border,
    borderRadius: 1,
  },
  stepColumn: {
    alignItems: 'center',
    minWidth: 44,
  },
  dotContainer: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  activeRing: {
    position: 'absolute',
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
  },
  stepDot: {
    backgroundColor: Colors.border,
  },
  stepLabel: {
    fontSize: 11,
    fontFamily: FontFamily.medium,
    color: Colors.textTertiary,
    textAlign: 'center',
  },

  /* ---- Warning ---- */
  warningRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: Spacing.sm,
  },
  warningIcon: {
    marginRight: 6,
  },
  warningText: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
  },
});

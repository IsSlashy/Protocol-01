/**
 * FingerprintVerification — the man-in-the-middle check, as a comparison the
 * user makes with their eyes.
 *
 * Six hex blocks that both devices must show. Confirmed by visual comparison,
 * the way Signal safety numbers are.
 *
 * 🎯 REALIGNED ON constants/theme.ts 2026-08-23. The code itself is the only
 * thing on this card that the accent is spent on now: the shield disc above the
 * title was a second cyan object competing with the six digits the whole modal
 * exists to make you read.
 */

import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Modal,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Colors, FontFamily, FontSize, BorderRadius, Spacing } from '@/constants/theme';

interface Props {
  visible: boolean;
  fingerprint: string;
  peerName?: string;
  onConfirm: () => void;
  onReject: () => void;
}

export default function FingerprintVerification({
  visible,
  fingerprint,
  peerName,
  onConfirm,
  onReject,
}: Props) {
  const handleConfirm = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    onConfirm();
  };

  const handleReject = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    onReject();
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      // Android back button must NOT silently dismiss — treat as reject so the
      // session is torn down cleanly and the user can't fall through to send.
      onRequestClose={handleReject}
    >
      <View style={styles.overlay}>
        <View style={styles.card}>
          {/* Header */}
          <View style={styles.iconRow}>
            <View style={styles.shieldIcon}>
              <Ionicons name="shield-checkmark-outline" size={24} color={Colors.textSecondary} />
            </View>
          </View>

          <Text style={styles.title}>Verify the connection</Text>
          <Text style={styles.subtitle}>
            Compare this code with{' '}
            {peerName ? (
              <Text style={styles.peerName}>{peerName}</Text>
            ) : (
              'the other device'
            )}
            . Both screens must show the same code.
          </Text>

          {/* Fingerprint display */}
          <View style={styles.fingerprintBox}>
            <Text style={styles.fingerprintText} accessibilityLabel={`Code ${fingerprint}`}>
              {fingerprint}
            </Text>
          </View>

          <Text style={styles.hint}>
            If the codes differ, choose “They differ” — someone may be intercepting the
            connection.
          </Text>

          {/* Actions */}
          <View style={styles.actions}>
            <TouchableOpacity
              style={styles.rejectBtn}
              onPress={handleReject}
              accessibilityRole="button"
              accessibilityLabel="The codes differ, cancel the connection"
            >
              <Text style={styles.rejectText}>They differ</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.confirmBtn}
              onPress={handleConfirm}
              accessibilityRole="button"
              accessibilityLabel="The codes match, continue"
            >
              <Text style={styles.confirmText}>They match</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

/**
 * The scrim, derived from the ground token the way `components/ui/AlertModal`
 * derives it, so a change to the ink reaches it. `b8` is 0.72 in the 8-digit
 * hex form React Native accepts.
 */
const SCRIM = `${Colors.background}b8`;

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: SCRIM,
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.xl,
  },
  card: {
    width: '100%',
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    padding: Spacing['2xl'],
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  iconRow: { marginBottom: Spacing.lg },
  shieldIcon: {
    width: 48,
    height: 48,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.surfaceTertiary,
    justifyContent: 'center',
    alignItems: 'center',
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
    lineHeight: 22,
    marginBottom: Spacing.xl,
  },
  peerName: { fontFamily: FontFamily.medium, color: Colors.text },
  fingerprintBox: {
    backgroundColor: Colors.background,
    borderRadius: BorderRadius.md,
    paddingVertical: Spacing.xl,
    paddingHorizontal: Spacing.xl,
    marginBottom: Spacing.lg,
    borderWidth: 1,
    borderColor: Colors.primaryMuted,
    width: '100%',
    alignItems: 'center',
  },
  fingerprintText: {
    fontSize: FontSize.xl,
    fontFamily: FontFamily.monoMedium,
    color: Colors.primary,
    letterSpacing: 2,
    textAlign: 'center',
  },
  hint: {
    fontSize: FontSize.xs,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    textAlign: 'center',
    marginBottom: Spacing.xl,
    lineHeight: 17,
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.md,
    width: '100%',
  },
  rejectBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: Spacing.lg,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.errorDim,
    borderWidth: 1,
    borderColor: Colors.error,
  },
  rejectText: { fontSize: FontSize.md, fontFamily: FontFamily.medium, color: Colors.error },
  confirmBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: Spacing.lg,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.primary,
  },
  confirmText: { fontSize: FontSize.md, fontFamily: FontFamily.medium, color: Colors.background },
});

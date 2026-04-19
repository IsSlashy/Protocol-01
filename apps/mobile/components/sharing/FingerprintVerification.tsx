/**
 * FingerprintVerification — Modal showing visual fingerprint for MITM check
 *
 * Displays 6 hex blocks that both devices should match.
 * Users confirm by visual comparison (like Signal safety numbers).
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
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';

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
              <Ionicons name="shield-checkmark" size={32} color={P01Colors.cyan} />
            </View>
          </View>

          <Text style={styles.title}>Verify Connection</Text>
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
            <Text style={styles.fingerprintText}>{fingerprint}</Text>
          </View>

          <Text style={styles.hint}>
            If the codes don't match, tap "No Match" — someone may be intercepting the connection.
          </Text>

          {/* Actions */}
          <View style={styles.actions}>
            <TouchableOpacity style={styles.rejectBtn} onPress={handleReject}>
              <Ionicons name="close" size={18} color={Colors.error} />
              <Text style={styles.rejectText}>No Match</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.confirmBtn} onPress={handleConfirm}>
              <Ionicons name="checkmark" size={18} color="#000" />
              <Text style={styles.confirmText}>Codes Match</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.xl,
  },
  card: {
    width: '100%',
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    padding: Spacing.xl,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
  },
  iconRow: { marginBottom: Spacing.md },
  shieldIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: P01Colors.cyanDim,
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    fontSize: 20,
    fontFamily: FontFamily.bold,
    color: Colors.text,
    marginBottom: Spacing.sm,
  },
  subtitle: {
    fontSize: 14,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: Spacing.lg,
  },
  peerName: { fontFamily: FontFamily.semibold, color: P01Colors.cyan },
  fingerprintBox: {
    backgroundColor: Colors.background,
    borderRadius: BorderRadius.md,
    paddingVertical: Spacing.lg,
    paddingHorizontal: Spacing.xl,
    marginBottom: Spacing.lg,
    borderWidth: 1,
    borderColor: P01Colors.cyan + '40',
    width: '100%',
    alignItems: 'center',
  },
  fingerprintText: {
    fontSize: 20,
    fontFamily: FontFamily.mono,
    color: P01Colors.cyan,
    letterSpacing: 2,
    textAlign: 'center',
  },
  hint: {
    fontSize: 12,
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
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 14,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.errorDim,
    borderWidth: 1,
    borderColor: Colors.error + '40',
  },
  rejectText: { fontSize: 15, fontFamily: FontFamily.semibold, color: Colors.error },
  confirmBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 14,
    borderRadius: BorderRadius.md,
    backgroundColor: P01Colors.cyan,
  },
  confirmText: { fontSize: 15, fontFamily: FontFamily.bold, color: '#000' },
});

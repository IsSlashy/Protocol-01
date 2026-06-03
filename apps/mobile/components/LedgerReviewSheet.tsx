/**
 * LedgerReviewSheet — per-sign review modal for hardware (Ledger) signing.
 *
 * Shown right before the device is prompted to co-sign an on-chain tx (spec §1C,
 * UI-6). Surfaces the actionable error states the Ledger Solana app can return:
 *   - 0x6808 BLIND_SIGNATURE_REQUIRED → "Allow blind sign" one-time explainer
 *   - 0x6985 user rejected on device
 *   - disconnect / timeout
 *
 * This is a presentation component. The owning screen/flow drives `status` and
 * wires the actual transport/signer (services/ledger/*). It does not itself open
 * a transport.
 */

import React from 'react';
import { View, Text, Modal, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';

export type LedgerReviewStatus =
  | 'idle'
  | 'awaiting-device'   // waiting for the user to confirm on the Ledger
  | 'blind-sign-required' // 0x6808
  | 'user-rejected'     // 0x6985
  | 'disconnected'      // BLE dropped
  | 'timeout'           // device did not respond
  | 'error';

export interface LedgerReviewSheetProps {
  visible: boolean;
  status: LedgerReviewStatus;
  /** One-line summary of what is being signed (e.g. "Unshield 0.1 SOL"). */
  summary?: string;
  errorMessage?: string;
  onRetry?: () => void;
  onCancel: () => void;
}

function statusContent(status: LedgerReviewStatus): {
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  title: string;
  body: string;
} {
  switch (status) {
    case 'awaiting-device':
      return {
        icon: 'hardware-chip-outline',
        color: P01Colors.cyan,
        title: 'Confirm on your Ledger',
        body: 'Review the transaction on your device and approve it to continue.',
      };
    case 'blind-sign-required':
      return {
        icon: 'warning-outline',
        color: '#eab308',
        title: 'Enable blind signing',
        body:
          'Protocol 01 uses a custom Solana program. On your Ledger, open the Solana app → ' +
          'Settings → enable "Allow blind sign", then retry.',
      };
    case 'user-rejected':
      return {
        icon: 'close-circle-outline',
        color: '#ef4444',
        title: 'Rejected on device',
        body: 'You declined the transaction on your Ledger. Nothing was signed.',
      };
    case 'disconnected':
      return {
        icon: 'bluetooth-outline',
        color: '#ef4444',
        title: 'Ledger disconnected',
        body: 'The Bluetooth connection to your Ledger dropped. Reconnect and try again.',
      };
    case 'timeout':
      return {
        icon: 'time-outline',
        color: '#eab308',
        title: 'No response',
        body: 'Your Ledger did not respond in time. Make sure the Solana app is open, then retry.',
      };
    case 'error':
      return {
        icon: 'alert-circle-outline',
        color: '#ef4444',
        title: 'Signing failed',
        body: 'Something went wrong while signing with your Ledger.',
      };
    default:
      return {
        icon: 'hardware-chip-outline',
        color: P01Colors.cyan,
        title: 'Ledger',
        body: '',
      };
  }
}

export function LedgerReviewSheet({
  visible,
  status,
  summary,
  errorMessage,
  onRetry,
  onCancel,
}: LedgerReviewSheetProps) {
  const c = statusContent(status);
  const isWaiting = status === 'awaiting-device';
  const canRetry =
    !!onRetry &&
    (status === 'blind-sign-required' ||
      status === 'user-rejected' ||
      status === 'disconnected' ||
      status === 'timeout' ||
      status === 'error');

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={[styles.iconWrap, { backgroundColor: `${c.color}22` }]}>
            {isWaiting ? (
              <ActivityIndicator color={c.color} />
            ) : (
              <Ionicons name={c.icon} size={28} color={c.color} />
            )}
          </View>

          <Text style={styles.title}>{c.title}</Text>
          {summary ? <Text style={styles.summary}>{summary}</Text> : null}
          <Text style={styles.body}>{errorMessage || c.body}</Text>

          <View style={styles.actions}>
            {canRetry ? (
              <TouchableOpacity style={styles.primaryButton} onPress={onRetry} activeOpacity={0.85}>
                <Text style={styles.primaryButtonText}>Try again</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity style={styles.secondaryButton} onPress={onCancel} activeOpacity={0.7}>
              <Text style={styles.secondaryButtonText}>{isWaiting ? 'Cancel' : 'Close'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.lg,
  },
  sheet: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: '#0f0f12',
    borderRadius: BorderRadius.xl,
    padding: Spacing.xl,
    alignItems: 'center',
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.lg,
  },
  title: {
    color: Colors.text,
    fontSize: 18,
    fontFamily: FontFamily.semibold,
    textAlign: 'center',
    marginBottom: Spacing.xs,
  },
  summary: {
    color: P01Colors.cyan,
    fontSize: 14,
    fontFamily: FontFamily.medium,
    textAlign: 'center',
    marginBottom: Spacing.sm,
  },
  body: {
    color: Colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    marginBottom: Spacing.lg,
  },
  actions: { width: '100%', gap: Spacing.sm },
  primaryButton: {
    backgroundColor: P01Colors.cyan,
    paddingVertical: Spacing.md + 2,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
  },
  primaryButtonText: { color: Colors.background, fontFamily: FontFamily.semibold, fontSize: 16 },
  secondaryButton: {
    paddingVertical: Spacing.md + 2,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  secondaryButtonText: { color: Colors.text, fontFamily: FontFamily.semibold, fontSize: 16 },
});

export default LedgerReviewSheet;

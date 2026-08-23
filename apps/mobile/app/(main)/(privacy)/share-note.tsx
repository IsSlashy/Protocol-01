/**
 * Share a note to a nearby device.
 *
 * 🎯 REBUILT ON THE REALIGNED THEME 2026-08-23. What this used to be: every
 * panel was a `BlurView` over a translucent grey with a `LinearGradient`
 * stacked on top, and four of those gradients ran cyan into `rgba(255, 119,
 * 168, …)` — the retired hot pink, hardcoded here where the theme sweep could
 * not reach it. So the screen kept a second accent after the brand dropped it,
 * and paid for it with three composited layers per card. Panels are a fill and
 * a hairline now, which is what the site and the extension draw.
 *
 * ⚠️ THE SUCCESS VIEW STAYS A VIEW, NOT A NAVIGATION. It is tempting to bounce
 * the user back automatically, and the comment below the imports says why that
 * is a bug: `success` survives from a previous session, so an effect watching
 * it fires on a screen nobody just finished. It is one line and one button.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';

import { useSharingStore } from '@/stores/sharingStore';
import { useDenominatedPoolStore } from '@/stores/denominatedPoolStore';
import type { TransportType } from '@/services/sharing/types';
import { Colors, FontFamily, FontSize, BorderRadius, Spacing } from '@/constants/theme';
import { Button } from '@/components/ui';
import { p01Alert } from '@/stores/alertStore';

import BleDeviceList from '@/components/sharing/BleDeviceList';
import FingerprintVerification from '@/components/sharing/FingerprintVerification';
import NfcTapOverlay from '@/components/sharing/NfcTapOverlay';
import ShareProgressIndicator from '@/components/sharing/ShareProgressIndicator';
import TransferAnimation from '@/components/sharing/TransferAnimation';

export default function ShareNoteScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ noteData?: string; noteId?: string }>();

  const {
    nearbyPeers,
    activeSession,
    isScanning,
    isBleAvailable,
    isNfcAvailable,
    error,
    checkAvailability,
    startBleScan,
    connectToPeer,
    confirmFingerprintAndSend,
    generateNfcPin,
    sendViaNfc,
    cancelSession,
    clearError,
  } = useSharingStore();

  const [selectedTransport, setSelectedTransport] = useState<TransportType | null>(null);
  const [noteData] = useState<string>(params.noteData || '');
  const [nfcPinInput, setNfcPinInput] = useState('');
  const [showNfcOverlay, setShowNfcOverlay] = useState(false);

  useEffect(() => {
    cancelSession();   // Clear stale session from previous receive/send
    checkAvailability();
  }, []);

  const sessionState = activeSession?.state || 'idle';
  const showFingerprint = sessionState === 'verifying-fingerprint' && activeSession?.fingerprint;
  const isSuccess = sessionState === 'success';

  // Mark the note as transferred when share succeeds OR when NFC data was sent
  // (NFC: once data leaves the device, receiver may have it even if sender gets an error)
  const markNoteTransferred = useCallback(() => {
    if (params.noteId) {
      console.log('[ShareNote] markNoteTransferred:', params.noteId);
      useDenominatedPoolStore.setState((state) => ({
        notes: state.notes.map((n) =>
          n.id === params.noteId ? { ...n, status: 'transferred' as any } : n
        ),
      }));
    }
  }, [params.noteId]);

  // NOTE: Do NOT add a useEffect watching isSuccess here.
  // Both send paths (BLE: handleFingerprintConfirm, NFC: handleStartNfc)
  // already call markNoteTransferred() explicitly after confirmed delivery.
  // A useEffect would fire on stale 'success' state from previous sessions.

  // No note = can't do anything
  if (!noteData) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <Animated.View entering={FadeInDown.delay(50)} style={styles.header}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={styles.backBtn}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Ionicons name="chevron-back" size={22} color={Colors.textSecondary} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Share note</Text>
          <View style={styles.headerSpacer} />
        </Animated.View>
        <View style={styles.centered}>
          <Animated.View entering={FadeInUp.delay(100)} style={styles.emptyContent}>
            <View style={styles.emptyIcon}>
              <Ionicons name="radio-outline" size={28} color={Colors.textTertiary} />
            </View>
            <Text style={styles.emptyTitle}>No note selected</Text>
            <Text style={styles.emptyText}>
              Open your notes and choose Nearby on a mature note to share it.
            </Text>
            <View style={styles.emptyAction}>
              <Button variant="primary" size="lg" fullWidth onPress={() => router.back()}>
                Back to notes
              </Button>
            </View>
          </Animated.View>
        </View>
      </SafeAreaView>
    );
  }

  // --- BLE ---
  const handleStartBle = useCallback(async () => {
    setSelectedTransport('ble');
    clearError();
    try { await startBleScan(); }
    catch (err) { p01Alert('Bluetooth Error', (err as Error).message); }
  }, [startBleScan, clearError]);

  const handleSelectPeer = useCallback(async (peer: any) => {
    try { await connectToPeer(peer.id); }
    catch (err: any) {
      const msg = err?.reason || err?.message || 'Unknown BLE error';
      p01Alert('Connection Failed', msg);
    }
  }, [connectToPeer]);

  const handleFingerprintConfirm = useCallback(async () => {
    try {
      console.log('[ShareNote:BLE] Starting BLE send...');
      await confirmFingerprintAndSend('denominated-pool', noteData);
      console.log('[ShareNote:BLE] Send + ACK success, marking transferred');
      // Only mark transferred AFTER successful send + ACK
      markNoteTransferred();
      console.log('[ShareNote:BLE] Note marked transferred');
    } catch (err) {
      console.error('[ShareNote:BLE] Send failed:', (err as Error).message);
      p01Alert('Send Failed', (err as Error).message);
    }
  }, [confirmFingerprintAndSend, noteData, markNoteTransferred]);

  const handleFingerprintReject = useCallback(async () => {
    await cancelSession();
    p01Alert('Connection Cancelled', 'Fingerprint mismatch — connection terminated for safety.');
  }, [cancelSession]);

  // --- NFC ---
  const handleStartNfc = useCallback(async () => {
    setSelectedTransport('nfc');
    clearError();
    const pin = generateNfcPin();
    setNfcPinInput(pin);
    setShowNfcOverlay(true);
    console.log('[ShareNote:NFC] Starting NFC send, pin generated');
    try {
      await sendViaNfc('denominated-pool', noteData, pin);
      console.log('[ShareNote:NFC] HCE reports transfer complete');
      // NFC has no reliable ACK — do NOT auto-mark as transferred.
      // The user keeps the note and can manually delete it after
      // confirming the receiver imported it successfully.
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      // Transfer failed — note is NOT marked transferred, user can retry
      console.error('[ShareNote:NFC] Transfer failed:', (err as Error).message);
      p01Alert('NFC Error', (err as Error).message);
    } finally {
      setShowNfcOverlay(false);
    }
  }, [generateNfcPin, sendViaNfc, noteData, clearError, markNoteTransferred]);

  // --- Success ---
  if (isSuccess) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <Animated.View entering={FadeInDown.delay(50)} style={styles.header}>
          <TouchableOpacity
            onPress={() => { cancelSession(); router.back(); }}
            style={styles.backBtn}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Ionicons name="chevron-back" size={22} color={Colors.textSecondary} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Share note</Text>
          <View style={styles.headerSpacer} />
        </Animated.View>
        <View style={styles.centered}>
          <Animated.View entering={FadeInUp.delay(100)} style={styles.emptyContent}>
            <Ionicons name="checkmark-circle-outline" size={40} color={Colors.primary} />
            <Text style={styles.successTitle}>Note sent</Text>
            <Text style={styles.emptyText}>
              Delivered over {selectedTransport === 'ble' ? 'Bluetooth' : 'NFC'} and acknowledged
              by the other device.
            </Text>
            <View style={styles.emptyAction}>
              <Button
                variant="primary"
                size="lg"
                fullWidth
                onPress={() => { cancelSession(); router.back(); }}
              >
                Done
              </Button>
            </View>
          </Animated.View>
        </View>
      </SafeAreaView>
    );
  }

  // --- NFC Overlay ---
  if (showNfcOverlay) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <NfcTapOverlay
          pin={nfcPinInput}
          isSender={true}
          onCancel={() => { cancelSession(); setShowNfcOverlay(false); }}
        />
      </SafeAreaView>
    );
  }

  // --- Main UI ---
  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Animated.View entering={FadeInDown.delay(50)} style={styles.header}>
        <TouchableOpacity
          onPress={() => { cancelSession(); router.back(); }}
          style={styles.backBtn}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="chevron-back" size={22} color={Colors.textSecondary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Share note</Text>
        <View style={styles.headerSpacer} />
      </Animated.View>

      {sessionState !== 'idle' && <ShareProgressIndicator state={sessionState} />}

      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        {/* Note ready */}
        <Animated.View entering={FadeInUp.delay(100)}>
          <View style={styles.noteReadyRow}>
            <Ionicons name="shield-checkmark-outline" size={16} color={Colors.primary} />
            <Text style={styles.noteReadyText}>Mature note ready to share</Text>
          </View>
        </Animated.View>

        {/* Transport selector */}
        <Animated.View entering={FadeInUp.delay(150)}>
          <Text style={styles.label}>Choose how to send</Text>
        </Animated.View>
        <View style={styles.transportRow}>
          <Animated.View entering={FadeInUp.delay(200)} style={styles.transportSlot}>
            <TouchableOpacity
              style={[
                styles.transportCard,
                selectedTransport === 'ble' && styles.transportCardActive,
                !isBleAvailable && styles.transportCardDisabled,
              ]}
              onPress={handleStartBle}
              disabled={!isBleAvailable}
              accessibilityRole="button"
              accessibilityState={{ selected: selectedTransport === 'ble', disabled: !isBleAvailable }}
              accessibilityLabel="Send over Bluetooth"
            >
              <Ionicons
                name="bluetooth"
                size={24}
                color={isBleAvailable ? Colors.primary : Colors.textTertiary}
              />
              <Text style={styles.transportTitle}>Bluetooth</Text>
              <Text style={styles.transportDesc}>
                {isBleAvailable ? 'Scan nearby' : 'Unavailable'}
              </Text>
            </TouchableOpacity>
          </Animated.View>

          {/* NFC — disabled, coming soon */}
          <Animated.View entering={FadeInUp.delay(260)} style={styles.transportSlot}>
            <View style={[styles.transportCard, styles.transportCardDisabled]}>
              <Ionicons name="phone-portrait-outline" size={24} color={Colors.textTertiary} />
              <Text style={styles.transportTitle}>NFC tap</Text>
              <Text style={styles.transportDesc}>Coming soon</Text>
            </View>
          </Animated.View>
        </View>

        {/* BLE device list */}
        {selectedTransport === 'ble' && sessionState !== 'sending' && sessionState !== 'encrypting' && sessionState !== 'idle' && (
          <Animated.View entering={FadeInUp.delay(100)}>
            <BleDeviceList
              peers={nearbyPeers}
              isScanning={isScanning}
              onSelectPeer={handleSelectPeer}
              onRefresh={() => startBleScan()}
            />
          </Animated.View>
        )}

        {/* Transfer animation */}
        {(sessionState === 'sending' || sessionState === 'encrypting') && (
          <Animated.View entering={FadeInUp.delay(100)}>
            <TransferAnimation
              isSending={true}
              transport={selectedTransport || 'ble'}
              peerName={activeSession?.peer?.displayName}
            />
          </Animated.View>
        )}

        {/* Error */}
        {error && (
          <Animated.View entering={FadeInUp.delay(100)}>
            <View style={styles.errorPanel} accessibilityRole="alert">
              <Ionicons name="alert-circle" size={16} color={Colors.error} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          </Animated.View>
        )}

        {/* Security footer */}
        <Animated.View entering={FadeInUp.delay(320)}>
          <View style={styles.securityRow}>
            <Ionicons name="lock-closed-outline" size={13} color={Colors.textTertiary} />
            <Text style={styles.securityText}>
              End-to-end encrypted. BLE: X25519 + XSalsa20-Poly1305. NFC: PIN-derived key.
            </Text>
          </View>
        </Animated.View>
      </ScrollView>

      {showFingerprint && (
        <FingerprintVerification
          visible={true}
          fingerprint={activeSession!.fingerprint!}
          peerName={activeSession?.peer?.displayName}
          onConfirm={handleFingerprintConfirm}
          onReject={handleFingerprintReject}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    minHeight: 56,
  },
  backBtn: { width: 44, height: 44, justifyContent: 'center', alignItems: 'center' },
  headerSpacer: { width: 44 },
  headerTitle: {
    flex: 1,
    color: Colors.text,
    fontSize: FontSize.xl,
    fontFamily: FontFamily.displayMedium,
  },
  scrollView: { flex: 1 },
  scrollContent: { paddingHorizontal: Spacing.xl, paddingTop: Spacing.lg, paddingBottom: 120 },
  centered: { flex: 1, justifyContent: 'center', paddingHorizontal: Spacing['3xl'] },

  /* Empty / success */
  emptyContent: { alignItems: 'center' },
  emptyIcon: {
    width: 56, height: 56, borderRadius: BorderRadius.full,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.border,
    marginBottom: Spacing['2xl'],
  },
  emptyTitle: {
    fontSize: FontSize['2xl'], fontFamily: FontFamily.display,
    color: Colors.text, textAlign: 'center',
  },
  successTitle: {
    fontSize: FontSize['2xl'], fontFamily: FontFamily.display,
    color: Colors.text, textAlign: 'center', marginTop: Spacing.lg,
  },
  emptyText: {
    fontSize: FontSize.md, fontFamily: FontFamily.regular, color: Colors.textSecondary,
    textAlign: 'center', lineHeight: 22, marginTop: Spacing.sm,
  },
  emptyAction: { width: '100%', marginTop: Spacing['3xl'] },

  /* Note ready */
  noteReadyRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    marginBottom: Spacing.xl,
  },
  noteReadyText: {
    fontSize: FontSize.sm, fontFamily: FontFamily.medium, color: Colors.textSecondary,
  },
  label: {
    fontSize: FontSize.sm, fontFamily: FontFamily.medium,
    color: Colors.textSecondary, marginBottom: Spacing.md,
  },

  /* Transport cards — a fill and a hairline. */
  transportRow: { flexDirection: 'row', gap: Spacing.md, marginBottom: Spacing.xl },
  transportSlot: { flex: 1 },
  transportCard: {
    alignItems: 'center',
    gap: Spacing.sm,
    minHeight: 100,
    paddingVertical: Spacing.xl,
    paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  transportCardActive: { borderColor: Colors.primary },
  transportCardDisabled: { opacity: 0.4 },
  transportTitle: {
    fontSize: FontSize.md, fontFamily: FontFamily.medium, color: Colors.text,
  },
  transportDesc: {
    fontSize: FontSize.xs, fontFamily: FontFamily.regular,
    color: Colors.textTertiary, textAlign: 'center',
  },

  /* Error */
  errorPanel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.errorDim,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.lg,
  },
  errorText: {
    flex: 1, fontSize: FontSize.sm, fontFamily: FontFamily.regular, color: Colors.error,
  },

  /* Security note */
  securityRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
    paddingTop: Spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.borderSoft,
  },
  securityText: {
    flex: 1, fontSize: FontSize.xs, fontFamily: FontFamily.regular,
    color: Colors.textTertiary, lineHeight: 16,
  },
});

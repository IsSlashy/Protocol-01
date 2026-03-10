/**
 * Receive Note Screen — Receive a shielded note from a nearby device via BLE or NFC
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  Modal,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import Animated, {
  FadeIn,
  SlideInDown,
  SlideOutDown,
} from 'react-native-reanimated';

import { useSharingStore } from '@/stores/sharingStore';
import { useShieldedStore } from '@/stores/shieldedStore';
import { useDenominatedPoolStore, type NoteSource } from '@/stores/denominatedPoolStore';
import type { TransportType, NotePayload } from '@/services/sharing/types';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import { p01Alert } from '@/stores/alertStore';

import FingerprintVerification from '@/components/sharing/FingerprintVerification';
import NfcTapOverlay from '@/components/sharing/NfcTapOverlay';
import ShareProgressIndicator from '@/components/sharing/ShareProgressIndicator';
import TransferAnimation from '@/components/sharing/TransferAnimation';

export default function ReceiveNoteScreen() {
  const router = useRouter();

  // Stores
  const {
    activeSession,
    isBleAvailable,
    isNfcAvailable,
    pendingNote,
    error,
    checkAvailability,
    startBleReceiver,
    confirmFingerprintAndReceive,
    startNfcReceiver,
    cancelSession,
    clearPendingNote,
    clearError,
  } = useSharingStore();

  const { importNote: importShieldedNote } = useShieldedStore();
  const { importNote: importDenominatedNote } = useDenominatedPoolStore();

  // Local state
  const [selectedTransport, setSelectedTransport] = useState<TransportType | null>(null);
  const [nfcPinInput, setNfcPinInput] = useState('');
  const [showNfcOverlay, setShowNfcOverlay] = useState(false);
  const [showNfcPinEntry, setShowNfcPinEntry] = useState(false);
  const [imported, setImported] = useState(false);
  const [importedNote, setImportedNote] = useState<NotePayload | null>(null);

  // Check availability on mount
  useEffect(() => {
    checkAvailability();
  }, []);

  // Auto-import when note is received
  useEffect(() => {
    if (pendingNote && !imported) {
      handleImportNote(pendingNote);
    }
  }, [pendingNote]);

  const sessionState = activeSession?.state || 'idle';
  const showFingerprint = sessionState === 'verifying-fingerprint' && activeSession?.fingerprint;

  // -----------------------------------------------------------------------
  // Import received note
  // -----------------------------------------------------------------------

  const handleImportNote = useCallback(async (payload: NotePayload) => {
    console.log('[ReceiveNote] Importing note, type:', payload.type, 'dataLen:', JSON.stringify(payload.data).length);
    try {
      if (payload.type === 'zk-shielded') {
        await importShieldedNote(payload.data);
      } else if (payload.type === 'denominated-pool') {
        importDenominatedNote(payload.data, 'received' as NoteSource);
      }
      console.log('[ReceiveNote] Import SUCCESS');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setImported(true);
      setImportedNote(payload);
      clearPendingNote();
    } catch (err) {
      console.error('[ReceiveNote] Import FAILED:', (err as Error).message);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      p01Alert('Import Failed', (err as Error).message);
    }
  }, [importShieldedNote, importDenominatedNote, clearPendingNote]);

  // -----------------------------------------------------------------------
  // BLE flow
  // -----------------------------------------------------------------------

  const handleStartBle = useCallback(async () => {
    setSelectedTransport('ble');
    clearError();
    try {
      await startBleReceiver();
    } catch (err: any) {
      const msg = err?.reason || err?.message || 'Unknown BLE error';
      p01Alert('Bluetooth Error', msg);
    }
  }, [startBleReceiver, clearError]);

  const handleFingerprintConfirm = useCallback(async () => {
    try {
      await confirmFingerprintAndReceive();
    } catch (err) {
      p01Alert('Error', (err as Error).message);
    }
  }, [confirmFingerprintAndReceive]);

  const handleFingerprintReject = useCallback(async () => {
    await cancelSession();
    p01Alert(
      'Connection Cancelled',
      'The fingerprint did not match. The connection has been terminated for safety.',
    );
  }, [cancelSession]);

  // -----------------------------------------------------------------------
  // NFC flow
  // -----------------------------------------------------------------------

  const handleStartNfc = useCallback(() => {
    setSelectedTransport('nfc');
    clearError();
    setShowNfcPinEntry(true);
  }, [clearError]);

  const handleNfcPinSubmit = useCallback(async () => {
    if (nfcPinInput.length !== 6) {
      p01Alert('Invalid PIN', 'Please enter the 6-digit code from the sender.');
      return;
    }
    setShowNfcPinEntry(false);
    setShowNfcOverlay(true);
    console.log('[ReceiveNote:NFC] Starting NFC receiver with PIN');
    try {
      await startNfcReceiver(nfcPinInput);
      console.log('[ReceiveNote:NFC] NFC receive completed');
    } catch (err) {
      console.error('[ReceiveNote:NFC] NFC receive failed:', (err as Error).message);
      p01Alert('NFC Error', (err as Error).message);
    } finally {
      setShowNfcOverlay(false);
    }
  }, [nfcPinInput, startNfcReceiver]);

  // -----------------------------------------------------------------------
  // Success result modal
  // -----------------------------------------------------------------------

  if (imported && importedNote) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={22} color={Colors.text} />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <Ionicons name="download" size={20} color={P01Colors.green} />
            <Text style={styles.headerTitle}>Receive</Text>
          </View>
          <View style={{ width: 40 }} />
        </View>
        <View style={styles.centered}>
          <View style={styles.successCard}>
            <View style={styles.successIconWrap}>
              <Ionicons name="checkmark-circle" size={56} color={P01Colors.green} />
            </View>
            <Text style={styles.successTitle}>Note Received!</Text>
            <Text style={styles.successDetail}>
              A {importedNote.type === 'zk-shielded' ? 'ZK Shielded' : 'Denominated Pool'} note
              has been imported to your wallet.
            </Text>
            <View style={styles.successActions}>
              <TouchableOpacity
                style={styles.successBtnPrimary}
                onPress={() => {
                  cancelSession();
                  if (importedNote.type === 'denominated-pool') {
                    router.push('/(main)/(privacy)/denominated-notes' as any);
                  } else {
                    router.push('/(main)/(privacy)/shielded' as any);
                  }
                }}
              >
                <LinearGradient
                  colors={[P01Colors.green, '#20A89E']}
                  style={styles.successBtnGradient}
                >
                  <Ionicons name="eye" size={18} color="#000" />
                  <Text style={styles.successBtnPrimaryText}>View Notes</Text>
                </LinearGradient>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.successBtnSecondary}
                onPress={() => {
                  cancelSession();
                  router.back();
                }}
              >
                <Text style={styles.successBtnSecondaryText}>Done</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  // -----------------------------------------------------------------------
  // NFC PIN Entry (bottom sheet modal)
  // -----------------------------------------------------------------------

  const nfcPinModal = (
    <Modal
      visible={showNfcPinEntry}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={() => setShowNfcPinEntry(false)}
    >
      <KeyboardAvoidingView
        style={ms.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <TouchableOpacity
          style={ms.backdrop}
          activeOpacity={1}
          onPress={() => setShowNfcPinEntry(false)}
        />
        <Animated.View
          entering={SlideInDown.duration(200)}
          exiting={SlideOutDown.duration(150)}
          style={ms.sheet}
        >
          <View style={ms.dragRow}>
            <View style={ms.dragHandle} />
          </View>

          {/* Header */}
          <View style={ms.sheetHeader}>
            <LinearGradient
              colors={[P01Colors.cyanDim, 'rgba(57, 197, 187, 0.05)']}
              style={ms.sheetIconWrap}
            >
              <Ionicons name="key" size={28} color={P01Colors.cyan} />
            </LinearGradient>
            <View style={{ flex: 1 }}>
              <Text style={ms.sheetTitle}>Enter PIN</Text>
              <Text style={ms.sheetSubtitle}>Ask the sender for the 6-digit code</Text>
            </View>
          </View>

          {/* PIN input */}
          <View style={ms.pinInputWrap}>
            <TextInput
              style={ms.pinInput}
              value={nfcPinInput}
              onChangeText={(t) => setNfcPinInput(t.replace(/[^0-9]/g, '').slice(0, 6))}
              placeholder="000000"
              placeholderTextColor={Colors.textTertiary}
              keyboardType="number-pad"
              maxLength={6}
              textAlign="center"
              autoFocus
            />
          </View>

          {/* Buttons */}
          <View style={ms.sheetActions}>
            <TouchableOpacity
              style={ms.cancelBtn}
              onPress={() => setShowNfcPinEntry(false)}
            >
              <Text style={ms.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={handleNfcPinSubmit}
              disabled={nfcPinInput.length !== 6}
              activeOpacity={0.8}
              style={{ flex: 1 }}
            >
              <LinearGradient
                colors={nfcPinInput.length !== 6
                  ? ['rgba(57,197,187,0.3)', 'rgba(57,197,187,0.15)']
                  : [P01Colors.cyan, '#20A89E']}
                style={ms.confirmBtn}
              >
                <Ionicons name="phone-portrait" size={18} color="#000" />
                <Text style={ms.confirmBtnText}>Start NFC Scan</Text>
              </LinearGradient>
            </TouchableOpacity>
          </View>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );

  // -----------------------------------------------------------------------
  // NFC Overlay
  // -----------------------------------------------------------------------

  if (showNfcOverlay) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <NfcTapOverlay
          isSender={false}
          onCancel={() => {
            cancelSession();
            setShowNfcOverlay(false);
          }}
        />
      </SafeAreaView>
    );
  }

  // -----------------------------------------------------------------------
  // Main UI
  // -----------------------------------------------------------------------

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => {
            cancelSession();
            router.back();
          }}
          style={styles.backBtn}
        >
          <Ionicons name="arrow-back" size={22} color={Colors.text} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Ionicons name="download" size={20} color={P01Colors.cyan} />
          <Text style={styles.headerTitle}>Receive</Text>
        </View>
        <View style={{ width: 40 }} />
      </View>

      {/* Progress */}
      {sessionState !== 'idle' && (
        <ShareProgressIndicator state={sessionState} />
      )}

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Explainer */}
        <View style={styles.explainer}>
          <Ionicons name="information-circle-outline" size={16} color={Colors.textTertiary} />
          <Text style={styles.explainerText}>
            Receive a shielded note from another P01 user nearby.
            Choose Bluetooth for medium range or NFC for tap-to-receive.
          </Text>
        </View>

        {/* Section label */}
        <Text style={styles.sectionLabel}>TRANSPORT METHOD</Text>

        {/* Transport cards */}
        <View style={styles.transportRow}>
          <TouchableOpacity
            style={[
              styles.transportCard,
              selectedTransport === 'ble' && styles.transportCardActive,
              !isBleAvailable && styles.transportCardDisabled,
            ]}
            onPress={handleStartBle}
            disabled={!isBleAvailable}
            activeOpacity={0.7}
          >
            <LinearGradient
              colors={selectedTransport === 'ble'
                ? ['rgba(59, 130, 246, 0.12)', 'rgba(59, 130, 246, 0.03)']
                : ['rgba(59, 130, 246, 0.06)', 'rgba(59, 130, 246, 0.01)']}
              style={styles.transportCardGradient}
            >
              <View style={[styles.transportIconWrap, { backgroundColor: `${P01Colors.blue}15` }]}>
                <Ionicons name="bluetooth" size={24} color={isBleAvailable ? P01Colors.blue : Colors.textTertiary} />
              </View>
              <Text style={styles.transportTitle}>Bluetooth</Text>
              <Text style={styles.transportDesc}>
                {isBleAvailable ? 'Wait for nearby sender' : 'Unavailable'}
              </Text>
            </LinearGradient>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.transportCard,
              selectedTransport === 'nfc' && styles.transportCardActive,
              !isNfcAvailable && styles.transportCardDisabled,
            ]}
            onPress={handleStartNfc}
            disabled={!isNfcAvailable}
            activeOpacity={0.7}
          >
            <LinearGradient
              colors={selectedTransport === 'nfc'
                ? ['rgba(255, 119, 168, 0.12)', 'rgba(255, 119, 168, 0.03)']
                : ['rgba(255, 119, 168, 0.06)', 'rgba(255, 119, 168, 0.01)']}
              style={styles.transportCardGradient}
            >
              <View style={[styles.transportIconWrap, { backgroundColor: `${P01Colors.pink}15` }]}>
                <Ionicons name="phone-portrait" size={24} color={isNfcAvailable ? P01Colors.pink : Colors.textTertiary} />
              </View>
              <Text style={styles.transportTitle}>NFC Tap</Text>
              <Text style={styles.transportDesc}>
                {isNfcAvailable ? 'Tap phones together' : 'Unavailable'}
              </Text>
            </LinearGradient>
          </TouchableOpacity>
        </View>

        {/* BLE: waiting for sender */}
        {selectedTransport === 'ble' && (sessionState === 'scanning' || sessionState === 'connecting' || sessionState === 'key-exchange') && (
          <View style={styles.waitingCard}>
            <LinearGradient
              colors={['rgba(59, 130, 246, 0.08)', 'rgba(59, 130, 246, 0.02)']}
              style={styles.waitingCardGradient}
            >
              <View style={styles.waitingIconWrap}>
                <Ionicons name="bluetooth" size={28} color={P01Colors.blue} />
              </View>
              <Text style={styles.waitingTitle}>Waiting for sender...</Text>
              <Text style={styles.waitingDesc}>
                Ask the sender to open their note and tap "Nearby".{'\n'}Your device is visible to nearby P01 users.
              </Text>
            </LinearGradient>
          </View>
        )}

        {/* Live transfer animation */}
        {(sessionState === 'receiving' || sessionState === 'decrypting' || sessionState === 'importing') && (
          <TransferAnimation
            isSending={false}
            transport={selectedTransport || 'ble'}
            peerName={activeSession?.peer?.displayName}
          />
        )}

        {/* Error */}
        {error && (
          <View style={styles.errorCard}>
            <Ionicons name="warning" size={18} color={Colors.error} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {/* Security note */}
        <View style={styles.securityCard}>
          <Ionicons name="shield-checkmark" size={14} color={Colors.textTertiary} />
          <Text style={styles.securityText}>
            Notes are verified cryptographically before import.
            BLE connections require visual fingerprint confirmation.
          </Text>
        </View>
      </ScrollView>

      {/* NFC PIN bottom sheet */}
      {nfcPinModal}

      {/* Fingerprint modal */}
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

// ─── Main Styles ───────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
  },
  headerCenter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 9999,
    backgroundColor: Colors.surfaceSecondary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    color: Colors.text,
    fontSize: 20,
    fontFamily: FontFamily.bold,
  },
  scrollView: { flex: 1 },
  scrollContent: {
    paddingHorizontal: Spacing.xl,
    paddingBottom: 120,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: Spacing.xl,
  },

  /* Explainer */
  explainer: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  explainerText: {
    flex: 1,
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    lineHeight: 18,
  },

  /* Section label */
  sectionLabel: {
    fontSize: 11,
    fontFamily: FontFamily.bold,
    color: Colors.textTertiary,
    letterSpacing: 1.2,
    marginBottom: Spacing.md,
  },

  /* Transport cards */
  transportRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginBottom: Spacing.xl,
  },
  transportCard: {
    flex: 1,
    borderRadius: BorderRadius.lg,
    overflow: 'hidden',
  },
  transportCardActive: {},
  transportCardDisabled: { opacity: 0.4 },
  transportCardGradient: {
    alignItems: 'center',
    gap: 8,
    paddingVertical: Spacing.xl,
    paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  transportIconWrap: {
    width: 48,
    height: 48,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  transportTitle: {
    fontSize: 15,
    fontFamily: FontFamily.semibold,
    color: Colors.text,
  },
  transportDesc: {
    fontSize: 11,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    textAlign: 'center',
  },

  /* Waiting card */
  waitingCard: {
    borderRadius: BorderRadius.lg,
    overflow: 'hidden',
    marginBottom: Spacing.xl,
  },
  waitingCardGradient: {
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.xl * 1.5,
    paddingHorizontal: Spacing.xl,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: `${P01Colors.blue}25`,
  },
  waitingIconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: `${P01Colors.blue}15`,
    justifyContent: 'center',
    alignItems: 'center',
  },
  waitingTitle: {
    fontSize: 17,
    fontFamily: FontFamily.semibold,
    color: Colors.text,
  },
  waitingDesc: {
    fontSize: 13,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 19,
  },

  /* Error card */
  errorCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: Colors.errorDim,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.error,
    marginBottom: Spacing.lg,
  },
  errorText: {
    flex: 1,
    fontSize: 13,
    fontFamily: FontFamily.regular,
    color: Colors.error,
  },

  /* Security footer */
  securityCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  securityText: {
    flex: 1,
    fontSize: 11,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    lineHeight: 16,
  },

  /* Success screen */
  successCard: {
    width: '100%',
    backgroundColor: Colors.surface,
    borderRadius: 20,
    alignItems: 'center',
    padding: Spacing.xl * 1.5,
    borderWidth: 1,
    borderColor: `${P01Colors.green}30`,
  },
  successIconWrap: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: `${P01Colors.green}12`,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.lg,
  },
  successTitle: {
    fontSize: 22,
    fontFamily: FontFamily.bold,
    color: Colors.text,
    marginBottom: Spacing.sm,
  },
  successDetail: {
    fontSize: 14,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: Spacing.xl,
  },
  successActions: {
    width: '100%',
    gap: Spacing.sm,
  },
  successBtnPrimary: {
    borderRadius: BorderRadius.md,
    overflow: 'hidden',
  },
  successBtnGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: BorderRadius.md,
  },
  successBtnPrimaryText: {
    fontSize: 15,
    fontFamily: FontFamily.bold,
    color: '#000',
  },
  successBtnSecondary: {
    paddingVertical: 14,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
  },
  successBtnSecondaryText: {
    fontSize: 15,
    fontFamily: FontFamily.semibold,
    color: Colors.text,
  },
});

// ─── NFC PIN Bottom Sheet Styles ────────────────────────────────────
const ms = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.75)',
  },
  sheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: Spacing.xl,
    paddingBottom: 40,
    borderTopWidth: 1,
    borderTopColor: `${P01Colors.cyan}30`,
  },
  dragRow: {
    alignItems: 'center',
    paddingTop: 10,
    paddingBottom: Spacing.md,
  },
  dragHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.border,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginBottom: Spacing.xl,
  },
  sheetIconWrap: {
    width: 52,
    height: 52,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetTitle: {
    fontSize: 20,
    fontFamily: FontFamily.bold,
    color: Colors.text,
  },
  sheetSubtitle: {
    fontSize: 13,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    marginTop: 2,
  },
  pinInputWrap: {
    alignItems: 'center',
    marginBottom: Spacing.xl,
  },
  pinInput: {
    width: 220,
    fontSize: 32,
    fontFamily: FontFamily.mono,
    color: P01Colors.cyan,
    letterSpacing: 8,
    backgroundColor: 'rgba(0,0,0,0.35)',
    borderRadius: BorderRadius.lg,
    borderWidth: 1.5,
    borderColor: `${P01Colors.cyan}35`,
    paddingVertical: Spacing.lg,
    paddingHorizontal: Spacing.xl,
    textAlign: 'center',
  },
  sheetActions: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginTop: Spacing.sm,
  },
  cancelBtn: {
    flex: 0.4,
    paddingVertical: 14,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
  },
  cancelBtnText: {
    fontSize: 15,
    fontFamily: FontFamily.semibold,
    color: Colors.text,
  },
  confirmBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: BorderRadius.md,
  },
  confirmBtnText: {
    fontSize: 15,
    fontFamily: FontFamily.bold,
    color: '#000',
  },
});

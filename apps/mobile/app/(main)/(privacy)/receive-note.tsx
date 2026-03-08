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
  Alert,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';

import { useSharingStore } from '@/stores/sharingStore';
import { useShieldedStore } from '@/stores/shieldedStore';
import { useDenominatedPoolStore, type NoteSource } from '@/stores/denominatedPoolStore';
import type { TransportType, NotePayload } from '@/services/sharing/types';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';

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
    try {
      if (payload.type === 'zk-shielded') {
        await importShieldedNote(payload.data);
      } else if (payload.type === 'denominated-pool') {
        importDenominatedNote(payload.data, 'received' as NoteSource);
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setImported(true);
      setImportedNote(payload);
      clearPendingNote();
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Import Failed', (err as Error).message);
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
      Alert.alert('Bluetooth Error', msg);
    }
  }, [startBleReceiver, clearError]);

  const handleFingerprintConfirm = useCallback(async () => {
    try {
      await confirmFingerprintAndReceive();
    } catch (err) {
      Alert.alert('Error', (err as Error).message);
    }
  }, [confirmFingerprintAndReceive]);

  const handleFingerprintReject = useCallback(async () => {
    await cancelSession();
    Alert.alert(
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
      Alert.alert('Invalid PIN', 'Please enter the 6-digit code from the sender.');
      return;
    }
    setShowNfcPinEntry(false);
    setShowNfcOverlay(true);
    try {
      await startNfcReceiver(nfcPinInput);
    } catch (err) {
      Alert.alert('NFC Error', (err as Error).message);
    } finally {
      setShowNfcOverlay(false);
    }
  }, [nfcPinInput, startNfcReceiver]);

  // -----------------------------------------------------------------------
  // Success
  // -----------------------------------------------------------------------

  if (imported && importedNote) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <Animated.View entering={FadeInDown.delay(50)} style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={22} color={Colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Receive Note</Text>
          <View style={{ width: 40 }} />
        </Animated.View>
        <View style={styles.centered}>
          <Animated.View entering={FadeInUp.delay(100)}>
            <View style={styles.successGlassOuter}>
              <BlurView intensity={15} tint="dark" style={styles.successGlass}>
                <LinearGradient
                  colors={['rgba(57, 197, 187, 0.06)', 'rgba(255, 119, 168, 0.03)', 'transparent']}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={StyleSheet.absoluteFill}
                />
                <Ionicons name="checkmark-circle" size={64} color={P01Colors.green} />
                <Text style={styles.successTitle}>Note Received!</Text>
                <Text style={styles.successDetail}>
                  A {importedNote.type === 'zk-shielded' ? 'ZK Shielded' : 'Denominated Pool'} note
                  has been imported to your wallet.
                </Text>
                <TouchableOpacity
                  style={styles.doneBtn}
                  onPress={() => {
                    cancelSession();
                    if (importedNote.type === 'denominated-pool') {
                      router.push('/(main)/(privacy)/denominated-notes' as any);
                    } else {
                      router.push('/(main)/(privacy)/shielded' as any);
                    }
                  }}
                >
                  <Text style={styles.doneBtnText}>View Notes</Text>
                </TouchableOpacity>
              </BlurView>
            </View>
          </Animated.View>
        </View>
      </SafeAreaView>
    );
  }

  // -----------------------------------------------------------------------
  // NFC PIN entry
  // -----------------------------------------------------------------------

  if (showNfcPinEntry) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <Animated.View entering={FadeInDown.delay(50)} style={styles.header}>
          <TouchableOpacity
            onPress={() => setShowNfcPinEntry(false)}
            style={styles.backBtn}
          >
            <Ionicons name="arrow-back" size={22} color={Colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Enter PIN</Text>
          <View style={{ width: 40 }} />
        </Animated.View>
        <View style={styles.pinContainer}>
          <Animated.View entering={FadeInUp.delay(100)}>
            <View style={styles.pinGlassOuter}>
              <BlurView intensity={15} tint="dark" style={styles.pinGlass}>
                <LinearGradient
                  colors={['rgba(57, 197, 187, 0.06)', 'rgba(255, 119, 168, 0.03)', 'transparent']}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={StyleSheet.absoluteFill}
                />
                <Ionicons name="key" size={40} color={P01Colors.cyan} />
                <Text style={styles.pinTitle}>Enter the code from the sender</Text>
                <Text style={styles.pinSubtitle}>
                  Ask the sender for the 6-digit code displayed on their screen.
                </Text>
                <TextInput
                  style={styles.pinInput}
                  value={nfcPinInput}
                  onChangeText={(t) => setNfcPinInput(t.replace(/[^0-9]/g, '').slice(0, 6))}
                  placeholder="000000"
                  placeholderTextColor={Colors.textTertiary}
                  keyboardType="number-pad"
                  maxLength={6}
                  textAlign="center"
                />
                <TouchableOpacity
                  style={[styles.pinSubmitBtn, nfcPinInput.length !== 6 && styles.disabledBtn]}
                  onPress={handleNfcPinSubmit}
                  disabled={nfcPinInput.length !== 6}
                >
                  <Ionicons name="phone-portrait" size={18} color="#000" />
                  <Text style={styles.pinSubmitText}>Start NFC Scan</Text>
                </TouchableOpacity>
              </BlurView>
            </View>
          </Animated.View>
        </View>
      </SafeAreaView>
    );
  }

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
      <Animated.View entering={FadeInDown.delay(50)} style={styles.header}>
        <TouchableOpacity
          onPress={() => {
            cancelSession();
            router.back();
          }}
          style={styles.backBtn}
        >
          <Ionicons name="arrow-back" size={22} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Receive Note</Text>
        <View style={{ width: 40 }} />
      </Animated.View>

      {/* Progress */}
      {sessionState !== 'idle' && (
        <ShareProgressIndicator state={sessionState} />
      )}

      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        {/* Info */}
        <Animated.View entering={FadeInUp.delay(100)}>
          <View style={styles.infoCardOuter}>
            <BlurView intensity={12} tint="dark" style={styles.infoCardGlass}>
              <LinearGradient
                colors={['rgba(57, 197, 187, 0.06)', 'rgba(255, 119, 168, 0.03)', 'transparent']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={StyleSheet.absoluteFill}
              />
              <Ionicons name="download" size={18} color={P01Colors.cyan} />
              <Text style={styles.infoText}>
                Receive a shielded note from another P01 user nearby.
                Choose Bluetooth for medium range or NFC for tap-to-receive.
              </Text>
            </BlurView>
          </View>
        </Animated.View>

        {/* Transport selector */}
        <Animated.View entering={FadeInUp.delay(150)}>
          <Text style={styles.label}>Transport Method</Text>
        </Animated.View>
        <View style={styles.transportRow}>
          <Animated.View entering={FadeInUp.delay(200)} style={{ flex: 1 }}>
            <TouchableOpacity
              style={[
                styles.transportCardOuter,
                selectedTransport === 'ble' && styles.transportCardOuterActive,
                !isBleAvailable && styles.transportCardDisabled,
              ]}
              onPress={handleStartBle}
              disabled={!isBleAvailable}
            >
              <BlurView intensity={12} tint="dark" style={styles.transportCardGlass}>
                <LinearGradient
                  colors={selectedTransport === 'ble'
                    ? ['rgba(57, 197, 187, 0.10)', 'rgba(57, 197, 187, 0.03)', 'transparent']
                    : ['rgba(57, 197, 187, 0.06)', 'rgba(255, 119, 168, 0.03)', 'transparent']}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={StyleSheet.absoluteFill}
                />
                <Ionicons name="bluetooth" size={28} color={isBleAvailable ? P01Colors.blue : Colors.textTertiary} />
                <Text style={styles.transportTitle}>Bluetooth</Text>
                <Text style={styles.transportDesc}>
                  {isBleAvailable ? 'Wait for nearby sender' : 'Bluetooth unavailable'}
                </Text>
              </BlurView>
            </TouchableOpacity>
          </Animated.View>

          <Animated.View entering={FadeInUp.delay(260)} style={{ flex: 1 }}>
            <TouchableOpacity
              style={[
                styles.transportCardOuter,
                selectedTransport === 'nfc' && styles.transportCardOuterActive,
                !isNfcAvailable && styles.transportCardDisabled,
              ]}
              onPress={handleStartNfc}
              disabled={!isNfcAvailable}
            >
              <BlurView intensity={12} tint="dark" style={styles.transportCardGlass}>
                <LinearGradient
                  colors={selectedTransport === 'nfc'
                    ? ['rgba(255, 119, 168, 0.10)', 'rgba(57, 197, 187, 0.03)', 'transparent']
                    : ['rgba(57, 197, 187, 0.06)', 'rgba(255, 119, 168, 0.03)', 'transparent']}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={StyleSheet.absoluteFill}
                />
                <Ionicons name="phone-portrait" size={28} color={isNfcAvailable ? P01Colors.pink : Colors.textTertiary} />
                <Text style={styles.transportTitle}>NFC Tap</Text>
                <Text style={styles.transportDesc}>
                  {isNfcAvailable ? 'Tap phones together' : 'NFC unavailable'}
                </Text>
              </BlurView>
            </TouchableOpacity>
          </Animated.View>
        </View>

        {/* BLE receiver: waiting for sender to connect */}
        {selectedTransport === 'ble' && (sessionState === 'scanning' || sessionState === 'connecting' || sessionState === 'key-exchange') && (
          <Animated.View entering={FadeInUp.delay(100)}>
            <View style={styles.waitingCardOuter}>
              <BlurView intensity={15} tint="dark" style={styles.waitingCardGlass}>
                <LinearGradient
                  colors={['rgba(57, 197, 187, 0.06)', 'rgba(255, 119, 168, 0.03)', 'transparent']}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={StyleSheet.absoluteFill}
                />
                <View style={styles.waitingPulse}>
                  <Ionicons name="bluetooth" size={32} color={P01Colors.blue} />
                </View>
                <Text style={styles.waitingTitle}>Waiting for sender...</Text>
                <Text style={styles.waitingDesc}>
                  Ask the sender to open their note and tap "Nearby". Your device is visible to nearby P01 users.
                </Text>
              </BlurView>
            </View>
          </Animated.View>
        )}

        {/* Live transfer animation */}
        {(sessionState === 'receiving' || sessionState === 'decrypting' || sessionState === 'importing') && (
          <Animated.View entering={FadeInUp.delay(100)}>
            <TransferAnimation
              isSending={false}
              transport={selectedTransport || 'ble'}
              peerName={activeSession?.peer?.displayName}
            />
          </Animated.View>
        )}

        {/* Error */}
        {error && (
          <Animated.View entering={FadeInUp.delay(100)}>
            <View style={styles.errorCardOuter}>
              <BlurView intensity={12} tint="dark" style={styles.errorCardGlass}>
                <LinearGradient
                  colors={['rgba(239, 68, 68, 0.08)', 'rgba(239, 68, 68, 0.02)', 'transparent']}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={StyleSheet.absoluteFill}
                />
                <Ionicons name="alert-circle" size={16} color={Colors.error} />
                <Text style={styles.errorText}>{error}</Text>
              </BlurView>
            </View>
          </Animated.View>
        )}

        {/* Security note */}
        <Animated.View entering={FadeInUp.delay(320)}>
          <View style={styles.securityOuter}>
            <BlurView intensity={8} tint="dark" style={styles.securityGlass}>
              <LinearGradient
                colors={['rgba(57, 197, 187, 0.04)', 'transparent']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={StyleSheet.absoluteFill}
              />
              <Ionicons name="shield-checkmark" size={14} color={Colors.textTertiary} />
              <Text style={styles.securityText}>
                Notes are verified cryptographically before import.
                BLE connections require visual fingerprint confirmation.
              </Text>
            </BlurView>
          </View>
        </Animated.View>
      </ScrollView>

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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 9999,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: { color: Colors.text, fontSize: 20, fontFamily: FontFamily.bold },
  scrollView: { flex: 1 },
  scrollContent: { paddingHorizontal: Spacing.xl, paddingBottom: 120 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: Spacing.xl },

  /* Success glass card */
  successGlassOuter: {
    borderRadius: 20,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.07)',
  },
  successGlass: {
    alignItems: 'center',
    gap: Spacing.lg,
    padding: Spacing.xl * 2,
    backgroundColor: 'rgba(12, 12, 14, 0.65)',
  },
  successTitle: { fontSize: 22, fontFamily: FontFamily.bold, color: Colors.text },
  successDetail: {
    fontSize: 14,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    textAlign: 'center',
    paddingHorizontal: Spacing.md,
  },
  doneBtn: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: BorderRadius.md,
    backgroundColor: P01Colors.cyanDim,
    marginTop: Spacing.md,
  },
  doneBtnText: { fontSize: 15, fontFamily: FontFamily.semibold, color: P01Colors.cyan },

  /* Info glass card */
  infoCardOuter: {
    borderRadius: 20,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.07)',
    marginBottom: Spacing.xl,
  },
  infoCardGlass: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: Spacing.md,
    backgroundColor: 'rgba(12, 12, 14, 0.65)',
  },
  infoText: {
    flex: 1,
    fontSize: 13,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    lineHeight: 19,
  },
  label: {
    fontSize: 14,
    fontFamily: FontFamily.semibold,
    color: Colors.textSecondary,
    marginBottom: Spacing.sm,
  },

  /* Transport glass cards */
  transportRow: { flexDirection: 'row', gap: Spacing.md, marginBottom: Spacing.xl },
  transportCardOuter: {
    borderRadius: 20,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.07)',
  },
  transportCardOuterActive: {
    borderColor: P01Colors.cyan,
  },
  transportCardGlass: {
    alignItems: 'center',
    gap: 8,
    paddingVertical: Spacing.xl,
    paddingHorizontal: Spacing.md,
    backgroundColor: 'rgba(12, 12, 14, 0.65)',
  },
  transportCardDisabled: { opacity: 0.4 },
  transportTitle: { fontSize: 15, fontFamily: FontFamily.semibold, color: Colors.text },
  transportDesc: { fontSize: 11, fontFamily: FontFamily.regular, color: Colors.textTertiary, textAlign: 'center' },

  /* Error glass card */
  errorCardOuter: {
    borderRadius: 20,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.15)',
    marginBottom: Spacing.lg,
  },
  errorCardGlass: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: Spacing.md,
    backgroundColor: 'rgba(12, 12, 14, 0.65)',
  },
  errorText: { flex: 1, fontSize: 13, fontFamily: FontFamily.regular, color: Colors.error },

  /* Security footer glass */
  securityOuter: {
    borderRadius: 20,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.05)',
  },
  securityGlass: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    padding: Spacing.md,
    backgroundColor: 'rgba(12, 12, 14, 0.45)',
  },
  securityText: {
    flex: 1,
    fontSize: 11,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    lineHeight: 16,
  },

  /* Waiting glass card */
  waitingCardOuter: {
    borderRadius: 20,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.07)',
    marginBottom: Spacing.xl,
  },
  waitingCardGlass: {
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.xl * 2,
    paddingHorizontal: Spacing.xl,
    backgroundColor: 'rgba(12, 12, 14, 0.65)',
  },
  waitingPulse: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: P01Colors.blue + '15',
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

  /* NFC PIN entry glass */
  pinContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.xl,
  },
  pinGlassOuter: {
    borderRadius: 20,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.07)',
    width: '100%',
  },
  pinGlass: {
    alignItems: 'center',
    padding: Spacing.xl * 1.5,
    gap: Spacing.md,
    backgroundColor: 'rgba(12, 12, 14, 0.65)',
  },
  pinTitle: { fontSize: 20, fontFamily: FontFamily.bold, color: Colors.text },
  pinSubtitle: {
    fontSize: 14,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  },
  pinInput: {
    width: 200,
    fontSize: 32,
    fontFamily: FontFamily.mono,
    color: P01Colors.cyan,
    letterSpacing: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderRadius: BorderRadius.md,
    borderWidth: 1,
    borderColor: P01Colors.cyan + '40',
    paddingVertical: Spacing.lg,
    paddingHorizontal: Spacing.xl,
    marginVertical: Spacing.lg,
  },
  pinSubmitBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 16,
    paddingHorizontal: 32,
    borderRadius: BorderRadius.lg,
    backgroundColor: P01Colors.cyan,
  },
  pinSubmitText: { fontSize: 16, fontFamily: FontFamily.bold, color: '#000' },
  disabledBtn: { opacity: 0.4 },
});

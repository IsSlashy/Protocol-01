/**
 * Share Note Screen — Send a private note to a nearby device via Bluetooth or NFC
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Alert,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';

import { useSharingStore } from '@/stores/sharingStore';
import { useDenominatedPoolStore } from '@/stores/denominatedPoolStore';
import type { TransportType } from '@/services/sharing/types';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';

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

  useEffect(() => { checkAvailability(); }, []);

  const sessionState = activeSession?.state || 'idle';
  const showFingerprint = sessionState === 'verifying-fingerprint' && activeSession?.fingerprint;
  const isSuccess = sessionState === 'success';

  // Mark the note as transferred when share succeeds OR when NFC data was sent
  // (NFC: once data leaves the device, receiver may have it even if sender gets an error)
  const markNoteTransferred = useCallback(() => {
    if (params.noteId) {
      useDenominatedPoolStore.setState((state) => ({
        notes: state.notes.map((n) =>
          n.id === params.noteId ? { ...n, status: 'transferred' as any } : n
        ),
      }));
    }
  }, [params.noteId]);

  useEffect(() => {
    if (isSuccess) markNoteTransferred();
  }, [isSuccess, markNoteTransferred]);

  // No note = can't do anything
  if (!noteData) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <Animated.View entering={FadeInDown.delay(50)} style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={22} color={Colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Share Note</Text>
          <View style={{ width: 40 }} />
        </Animated.View>
        <View style={styles.centered}>
          <Animated.View entering={FadeInUp.delay(100)} style={styles.emptyContent}>
            <Ionicons name="alert-circle-outline" size={48} color={Colors.textTertiary} />
            <Text style={styles.emptyTitle}>No Note Selected</Text>
            <Text style={styles.emptyText}>
              Go to your notes and tap "Nearby" on a mature note to share it.
            </Text>
            <TouchableOpacity style={styles.doneBtn} onPress={() => router.back()}>
              <Text style={styles.doneBtnText}>Go Back</Text>
            </TouchableOpacity>
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
    catch (err) { Alert.alert('Bluetooth Error', (err as Error).message); }
  }, [startBleScan, clearError]);

  const handleSelectPeer = useCallback(async (peer: any) => {
    try { await connectToPeer(peer.id); }
    catch (err: any) {
      const msg = err?.reason || err?.message || 'Unknown BLE error';
      Alert.alert('Connection Failed', msg);
    }
  }, [connectToPeer]);

  const handleFingerprintConfirm = useCallback(async () => {
    markNoteTransferred();
    try { await confirmFingerprintAndSend('denominated-pool', noteData); }
    catch (err) { Alert.alert('Send Failed', (err as Error).message); }
  }, [confirmFingerprintAndSend, noteData, markNoteTransferred]);

  const handleFingerprintReject = useCallback(async () => {
    await cancelSession();
    Alert.alert('Connection Cancelled', 'Fingerprint mismatch — connection terminated for safety.');
  }, [cancelSession]);

  // --- NFC ---
  const handleStartNfc = useCallback(async () => {
    setSelectedTransport('nfc');
    clearError();
    const pin = generateNfcPin();
    setNfcPinInput(pin);
    setShowNfcOverlay(true);
    // Mark as transferred immediately — once NFC data is set on HCE,
    // the receiver may get it even if sender sees a transceive error
    markNoteTransferred();
    try {
      await sendViaNfc('denominated-pool', noteData, pin);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      Alert.alert('NFC Error', (err as Error).message);
    } finally {
      setShowNfcOverlay(false);
    }
  }, [generateNfcPin, sendViaNfc, noteData, clearError, markNoteTransferred]);

  // --- Success ---
  if (isSuccess) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <Animated.View entering={FadeInDown.delay(50)} style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={22} color={Colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Share Note</Text>
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
                <Text style={styles.successTitle}>Note Shared!</Text>
                <Text style={styles.successDetail}>
                  Securely transferred via {selectedTransport === 'ble' ? 'Bluetooth' : 'NFC'}.
                </Text>
                <TouchableOpacity
                  style={styles.doneBtn}
                  onPress={() => { cancelSession(); router.back(); }}
                >
                  <Text style={styles.doneBtnText}>Done</Text>
                </TouchableOpacity>
              </BlurView>
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
        >
          <Ionicons name="arrow-back" size={22} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Share Note</Text>
        <View style={{ width: 40 }} />
      </Animated.View>

      {sessionState !== 'idle' && <ShareProgressIndicator state={sessionState} />}

      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        {/* Note ready badge */}
        <Animated.View entering={FadeInUp.delay(100)}>
          <View style={styles.noteReadyOuter}>
            <BlurView intensity={12} tint="dark" style={styles.noteReadyGlass}>
              <LinearGradient
                colors={['rgba(57, 197, 187, 0.06)', 'rgba(255, 119, 168, 0.03)', 'transparent']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={StyleSheet.absoluteFill}
              />
              <Ionicons name="shield-checkmark" size={18} color={P01Colors.green} />
              <Text style={styles.noteReadyText}>Mature note ready to share</Text>
            </BlurView>
          </View>
        </Animated.View>

        {/* Transport selector */}
        <Animated.View entering={FadeInUp.delay(150)}>
          <Text style={styles.label}>Choose how to send</Text>
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
                  {isBleAvailable ? 'Scan nearby' : 'Unavailable'}
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
                  {isNfcAvailable ? 'Tap phones' : 'Unavailable'}
                </Text>
              </BlurView>
            </TouchableOpacity>
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

        {/* Security footer */}
        <Animated.View entering={FadeInUp.delay(320)}>
          <View style={styles.securityOuter}>
            <BlurView intensity={8} tint="dark" style={styles.securityGlass}>
              <LinearGradient
                colors={['rgba(57, 197, 187, 0.04)', 'transparent']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={StyleSheet.absoluteFill}
              />
              <Ionicons name="lock-closed" size={14} color={Colors.textTertiary} />
              <Text style={styles.securityText}>
                End-to-end encrypted. BLE: X25519 + XSalsa20-Poly1305. NFC: PIN-derived key.
              </Text>
            </BlurView>
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
  container: { flex: 1, backgroundColor: 'transparent' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
  },
  backBtn: {
    width: 40, height: 40, borderRadius: 9999,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    justifyContent: 'center', alignItems: 'center',
  },
  headerTitle: { color: Colors.text, fontSize: 20, fontFamily: FontFamily.bold },
  scrollView: { flex: 1 },
  scrollContent: { paddingHorizontal: Spacing.xl, paddingBottom: 120 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: Spacing.xl },
  emptyContent: { alignItems: 'center', gap: Spacing.lg },
  emptyTitle: { fontSize: 18, fontFamily: FontFamily.bold, color: Colors.text },
  emptyText: { fontSize: 14, fontFamily: FontFamily.regular, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 },

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
  successDetail: { fontSize: 14, fontFamily: FontFamily.regular, color: Colors.textSecondary, textAlign: 'center' },
  doneBtn: {
    paddingHorizontal: 24, paddingVertical: 12,
    borderRadius: BorderRadius.md, backgroundColor: P01Colors.cyanDim, marginTop: Spacing.md,
  },
  doneBtnText: { fontSize: 15, fontFamily: FontFamily.semibold, color: P01Colors.cyan },

  /* Note ready glass card */
  noteReadyOuter: {
    borderRadius: 20,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.07)',
    marginBottom: Spacing.xl,
  },
  noteReadyGlass: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: Spacing.md,
    backgroundColor: 'rgba(12, 12, 14, 0.65)',
  },
  noteReadyText: { fontSize: 14, fontFamily: FontFamily.medium, color: P01Colors.green },
  label: { fontSize: 14, fontFamily: FontFamily.semibold, color: Colors.textSecondary, marginBottom: Spacing.sm },

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
  securityText: { flex: 1, fontSize: 11, fontFamily: FontFamily.regular, color: Colors.textTertiary, lineHeight: 16 },
});

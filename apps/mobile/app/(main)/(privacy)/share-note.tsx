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
import * as Haptics from 'expo-haptics';

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
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={22} color={Colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Share Note</Text>
          <View style={{ width: 40 }} />
        </View>
        <View style={styles.centered}>
          <Ionicons name="alert-circle-outline" size={48} color={Colors.textTertiary} />
          <Text style={styles.emptyTitle}>No Note Selected</Text>
          <Text style={styles.emptyText}>
            Go to your notes and tap "Nearby" on a mature note to share it.
          </Text>
          <TouchableOpacity style={styles.doneBtn} onPress={() => router.back()}>
            <Text style={styles.doneBtnText}>Go Back</Text>
          </TouchableOpacity>
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
    catch (err) { Alert.alert('Connection Failed', (err as Error).message); }
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
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={22} color={Colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Share Note</Text>
          <View style={{ width: 40 }} />
        </View>
        <View style={styles.centered}>
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
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => { cancelSession(); router.back(); }}
          style={styles.backBtn}
        >
          <Ionicons name="arrow-back" size={22} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Share Note</Text>
        <View style={{ width: 40 }} />
      </View>

      {sessionState !== 'idle' && <ShareProgressIndicator state={sessionState} />}

      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        {/* Note ready badge */}
        <View style={styles.noteReady}>
          <Ionicons name="shield-checkmark" size={18} color={P01Colors.green} />
          <Text style={styles.noteReadyText}>Mature note ready to share</Text>
        </View>

        {/* Transport selector */}
        <Text style={styles.label}>Choose how to send</Text>
        <View style={styles.transportRow}>
          <TouchableOpacity
            style={[
              styles.transportCard,
              selectedTransport === 'ble' && styles.transportCardActive,
              !isBleAvailable && styles.transportCardDisabled,
            ]}
            onPress={handleStartBle}
            disabled={!isBleAvailable}
          >
            <Ionicons name="bluetooth" size={28} color={isBleAvailable ? P01Colors.blue : Colors.textTertiary} />
            <Text style={styles.transportTitle}>Bluetooth</Text>
            <Text style={styles.transportDesc}>
              {isBleAvailable ? 'Scan nearby' : 'Unavailable'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.transportCard,
              selectedTransport === 'nfc' && styles.transportCardActive,
              !isNfcAvailable && styles.transportCardDisabled,
            ]}
            onPress={handleStartNfc}
            disabled={!isNfcAvailable}
          >
            <Ionicons name="phone-portrait" size={28} color={isNfcAvailable ? P01Colors.pink : Colors.textTertiary} />
            <Text style={styles.transportTitle}>NFC Tap</Text>
            <Text style={styles.transportDesc}>
              {isNfcAvailable ? 'Tap phones' : 'Unavailable'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* BLE device list */}
        {selectedTransport === 'ble' && sessionState !== 'sending' && sessionState !== 'encrypting' && sessionState !== 'idle' && (
          <BleDeviceList
            peers={nearbyPeers}
            isScanning={isScanning}
            onSelectPeer={handleSelectPeer}
            onRefresh={() => startBleScan()}
          />
        )}

        {/* Transfer animation */}
        {(sessionState === 'sending' || sessionState === 'encrypting') && (
          <TransferAnimation
            isSending={true}
            transport={selectedTransport || 'ble'}
            peerName={activeSession?.peer?.displayName}
          />
        )}

        {/* Error */}
        {error && (
          <View style={styles.errorCard}>
            <Ionicons name="alert-circle" size={16} color={Colors.error} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {/* Security footer */}
        <View style={styles.securityInfo}>
          <Ionicons name="lock-closed" size={14} color={Colors.textTertiary} />
          <Text style={styles.securityText}>
            End-to-end encrypted. BLE: X25519 + XSalsa20-Poly1305. NFC: PIN-derived key.
          </Text>
        </View>
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
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
  },
  backBtn: {
    width: 40, height: 40, borderRadius: 9999,
    backgroundColor: Colors.surfaceSecondary,
    justifyContent: 'center', alignItems: 'center',
  },
  headerTitle: { color: Colors.text, fontSize: 20, fontFamily: FontFamily.bold },
  scrollView: { flex: 1 },
  scrollContent: { paddingHorizontal: Spacing.xl, paddingBottom: 120 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: Spacing.lg, paddingHorizontal: Spacing.xl },
  emptyTitle: { fontSize: 18, fontFamily: FontFamily.bold, color: Colors.text },
  emptyText: { fontSize: 14, fontFamily: FontFamily.regular, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 },
  successTitle: { fontSize: 22, fontFamily: FontFamily.bold, color: Colors.text },
  successDetail: { fontSize: 14, fontFamily: FontFamily.regular, color: Colors.textSecondary, textAlign: 'center' },
  doneBtn: {
    paddingHorizontal: 24, paddingVertical: 12,
    borderRadius: BorderRadius.md, backgroundColor: P01Colors.cyanDim, marginTop: Spacing.md,
  },
  doneBtnText: { fontSize: 15, fontFamily: FontFamily.semibold, color: P01Colors.cyan },
  noteReady: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: P01Colors.greenDim, borderRadius: BorderRadius.md,
    padding: Spacing.md, marginBottom: Spacing.xl,
  },
  noteReadyText: { fontSize: 14, fontFamily: FontFamily.medium, color: P01Colors.green },
  label: { fontSize: 14, fontFamily: FontFamily.semibold, color: Colors.textSecondary, marginBottom: Spacing.sm },
  transportRow: { flexDirection: 'row', gap: Spacing.md, marginBottom: Spacing.xl },
  transportCard: {
    flex: 1, alignItems: 'center', gap: 8,
    paddingVertical: Spacing.xl, borderRadius: BorderRadius.md,
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border,
  },
  transportCardActive: { borderColor: P01Colors.cyan, backgroundColor: P01Colors.cyanDim },
  transportCardDisabled: { opacity: 0.4 },
  transportTitle: { fontSize: 15, fontFamily: FontFamily.semibold, color: Colors.text },
  transportDesc: { fontSize: 11, fontFamily: FontFamily.regular, color: Colors.textTertiary, textAlign: 'center' },
  errorCard: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: Colors.errorDim, borderRadius: BorderRadius.md,
    padding: Spacing.md, marginBottom: Spacing.lg,
  },
  errorText: { flex: 1, fontSize: 13, fontFamily: FontFamily.regular, color: Colors.error },
  securityInfo: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: Spacing.sm },
  securityText: { flex: 1, fontSize: 11, fontFamily: FontFamily.regular, color: Colors.textTertiary, lineHeight: 16 },
});

/**
 * Receive Note Screen — BLE / NFC nearby note transfer
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput, StyleSheet,
  Modal, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, { SlideInDown, SlideOutDown } from 'react-native-reanimated';

import { useSharingStore } from '@/stores/sharingStore';
import { useShieldedStore } from '@/stores/shieldedStore';
import { useDenominatedPoolStore, type NoteSource } from '@/stores/denominatedPoolStore';
import type { TransportType, NotePayload } from '@/services/sharing/types';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import { p01Alert } from '@/stores/alertStore';
import { useT } from '@/i18n';

import FingerprintVerification from '@/components/sharing/FingerprintVerification';
import NfcTapOverlay from '@/components/sharing/NfcTapOverlay';
import ShareProgressIndicator from '@/components/sharing/ShareProgressIndicator';
import TransferAnimation from '@/components/sharing/TransferAnimation';

export default function ReceiveNoteScreen() {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const {
    activeSession, isBleAvailable, isNfcAvailable, pendingNote, error,
    checkAvailability, startBleReceiver, confirmFingerprintAndReceive,
    startNfcReceiver, cancelSession, clearPendingNote, clearError,
  } = useSharingStore();
  const { importNote: importShielded } = useShieldedStore();
  const { importNote: importDenominated } = useDenominatedPoolStore();

  const [selectedTransport, setSelectedTransport] = useState<TransportType | null>(null);
  const [nfcPin, setNfcPin] = useState('');
  const [showNfcOverlay, setShowNfcOverlay] = useState(false);
  const [showNfcPin, setShowNfcPin] = useState(false);
  const [imported, setImported] = useState(false);
  const [importedNote, setImportedNote] = useState<NotePayload | null>(null);

  useEffect(() => { checkAvailability(); }, []);

  const handleImport = useCallback(async (payload: NotePayload) => {
    try {
      if (payload.type === 'zk-shielded') await importShielded(payload.data);
      else if (payload.type === 'denominated-pool') importDenominated(payload.data, 'received' as NoteSource);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setImported(true); setImportedNote(payload); clearPendingNote();
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      p01Alert(t('nearby.importFailed'), (err as Error).message);
    }
  }, [importShielded, importDenominated, clearPendingNote]);

  useEffect(() => { if (pendingNote && !imported) handleImport(pendingNote); }, [pendingNote, imported, handleImport]);

  const sessionState = activeSession?.state || 'idle';
  const showFingerprint = sessionState === 'verifying-fingerprint' && activeSession?.fingerprint;

  // ── BLE ──
  const handleStartBle = useCallback(async () => {
    setSelectedTransport('ble'); clearError();
    try { await startBleReceiver(); }
    catch (err: any) { p01Alert(t('nearby.bluetoothError'), err?.reason || err?.message || t('alerts.errorGeneric')); }
  }, [startBleReceiver, clearError]);

  const handleFpConfirm = useCallback(async () => {
    try { await confirmFingerprintAndReceive(); } catch (e) { p01Alert(t('common.error'), (e as Error).message); }
  }, [confirmFingerprintAndReceive]);

  const handleFpReject = useCallback(async () => {
    await cancelSession();
    p01Alert(t('nearby.connectionCancelled'), t('nearby.fingerprintMismatch'));
  }, [cancelSession]);

  // ── NFC ──
  const handleStartNfc = useCallback(() => {
    if (!isNfcAvailable) {
      p01Alert(t('nearby.unavailable'), t('nearby.nfcUnavailable'));
      return;
    }
    p01Alert(
      t('nearby.experimentalFeature'),
      t('nearby.nfcWarning'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('nearby.continueNFC'), onPress: () => { setSelectedTransport('nfc'); clearError(); setShowNfcPin(true); } },
      ],
      'warning',
    );
  }, [clearError, isNfcAvailable]);

  const handleNfcSubmit = useCallback(async () => {
    if (nfcPin.length !== 6) return p01Alert(t('common.error'), t('nearby.invalidPin'));
    setShowNfcPin(false); setShowNfcOverlay(true);
    try {
      await startNfcReceiver(nfcPin);
      const note = useSharingStore.getState().pendingNote;
      if (note && !imported) handleImport(note);
    } catch (e) { p01Alert(t('nearby.nfcError'), (e as Error).message); }
    finally {
      setShowNfcOverlay(false);
      const storeErr = useSharingStore.getState().error;
      if (storeErr && !useSharingStore.getState().pendingNote) p01Alert(t('common.failed'), storeErr);
    }
  }, [nfcPin, startNfcReceiver, imported, handleImport]);

  // ── Success ──
  if (imported && importedNote) {
    return (
      <View style={[st.container, { paddingTop: insets.top }]}>
        <View style={st.header}>
          <TouchableOpacity onPress={() => router.back()} style={st.backBtn}>
            <Ionicons name="arrow-back" size={22} color={Colors.text} />
          </TouchableOpacity>
          <Text style={st.headerTitle}>{t('common.receive')}</Text>
          <View style={{ width: 40 }} />
        </View>
        <View style={st.centered}>
          <View style={st.successIcon}>
            <Ionicons name="checkmark-circle" size={56} color={P01Colors.green} />
          </View>
          <Text style={st.successTitle}>{t('nearby.noteReceived')}</Text>
          <Text style={st.successDesc}>
            {t('nearby.noteImported', { type: importedNote.type === 'zk-shielded' ? 'ZK Shielded' : 'Denominated Pool' })}
          </Text>
          <View style={{ width: '100%', gap: 8, marginTop: 24 }}>
            <TouchableOpacity style={st.primaryBtn} onPress={() => {
              cancelSession();
              router.push(importedNote.type === 'denominated-pool'
                ? '/(main)/(privacy)/denominated-notes' as any
                : '/(main)/(privacy)/shielded' as any);
            }}>
              <Ionicons name="eye" size={18} color="#000" />
              <Text style={st.primaryBtnText}>{t('nearby.viewNotes')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={st.secondaryBtn} onPress={() => { cancelSession(); router.back(); }}>
              <Text style={st.secondaryBtnText}>{t('common.done')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  }

  // ── NFC overlay ──
  if (showNfcOverlay) {
    return (
      <View style={[st.container, { paddingTop: insets.top }]}>
        <NfcTapOverlay isSender={false} onCancel={() => { cancelSession(); setShowNfcOverlay(false); }} />
      </View>
    );
  }

  // ── Main ──
  return (
    <View style={[st.container, { paddingTop: insets.top }]}>
      <View style={st.header}>
        <TouchableOpacity onPress={() => { cancelSession(); router.back(); }} style={st.backBtn}>
          <Ionicons name="arrow-back" size={22} color={Colors.text} />
        </TouchableOpacity>
        <Text style={st.headerTitle}>{t('nearby.receiveTitle')}</Text>
        <View style={{ width: 40 }} />
      </View>

      {sessionState !== 'idle' && <ShareProgressIndicator state={sessionState} />}

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: Spacing.xl, paddingBottom: 120 }}
        showsVerticalScrollIndicator={false}>

        {/* Transport methods */}
        <Text style={st.sectionLabel}>{t('nearby.chooseMethod')}</Text>
        <View style={{ flexDirection: 'row', gap: 10, marginBottom: 20 }}>
          {/* Bluetooth */}
          <TouchableOpacity
            onPress={handleStartBle} disabled={!isBleAvailable} activeOpacity={0.7}
            style={[st.methodCard, selectedTransport === 'ble' && st.methodCardActive,
              !isBleAvailable && { opacity: 0.35 }]}>
            <View style={[st.methodIcon, { backgroundColor: P01Colors.blueDim }]}>
              <Ionicons name="bluetooth" size={24} color={isBleAvailable ? P01Colors.blue : Colors.textTertiary} />
            </View>
            <Text style={st.methodTitle}>{t('nearby.bluetooth')}</Text>
            <Text style={st.methodDesc}>{isBleAvailable ? t('nearby.nearbySender') : t('nearby.unavailable')}</Text>
            {selectedTransport === 'ble' && (
              <View style={[st.activeDot, { backgroundColor: P01Colors.blue }]} />
            )}
          </TouchableOpacity>

          {/* NFC */}
          <TouchableOpacity
            onPress={handleStartNfc} activeOpacity={0.7}
            style={[st.methodCard, selectedTransport === 'nfc' && st.methodCardActive]}>
            <View style={[st.methodIcon, { backgroundColor: P01Colors.pinkDim }]}>
              <Ionicons name="phone-portrait" size={24} color={isNfcAvailable ? P01Colors.pink : Colors.textTertiary} />
            </View>
            <Text style={st.methodTitle}>{t('nearby.nfcTap')}</Text>
            <Text style={[st.methodDesc, { color: P01Colors.yellow }]}>{t('common.experimental')}</Text>
            {selectedTransport === 'nfc' && (
              <View style={[st.activeDot, { backgroundColor: P01Colors.pink }]} />
            )}
          </TouchableOpacity>
        </View>

        {/* BLE waiting */}
        {selectedTransport === 'ble' && ['scanning', 'connecting', 'key-exchange'].includes(sessionState) && (
          <View style={st.waitCard}>
            <View style={st.waitIcon}>
              <Ionicons name="bluetooth" size={28} color={P01Colors.blue} />
            </View>
            <Text style={st.waitTitle}>{t('nearby.waitingForSender')}</Text>
            <Text style={st.waitDesc}>
              {t('nearby.askSenderToOpen')}
            </Text>
          </View>
        )}

        {/* Transfer animation */}
        {['receiving', 'decrypting', 'importing'].includes(sessionState) && (
          <TransferAnimation
            isSending={false}
            transport={selectedTransport || 'ble'}
            peerName={activeSession?.peer?.displayName}
          />
        )}

        {/* Error */}
        {error && (
          <View style={st.errorCard}>
            <Ionicons name="warning" size={16} color={Colors.error} />
            <Text style={st.errorText}>{error}</Text>
          </View>
        )}

        {/* How it works */}
        <View style={st.infoSection}>
          <Text style={st.sectionLabel}>{t('nearby.howItWorks')}</Text>
          {[
            { icon: 'radio-outline', color: P01Colors.blue, text: t('nearby.step1') },
            { icon: 'key-outline', color: P01Colors.cyan, text: t('nearby.step2') },
            { icon: 'finger-print-outline', color: P01Colors.pink, text: t('nearby.step3') },
            { icon: 'shield-checkmark-outline', color: P01Colors.green, text: t('nearby.step4') },
          ].map((step, i) => (
            <View key={i} style={st.stepRow}>
              <View style={[st.stepIcon, { backgroundColor: `${step.color}12` }]}>
                <Ionicons name={step.icon as any} size={16} color={step.color} />
              </View>
              <Text style={st.stepText}>{step.text}</Text>
            </View>
          ))}
        </View>

        {/* Security */}
        <View style={st.footerInfo}>
          <Ionicons name="lock-closed" size={13} color={Colors.textTertiary} />
          <Text style={st.footerText}>
            {t('nearby.e2eEncrypted')}
          </Text>
        </View>
      </ScrollView>

      {/* NFC PIN modal */}
      <Modal visible={showNfcPin} transparent animationType="none" statusBarTranslucent
        onRequestClose={() => setShowNfcPin(false)}>
        <KeyboardAvoidingView style={ms.overlay} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <TouchableOpacity style={ms.backdrop} activeOpacity={1} onPress={() => setShowNfcPin(false)} />
          <Animated.View entering={SlideInDown.duration(200)} exiting={SlideOutDown.duration(150)} style={ms.sheet}>
            <View style={ms.dragRow}><View style={ms.dragHandle} /></View>
            <View style={{ alignItems: 'center', marginBottom: 20 }}>
              <View style={[st.methodIcon, { backgroundColor: P01Colors.cyanDim, width: 52, height: 52, borderRadius: 16, marginBottom: 12 }]}>
                <Ionicons name="key" size={24} color={P01Colors.cyan} />
              </View>
              <Text style={st.waitTitle}>{t('nearby.enterPin')}</Text>
              <Text style={st.waitDesc}>{t('nearby.askSenderForCode')}</Text>
            </View>
            <View style={{ alignItems: 'center', marginBottom: 24 }}>
              <TextInput style={ms.pinInput} value={nfcPin}
                onChangeText={val => setNfcPin(val.replace(/[^0-9]/g, '').slice(0, 6))}
                placeholder="000000" placeholderTextColor={Colors.textTertiary}
                keyboardType="number-pad" maxLength={6} textAlign="center" autoFocus />
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TouchableOpacity style={st.secondaryBtn} onPress={() => setShowNfcPin(false)}>
                <Text style={st.secondaryBtnText}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={handleNfcSubmit} disabled={nfcPin.length !== 6}
                style={[st.primaryBtn, { flex: 2 }, nfcPin.length !== 6 && { opacity: 0.4 }]}>
                <Ionicons name="phone-portrait" size={16} color="#000" />
                <Text style={st.primaryBtnText}>{t('nearby.startNFCScan')}</Text>
              </TouchableOpacity>
            </View>
          </Animated.View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Fingerprint modal */}
      {showFingerprint && (
        <FingerprintVerification visible fingerprint={activeSession!.fingerprint!}
          peerName={activeSession?.peer?.displayName}
          onConfirm={handleFpConfirm} onReject={handleFpReject} />
      )}
    </View>
  );
}

const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl, paddingVertical: Spacing.md,
  },
  backBtn: {
    width: 40, height: 40, borderRadius: BorderRadius.full,
    backgroundColor: Colors.surfaceSecondary, alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: { fontSize: 20, fontFamily: FontFamily.bold, color: Colors.text },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: Spacing.xl },

  sectionLabel: { fontSize: 11, fontFamily: FontFamily.bold, color: Colors.textTertiary, letterSpacing: 1, marginBottom: 10 },

  // Method cards
  methodCard: {
    flex: 1, alignItems: 'center', gap: 8,
    paddingVertical: 24, paddingHorizontal: 12,
    backgroundColor: Colors.surfaceSecondary, borderRadius: BorderRadius.xl,
    borderWidth: 1, borderColor: 'transparent',
  },
  methodCardActive: { borderColor: Colors.surfaceTertiary },
  methodIcon: {
    width: 48, height: 48, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
  },
  methodTitle: { fontSize: 15, fontFamily: FontFamily.semibold, color: Colors.text },
  methodDesc: { fontSize: 11, fontFamily: FontFamily.regular, color: Colors.textTertiary, textAlign: 'center' },
  activeDot: { width: 6, height: 6, borderRadius: 3, marginTop: 4 },

  // Waiting
  waitCard: {
    alignItems: 'center', gap: 10,
    padding: 28, backgroundColor: Colors.surfaceSecondary, borderRadius: BorderRadius.xl, marginBottom: 20,
  },
  waitIcon: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: P01Colors.blueDim, alignItems: 'center', justifyContent: 'center',
  },
  waitTitle: { fontSize: 17, fontFamily: FontFamily.semibold, color: Colors.text },
  waitDesc: { fontSize: 13, fontFamily: FontFamily.regular, color: Colors.textSecondary, textAlign: 'center', lineHeight: 19 },

  // Error
  errorCard: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    padding: 12, backgroundColor: 'rgba(255,51,102,0.08)', borderRadius: BorderRadius.md, marginBottom: 16,
  },
  errorText: { flex: 1, fontSize: 13, fontFamily: FontFamily.regular, color: Colors.error },

  // Steps
  infoSection: { marginTop: 8, marginBottom: 20 },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  stepIcon: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  stepText: { flex: 1, fontSize: 13, fontFamily: FontFamily.regular, color: Colors.textSecondary },

  // Footer
  footerInfo: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: Spacing.md },
  footerText: { flex: 1, fontSize: 11, fontFamily: FontFamily.regular, color: Colors.textTertiary, lineHeight: 16 },

  // Success
  successIcon: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: P01Colors.greenDim, alignItems: 'center', justifyContent: 'center', marginBottom: 16,
  },
  successTitle: { fontSize: 22, fontFamily: FontFamily.bold, color: Colors.text, marginBottom: 6 },
  successDesc: { fontSize: 14, fontFamily: FontFamily.regular, color: Colors.textSecondary, textAlign: 'center' },

  // Buttons
  primaryBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 14, borderRadius: BorderRadius.md, backgroundColor: P01Colors.cyan,
  },
  primaryBtnText: { fontSize: 15, fontFamily: FontFamily.bold, color: '#000' },
  secondaryBtn: {
    flex: 1, paddingVertical: 14, borderRadius: BorderRadius.md,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: Colors.surfaceSecondary,
  },
  secondaryBtnText: { fontSize: 15, fontFamily: FontFamily.semibold, color: Colors.text },
});

const ms = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.7)' },
  sheet: {
    backgroundColor: Colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingHorizontal: Spacing.xl, paddingBottom: 40,
  },
  dragRow: { alignItems: 'center', paddingTop: 10, paddingBottom: Spacing.md },
  dragHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: Colors.surfaceTertiary },
  pinInput: {
    width: 200, fontSize: 28, fontFamily: FontFamily.mono, color: P01Colors.cyan, letterSpacing: 8,
    backgroundColor: 'rgba(0,0,0,0.3)', borderRadius: BorderRadius.md,
    borderWidth: 1.5, borderColor: `${P01Colors.cyan}30`,
    paddingVertical: 14, paddingHorizontal: Spacing.xl, textAlign: 'center',
  },
});

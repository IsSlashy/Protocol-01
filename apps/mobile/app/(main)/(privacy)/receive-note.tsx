/**
 * Receive Note Screen — BLE / NFC nearby note transfer
 * Glass design matching share-note.tsx
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput, StyleSheet,
  Modal, KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown, FadeInUp, SlideInDown, SlideOutDown } from 'react-native-reanimated';

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
      <SafeAreaView style={s.container} edges={['top']}>
        <Animated.View entering={FadeInDown.delay(50)} style={s.header}>
          <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
            <Ionicons name="arrow-back" size={22} color={Colors.text} />
          </TouchableOpacity>
          <Text style={s.headerTitle}>{t('nearby.receiveTitle')}</Text>
          <View style={{ width: 40 }} />
        </Animated.View>
        <View style={s.centered}>
          <Animated.View entering={FadeInUp.delay(100)}>
            <View style={s.glassOuter}>
              <BlurView intensity={15} tint="dark" style={s.glassInner}>
                <LinearGradient
                  colors={['rgba(57, 197, 187, 0.06)', 'rgba(255, 119, 168, 0.03)', 'transparent']}
                  start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                  style={StyleSheet.absoluteFill}
                />
                <Ionicons name="checkmark-circle" size={64} color={P01Colors.green} />
                <Text style={s.successTitle}>{t('nearby.noteReceived')}</Text>
                <Text style={s.successDesc}>
                  {t('nearby.noteImported', { type: importedNote.type === 'zk-shielded' ? 'ZK Shielded' : 'Denominated Pool' })}
                </Text>
                <View style={{ width: '100%', gap: 8, marginTop: 24 }}>
                  <TouchableOpacity style={s.primaryBtn} onPress={() => {
                    cancelSession();
                    router.push(importedNote.type === 'denominated-pool'
                      ? '/(main)/(privacy)/denominated-notes' as any
                      : '/(main)/(privacy)/shielded' as any);
                  }}>
                    <Ionicons name="eye" size={18} color="#000" />
                    <Text style={s.primaryBtnText}>{t('nearby.viewNotes')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.secondaryBtn} onPress={() => { cancelSession(); router.back(); }}>
                    <Text style={s.secondaryBtnText}>{t('common.done')}</Text>
                  </TouchableOpacity>
                </View>
              </BlurView>
            </View>
          </Animated.View>
        </View>
      </SafeAreaView>
    );
  }

  // ── NFC overlay ──
  if (showNfcOverlay) {
    return (
      <SafeAreaView style={s.container} edges={['top']}>
        <NfcTapOverlay isSender={false} onCancel={() => { cancelSession(); setShowNfcOverlay(false); }} />
      </SafeAreaView>
    );
  }

  // ── Main ──
  return (
    <SafeAreaView style={s.container} edges={['top']}>
      <Animated.View entering={FadeInDown.delay(50)} style={s.header}>
        <TouchableOpacity onPress={() => { cancelSession(); router.back(); }} style={s.backBtn}>
          <Ionicons name="arrow-back" size={22} color={Colors.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>{t('nearby.receiveTitle')}</Text>
        <View style={{ width: 40 }} />
      </Animated.View>

      {sessionState !== 'idle' && <ShareProgressIndicator state={sessionState} />}

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: Spacing.xl, paddingBottom: 120 }}
        showsVerticalScrollIndicator={false}>

        {/* Transport methods */}
        <Animated.View entering={FadeInUp.delay(100)}>
          <Text style={s.label}>{t('nearby.chooseMethod')}</Text>
        </Animated.View>
        <View style={s.transportRow}>
          {/* Bluetooth */}
          <Animated.View entering={FadeInUp.delay(150)} style={{ flex: 1 }}>
            <TouchableOpacity
              onPress={handleStartBle} disabled={!isBleAvailable} activeOpacity={0.7}
              style={[s.glassOuter, selectedTransport === 'ble' && s.glassOuterActive,
                !isBleAvailable && { opacity: 0.35 }]}>
              <BlurView intensity={12} tint="dark" style={s.transportGlass}>
                <LinearGradient
                  colors={selectedTransport === 'ble'
                    ? ['rgba(57, 197, 187, 0.10)', 'rgba(57, 197, 187, 0.03)', 'transparent']
                    : ['rgba(57, 197, 187, 0.06)', 'rgba(255, 119, 168, 0.03)', 'transparent']}
                  start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                  style={StyleSheet.absoluteFill}
                />
                <Ionicons name="bluetooth" size={28} color={isBleAvailable ? P01Colors.blue : Colors.textTertiary} />
                <Text style={s.transportTitle}>{t('nearby.bluetooth')}</Text>
                <Text style={s.transportDesc}>
                  {isBleAvailable ? t('nearby.nearbySender') : t('nearby.unavailable')}
                </Text>
              </BlurView>
            </TouchableOpacity>
          </Animated.View>

          {/* NFC — disabled, coming soon */}
          <Animated.View entering={FadeInUp.delay(210)} style={{ flex: 1 }}>
            <View style={[s.glassOuter, { opacity: 0.35 }]}>
              <BlurView intensity={12} tint="dark" style={s.transportGlass}>
                <LinearGradient
                  colors={['rgba(57, 197, 187, 0.06)', 'rgba(255, 119, 168, 0.03)', 'transparent']}
                  start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                  style={StyleSheet.absoluteFill}
                />
                <Ionicons name="phone-portrait" size={28} color={Colors.textTertiary} />
                <Text style={s.transportTitle}>{t('nearby.nfcTap')}</Text>
                <Text style={[s.transportDesc, { color: Colors.textTertiary }]}>{t('common.comingSoon')}</Text>
              </BlurView>
            </View>
          </Animated.View>
        </View>

        {/* BLE waiting */}
        {selectedTransport === 'ble' && ['scanning', 'connecting', 'key-exchange'].includes(sessionState) && (
          <Animated.View entering={FadeInUp.delay(100)}>
            <View style={s.glassOuter}>
              <BlurView intensity={12} tint="dark" style={[s.glassInner, { alignItems: 'center', gap: 10, padding: 28 }]}>
                <LinearGradient
                  colors={['rgba(57, 197, 187, 0.06)', 'transparent']}
                  start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                  style={StyleSheet.absoluteFill}
                />
                <View style={s.waitIcon}>
                  <Ionicons name="bluetooth" size={28} color={P01Colors.blue} />
                </View>
                <Text style={s.waitTitle}>{t('nearby.waitingForSender')}</Text>
                <Text style={s.waitDesc}>{t('nearby.askSenderToOpen')}</Text>
              </BlurView>
            </View>
          </Animated.View>
        )}

        {/* Transfer animation */}
        {['receiving', 'decrypting', 'importing'].includes(sessionState) && (
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
            <View style={s.errorOuter}>
              <BlurView intensity={12} tint="dark" style={s.errorGlass}>
                <LinearGradient
                  colors={['rgba(239, 68, 68, 0.08)', 'rgba(239, 68, 68, 0.02)', 'transparent']}
                  start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                  style={StyleSheet.absoluteFill}
                />
                <Ionicons name="alert-circle" size={16} color={Colors.error} />
                <Text style={s.errorText}>{error}</Text>
              </BlurView>
            </View>
          </Animated.View>
        )}

        {/* How it works */}
        <Animated.View entering={FadeInUp.delay(270)}>
          <Text style={s.label}>{t('nearby.howItWorks')}</Text>
          {[
            { icon: 'radio-outline', color: P01Colors.blue, text: t('nearby.step1') },
            { icon: 'key-outline', color: P01Colors.cyan, text: t('nearby.step2') },
            { icon: 'finger-print-outline', color: P01Colors.pink, text: t('nearby.step3') },
            { icon: 'shield-checkmark-outline', color: P01Colors.green, text: t('nearby.step4') },
          ].map((step, i) => (
            <View key={i} style={s.stepRow}>
              <View style={[s.stepIcon, { backgroundColor: `${step.color}12` }]}>
                <Ionicons name={step.icon as any} size={16} color={step.color} />
              </View>
              <Text style={s.stepText}>{step.text}</Text>
            </View>
          ))}
        </Animated.View>

        {/* Security footer */}
        <Animated.View entering={FadeInUp.delay(320)}>
          <View style={s.securityOuter}>
            <BlurView intensity={8} tint="dark" style={s.securityGlass}>
              <LinearGradient
                colors={['rgba(57, 197, 187, 0.04)', 'transparent']}
                start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                style={StyleSheet.absoluteFill}
              />
              <Ionicons name="lock-closed" size={14} color={Colors.textTertiary} />
              <Text style={s.securityText}>
                {t('nearby.e2eEncrypted')}
              </Text>
            </BlurView>
          </View>
        </Animated.View>

        {/* Manual import link */}
        <Animated.View entering={FadeInUp.delay(380)}>
          <TouchableOpacity
            style={s.importLink}
            onPress={() => router.push('/(main)/(privacy)/denominated-import' as any)}
            activeOpacity={0.6}
          >
            <Ionicons name="clipboard-outline" size={14} color={Colors.textTertiary} />
            <Text style={s.importLinkText}>{t('privacy.importNote')}</Text>
          </TouchableOpacity>
        </Animated.View>
      </ScrollView>

      {/* NFC PIN modal */}
      <Modal visible={showNfcPin} transparent animationType="none" statusBarTranslucent
        onRequestClose={() => setShowNfcPin(false)}>
        <KeyboardAvoidingView style={ms.overlay} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <TouchableOpacity style={ms.backdrop} activeOpacity={1} onPress={() => setShowNfcPin(false)} />
          <Animated.View entering={SlideInDown.duration(200)} exiting={SlideOutDown.duration(150)} style={ms.sheet}>
            <View style={ms.dragRow}><View style={ms.dragHandle} /></View>
            <View style={{ alignItems: 'center', marginBottom: 20 }}>
              <View style={{ width: 52, height: 52, borderRadius: 16, backgroundColor: P01Colors.cyanDim, alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>
                <Ionicons name="key" size={24} color={P01Colors.cyan} />
              </View>
              <Text style={s.waitTitle}>{t('nearby.enterPin')}</Text>
              <Text style={s.waitDesc}>{t('nearby.askSenderForCode')}</Text>
            </View>
            <View style={{ alignItems: 'center', marginBottom: 24 }}>
              <TextInput style={ms.pinInput} value={nfcPin}
                onChangeText={val => setNfcPin(val.replace(/[^0-9]/g, '').slice(0, 6))}
                placeholder="000000" placeholderTextColor={Colors.textTertiary}
                keyboardType="number-pad" maxLength={6} textAlign="center" autoFocus />
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TouchableOpacity style={s.secondaryBtn} onPress={() => setShowNfcPin(false)}>
                <Text style={s.secondaryBtnText}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={handleNfcSubmit} disabled={nfcPin.length !== 6}
                style={[s.primaryBtn, { flex: 2 }, nfcPin.length !== 6 && { opacity: 0.4 }]}>
                <Ionicons name="phone-portrait" size={16} color="#000" />
                <Text style={s.primaryBtnText}>{t('nearby.startNFCScan')}</Text>
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
    </SafeAreaView>
  );
}

// ── Styles (glass design matching share-note.tsx) ─────────────────────
const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl, paddingVertical: Spacing.lg,
  },
  backBtn: {
    width: 40, height: 40, borderRadius: 9999,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    justifyContent: 'center', alignItems: 'center',
  },
  headerTitle: { color: Colors.text, fontSize: 20, fontFamily: FontFamily.bold },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: Spacing.xl },
  label: { fontSize: 14, fontFamily: FontFamily.semibold, color: Colors.textSecondary, marginBottom: Spacing.sm },

  // Glass cards
  glassOuter: {
    borderRadius: 20, overflow: 'hidden',
    borderWidth: 1, borderColor: 'rgba(57, 197, 187, 0.07)',
    marginBottom: Spacing.lg,
  },
  glassOuterActive: { borderColor: P01Colors.cyan },
  glassInner: {
    alignItems: 'center', gap: Spacing.lg, padding: Spacing.xl * 2,
    backgroundColor: 'rgba(12, 12, 14, 0.65)',
  },

  // Transport glass cards
  transportRow: { flexDirection: 'row', gap: Spacing.md, marginBottom: Spacing.xl },
  transportGlass: {
    alignItems: 'center', gap: 8,
    paddingVertical: Spacing.xl, paddingHorizontal: Spacing.md,
    backgroundColor: 'rgba(12, 12, 14, 0.65)',
  },
  transportTitle: { fontSize: 15, fontFamily: FontFamily.semibold, color: Colors.text },
  transportDesc: { fontSize: 11, fontFamily: FontFamily.regular, color: Colors.textTertiary, textAlign: 'center' },

  // Wait
  waitIcon: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: P01Colors.blueDim, alignItems: 'center', justifyContent: 'center',
  },
  waitTitle: { fontSize: 17, fontFamily: FontFamily.semibold, color: Colors.text },
  waitDesc: { fontSize: 13, fontFamily: FontFamily.regular, color: Colors.textSecondary, textAlign: 'center', lineHeight: 19 },

  // Error glass
  errorOuter: {
    borderRadius: 20, overflow: 'hidden',
    borderWidth: 1, borderColor: 'rgba(239, 68, 68, 0.15)',
    marginBottom: Spacing.lg,
  },
  errorGlass: {
    flexDirection: 'row', alignItems: 'center', gap: 8, padding: Spacing.md,
    backgroundColor: 'rgba(12, 12, 14, 0.65)',
  },
  errorText: { flex: 1, fontSize: 13, fontFamily: FontFamily.regular, color: Colors.error },

  // Steps
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  stepIcon: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  stepText: { flex: 1, fontSize: 13, fontFamily: FontFamily.regular, color: Colors.textSecondary },

  // Security footer glass
  securityOuter: {
    borderRadius: 20, overflow: 'hidden',
    borderWidth: 1, borderColor: 'rgba(57, 197, 187, 0.05)',
  },
  securityGlass: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: Spacing.md,
    backgroundColor: 'rgba(12, 12, 14, 0.45)',
  },
  securityText: { flex: 1, fontSize: 11, fontFamily: FontFamily.regular, color: Colors.textTertiary, lineHeight: 16 },

  // Import link
  importLink: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 16, marginTop: 4,
  },
  importLinkText: { fontSize: 13, fontFamily: FontFamily.medium, color: Colors.textTertiary },

  // Success
  successTitle: { fontSize: 22, fontFamily: FontFamily.bold, color: Colors.text },
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
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
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

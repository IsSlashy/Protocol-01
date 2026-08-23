/**
 * Receive a note from a nearby device.
 *
 * 🎯 REBUILT ON THE REALIGNED THEME 2026-08-23, as the mirror of share-note.
 *
 * ⛔ THE GLASS IS GONE, and with it the hardcoded `rgba(255, 119, 168, …)` that
 * ran through five of this screen's gradients. That is the retired pink,
 * written as a literal in a StyleSheet, which is exactly why retuning
 * `constants/theme.ts` moved nothing here. Panels are a fill and a hairline.
 *
 * ⛔ AND THE FOUR-COLOUR STEP LIST IS ONE COLOUR. "How it works" had a blue, a
 * cyan, a pink and a green icon for four steps that carry no decision between
 * them. Four accents on an explanation, while the control the user actually has
 * to find sits in the same cyan as step two.
 *
 * ⚠️ `container` was `backgroundColor: 'transparent'`, which only looked right
 * because a parent happened to paint ink behind it. A screen owns its ground.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput, StyleSheet,
  Modal, KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown, FadeInUp, SlideInDown, SlideOutDown } from 'react-native-reanimated';

import { useSharingStore } from '@/stores/sharingStore';
import { useShieldedStore } from '@/stores/shieldedStore';
import { useDenominatedPoolStore, type NoteSource } from '@/stores/denominatedPoolStore';
import type { TransportType, NotePayload } from '@/services/sharing/types';
import { Colors, FontFamily, FontSize, BorderRadius, Spacing } from '@/constants/theme';
import { Button } from '@/components/ui';
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
          <TouchableOpacity
            onPress={() => { cancelSession(); router.back(); }}
            style={s.backBtn}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityRole="button"
            accessibilityLabel={t('common.back')}
          >
            <Ionicons name="chevron-back" size={22} color={Colors.textSecondary} />
          </TouchableOpacity>
          <Text style={s.headerTitle}>{t('nearby.receiveTitle')}</Text>
          <View style={s.headerSpacer} />
        </Animated.View>
        <View style={s.centered}>
          <Animated.View entering={FadeInUp.delay(100)} style={s.centeredContent}>
            <Ionicons name="checkmark-circle-outline" size={40} color={Colors.primary} />
            <Text style={s.successTitle}>{t('nearby.noteReceived')}</Text>
            <Text style={s.successDesc}>
              {t('nearby.noteImported', { type: importedNote.type === 'zk-shielded' ? 'ZK Shielded' : 'Denominated Pool' })}
            </Text>
            <View style={s.centeredActions}>
              <Button
                variant="primary"
                size="lg"
                fullWidth
                onPress={() => {
                  cancelSession();
                  router.push(importedNote.type === 'denominated-pool'
                    ? '/(main)/(privacy)/denominated-notes' as any
                    : '/(main)/(privacy)/shielded' as any);
                }}
              >
                {t('nearby.viewNotes')}
              </Button>
              <Button
                variant="ghost"
                size="md"
                fullWidth
                onPress={() => { cancelSession(); router.back(); }}
              >
                {t('common.done')}
              </Button>
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
        <TouchableOpacity
          onPress={() => { cancelSession(); router.back(); }}
          style={s.backBtn}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityRole="button"
          accessibilityLabel={t('common.back')}
        >
          <Ionicons name="chevron-back" size={22} color={Colors.textSecondary} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>{t('nearby.receiveTitle')}</Text>
        <View style={s.headerSpacer} />
      </Animated.View>

      {sessionState !== 'idle' && <ShareProgressIndicator state={sessionState} />}

      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}>

        {/* Transport methods */}
        <Animated.View entering={FadeInUp.delay(100)}>
          <Text style={s.label}>{t('nearby.chooseMethod')}</Text>
        </Animated.View>
        <View style={s.transportRow}>
          {/* Bluetooth */}
          <Animated.View entering={FadeInUp.delay(150)} style={s.transportSlot}>
            <TouchableOpacity
              onPress={handleStartBle} disabled={!isBleAvailable} activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityState={{ selected: selectedTransport === 'ble', disabled: !isBleAvailable }}
              accessibilityLabel={t('nearby.bluetooth')}
              style={[
                s.transportCard,
                selectedTransport === 'ble' && s.transportCardActive,
                !isBleAvailable && s.transportCardDisabled,
              ]}>
              <Ionicons name="bluetooth" size={24} color={isBleAvailable ? Colors.primary : Colors.textTertiary} />
              <Text style={s.transportTitle}>{t('nearby.bluetooth')}</Text>
              <Text style={s.transportDesc}>
                {isBleAvailable ? t('nearby.nearbySender') : t('nearby.unavailable')}
              </Text>
            </TouchableOpacity>
          </Animated.View>

          {/* NFC — disabled, coming soon */}
          <Animated.View entering={FadeInUp.delay(210)} style={s.transportSlot}>
            <View style={[s.transportCard, s.transportCardDisabled]}>
              <Ionicons name="phone-portrait-outline" size={24} color={Colors.textTertiary} />
              <Text style={s.transportTitle}>{t('nearby.nfcTap')}</Text>
              <Text style={s.transportDesc}>{t('common.comingSoon')}</Text>
            </View>
          </Animated.View>
        </View>

        {/* BLE waiting */}
        {selectedTransport === 'ble' && ['scanning', 'connecting', 'key-exchange'].includes(sessionState) && (
          <Animated.View entering={FadeInUp.delay(100)}>
            <View style={s.waitPanel}>
              <Ionicons name="bluetooth" size={24} color={Colors.primary} />
              <Text style={s.waitTitle}>{t('nearby.waitingForSender')}</Text>
              <Text style={s.waitDesc}>{t('nearby.askSenderToOpen')}</Text>
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
            <View style={s.errorPanel} accessibilityRole="alert">
              <Ionicons name="alert-circle" size={16} color={Colors.error} />
              <Text style={s.errorText}>{error}</Text>
            </View>
          </Animated.View>
        )}

        {/* How it works */}
        <Animated.View entering={FadeInUp.delay(270)}>
          <Text style={s.label}>{t('nearby.howItWorks')}</Text>
          {[
            { icon: 'radio-outline', text: t('nearby.step1') },
            { icon: 'key-outline', text: t('nearby.step2') },
            { icon: 'finger-print-outline', text: t('nearby.step3') },
            { icon: 'shield-checkmark-outline', text: t('nearby.step4') },
          ].map((step, i) => (
            <View key={i} style={s.stepRow}>
              <Ionicons name={step.icon as any} size={16} color={Colors.textTertiary} />
              <Text style={s.stepText}>{step.text}</Text>
            </View>
          ))}
        </Animated.View>

        {/* Security footer */}
        <Animated.View entering={FadeInUp.delay(320)}>
          <View style={s.securityRow}>
            <Ionicons name="lock-closed-outline" size={13} color={Colors.textTertiary} />
            <Text style={s.securityText}>
              {t('nearby.e2eEncrypted')}
            </Text>
          </View>
        </Animated.View>

        {/* Manual import link */}
        <Animated.View entering={FadeInUp.delay(380)}>
          <TouchableOpacity
            style={s.importLink}
            onPress={() => router.push('/(main)/(privacy)/denominated-import' as any)}
            activeOpacity={0.6}
            accessibilityRole="button"
            accessibilityLabel={t('privacy.importNote')}
          >
            <Ionicons name="clipboard-outline" size={14} color={Colors.textSecondary} />
            <Text style={s.importLinkText}>{t('privacy.importNote')}</Text>
          </TouchableOpacity>
        </Animated.View>
      </ScrollView>

      {/* NFC PIN modal */}
      <Modal visible={showNfcPin} transparent animationType="none" statusBarTranslucent
        onRequestClose={() => setShowNfcPin(false)}>
        <KeyboardAvoidingView style={ms.overlay} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <TouchableOpacity
            style={ms.backdrop}
            activeOpacity={1}
            onPress={() => setShowNfcPin(false)}
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}
          />
          <Animated.View entering={SlideInDown.duration(200)} exiting={SlideOutDown.duration(150)} style={ms.sheet}>
            <View style={ms.dragRow}><View style={ms.dragHandle} /></View>
            <View style={ms.sheetHead}>
              <Text style={s.waitTitle}>{t('nearby.enterPin')}</Text>
              <Text style={s.waitDesc}>{t('nearby.askSenderForCode')}</Text>
            </View>
            <View style={ms.pinRow}>
              <TextInput style={ms.pinInput} value={nfcPin}
                onChangeText={val => setNfcPin(val.replace(/[^0-9]/g, '').slice(0, 6))}
                placeholder="000000" placeholderTextColor={Colors.textTertiary}
                keyboardType="number-pad" maxLength={6} textAlign="center" autoFocus
                accessibilityLabel={t('nearby.enterPin')} />
            </View>
            <View style={ms.sheetActions}>
              <View style={ms.sheetActionSlot}>
                <Button variant="secondary" size="md" fullWidth onPress={() => setShowNfcPin(false)}>
                  {t('common.cancel')}
                </Button>
              </View>
              <View style={ms.sheetActionSlotWide}>
                <Button
                  variant="primary"
                  size="md"
                  fullWidth
                  disabled={nfcPin.length !== 6}
                  onPress={handleNfcSubmit}
                >
                  {t('nearby.startNFCScan')}
                </Button>
              </View>
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

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, minHeight: 56,
  },
  backBtn: { width: 44, height: 44, justifyContent: 'center', alignItems: 'center' },
  headerSpacer: { width: 44 },
  headerTitle: {
    flex: 1, color: Colors.text, fontSize: FontSize.xl, fontFamily: FontFamily.displayMedium,
  },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: Spacing.xl, paddingTop: Spacing.lg, paddingBottom: 120 },
  centered: { flex: 1, justifyContent: 'center', paddingHorizontal: Spacing['3xl'] },
  centeredContent: { alignItems: 'center' },
  centeredActions: { width: '100%', gap: Spacing.md, marginTop: Spacing['3xl'] },
  label: {
    fontSize: FontSize.sm, fontFamily: FontFamily.medium,
    color: Colors.textSecondary, marginBottom: Spacing.md,
  },

  // Transport cards
  transportRow: { flexDirection: 'row', gap: Spacing.md, marginBottom: Spacing.xl },
  transportSlot: { flex: 1 },
  transportCard: {
    alignItems: 'center', gap: Spacing.sm,
    minHeight: 100,
    paddingVertical: Spacing.xl, paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1, borderColor: Colors.border,
  },
  transportCardActive: { borderColor: Colors.primary },
  transportCardDisabled: { opacity: 0.4 },
  transportTitle: { fontSize: FontSize.md, fontFamily: FontFamily.medium, color: Colors.text },
  transportDesc: {
    fontSize: FontSize.xs, fontFamily: FontFamily.regular,
    color: Colors.textTertiary, textAlign: 'center',
  },

  // Waiting
  waitPanel: {
    alignItems: 'center', gap: Spacing.sm,
    padding: Spacing['2xl'], marginBottom: Spacing.lg,
    borderRadius: BorderRadius.lg,
    backgroundColor: Colors.surfaceSecondary,
    borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.border,
  },
  waitTitle: { fontSize: FontSize.lg, fontFamily: FontFamily.displayMedium, color: Colors.text },
  waitDesc: {
    fontSize: FontSize.sm, fontFamily: FontFamily.regular,
    color: Colors.textSecondary, textAlign: 'center', lineHeight: 19,
  },

  // Error
  errorPanel: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.errorDim, borderRadius: BorderRadius.md,
    padding: Spacing.md, marginBottom: Spacing.lg,
  },
  errorText: {
    flex: 1, fontSize: FontSize.sm, fontFamily: FontFamily.regular, color: Colors.error,
  },

  // Steps
  stepRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md, marginBottom: Spacing.md,
  },
  stepText: {
    flex: 1, fontSize: FontSize.sm, fontFamily: FontFamily.regular, color: Colors.textSecondary,
  },

  // Security note
  securityRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm,
    paddingTop: Spacing.lg, marginTop: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.borderSoft,
  },
  securityText: {
    flex: 1, fontSize: FontSize.xs, fontFamily: FontFamily.regular,
    color: Colors.textTertiary, lineHeight: 16,
  },

  // Import link
  importLink: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: Spacing.sm, minHeight: 44, marginTop: Spacing.md,
  },
  importLinkText: {
    fontSize: FontSize.sm, fontFamily: FontFamily.medium, color: Colors.textSecondary,
  },

  // Success
  successTitle: {
    fontSize: FontSize['2xl'], fontFamily: FontFamily.display,
    color: Colors.text, marginTop: Spacing.lg,
  },
  successDesc: {
    fontSize: FontSize.md, fontFamily: FontFamily.regular,
    color: Colors.textSecondary, textAlign: 'center', lineHeight: 22, marginTop: Spacing.sm,
  },
});

/** The ground at 72%, derived the way `components/ui/AlertModal` derives it. */
const SCRIM = `${Colors.background}b8`;

const ms = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: SCRIM },
  sheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: BorderRadius['2xl'], borderTopRightRadius: BorderRadius['2xl'],
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border,
    paddingHorizontal: Spacing.xl, paddingBottom: Spacing['4xl'],
  },
  dragRow: { alignItems: 'center', paddingTop: Spacing.md, paddingBottom: Spacing.md },
  dragHandle: {
    width: 40, height: 4, borderRadius: 2, backgroundColor: Colors.borderLight,
  },
  sheetHead: { alignItems: 'center', gap: Spacing.xs, marginBottom: Spacing.xl },
  pinRow: { alignItems: 'center', marginBottom: Spacing['2xl'] },
  sheetActions: { flexDirection: 'row', gap: Spacing.sm },
  sheetActionSlot: { flex: 1 },
  sheetActionSlotWide: { flex: 2 },
  pinInput: {
    width: 200, minHeight: 56,
    fontSize: FontSize['2xl'], fontFamily: FontFamily.mono,
    color: Colors.text, letterSpacing: 8,
    backgroundColor: Colors.surfaceSecondary, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border,
    paddingVertical: Spacing.md, paddingHorizontal: Spacing.xl, textAlign: 'center',
  },
});

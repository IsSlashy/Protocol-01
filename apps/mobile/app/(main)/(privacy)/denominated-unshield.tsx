import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown } from 'react-native-reanimated';

import {
  useDenominatedPoolStore, type StoredNote, type NoteStatus,
} from '@/stores/denominatedPoolStore';
import { useStarkProver } from '@/providers/StarkProverProvider';
import { useArcium } from '@/providers/ArciumProvider';
import { receiptFromJSON } from '@/services/denominatedPool';
import { vaultDecrypt } from '@/utils/crypto/noteVault';
import { getKeypair } from '@/services/solana/wallet';
import { useWalletStore } from '@/stores/walletStore';
import { PublicKey } from '@solana/web3.js';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import { requireBiometricAuth } from '@/utils/biometricGate';
import { p01Alert } from '@/stores/alertStore';
import { useT } from '@/i18n';

export default function DenominatedUnshieldScreen() {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ noteId?: string; emergency?: string }>();
  const isEmergencyMode = params.emergency === '1';

  const {
    notes, isLoading, isProving, error, progress,
    unshieldNoteStark, refreshNoteStatuses,
  } = useDenominatedPoolStore();

  const { publicKey: walletPublicKey } = useWalletStore();
  const { isReady: starkReady, generatePoolCommitmentProof } = useStarkProver();
  const { isMpcActive } = useArcium();

  const [selectedNote, setSelectedNote] = useState<StoredNote | null>(null);
  const [recipient, setRecipient] = useState('');
  const [useOwnWallet, setUseOwnWallet] = useState(true);
  const [emergencyToggle, setEmergencyToggle] = useState(isEmergencyMode);

  const matureNotes = notes.filter(n => n.status === 'mature');
  const pendingNotes = notes.filter(n => n.status === 'pending');
  const selectableNotes = emergencyToggle ? [...matureNotes, ...pendingNotes] : matureNotes;

  useEffect(() => {
    if (params.noteId) {
      const note = notes.find(n => n.id === params.noteId);
      if (note) setSelectedNote(note);
    }
    refreshNoteStatuses();
  }, [params.noteId]);

  useEffect(() => {
    if (!useOwnWallet) return;
    if (walletPublicKey) {
      setRecipient(walletPublicKey);
      return;
    }
    (async () => {
      const keypair = await getKeypair();
      if (keypair) setRecipient(keypair.publicKey.toBase58());
    })();
  }, [useOwnWallet, walletPublicKey]);

  const executeUnshield = useCallback(async (emergency: boolean) => {
    if (!selectedNote) {
      p01Alert(t('shieldUnshield.selectNote'), t('shieldUnshield.selectNoteFirst'));
      return;
    }
    // Resolve recipient. Accepts either a raw Solana pubkey OR a stealth
    // meta-address (`st:01...`). Meta-addresses are expanded into a one-time
    // stealth pubkey so the on-chain unshield tx doesn't link to a known
    // wallet — see private-send.tsx for the same pattern.
    let finalRecipient = recipient.trim();
    let stealthUsed = false;
    try {
      const { isMetaAddress, deriveStealthForRecipient } = require('@/services/stealth/keys');
      if (isMetaAddress(finalRecipient)) {
        const stealth = deriveStealthForRecipient(finalRecipient);
        finalRecipient = stealth.address;
        stealthUsed = true;
      } else {
        new PublicKey(finalRecipient);
      }
    } catch {
      p01Alert(t('common.error'), t('shieldUnshield.invalidRecipient'));
      return;
    }
    if (!finalRecipient) {
      p01Alert(t('common.error'), t('shieldUnshield.invalidRecipient'));
      return;
    }
    const authed = await requireBiometricAuth('Authenticate to unshield funds');
    if (!authed) {
      p01Alert(t('common.error'), t('shieldUnshield.authRequired'));
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      if (!starkReady) {
        p01Alert(t('common.error'), t('shieldUnshield.starkNotReady'));
        return;
      }
      const receipt = receiptFromJSON(vaultDecrypt(selectedNote.receiptJSON));
      const starkResult = await generatePoolCommitmentProof(
        receipt.nullifierPreimage.toString(),
        receipt.secret.toString(),
        receipt.depositEpoch.toString(),
        receipt.tokenMint.toString(),
      );
      const proofBytes = Buffer.from(starkResult.proofHex, 'hex');
      const publicInputs = starkResult.publicInputs.map((s: string) => BigInt(s));
      // Single unified call — `emergency` only flips min_epoch=0 on-chain; the
      // privacy posture (ephemeral signer + ECDH stealth recipient + random sweep)
      // is identical for both paths.
      const sig = await unshieldNoteStark(
        selectedNote.id,
        finalRecipient,
        { proofBytes, publicInputs, proofSize: starkResult.proofSize },
        emergency,
      );

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      useWalletStore.getState().refreshBalance();
      setTimeout(() => useWalletStore.getState().refreshTransactions(), 5000);
      const proofLabel = isMpcActive ? 'STARK + MPC' : 'STARK';
      const mpcNote = isMpcActive ? `\n\n${t('shieldUnshield.nullifierHidden')}` : '';
      const stealthNote = stealthUsed ? `\n\nStealth → ${finalRecipient.slice(0, 8)}...` : '';
      p01Alert(
        emergency ? t('shieldUnshield.emergencyComplete') : `${t('shieldUnshield.unshieldComplete')} (${proofLabel})`,
        `${selectedNote.denomination} ${selectedNote.token} → ${finalRecipient.slice(0, 8)}...${mpcNote}${stealthNote}\n\nTx: ${sig.slice(0, 16)}...`,
        [{ text: 'OK', onPress: () => router.back() }],
      );
    } catch (err: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      p01Alert(t('common.error'), err.message);
    }
  }, [selectedNote, recipient, unshieldNoteStark, starkReady, generatePoolCommitmentProof, router, t, isMpcActive]);

  const handleUnshield = useCallback(() => {
    if (emergencyToggle) {
      p01Alert(
        t('shieldUnshield.privacyWarning'),
        t('shieldUnshield.emergencyWarning'),
        [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('privacy.proceed'), style: 'destructive', onPress: () => executeUnshield(true) },
        ],
      );
    } else {
      executeUnshield(false);
    }
  }, [emergencyToggle, executeUnshield, t]);

  const statusIcon = (status: NoteStatus) => {
    switch (status) {
      case 'mature': return { name: 'checkmark-circle' as const, color: P01Colors.cyan };
      case 'pending': return { name: 'time' as const, color: P01Colors.yellow };
      default: return { name: 'close-circle' as const, color: Colors.textTertiary };
    }
  };

  return (
    <View style={[st.container, { paddingTop: insets.top }]}>
      {/* ── Header ── */}
      <View style={st.header}>
        <TouchableOpacity onPress={() => router.back()} style={st.backBtn}>
          <Ionicons name="arrow-back" size={20} color={Colors.text} />
        </TouchableOpacity>
        <Text style={st.headerTitle}>
          {emergencyToggle ? t('privacy.emergencyUnshield') : t('shieldUnshield.unshieldTitle')}
        </Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: Spacing.xl, paddingBottom: insets.bottom + 100 }}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Mode Toggle ── */}
        <Animated.View entering={FadeInDown.duration(250)}>
          <View style={st.toggle}>
            <ToggleBtn
              label={t('shieldUnshield.normal')}
              active={!emergencyToggle}
              color={P01Colors.cyan}
              onPress={() => { setEmergencyToggle(false); setSelectedNote(null); }}
            />
            <ToggleBtn
              label={t('shieldUnshield.emergency')}
              icon="warning"
              active={emergencyToggle}
              color="#FF6B35"
              onPress={() => { setEmergencyToggle(true); setSelectedNote(null); }}
            />
          </View>
        </Animated.View>

        {/* ── Emergency Warning ── */}
        {emergencyToggle && (
          <Animated.View entering={FadeInDown.duration(200)}>
            <View style={st.alertCard}>
              <Ionicons name="warning" size={16} color="#FF6B35" />
              <Text style={st.alertText}>{t('shieldUnshield.emergencyWarning')}</Text>
            </View>
          </Animated.View>
        )}

        {/* ── Section: Select Note ── */}
        <Animated.View entering={FadeInDown.delay(60).duration(250)}>
          <Text style={st.sectionLabel}>
            {emergencyToggle ? t('shieldUnshield.selectANote') : t('shieldUnshield.selectMatureNote')}
          </Text>

          {selectableNotes.length === 0 && notes.filter(n => n.status !== 'spent').length === 0 && (
            <View style={st.emptyCard}>
              <View style={st.emptyIcon}>
                <Ionicons name="receipt-outline" size={24} color={Colors.textTertiary} />
              </View>
              <Text style={st.emptyText}>{t('shieldUnshield.noNotesFound')}</Text>
              <TouchableOpacity
                style={st.emptyAction}
                onPress={() => router.push('/(main)/(privacy)/denominated-shield' as any)}
              >
                <Text style={st.emptyActionText}>{t('shieldUnshield.goToShield')}</Text>
              </TouchableOpacity>
            </View>
          )}

          {!emergencyToggle && matureNotes.length === 0 && pendingNotes.length > 0 && (
            <View style={st.infoCard}>
              <Ionicons name="time-outline" size={16} color={P01Colors.yellow} />
              <Text style={st.infoText}>
                {t('shieldUnshield.notesMaturing', { count: pendingNotes.length })}
              </Text>
            </View>
          )}

          <View style={{ gap: 8 }}>
            {selectableNotes.map((note, i) => {
              const isSelected = selectedNote?.id === note.id;
              const icon = statusIcon(note.status);
              return (
                <Animated.View key={note.id} entering={FadeInDown.delay(100 + i * 40).duration(250)}>
                  <TouchableOpacity
                    style={[st.noteCard, isSelected && st.noteCardSelected]}
                    onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setSelectedNote(note); }}
                    disabled={isLoading}
                    activeOpacity={0.7}
                  >
                    <View style={[st.noteIcon, { backgroundColor: `${icon.color}18` }]}>
                      <Ionicons name={icon.name} size={20} color={icon.color} />
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={st.noteAmount}>{note.denomination} {note.token}</Text>
                      <Text style={st.noteTime}>{new Date(note.shieldedAt).toLocaleString()}</Text>
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      {note.status === 'pending' && emergencyToggle && (
                        <Badge text={t('shieldUnshield.immature').toUpperCase()} color="#FF6B35" />
                      )}
                      <Ionicons
                        name={isSelected ? 'radio-button-on' : 'radio-button-off'}
                        size={20}
                        color={isSelected ? P01Colors.cyan : Colors.textTertiary}
                      />
                    </View>
                  </TouchableOpacity>
                </Animated.View>
              );
            })}
          </View>
        </Animated.View>

        {/* ── Section: Recipient ── */}
        <Animated.View entering={FadeInDown.delay(180).duration(250)}>
          <Text style={st.sectionLabel}>{t('shieldUnshield.recipientAddress')}</Text>

          <View style={st.toggle}>
            <ToggleBtn
              label={t('shieldUnshield.myWallet')}
              active={useOwnWallet}
              color={P01Colors.cyan}
              onPress={() => setUseOwnWallet(true)}
            />
            <ToggleBtn
              label={t('shieldUnshield.custom')}
              active={!useOwnWallet}
              color={P01Colors.cyan}
              onPress={() => { setUseOwnWallet(false); setRecipient(''); }}
            />
          </View>

          {!useOwnWallet && (
            <TextInput
              style={st.addressInput}
              value={recipient}
              onChangeText={setRecipient}
              placeholder={t('shieldUnshield.solanaAddress')}
              placeholderTextColor={Colors.textTertiary}
              autoCapitalize="none"
              autoCorrect={false}
            />
          )}

          {useOwnWallet && recipient ? (
            <View style={st.addressPreview}>
              <Ionicons name="wallet-outline" size={14} color={Colors.textSecondary} />
              <Text style={st.addressPreviewText} numberOfLines={1}>{recipient}</Text>
            </View>
          ) : null}
        </Animated.View>

        {/* ── Confirm Button ── */}
        <Animated.View entering={FadeInDown.delay(260).duration(250)}>
          <TouchableOpacity
            style={[
              st.confirmBtn,
              emergencyToggle && selectedNote?.status === 'pending' && st.confirmBtnEmergency,
              (!selectedNote || isLoading) && st.confirmBtnDisabled,
            ]}
            onPress={handleUnshield}
            disabled={!selectedNote || isLoading}
            activeOpacity={0.8}
          >
            {isLoading ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <ActivityIndicator size="small" color="#000" />
                <Text style={st.confirmText}>
                  {isProving ? t('shieldUnshield.generatingProof') : progress || t('shieldUnshield.unshielding')}
                </Text>
              </View>
            ) : (
              <>
                <Ionicons name={emergencyToggle ? 'warning' : 'arrow-up-circle'} size={20} color="#000" />
                <Text style={st.confirmText}>
                  {selectedNote
                    ? (emergencyToggle && selectedNote.status === 'pending'
                      ? t('shieldUnshield.emergencyWithdraw', { amount: selectedNote.denomination, token: selectedNote.token })
                      : t('shieldUnshield.withdraw', { amount: selectedNote.denomination, token: selectedNote.token }))
                    : t('shieldUnshield.selectNoteFirst')}
                </Text>
              </>
            )}
          </TouchableOpacity>
          {isLoading && <UnshieldProgressBar progress={progress} />}
        </Animated.View>

        {/* ── Privacy Footer ── */}
        <Animated.View entering={FadeInDown.delay(320).duration(250)}>
          <View style={st.privacyFooter}>
            <Ionicons name="lock-closed" size={13} color={Colors.textTertiary} />
            <Text style={st.privacyText}>{t('shieldUnshield.starkOnDevice')}</Text>
          </View>
        </Animated.View>

        {/* ── Error ── */}
        {error && !isLoading && (
          <View style={st.errorCard}>
            <Ionicons name="alert-circle" size={16} color={Colors.error} />
            <Text style={st.errorText}>{error}</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────

function ToggleBtn({ label, icon, active, color, onPress }: {
  label: string; icon?: string; active: boolean; color: string; onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[st.toggleBtn, active && { backgroundColor: `${color}18`, borderColor: `${color}40` }]}
      onPress={onPress} activeOpacity={0.7}
    >
      {icon && <Ionicons name={icon as any} size={14} color={active ? color : Colors.textTertiary} />}
      <Text style={[st.toggleText, active && { color }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function UnshieldProgressBar({ progress }: { progress: string | null }) {
  const text = progress || '';
  const batchMatch = text.match(/batch\s+(\d+)\s*\/\s*(\d+)/i);
  const resizeMatch = text.match(/resize|Resizing/i);
  const provingMatch = text.match(/proof|commitment|STARK/i);

  let current = 0;
  let total = 0;
  let label = text;

  if (batchMatch) {
    current = parseInt(batchMatch[1], 10);
    total = parseInt(batchMatch[2], 10);
    label = `Uploading proof · batch ${current}/${total}`;
  } else if (resizeMatch) {
    label = 'Resizing proof buffer';
  } else if (provingMatch) {
    label = text;
  }

  const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : (text ? 8 : 0);
  return (
    <View style={st.progressWrap}>
      <View style={st.progressRow}>
        <Text style={st.progressLabel} numberOfLines={1}>{label}</Text>
        {total > 0 && <Text style={st.progressCount}>{current}/{total}</Text>}
      </View>
      <View style={st.progressTrack}>
        <View style={[st.progressFill, { width: `${pct}%` }]} />
      </View>
    </View>
  );
}

function Badge({ text, color }: { text: string; color: string }) {
  return (
    <View style={[st.badge, { backgroundColor: `${color}20` }]}>
      <Text style={[st.badgeText, { color }]}>{text}</Text>
    </View>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────

const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },

  // Header
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl, paddingVertical: Spacing.lg,
  },
  backBtn: {
    width: 40, height: 40, borderRadius: BorderRadius.full,
    backgroundColor: Colors.surfaceSecondary, alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: { fontSize: 18, fontFamily: FontFamily.bold, color: Colors.text },

  // Toggle
  toggle: {
    flexDirection: 'row', gap: 4, padding: 4,
    backgroundColor: Colors.surfaceSecondary, borderRadius: BorderRadius.lg, marginBottom: Spacing.lg,
  },
  toggleBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 10, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: 'transparent',
  },
  toggleText: { fontSize: 13, fontFamily: FontFamily.semibold, color: Colors.textSecondary },

  // Alert / Info cards
  alertCard: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    padding: 14, backgroundColor: 'rgba(255,107,53,0.08)', borderRadius: BorderRadius.xl,
    borderWidth: 1, borderColor: 'rgba(255,107,53,0.2)', marginBottom: Spacing.lg,
  },
  alertText: { flex: 1, fontSize: 13, fontFamily: FontFamily.regular, color: '#FF6B35', lineHeight: 19 },
  infoCard: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    padding: 14, backgroundColor: `${P01Colors.yellow}10`, borderRadius: BorderRadius.xl,
    borderWidth: 1, borderColor: `${P01Colors.yellow}30`, marginBottom: 12,
  },
  infoText: { flex: 1, fontSize: 13, fontFamily: FontFamily.regular, color: P01Colors.yellow, lineHeight: 19 },

  // Section
  sectionLabel: {
    fontSize: 12, fontFamily: FontFamily.semibold, color: Colors.textSecondary,
    letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: Spacing.md, marginTop: Spacing.lg,
  },

  // Note cards
  noteCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 14, backgroundColor: Colors.surfaceSecondary, borderRadius: BorderRadius.xl,
  },
  noteCardSelected: { borderWidth: 1, borderColor: `${P01Colors.cyan}40` },
  noteIcon: {
    width: 42, height: 42, borderRadius: BorderRadius.md,
    alignItems: 'center', justifyContent: 'center',
  },
  noteAmount: { fontSize: 15, fontFamily: FontFamily.bold, color: Colors.text },
  noteTime: { fontSize: 12, fontFamily: FontFamily.regular, color: Colors.textTertiary, marginTop: 2 },

  // Badge
  badge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  badgeText: { fontSize: 9, fontFamily: FontFamily.semibold },

  // Empty state
  emptyCard: {
    alignItems: 'center', gap: 12, padding: 32,
    backgroundColor: Colors.surfaceSecondary, borderRadius: BorderRadius.xl,
  },
  emptyIcon: {
    width: 48, height: 48, borderRadius: 24,
    backgroundColor: '#1a1a1f', alignItems: 'center', justifyContent: 'center',
  },
  emptyText: { fontSize: 14, fontFamily: FontFamily.regular, color: Colors.textSecondary, textAlign: 'center' },
  emptyAction: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: BorderRadius.full, backgroundColor: P01Colors.cyanDim },
  emptyActionText: { fontSize: 13, fontFamily: FontFamily.semibold, color: P01Colors.cyan },

  // Recipient
  addressInput: {
    backgroundColor: Colors.surfaceSecondary, borderRadius: BorderRadius.lg,
    paddingHorizontal: 16, paddingVertical: 14,
    color: Colors.text, fontFamily: FontFamily.mono, fontSize: 13,
  },
  addressPreview: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: Colors.surfaceSecondary, borderRadius: BorderRadius.lg,
    paddingHorizontal: 14, paddingVertical: 12,
  },
  addressPreviewText: { flex: 1, fontFamily: FontFamily.mono, fontSize: 12, color: Colors.textSecondary },

  // Confirm button
  confirmBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: P01Colors.cyan, borderRadius: BorderRadius.lg,
    paddingVertical: 16, marginTop: Spacing.xl,
  },
  confirmBtnEmergency: { backgroundColor: '#FF6B35' },
  confirmBtnDisabled: { opacity: 0.4 },
  confirmText: { fontSize: 15, fontFamily: FontFamily.bold, color: '#000' },

  // Progress bar (chunk upload)
  progressWrap: { marginTop: 12, paddingHorizontal: 2 },
  progressRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 6,
  },
  progressLabel: {
    flex: 1, fontSize: 11, fontFamily: FontFamily.mono,
    color: Colors.textSecondary, letterSpacing: 0.3,
  },
  progressCount: {
    fontSize: 11, fontFamily: FontFamily.bold,
    color: P01Colors.cyan, marginLeft: 8,
  },
  progressTrack: {
    height: 4, borderRadius: 2, overflow: 'hidden',
    backgroundColor: 'rgba(0,224,255,0.12)',
  },
  progressFill: {
    height: '100%', backgroundColor: P01Colors.cyan, borderRadius: 2,
  },

  // Privacy footer
  privacyFooter: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, marginTop: Spacing.lg,
  },
  privacyText: { fontSize: 11, fontFamily: FontFamily.regular, color: Colors.textTertiary },

  // Error
  errorCard: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: `${Colors.error}12`, borderRadius: BorderRadius.xl,
    padding: 14, marginTop: Spacing.lg,
  },
  errorText: { flex: 1, fontSize: 13, fontFamily: FontFamily.regular, color: Colors.error },
});

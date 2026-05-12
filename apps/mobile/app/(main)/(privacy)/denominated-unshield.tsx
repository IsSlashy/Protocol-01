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
import {
  receiptFromJSON,
  ALL_POOLS_V3,
  fetchPoolLeavesByIndex,
  buildMerkleProofFromLeavesV3,
  goldilocksToLeBytes32,
} from '@/services/denominatedPool';
import { vaultDecrypt } from '@/utils/crypto/noteVault';
import { getKeypair } from '@/services/solana/wallet';
import { getConnection } from '@/services/solana/connection';
import { useWalletStore } from '@/stores/walletStore';
import { PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import { OperationProgressBar } from '@/components/ui/OperationProgressBar';
import { requireBiometricAuth } from '@/utils/biometricGate';
import { withKeepAwake } from '@/utils/keepAwakeDuring';
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
    unshieldNoteStark, unshieldNoteStarkV3, refreshNoteStatuses, resetOperationState,
  } = useDenominatedPoolStore();

  const { publicKey: walletPublicKey } = useWalletStore();
  const {
    isReady: starkReady,
    generatePoolCommitmentProof,
    generateMerklePathProof,
  } = useStarkProver();
  const { isMpcActive } = useArcium();

  const [selectedNote, setSelectedNote] = useState<StoredNote | null>(null);
  const [recipient, setRecipient] = useState('');
  const [useOwnWallet, setUseOwnWallet] = useState(true);
  const [emergencyToggle, setEmergencyToggle] = useState(isEmergencyMode);
  const [refreshing, setRefreshing] = useState(false);
  // Sync re-tap guard (store's isLoading flips after biometric+stealth+RPC).
  const [submitting, setSubmitting] = useState(false);

  const matureNotes = notes.filter(n => n.status === 'mature');
  const pendingNotes = notes.filter(n => n.status === 'pending');
  const usedNotes = notes.filter(n => n.status === 'spent' || n.status === 'transferred');
  const selectableNotes = emergencyToggle ? [...matureNotes, ...pendingNotes] : matureNotes;

  const doRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshNoteStatuses();
    } finally {
      setRefreshing(false);
    }
  }, [refreshNoteStatuses]);

  useEffect(() => {
    if (params.noteId) {
      const note = notes.find(n => n.id === params.noteId);
      if (note) setSelectedNote(note);
    }
    doRefresh();
  }, [params.noteId]);

  // If the currently-selected note got marked spent during refresh, deselect it.
  useEffect(() => {
    if (selectedNote && (selectedNote.status === 'spent' || selectedNote.status === 'transferred')) {
      setSelectedNote(null);
    }
  }, [selectedNote, notes]);

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
    if (submitting) return;
    setSubmitting(true);
    try {
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
      const sig = await withKeepAwake(emergency ? 'p01-emergency-unshield' : 'p01-unshield', async () => {
        const receipt = receiptFromJSON(vaultDecrypt(selectedNote.receiptJSON));

        if (selectedNote.poolVersion === 'v3') {
          // V3 unshield = C1 (pool_commitment) + C3 (merkle_path) proofs
          // submitted sequentially. The StarkProver is single-threaded
          // (one WebView) — DO NOT use Promise.all here.
          const pool = ALL_POOLS_V3.find(p => p.poolPDA.toBase58() === selectedNote.poolPDA);
          if (!pool) throw new Error('V3 pool config not found for this note');

          // C1 — pool commitment proof (same publicInputs format as v2).
          const c1Result = await generatePoolCommitmentProof(
            receipt.nullifierPreimage.toString(),
            receipt.secret.toString(),
            receipt.depositEpoch.toString(),
            receipt.tokenMint.toString(),
          );

          // Build merkle path against the current on-chain V3 tree.
          // V3 trees are real (subtrees attested by C6), so a pure rebuild
          // from leaves matches the on-chain root. We need this fresh path
          // because other deposits may have been added since the receipt was
          // stored.
          const conn = getConnection();
          // Bumped from default 1000 to 5000 — devnet Helius 429s frequently
          // truncate the signature list at low limits; missing even one
          // LeafInserted event makes `buildMerkleProofFromLeavesV3` fill that
          // slot with BN254 ZERO_VALUE (gap-fill), producing a Goldilocks
          // root that doesn't exist on-chain → InvalidMerkleRoot at unshield.
          const SIG_SCAN_LIMIT = 5000;
          let leafScan = await fetchPoolLeavesByIndex(conn, pool.poolPDA, { maxSignatures: SIG_SCAN_LIMIT });
          let { leavesByIndex } = leafScan;
          let merkleProof = buildMerkleProofFromLeavesV3({
            leavesByIndex,
            targetLeafIndex: receipt.leafIndex,
          });

          // Pre-proof verification — if the rebuilt root isn't in the pool's
          // known roots, the STARK proof would fail at submission anyway
          // (after burning ~2 SOL of buffer rent + 7 min of upload). Re-fetch
          // the pool, retry the scan ONCE more with delay if mismatch (gives
          // Helius indexer time to catch up on a just-shielded note).
          {
            const { parsePoolAccount } = await import('@/services/denominatedPool/parsePool');
            const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
            const checkRoot = async (rootBigint: bigint, label: string) => {
              const acct = await conn.getAccountInfo(pool.poolPDA, 'confirmed');
              if (!acct) return null;
              const parsed = parsePoolAccount(acct.data);
              if (!parsed) return null;
              const target = new Uint8Array(goldilocksToLeBytes32(rootBigint));
              const inCur = eq(target, parsed.currentRoot);
              const idx = parsed.historicalRoots.findIndex(r => eq(target, r));
              const ok = inCur || idx >= 0;
              console.log(`[Unshield/V3] pre-proof ${label}: rebuilt c3Root in pool? ${ok ? 'YES (' + (inCur ? 'currentRoot' : 'hist[' + idx + ']') + ')' : 'NO'} — pool nextLeafIdx=${parsed.nextLeafIndex} histLen=${parsed.historicalRoots.length} mySeen=${leafScan.scannedLeafCount} missing=${leafScan.missing.length}`);
              return ok;
            };
            const ok1 = await checkRoot(merkleProof.root, 'attempt-1');
            if (ok1 === false) {
              console.warn('[Unshield/V3] root mismatch — retrying scan after 8s with limit ' + (SIG_SCAN_LIMIT * 2));
              await new Promise(r => setTimeout(r, 8000));
              leafScan = await fetchPoolLeavesByIndex(conn, pool.poolPDA, { maxSignatures: SIG_SCAN_LIMIT * 2 });
              leavesByIndex = leafScan.leavesByIndex;
              merkleProof = buildMerkleProofFromLeavesV3({ leavesByIndex, targetLeafIndex: receipt.leafIndex });
              const ok2 = await checkRoot(merkleProof.root, 'attempt-2');
              if (ok2 === false) {
                throw new Error(
                  'Cannot rebuild merkle root that matches the pool. ' +
                  'Likely a missing LeafInserted event (Helius indexing delay). ' +
                  'Wait ~30s and retry, or restart the app to bust caches.',
                );
              }
            }
          }
          const { root: c3Root, pathElements: c3Path, pathIndices: c3Indices } = merkleProof;

          // Stash the latest root onto the receipt so the v3 unshield ix
          // sends the merkle_root that's currently in the on-chain ring.
          // (Mutation OK — receipt is local to this closure.)
          receipt.merkleRoot = c3Root;
          receipt.merklePathElements = c3Path;
          receipt.merklePathIndices = c3Indices;

          // C3 — merkle path proof (NEW in V3).
          const U64 = (1n << 64n) - 1n;
          const c3Result = await generateMerklePathProof(
            (receipt.commitment & U64).toString(),
            c3Path.map(e => (e & U64).toString()),
            c3Indices,
          );

          // Re-encrypt the receipt back into the StoredNote so future
          // operations see the refreshed merkleRoot. (We persist via the
          // store's secureReceipt helper inside unshieldNoteStarkV3 — the
          // store reads the receipt fresh so passing the updated values is
          // not strictly needed for this single call.)

          const c1Bytes = Buffer.from(c1Result.proofHex, 'hex');
          const c1Inputs = c1Result.publicInputs.map((s: string) => BigInt(s));
          const c3Bytes = Buffer.from(c3Result.proofHex, 'hex');
          const c3Inputs = c3Result.publicInputs.map((s: string) => BigInt(s));

          return unshieldNoteStarkV3(
            selectedNote.id,
            finalRecipient,
            { proofBytes: c1Bytes, publicInputs: c1Inputs, proofSize: c1Result.proofSize },
            { proofBytes: c3Bytes, publicInputs: c3Inputs, proofSize: c3Result.proofSize },
            emergency,
          );
        }

        // v2 path — single STARK proof (pool_commitment).
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
        return unshieldNoteStark(
          selectedNote.id,
          finalRecipient,
          { proofBytes, publicInputs, proofSize: starkResult.proofSize },
          emergency,
        );
      });

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
    } finally {
      setSubmitting(false);
    }
  }, [selectedNote, recipient, unshieldNoteStark, unshieldNoteStarkV3, starkReady, generatePoolCommitmentProof, generateMerklePathProof, router, t, isMpcActive, submitting]);

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

      {isLoading && (
        <View style={st.stickyProgress}>
          <ActivityIndicator size="small" color={P01Colors.cyan} />
          <Text style={st.stickyProgressText} numberOfLines={2}>
            {isProving ? `${progress ?? 'Processing'} (proving…)` : (progress ?? 'Processing…')}
          </Text>
          <TouchableOpacity
            style={st.stickyCancel}
            onPress={resetOperationState}
            accessibilityRole="button"
            accessibilityLabel="Cancel stuck operation"
          >
            <Ionicons name="close" size={16} color={Colors.text} />
          </TouchableOpacity>
        </View>
      )}

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
          <View style={st.sectionLabelRow}>
            <Text style={[st.sectionLabel, { marginTop: 0, marginBottom: 0 }]}>
              {emergencyToggle ? t('shieldUnshield.selectANote') : t('shieldUnshield.selectMatureNote')}
            </Text>
            <TouchableOpacity
              onPress={doRefresh}
              disabled={refreshing}
              style={st.refreshBtn}
              accessibilityRole="button"
              accessibilityLabel="Refresh note statuses"
            >
              {refreshing ? (
                <ActivityIndicator size="small" color={P01Colors.cyan} />
              ) : (
                <Ionicons name="refresh" size={16} color={P01Colors.cyan} />
              )}
              <Text style={st.refreshBtnText}>{refreshing ? 'Checking…' : 'Refresh'}</Text>
            </TouchableOpacity>
          </View>

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

          {usedNotes.length > 0 && (
            <View style={st.usedHint}>
              <Ionicons name="information-circle-outline" size={14} color={Colors.textTertiary} />
              <Text style={st.usedHintText}>
                {usedNotes.length} note{usedNotes.length === 1 ? '' : 's'} already used (shown below, can't be reused)
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

          {usedNotes.length > 0 && (
            <View style={{ gap: 6, marginTop: Spacing.lg }}>
              <Text style={st.usedSectionLabel}>USED NOTES</Text>
              {usedNotes.map((note) => (
                <View key={note.id} style={st.usedNoteCard}>
                  <View style={[st.noteIcon, { backgroundColor: 'rgba(255,255,255,0.04)' }]}>
                    <Ionicons name="checkmark-done" size={18} color={Colors.textTertiary} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={st.usedNoteAmount}>{note.denomination} {note.token}</Text>
                    <Text style={st.usedNoteTime}>
                      {note.status === 'spent' ? 'Spent' : 'Transferred'} · {new Date(note.shieldedAt).toLocaleDateString()}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          )}
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
              (!selectedNote || isLoading || submitting) && st.confirmBtnDisabled,
            ]}
            onPress={handleUnshield}
            disabled={!selectedNote || isLoading || submitting}
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
          {isLoading && <OperationProgressBar progress={progress} variant="inline" />}
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

  // Sticky progress (below header, always visible during long flow)
  stickyProgress: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: Spacing.xl,
    marginBottom: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderRadius: 12,
    backgroundColor: 'rgba(57, 197, 187, 0.15)',
    borderWidth: 1,
    borderColor: P01Colors.cyan,
    gap: Spacing.sm,
  },
  stickyProgressText: {
    flex: 1,
    color: Colors.text,
    fontSize: 13,
    fontFamily: FontFamily.medium,
  },
  stickyCancel: {
    width: 28,
    height: 28,
    borderRadius: 9999,
    backgroundColor: Colors.surfaceSecondary,
    justifyContent: 'center',
    alignItems: 'center',
  },

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
  sectionLabelRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: Spacing.md, marginTop: Spacing.lg,
  },
  refreshBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8,
    backgroundColor: `${P01Colors.cyan}14`,
  },
  refreshBtnText: {
    fontSize: 12, fontFamily: FontFamily.semibold, color: P01Colors.cyan,
  },
  usedHint: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 10, paddingVertical: 8, marginBottom: Spacing.sm,
  },
  usedHintText: { flex: 1, fontSize: 11, color: Colors.textTertiary, fontFamily: FontFamily.regular },
  usedSectionLabel: {
    fontSize: 10, fontFamily: FontFamily.semibold, color: Colors.textTertiary,
    letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 4,
  },
  usedNoteCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 12, backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: BorderRadius.lg,
    opacity: 0.6,
  },
  usedNoteAmount: { fontSize: 13, fontFamily: FontFamily.semibold, color: Colors.textSecondary },
  usedNoteTime: { fontSize: 11, fontFamily: FontFamily.regular, color: Colors.textTertiary, marginTop: 2 },

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

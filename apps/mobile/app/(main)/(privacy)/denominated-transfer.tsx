import React, { useState, useCallback, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Share,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';

import { Buffer } from 'buffer';
import { useDenominatedPoolStore, type StoredNote } from '@/stores/denominatedPoolStore';
import { useStarkProver } from '@/providers/StarkProverProvider';
import {
  receiptFromJSON,
  ALL_POOLS_V3,
  fetchPoolLeavesByIndex,
  buildMerkleProofFromLeavesV3,
  computeNewRootFromSubtreesV3,
  parseFilledSubtrees,
  createCommitmentV3,
  pubkeyToField,
  slotToEpoch,
} from '@/services/denominatedPool';
import { vaultDecrypt } from '@/utils/crypto/noteVault';
import { getConnection } from '@/services/solana/connection';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import { p01Alert } from '@/stores/alertStore';
import { useT } from '@/i18n';

/**
 * 64-bit cryptographically-random scalar for V3 transfer note secrets.
 * The recipient's note must be unrelated to the sender's wallet seed —
 * deterministic recovery doesn't apply, only the recipient's possession of
 * `(secret, nullifier_preimage)` lets them spend the note.
 */
function secureRandomU64(): bigint {
  const bytes = new Uint8Array(8);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 8; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let n = 0n;
  for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(bytes[i]);
  return n;
}

export default function DenominatedTransferScreen() {
  return <TransferScreenContent />;
}

function TransferScreenContent() {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { noteId: paramNoteId } = useLocalSearchParams<{ noteId?: string }>();
  const {
    notes,
    transferNoteStark,
    transferNoteStarkV3,
    isLoading,
    isProving,
    progress,
    error,
  } = useDenominatedPoolStore();
  const {
    isReady: starkReady,
    generatePoolCommitmentProof,
    generateMerklePathProof,
    generateMerkleUpdateProof,
  } = useStarkProver();

  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(paramNoteId ?? null);
  const [result, setResult] = useState<{ txSig: string; shareableNote: string } | null>(null);
  // Sync re-tap guard (store's isLoading flips after STARK gen starts).
  const [submitting, setSubmitting] = useState(false);

  const matureNotes = useMemo(
    () => notes.filter(n => n.status === 'mature'),
    [notes],
  );

  const note = useMemo(
    () => notes.find(n => n.id === selectedNoteId),
    [notes, selectedNoteId],
  );

  // Auto-select if only one mature note
  useEffect(() => {
    if (!paramNoteId && matureNotes.length === 1) {
      setSelectedNoteId(matureNotes[0].id);
    }
  }, [paramNoteId, matureNotes]);

  const handleTransfer = useCallback(async () => {
    if (!selectedNoteId) return;
    if (submitting) return;
    if (!starkReady) {
      p01Alert(t('common.error'), t('shieldUnshield.starkNotReady'));
      return;
    }
    const note = notes.find(n => n.id === selectedNoteId);
    if (!note) return;
    setSubmitting(true);
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const receipt = receiptFromJSON(vaultDecrypt(note.receiptJSON));

      if (note.poolVersion === 'v3') {
        // V3 path — generate C1 + C3 + C6 sequentially. The StarkProver
        // WebView is single-threaded; never use Promise.all here.
        const pool = ALL_POOLS_V3.find(p => p.poolPDA.toBase58() === note.poolPDA);
        if (!pool) throw new Error('V3 pool config not found');

        // 1. C1 — proves ownership of OLD note.
        const c1Result = await generatePoolCommitmentProof(
          receipt.nullifierPreimage.toString(),
          receipt.secret.toString(),
          receipt.depositEpoch.toString(),
          receipt.tokenMint.toString(),
        );

        // 2. Read on-chain V3 tree state (root, leafCount, subtrees) and the
        //    leaves-by-index map so we can build BOTH the OLD merkle path
        //    (for C3) AND the NEW insertion deltas (for C6).
        const conn = getConnection();
        const treeAccount = await conn.getAccountInfo(pool.treePDA);
        if (!treeAccount) throw new Error('V3 merkle tree account not found');
        const { leafCount, subtrees } = parseFilledSubtrees(treeAccount.data);
        const { leavesByIndex } = await fetchPoolLeavesByIndex(conn, pool.poolPDA);

        // 3. C3 — proves OLD commitment is at the current on-chain root.
        const { root: c3Root, pathElements: c3Path, pathIndices: c3Indices } =
          buildMerkleProofFromLeavesV3({
            leavesByIndex,
            targetLeafIndex: receipt.leafIndex,
          });
        const U64 = (1n << 64n) - 1n;
        const c3Result = await generateMerklePathProof(
          (receipt.commitment & U64).toString(),
          c3Path.map(e => (e & U64).toString()),
          c3Indices,
        );
        // Receipt mutation purely for parity with unshield V3 — the SDK reads
        // the C3 root straight from `c3Result.publicInputs[1]`, so this is
        // belt-and-braces only.
        receipt.merkleRoot = c3Root;

        // 4. Generate fresh secrets for the recipient (RANDOM — the recipient
        //    is unrelated to the sender's seed; deterministic recovery does
        //    not apply for peer-to-peer transfer outputs).
        const newSecret = secureRandomU64();
        const newNullifierPreimage = secureRandomU64();
        const slot = await conn.getSlot('confirmed');
        const newDepositEpoch = slotToEpoch(slot);
        const tokenMintField = pubkeyToField(pool.tokenMint);
        const newCommitment = createCommitmentV3(
          newNullifierPreimage, newSecret, newDepositEpoch, tokenMintField,
        );

        // 5. Compute C6 witness (current_root → newRoot via newCommitment at
        //    leafCount). `updatedSubtrees` is depth+1 entries (level 0 is
        //    the leaf itself); on-chain `insert_with_root_v3` needs
        //    levels 1..=depth so we slice(1) at the call site.
        const { newRoot, updatedSubtrees, pathElements: c6Path, pathIndices: c6Indices } =
          computeNewRootFromSubtreesV3(newCommitment, leafCount, subtrees);

        const c6Result = await generateMerkleUpdateProof(
          '0',
          (newCommitment & U64).toString(),
          c6Path.map(e => (e & U64).toString()),
          c6Indices,
        );

        const c1Bytes = Buffer.from(c1Result.proofHex, 'hex');
        const c1Inputs = c1Result.publicInputs.map((s: string) => BigInt(s));
        const c3Bytes = Buffer.from(c3Result.proofHex, 'hex');
        const c3Inputs = c3Result.publicInputs.map((s: string) => BigInt(s));
        const c6Bytes = Buffer.from(c6Result.proofHex, 'hex');
        const c6Inputs = c6Result.publicInputs.map((s: string) => BigInt(s));

        const res = await transferNoteStarkV3(
          selectedNoteId,
          { proofBytes: c1Bytes, publicInputs: c1Inputs, proofSize: c1Result.proofSize },
          { proofBytes: c3Bytes, publicInputs: c3Inputs, proofSize: c3Result.proofSize },
          { proofBytes: c6Bytes, publicInputs: c6Inputs, proofSize: c6Result.proofSize },
          {
            newCommitment,
            newRoot,
            newSubtrees: updatedSubtrees.slice(1),
            newSecret,
            newNullifierPreimage,
            newDepositEpoch,
            newLeafIndex: leafCount,
          },
        );
        setResult(res);
      } else {
        // v2 path — single C1 proof.
        const starkResult = await generatePoolCommitmentProof(
          receipt.nullifierPreimage.toString(),
          receipt.secret.toString(),
          receipt.depositEpoch.toString(),
          receipt.tokenMint.toString(),
        );
        const proofBytes = Buffer.from(starkResult.proofHex, 'hex');
        const publicInputs = starkResult.publicInputs.map((s: string) => BigInt(s));
        const res = await transferNoteStark(selectedNoteId, {
          proofBytes, publicInputs, proofSize: starkResult.proofSize,
        });
        setResult(res);
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      p01Alert(t('alerts.sendFailed'), (err as Error).message || t('alerts.errorGeneric'));
    } finally {
      setSubmitting(false);
    }
  }, [
    selectedNoteId, notes, starkReady,
    generatePoolCommitmentProof, generateMerklePathProof, generateMerkleUpdateProof,
    transferNoteStark, transferNoteStarkV3, t, submitting,
  ]);

  const handleCopy = useCallback(async () => {
    if (!result) return;
    await Clipboard.setStringAsync(result.shareableNote);
    setTimeout(() => Clipboard.setStringAsync(''), 60000);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    p01Alert(t('alerts.copied'), t('alerts.clipboardClears'));
  }, [result]);

  const handleShare = useCallback(async () => {
    if (!result) return;
    await Share.share({ message: result.shareableNote, title: 'Protocol 01 — Private Note' });
  }, [result]);

  // ─── Result screen ─────────────────────────────────
  if (result) {
    return (
      <View style={[st.container, { paddingTop: insets.top }]}>
        <View style={st.header}>
          <TouchableOpacity onPress={() => router.back()} style={st.backBtn}>
            <Ionicons name="arrow-back" size={22} color={Colors.text} />
          </TouchableOpacity>
          <Text style={st.headerTitle}>{t('denomTransfer.noteSent')}</Text>
          <View style={{ width: 40 }} />
        </View>

        <View style={st.resultContainer}>
          <Animated.View entering={FadeIn.duration(400)} style={st.resultContent}>
            <View style={st.resultIcon}>
              <Ionicons name="checkmark-circle" size={48} color={P01Colors.cyan} />
            </View>
            <Text style={st.resultTitle}>{t('denomTransfer.noteSent')}</Text>
            {note && (
              <Text style={st.resultAmount}>{note.denomination} {note.token}</Text>
            )}
            <Text style={st.resultTx}>Tx: {result.txSig.slice(0, 16)}...</Text>

            <Text style={st.resultHint}>
              {t('denomTransfer.shareWithRecipient')}
            </Text>

            <View style={st.resultActions}>
              <TouchableOpacity style={st.resultBtn} onPress={handleCopy}>
                <Ionicons name="copy-outline" size={18} color={P01Colors.cyan} />
                <Text style={st.resultBtnText}>{t('shieldUnshield.copyNote')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={st.resultBtn} onPress={handleShare}>
                <Ionicons name="share-outline" size={18} color={P01Colors.cyan} />
                <Text style={st.resultBtnText}>{t('common.share')}</Text>
              </TouchableOpacity>
            </View>

            <View style={st.warningRow}>
              <Ionicons name="lock-closed" size={12} color={P01Colors.yellow} />
              <Text style={st.warningText}>{t('shieldUnshield.shareNote')}</Text>
            </View>
          </Animated.View>

          <TouchableOpacity
            style={st.doneBtn}
            onPress={() => router.push('/(main)/(privacy)/denominated-notes' as any)}
          >
            <Text style={st.doneBtnText}>{t('denomTransfer.backToNotes')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ─── Main screen ───────────────────────────────────
  return (
    <View style={[st.container, { paddingTop: insets.top }]}>
      <View style={st.header}>
        <TouchableOpacity onPress={() => router.back()} style={st.backBtn}>
          <Ionicons name="arrow-back" size={22} color={Colors.text} />
        </TouchableOpacity>
        <Text style={st.headerTitle}>{t('denomTransfer.title')}</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView
        style={st.scroll}
        contentContainerStyle={[st.scrollContent, { paddingBottom: 100 + insets.bottom }]}
      >
        {matureNotes.length === 0 ? (
          <Animated.View entering={FadeIn.duration(300)} style={st.emptyState}>
            <Ionicons name="receipt-outline" size={48} color={Colors.textTertiary} />
            <Text style={st.emptyTitle}>{t('shieldUnshield.noMatureNotes')}</Text>
            <Text style={st.emptyDesc}>
              {t('shieldUnshield.depositFirst')}
            </Text>
            <TouchableOpacity
              style={st.emptyBtn}
              onPress={() => router.push('/(main)/(privacy)/denominated-shield' as any)}
            >
              <Text style={st.emptyBtnText}>{t('privacy.deposit')}</Text>
            </TouchableOpacity>
          </Animated.View>
        ) : (
          <>
            <Animated.View entering={FadeInDown.delay(50).duration(300)}>
              <Text style={st.sectionLabel}>{t('denomTransfer.selectNote')}</Text>
              <View style={st.notesList}>
                {matureNotes.map((n) => {
                  const isSelected = n.id === selectedNoteId;
                  return (
                    <TouchableOpacity
                      key={n.id}
                      style={[st.noteCard, isSelected && st.noteCardSelected]}
                      onPress={() => {
                        Haptics.selectionAsync();
                        setSelectedNoteId(n.id);
                      }}
                      activeOpacity={0.7}
                    >
                      <View style={[st.noteIcon, isSelected && st.noteIconSelected]}>
                        <Text style={[st.noteIconText, isSelected && st.noteIconTextSelected]}>
                          {n.token === 'SOL' ? 'S' : '$'}
                        </Text>
                      </View>
                      <View style={st.noteInfo}>
                        <Text style={st.noteAmount}>{n.denomination} {n.token}</Text>
                        <Text style={st.noteId}>{t('denomTransfer.readyToSend')}</Text>
                      </View>
                      <View style={[st.radio, isSelected && st.radioSelected]}>
                        {isSelected && <View style={st.radioDot} />}
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </Animated.View>

            {error && (
              <View style={st.errorCard}>
                <Ionicons name="alert-circle" size={16} color={Colors.error} />
                <Text style={st.errorText}>{error}</Text>
              </View>
            )}
          </>
        )}
      </ScrollView>

      {/* Send button */}
      {matureNotes.length > 0 && (
        <View style={[st.footer, { paddingBottom: 80 + insets.bottom }]}>
          <TouchableOpacity
            style={[st.sendBtn, (!selectedNoteId || isLoading || submitting) && st.sendBtnDisabled]}
            onPress={handleTransfer}
            disabled={!selectedNoteId || isLoading || submitting}
          >
            {isLoading ? (
              <Text style={st.sendBtnText}>
                {isProving ? t('shieldUnshield.generatingProof') : progress || t('common.processing')}
              </Text>
            ) : (
              <>
                <Ionicons name="paper-plane" size={18} color="#000" />
                <Text style={st.sendBtnText}>
                  {note ? `${t('common.send')} ${note.denomination} ${note.token}` : t('shieldUnshield.sendNote')}
                </Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl, paddingVertical: Spacing.lg,
  },
  backBtn: {
    width: 40, height: 40, borderRadius: 9999,
    backgroundColor: Colors.surfaceSecondary, justifyContent: 'center', alignItems: 'center',
  },
  headerTitle: { color: Colors.text, fontSize: 20, fontFamily: FontFamily.bold },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: Spacing.xl },

  // Section
  sectionLabel: {
    fontSize: 14, fontFamily: FontFamily.medium, color: Colors.textSecondary, marginBottom: 12,
  },

  // Notes list
  notesList: { gap: 8 },
  noteCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 16, borderRadius: 16, backgroundColor: '#0f0f12',
    borderWidth: 1.5, borderColor: 'transparent',
  },
  noteCardSelected: { borderColor: '#3b82f6' },
  noteIcon: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: 'rgba(59, 130, 246, 0.1)',
    alignItems: 'center', justifyContent: 'center',
  },
  noteIconSelected: { backgroundColor: 'rgba(59, 130, 246, 0.2)' },
  noteIconText: { fontSize: 16, fontFamily: FontFamily.bold, color: '#3b82f6' },
  noteIconTextSelected: { color: '#3b82f6' },
  noteInfo: { flex: 1 },
  noteAmount: { fontSize: 16, fontFamily: FontFamily.bold, color: Colors.text },
  noteId: { fontSize: 12, fontFamily: FontFamily.regular, color: Colors.textSecondary, marginTop: 2 },
  radio: {
    width: 22, height: 22, borderRadius: 11,
    borderWidth: 2, borderColor: Colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  radioSelected: { borderColor: '#3b82f6' },
  radioDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#3b82f6' },

  // Empty state
  emptyState: {
    alignItems: 'center', justifyContent: 'center',
    paddingVertical: 60, gap: 12,
  },
  emptyTitle: { fontSize: 18, fontFamily: FontFamily.bold, color: Colors.text },
  emptyDesc: {
    fontSize: 14, fontFamily: FontFamily.regular, color: Colors.textSecondary,
    textAlign: 'center', lineHeight: 20, paddingHorizontal: 20,
  },
  emptyBtn: {
    paddingHorizontal: 20, paddingVertical: 10, borderRadius: 12,
    backgroundColor: P01Colors.cyanDim, marginTop: 8,
  },
  emptyBtnText: { fontSize: 14, fontFamily: FontFamily.semibold, color: P01Colors.cyan },

  // Error
  errorCard: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: Colors.errorDim, borderRadius: 12, padding: 12, marginTop: 16,
  },
  errorText: { flex: 1, fontSize: 13, fontFamily: FontFamily.regular, color: Colors.error },

  // Footer
  footer: { paddingHorizontal: Spacing.xl, paddingTop: Spacing.md },
  sendBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 16, borderRadius: 14, backgroundColor: '#3b82f6',
  },
  sendBtnDisabled: { opacity: 0.4 },
  sendBtnText: { fontSize: 16, fontFamily: FontFamily.bold, color: '#000' },

  // Result
  resultContainer: { flex: 1, justifyContent: 'space-between', paddingHorizontal: Spacing.xl },
  resultContent: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  resultIcon: { marginBottom: 8 },
  resultTitle: { fontSize: 22, fontFamily: FontFamily.bold, color: Colors.text },
  resultAmount: { fontSize: 18, fontFamily: FontFamily.semibold, color: '#3b82f6' },
  resultTx: { fontSize: 12, fontFamily: FontFamily.mono, color: Colors.textTertiary },
  resultHint: {
    fontSize: 13, fontFamily: FontFamily.regular, color: Colors.textSecondary,
    textAlign: 'center', lineHeight: 19, marginTop: 12, paddingHorizontal: 16,
  },
  resultActions: { flexDirection: 'row', gap: 12, marginTop: 20 },
  resultBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 20, paddingVertical: 12, borderRadius: 12,
    backgroundColor: P01Colors.cyanDim,
  },
  resultBtnText: { fontSize: 14, fontFamily: FontFamily.medium, color: P01Colors.cyan },
  warningRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 16,
  },
  warningText: { fontSize: 12, fontFamily: FontFamily.regular, color: P01Colors.yellow },
  doneBtn: {
    paddingVertical: 16, borderRadius: 14, alignItems: 'center',
    backgroundColor: '#0f0f12', marginBottom: 80,
  },
  doneBtnText: { fontSize: 15, fontFamily: FontFamily.semibold, color: Colors.text },
});

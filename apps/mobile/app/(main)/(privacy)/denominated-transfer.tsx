/**
 * Send a note — and the one screen in the app that produces a secret the user
 * must carry off it by hand.
 *
 * 🚨 WHY THIS SCREEN IS NOT THE USUAL SUCCESS CARD. The transfer mints a fresh
 * `(secret, nullifier_preimage)` pair for the recipient and hands it back as
 * one encoded string. Nothing on chain, and nothing on the recipient's device,
 * knows that string yet: until it is copied out of here and delivered, the
 * recipient has no claim on the money. So the copy control is the PRIMARY
 * action, in the accent, full width — not one of two equal chips under a
 * checkmark — and leaving without having taken it asks first.
 *
 * ⚠️ AND THE WARNING SAYS WHAT IS TRUE, NOT WHAT IS SCARIEST. The string is
 * persisted as `transferredTo` on the spent note
 * (stores/denominatedPoolStore.ts:2090, :2253) and can be re-shared from the
 * notes list, so this does not claim it is the only copy. It says it lives on
 * this device and nowhere else, which is the fact that should change behaviour.
 *
 * 🎯 Realigned on constants/theme.ts 2026-08-23: the note cards, the radios and
 * the send button were hardcoded `#3b82f6`, and the button label `#000` — a
 * second accent and a pure black the palette does not contain.
 */

import React, { useState, useCallback, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Share,
  BackHandler,
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
  ZERO_VALUE_V3,
  MERKLE_DEPTH,
  createCommitmentV3,
  pubkeyToField,
  slotToEpoch,
} from '@/services/denominatedPool';
import { vaultDecrypt } from '@/utils/crypto/noteVault';
import { getConnection } from '@/services/solana/connection';
import { Colors, FontFamily, FontSize, BorderRadius, Spacing } from '@/constants/theme';
import { Button } from '@/components/ui';
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
  // Has the note left this screen yet? Copy or share both count; the guard
  // below is about the user having the string, not about which control gave it
  // to them.
  const [noteTaken, setNoteTaken] = useState(false);

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

        // Current on-chain root (low 8 bytes LE of MerkleTreeStateV3.root @ offset 8+32).
        let onChainRoot = 0n;
        for (let b = 7; b >= 0; b--) onChainRoot = (onChainRoot << 8n) | BigInt(treeAccount.data[8 + 32 + b]);
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

        // 5. Compute C6 witness via the filled_subtrees-layout chooser (same fix
        //    as the shield path). insert_with_root_v3 stores filled_subtrees
        //    shifted by one (merkle_tree_v3.rs:176-184), so reconstruct old_root
        //    BOTH ways and use whichever reproduces the live on-chain root —
        //    otherwise the C6 proof bakes a wrong old_root → InvalidProof(6000)
        //    at shield_denominated_v3-style verification on any pool with ≥2 leaves.
        const t_direct = computeNewRootFromSubtreesV3(newCommitment, leafCount, subtrees);
        const t_sliced = computeNewRootFromSubtreesV3(newCommitment, leafCount, subtrees.slice(1));
        const t_oldDirect = computeNewRootFromSubtreesV3(ZERO_VALUE_V3, leafCount, subtrees).newRoot;
        const t_oldSliced = computeNewRootFromSubtreesV3(ZERO_VALUE_V3, leafCount, subtrees.slice(1)).newRoot;
        let t_chosen: typeof t_direct;
        if (t_oldDirect === onChainRoot) {
          t_chosen = t_direct;
        } else if (t_oldSliced === onChainRoot) {
          t_chosen = t_sliced;
        } else {
          throw new Error(
            `Transfer pre-flight failed: cannot reconstruct the on-chain Merkle root (${onChainRoot}) ` +
            `from the pool's filled_subtrees for leaf #${leafCount} (direct=${t_oldDirect}, shifted=${t_oldSliced}). ` +
            `Tree state diverged — not generating a proof that would be rejected.`,
          );
        }
        const { newRoot, updatedSubtrees, pathElements: c6Path, pathIndices: c6Indices } = t_chosen;

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
            // EXACTLY tree_depth (=MERKLE_DEPTH=15) entries required on-chain
            // (insert_with_root_v3 length guard). updatedSubtrees is 16 on the
            // DIRECT layout, 15 on SLICED — slice(0, MERKLE_DEPTH) yields the
            // canonical 15 for both. (Was .slice(1) → 14 on SLICED →
            // InvalidMerkleRoot(6002). Same fix as denominated-shield.tsx.)
            newSubtrees: updatedSubtrees.slice(0, MERKLE_DEPTH),
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
    setNoteTaken(true);
    p01Alert(t('alerts.copied'), t('alerts.clipboardClears'));
  }, [result]);

  const handleShare = useCallback(async () => {
    if (!result) return;
    await Share.share({ message: result.shareableNote, title: 'Protocol 01 — Private Note' });
    setNoteTaken(true);
  }, [result]);

  /**
   * Leaving the result screen. ⚠️ This is the one confirmation in this pass
   * that is NOT deleted: it carries information the user cannot get anywhere
   * else on the way out, and the alternative to reading it is a recipient who
   * never receives the money.
   */
  const leaveResult = useCallback(
    (go: () => void) => {
      if (noteTaken) {
        go();
        return;
      }
      p01Alert(
        t('denomTransfer.notCopiedTitle'),
        t('denomTransfer.notCopiedBody'),
        [
          { text: t('shieldUnshield.copyNote'), onPress: () => { handleCopy(); } },
          { text: t('denomTransfer.leaveAnyway'), style: 'destructive', onPress: go },
        ],
        'warning',
      );
    },
    [noteTaken, handleCopy, t],
  );

  // Android's hardware back is a way off this screen too, and it bypassed every
  // control on it.
  useEffect(() => {
    if (!result) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (noteTaken) return false;
      leaveResult(() => router.back());
      return true;
    });
    return () => sub.remove();
  }, [result, noteTaken, leaveResult, router]);

  // ─── Result screen ─────────────────────────────────
  if (result) {
    return (
      <View style={[st.container, { paddingTop: insets.top }]}>
        <View style={st.header}>
          <TouchableOpacity
            onPress={() => leaveResult(() => router.back())}
            style={st.backBtn}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityRole="button"
            accessibilityLabel={t('common.back')}
          >
            <Ionicons name="chevron-back" size={22} color={Colors.textSecondary} />
          </TouchableOpacity>
          <Text style={st.headerTitle}>{t('denomTransfer.noteSent')}</Text>
          <View style={st.headerSpacer} />
        </View>

        <ScrollView
          style={st.scroll}
          contentContainerStyle={[st.scrollContent, { paddingBottom: Spacing['3xl'] }]}
        >
          <Animated.View entering={FadeIn.duration(300)}>
            {note ? (
              <Text style={st.resultAmount}>
                {note.denomination} {note.token}
              </Text>
            ) : null}
            <Text style={st.resultTx}>{result.txSig.slice(0, 16)}…</Text>

            {/* The note itself, on screen. It was previously invisible: the
                user was asked to copy a thing they had never been shown. */}
            <Text style={st.blobLabel}>{t('denomTransfer.shareWithRecipient')}</Text>
            <View style={st.blobPanel}>
              <Text style={st.blobText} numberOfLines={4} selectable>
                {result.shareableNote}
              </Text>
            </View>

            <View style={st.cautionPanel}>
              <Ionicons name="alert-circle-outline" size={16} color={Colors.warning} />
              <Text style={st.cautionText}>{t('denomTransfer.noteHeldHere')}</Text>
            </View>
          </Animated.View>
        </ScrollView>

        {/* One primary action, and it is the one that gets the note out. */}
        <View style={[st.footer, { paddingBottom: Math.max(insets.bottom, Spacing.lg) }]}>
          <Button
            variant="primary"
            size="lg"
            fullWidth
            onPress={handleCopy}
            accessibilityLabel={t('shieldUnshield.copyNote')}
            icon={
              <Ionicons
                name={noteTaken ? 'checkmark' : 'copy-outline'}
                size={18}
                color={Colors.background}
              />
            }
          >
            {noteTaken ? t('common.copied') : t('shieldUnshield.copyNote')}
          </Button>

          <Button variant="secondary" size="md" fullWidth onPress={handleShare}>
            {t('common.share')}
          </Button>

          <Button
            variant="ghost"
            size="md"
            fullWidth
            onPress={() =>
              leaveResult(() => router.push('/(main)/(privacy)/denominated-notes' as any))
            }
          >
            {t('denomTransfer.backToNotes')}
          </Button>
        </View>
      </View>
    );
  }

  // ─── Main screen ───────────────────────────────────
  return (
    <View style={[st.container, { paddingTop: insets.top }]}>
      <View style={st.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={st.backBtn}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityRole="button"
          accessibilityLabel={t('common.back')}
        >
          <Ionicons name="chevron-back" size={22} color={Colors.textSecondary} />
        </TouchableOpacity>
        <Text style={st.headerTitle}>{t('denomTransfer.title')}</Text>
        <View style={st.headerSpacer} />
      </View>

      <ScrollView
        style={st.scroll}
        contentContainerStyle={[st.scrollContent, { paddingBottom: 100 + insets.bottom }]}
      >
        {matureNotes.length === 0 ? (
          <Animated.View entering={FadeIn.duration(300)} style={st.emptyState}>
            <View style={st.emptyIcon}>
              <Ionicons name="receipt-outline" size={28} color={Colors.textTertiary} />
            </View>
            <Text style={st.emptyTitle}>{t('shieldUnshield.noMatureNotes')}</Text>
            <Text style={st.emptyDesc}>
              {t('shieldUnshield.depositFirst')}
            </Text>
            <View style={st.emptyAction}>
              <Button
                variant="primary"
                size="lg"
                fullWidth
                onPress={() => router.push('/(main)/(privacy)/denominated-shield' as any)}
              >
                {t('privacy.deposit')}
              </Button>
            </View>
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
                      accessibilityRole="radio"
                      accessibilityState={{ selected: isSelected }}
                      accessibilityLabel={`${n.denomination} ${n.token}`}
                    >
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
              <View style={st.errorCard} accessibilityRole="alert">
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
          <Button
            variant="primary"
            size="lg"
            fullWidth
            loading={isLoading}
            disabled={!selectedNoteId || submitting}
            onPress={handleTransfer}
            icon={
              isLoading ? undefined : (
                <Ionicons name="paper-plane-outline" size={18} color={Colors.background} />
              )
            }
          >
            {note
              ? `${t('common.send')} ${note.denomination} ${note.token}`
              : t('shieldUnshield.sendNote')}
          </Button>

          {/* ⚠️ The button spinner replaces its label, and proof generation is
              the longest wait in the app. The step goes under the button
              instead of being swallowed by it. */}
          {isLoading ? (
            <Text style={st.progressText} accessibilityLiveRegion="polite">
              {isProving
                ? t('shieldUnshield.generatingProof')
                : progress || t('common.processing')}
            </Text>
          ) : null}
        </View>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, minHeight: 56,
  },
  backBtn: {
    width: 44, height: 44,
    justifyContent: 'center', alignItems: 'center',
  },
  headerSpacer: { width: 44 },
  headerTitle: {
    flex: 1, color: Colors.text, fontSize: FontSize.xl, fontFamily: FontFamily.displayMedium,
  },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: Spacing.xl },

  // Section
  sectionLabel: {
    fontSize: FontSize.sm, fontFamily: FontFamily.medium,
    color: Colors.textSecondary, marginBottom: Spacing.md,
  },

  // Notes list — a flat panel and a hairline, like every other panel.
  notesList: { gap: Spacing.sm },
  noteCard: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    minHeight: 64, padding: Spacing.lg,
    borderRadius: BorderRadius.lg, backgroundColor: Colors.surface,
    borderWidth: 1, borderColor: Colors.border,
  },
  noteCardSelected: { borderColor: Colors.primary },
  noteInfo: { flex: 1 },
  noteAmount: { fontSize: FontSize.lg, fontFamily: FontFamily.monoMedium, color: Colors.text },
  noteId: {
    fontSize: FontSize.xs, fontFamily: FontFamily.regular,
    color: Colors.textSecondary, marginTop: 2,
  },
  radio: {
    width: 22, height: 22, borderRadius: BorderRadius.full,
    borderWidth: 1.5, borderColor: Colors.borderLight,
    alignItems: 'center', justifyContent: 'center',
  },
  radioSelected: { borderColor: Colors.primary },
  radioDot: {
    width: 10, height: 10, borderRadius: BorderRadius.full,
    backgroundColor: Colors.primary,
  },

  // Empty state
  emptyState: {
    alignItems: 'center', justifyContent: 'center',
    paddingVertical: Spacing['6xl'],
  },
  emptyIcon: {
    width: 56, height: 56, borderRadius: BorderRadius.full,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.border,
    marginBottom: Spacing['2xl'],
  },
  emptyTitle: {
    fontSize: FontSize['2xl'], fontFamily: FontFamily.display,
    color: Colors.text, textAlign: 'center',
  },
  emptyDesc: {
    fontSize: FontSize.md, fontFamily: FontFamily.regular, color: Colors.textSecondary,
    textAlign: 'center', lineHeight: 22, marginTop: Spacing.sm,
  },
  emptyAction: { width: '100%', marginTop: Spacing['3xl'] },

  // Error
  errorCard: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.errorDim, borderRadius: BorderRadius.md,
    padding: Spacing.md, marginTop: Spacing.lg,
  },
  errorText: {
    flex: 1, fontSize: FontSize.sm, fontFamily: FontFamily.regular, color: Colors.error,
  },

  // Footer
  footer: { paddingHorizontal: Spacing.xl, paddingTop: Spacing.md, gap: Spacing.md },
  progressText: {
    fontSize: FontSize.sm, fontFamily: FontFamily.regular,
    color: Colors.textSecondary, textAlign: 'center',
  },

  // Result
  resultAmount: {
    fontSize: FontSize['3xl'], fontFamily: FontFamily.display, color: Colors.text,
    marginTop: Spacing.lg,
  },
  resultTx: {
    fontSize: FontSize.xs, fontFamily: FontFamily.mono, color: Colors.textTertiary,
    marginTop: Spacing.xs,
  },
  blobLabel: {
    fontSize: FontSize.sm, fontFamily: FontFamily.regular, color: Colors.textSecondary,
    lineHeight: 20, marginTop: Spacing['2xl'], marginBottom: Spacing.md,
  },
  blobPanel: {
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.border,
    padding: Spacing.lg,
  },
  blobText: {
    fontSize: FontSize.xs, fontFamily: FontFamily.mono, color: Colors.textSecondary,
    lineHeight: 17,
  },
  cautionPanel: {
    flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm,
    backgroundColor: Colors.warningDim,
    borderRadius: BorderRadius.md,
    padding: Spacing.md, marginTop: Spacing.lg,
  },
  cautionText: {
    flex: 1, fontSize: FontSize.sm, fontFamily: FontFamily.regular,
    color: Colors.text, lineHeight: 19,
  },
});

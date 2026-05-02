/**
 * Batch Unshield Screen
 *
 * Sequential unshield of multiple denominated notes toward a single recipient.
 *
 * Why sequential (not parallel):
 *  - each unshield blocks ~0.85 SOL rent on an ephemeral stealth signer while
 *    its proof buffer is open on-chain; parallel = N × rent in-flight
 *  - the STARK prover WASM is single-threaded
 *
 * Flow per note:
 *  1. `proving`       — generatePoolCommitmentProof (WebView WASM)
 *  2. `unshielding`   — unshieldNoteStark (submit proof → verify → unshield)
 *  3. `sweeping`      — stealth → recipient (handled inside unshieldNoteStark)
 *  4. `done` / `failed`
 *
 * Failure in one note does not abort the batch — the loop continues and the
 * user can retry failed items afterwards.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { PublicKey } from '@solana/web3.js';

import { useDenominatedPoolStore } from '@/stores/denominatedPoolStore';
import {
  useBatchUnshieldStore,
  type BatchNoteStatus,
} from '@/stores/batchUnshieldStore';
import { useStarkProver } from '@/providers/StarkProverProvider';
import { useWalletStore } from '@/stores/walletStore';
import {
  receiptFromJSON,
  ALL_POOLS_V3,
  fetchPoolLeavesByIndex,
  buildMerkleProofFromLeavesV3,
} from '@/services/denominatedPool';
import { vaultDecrypt } from '@/utils/crypto/noteVault';
import { getKeypair } from '@/services/solana/wallet';
import { getConnection } from '@/services/solana/connection';
import { Buffer } from 'buffer';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import { requireBiometricAuth } from '@/utils/biometricGate';
import { p01Alert } from '@/stores/alertStore';
import { useT } from '@/i18n';

export default function DenominatedUnshieldBatchScreen() {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const { notes, unshieldNoteStark, unshieldNoteStarkV3 } = useDenominatedPoolStore();
  const { publicKey: walletPublicKey } = useWalletStore();
  const {
    isReady: starkReady,
    generatePoolCommitmentProof,
    generateMerklePathProof,
  } = useStarkProver();

  const selectedIds = useBatchUnshieldStore((s) => s.selectedIds);
  const recipient = useBatchUnshieldStore((s) => s.recipient);
  const running = useBatchUnshieldStore((s) => s.running);
  const currentIndex = useBatchUnshieldStore((s) => s.currentIndex);
  const states = useBatchUnshieldStore((s) => s.states);
  const setRecipient = useBatchUnshieldStore((s) => s.setRecipient);
  const beginRun = useBatchUnshieldStore((s) => s.beginRun);
  const advance = useBatchUnshieldStore((s) => s.advance);
  const finishRun = useBatchUnshieldStore((s) => s.finishRun);
  const updateNote = useBatchUnshieldStore((s) => s.updateNote);
  const clearSelection = useBatchUnshieldStore((s) => s.clearSelection);

  const [useOwnWallet, setUseOwnWallet] = useState(true);

  const batchNotes = useMemo(
    () =>
      selectedIds
        .map((id) => notes.find((n) => n.id === id))
        .filter((n): n is NonNullable<typeof n> => !!n),
    [selectedIds, notes],
  );

  const token = batchNotes[0]?.token ?? 'SOL';
  const totalAmount = batchNotes.reduce((acc, n) => acc + n.denomination, 0);

  // Prefill recipient from the connected wallet.
  useEffect(() => {
    if (!useOwnWallet) return;
    if (walletPublicKey) {
      setRecipient(walletPublicKey);
      return;
    }
    (async () => {
      const kp = await getKeypair();
      if (kp) setRecipient(kp.publicKey.toBase58());
    })();
  }, [useOwnWallet, walletPublicKey, setRecipient]);

  // Guard: no selection → bounce back.
  useEffect(() => {
    if (!selectedIds.length) {
      router.back();
    }
  }, [selectedIds.length, router]);

  const resolveRecipient = useCallback((): { addr: string; stealth: boolean } | null => {
    const trimmed = recipient.trim();
    if (!trimmed) return null;
    try {
      // Accept meta-address or raw pubkey.
      const { isMetaAddress, deriveStealthForRecipient } = require('@/services/stealth/keys');
      if (isMetaAddress(trimmed)) {
        const stealth = deriveStealthForRecipient(trimmed);
        return { addr: stealth.address, stealth: true };
      }
      new PublicKey(trimmed);
      return { addr: trimmed, stealth: false };
    } catch {
      return null;
    }
  }, [recipient]);

  const runBatch = useCallback(
    async (noteIdsToRun: string[]) => {
      const resolved = resolveRecipient();
      if (!resolved) {
        p01Alert(t('common.error'), t('shieldUnshield.invalidRecipient'));
        return;
      }
      if (!starkReady) {
        p01Alert(t('common.error'), t('shieldUnshield.starkNotReady'));
        return;
      }
      const authed = await requireBiometricAuth('Authenticate to unshield notes');
      if (!authed) {
        p01Alert(t('common.error'), t('shieldUnshield.authRequired'));
        return;
      }

      beginRun();
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      for (let i = 0; i < noteIdsToRun.length; i++) {
        const id = noteIdsToRun[i];
        // Reflect the absolute index relative to the full batch so the
        // spinner lands on the right row.
        const absoluteIndex = selectedIds.indexOf(id);
        advance(absoluteIndex >= 0 ? absoluteIndex : i);

        const note = notes.find((n) => n.id === id);
        if (!note) {
          updateNote(id, { status: 'failed', error: 'Note not found' });
          continue;
        }

        try {
          updateNote(id, { status: 'proving', progress: t('batchNoteProving') });
          const receipt = receiptFromJSON(vaultDecrypt(note.receiptJSON));

          let sig: string;
          if (note.poolVersion === 'v3') {
            // V3: C1 + C3 sequentially (StarkProver is single-threaded).
            const pool = ALL_POOLS_V3.find(p => p.poolPDA.toBase58() === note.poolPDA);
            if (!pool) throw new Error('V3 pool config not found');

            const c1Result = await generatePoolCommitmentProof(
              receipt.nullifierPreimage.toString(),
              receipt.secret.toString(),
              receipt.depositEpoch.toString(),
              receipt.tokenMint.toString(),
            );

            // Rebuild merkle path against the current on-chain V3 tree.
            const conn = getConnection();
            const { leavesByIndex } = await fetchPoolLeavesByIndex(conn, pool.poolPDA);
            const { root: c3Root, pathElements: c3Path, pathIndices: c3Indices } =
              buildMerkleProofFromLeavesV3({
                leavesByIndex,
                targetLeafIndex: receipt.leafIndex,
              });
            receipt.merkleRoot = c3Root;
            receipt.merklePathElements = c3Path;
            receipt.merklePathIndices = c3Indices;

            const U64 = (1n << 64n) - 1n;
            const c3Result = await generateMerklePathProof(
              (receipt.commitment & U64).toString(),
              c3Path.map(e => (e & U64).toString()),
              c3Indices,
            );

            updateNote(id, {
              status: 'unshielding',
              progress: t('privacy.batchNoteUnshielding'),
            });

            sig = await unshieldNoteStarkV3(
              id,
              resolved.addr,
              {
                proofBytes: Buffer.from(c1Result.proofHex, 'hex'),
                publicInputs: c1Result.publicInputs.map((s: string) => BigInt(s)),
                proofSize: c1Result.proofSize,
              },
              {
                proofBytes: Buffer.from(c3Result.proofHex, 'hex'),
                publicInputs: c3Result.publicInputs.map((s: string) => BigInt(s)),
                proofSize: c3Result.proofSize,
              },
              false,
            );
          } else {
            const starkResult = await generatePoolCommitmentProof(
              receipt.nullifierPreimage.toString(),
              receipt.secret.toString(),
              receipt.depositEpoch.toString(),
              receipt.tokenMint.toString(),
            );
            const proofBytes = Buffer.from(starkResult.proofHex, 'hex');
            const publicInputs = starkResult.publicInputs.map((s: string) => BigInt(s));

            updateNote(id, {
              status: 'unshielding',
              progress: t('privacy.batchNoteUnshielding'),
            });

            sig = await unshieldNoteStark(
              id,
              resolved.addr,
              { proofBytes, publicInputs, proofSize: starkResult.proofSize },
              false,
            );
          }

          updateNote(id, {
            status: 'done',
            txSig: sig,
            progress: undefined,
            error: undefined,
          });
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        } catch (err: any) {
          console.error('[BatchUnshield] Note failed:', id, err?.message);
          updateNote(id, {
            status: 'failed',
            error: err?.message ?? 'Unknown error',
            progress: undefined,
          });
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        }
      }

      finishRun();
      useWalletStore.getState().refreshBalance();
      setTimeout(() => useWalletStore.getState().refreshTransactions(), 5000);
    },
    [
      resolveRecipient,
      starkReady,
      notes,
      selectedIds,
      generatePoolCommitmentProof,
      generateMerklePathProof,
      unshieldNoteStark,
      unshieldNoteStarkV3,
      t,
      beginRun,
      advance,
      finishRun,
      updateNote,
    ],
  );

  const handleStart = useCallback(() => {
    if (running) return;
    runBatch(selectedIds);
  }, [running, runBatch, selectedIds]);

  const failedIds = selectedIds.filter((id) => states[id]?.status === 'failed');
  const doneCount = selectedIds.filter((id) => states[id]?.status === 'done').length;
  const allDone = selectedIds.length > 0 && doneCount === selectedIds.length;
  const anyStarted = Object.values(states).some((s) => s.status !== 'queued');

  const handleRetry = useCallback(() => {
    if (running || !failedIds.length) return;
    // Reset failed → queued before rerun so UI reflects the retry.
    for (const id of failedIds) updateNote(id, { status: 'queued', error: undefined });
    runBatch(failedIds);
  }, [running, failedIds, runBatch, updateNote]);

  const handleClose = useCallback(() => {
    clearSelection();
    router.back();
  }, [clearSelection, router]);

  const statusLabel = (s: BatchNoteStatus | undefined): string => {
    switch (s) {
      case 'proving':
        return t('privacy.batchNoteProving');
      case 'unshielding':
        return t('privacy.batchNoteUnshielding');
      case 'sweeping':
        return t('privacy.batchNoteSweeping');
      case 'done':
        return t('privacy.batchNoteDone');
      case 'failed':
        return t('privacy.batchNoteFailed');
      default:
        return t('privacy.batchNoteQueued');
    }
  };

  const statusColor = (s: BatchNoteStatus | undefined): string => {
    switch (s) {
      case 'done':
        return P01Colors.cyan;
      case 'failed':
        return Colors.error;
      case 'proving':
      case 'unshielding':
      case 'sweeping':
        return P01Colors.yellow;
      default:
        return Colors.textTertiary;
    }
  };

  return (
    <View style={[st.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={st.header}>
        <TouchableOpacity
          onPress={running ? undefined : handleClose}
          style={[st.backBtn, running && { opacity: 0.4 }]}
          disabled={running}
        >
          <Ionicons name="arrow-back" size={22} color={Colors.text} />
        </TouchableOpacity>
        <Text style={st.headerTitle}>{t('privacy.batchUnshieldTitle')}</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: Spacing.xl, paddingBottom: 140 }}
      >
        {/* Summary card */}
        <View style={st.summaryCard}>
          <View style={st.summaryRow}>
            <Text style={st.summaryLabel}>{t('common.total')}</Text>
            <Text style={st.summaryVal}>
              {totalAmount} {token}
            </Text>
          </View>
          <View style={st.summaryRow}>
            <Text style={st.summaryLabel}>{t('privacy.batchSelectedCount', { count: selectedIds.length })}</Text>
            {running && <ActivityIndicator size="small" color={P01Colors.cyan} />}
            {allDone && (
              <Ionicons name="checkmark-circle" size={20} color={P01Colors.cyan} />
            )}
          </View>
        </View>

        {/* Recipient */}
        <Text style={st.sectionLabel}>{t('privacy.batchRecipientLabel')}</Text>
        <View style={st.recipientRow}>
          <TouchableOpacity
            onPress={() => setUseOwnWallet((v) => !v)}
            style={[st.toggleChip, useOwnWallet && { backgroundColor: P01Colors.cyanDim }]}
            disabled={running}
          >
            <Ionicons
              name={useOwnWallet ? 'person-circle' : 'person-circle-outline'}
              size={14}
              color={useOwnWallet ? P01Colors.cyan : Colors.textSecondary}
            />
            <Text
              style={[
                st.toggleChipText,
                { color: useOwnWallet ? P01Colors.cyan : Colors.textSecondary },
              ]}
            >
              {t('shieldUnshield.myWallet')}
            </Text>
          </TouchableOpacity>
        </View>
        <TextInput
          style={[st.input, (useOwnWallet || running) && { opacity: 0.5 }]}
          value={recipient}
          onChangeText={setRecipient}
          placeholder="Solana pubkey / st:01…"
          placeholderTextColor={Colors.textTertiary}
          editable={!useOwnWallet && !running}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Text style={st.helpText}>{t('privacy.batchRecipientHelp')}</Text>

        {/* Per-note progress list */}
        <Text style={[st.sectionLabel, { marginTop: Spacing.xl }]}>
          {t('privacy.activeNotes')}
        </Text>
        {batchNotes.map((note, idx) => {
          const s = states[note.id];
          const isCurrent = running && currentIndex === idx;
          return (
            <View
              key={note.id}
              style={[
                st.noteRow,
                isCurrent && { borderColor: P01Colors.cyan, borderWidth: 1 },
              ]}
            >
              <View style={{ flex: 1 }}>
                <Text style={st.noteAmount}>
                  {note.denomination} {note.token}
                </Text>
                <Text style={[st.noteStatus, { color: statusColor(s?.status) }]}>
                  {statusLabel(s?.status)}
                  {s?.txSig ? ` · ${s.txSig.slice(0, 8)}…` : ''}
                </Text>
                {s?.error && <Text style={st.noteError}>{s.error}</Text>}
              </View>
              {(s?.status === 'proving' ||
                s?.status === 'unshielding' ||
                s?.status === 'sweeping') && (
                <ActivityIndicator size="small" color={P01Colors.yellow} />
              )}
              {s?.status === 'done' && (
                <Ionicons name="checkmark-circle" size={18} color={P01Colors.cyan} />
              )}
              {s?.status === 'failed' && (
                <Ionicons name="alert-circle" size={18} color={Colors.error} />
              )}
            </View>
          );
        })}
      </ScrollView>

      {/* Bottom action bar */}
      <View style={[st.bottomBar, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        {!anyStarted && (
          <TouchableOpacity
            onPress={handleStart}
            style={[st.cta, (!starkReady || running) && { opacity: 0.4 }]}
            disabled={!starkReady || running}
          >
            <Ionicons name="wallet-outline" size={16} color="#000" />
            <Text style={st.ctaText}>{t('privacy.batchStart')}</Text>
          </TouchableOpacity>
        )}
        {running && (
          <View style={[st.cta, { opacity: 0.7 }]}>
            <ActivityIndicator size="small" color="#000" />
            <Text style={st.ctaText}>{t('privacy.batchRunning')}</Text>
          </View>
        )}
        {anyStarted && !running && failedIds.length > 0 && (
          <TouchableOpacity
            onPress={handleRetry}
            style={[st.cta, { backgroundColor: P01Colors.yellow }]}
          >
            <Ionicons name="refresh" size={16} color="#000" />
            <Text style={st.ctaText}>{t('privacy.batchRetry')}</Text>
          </TouchableOpacity>
        )}
        {anyStarted && !running && (
          <TouchableOpacity onPress={handleClose} style={st.closeBtn}>
            <Text style={st.closeBtnText}>{t('privacy.batchClose')}</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl, paddingVertical: Spacing.md,
  },
  backBtn: {
    width: 40, height: 40, borderRadius: BorderRadius.full,
    backgroundColor: Colors.surfaceSecondary, alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: { fontSize: 18, fontFamily: FontFamily.bold, color: Colors.text },

  summaryCard: {
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.xl,
    padding: Spacing.lg,
    marginBottom: Spacing.lg,
    gap: 10,
  },
  summaryRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  summaryLabel: { fontSize: 13, fontFamily: FontFamily.regular, color: Colors.textSecondary },
  summaryVal: { fontSize: 20, fontFamily: FontFamily.bold, color: Colors.text },

  sectionLabel: {
    fontSize: 13, fontFamily: FontFamily.semibold, color: Colors.textSecondary,
    marginBottom: 8,
  },
  recipientRow: { flexDirection: 'row', gap: 6, marginBottom: 8 },
  toggleChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: BorderRadius.sm, backgroundColor: Colors.surfaceSecondary,
  },
  toggleChipText: { fontSize: 12, fontFamily: FontFamily.medium },
  input: {
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    fontSize: 13,
    fontFamily: FontFamily.mono,
    color: Colors.text,
  },
  helpText: {
    fontSize: 11, fontFamily: FontFamily.regular, color: Colors.textTertiary,
    marginTop: 6, lineHeight: 15,
  },

  noteRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.lg,
    padding: Spacing.md, marginBottom: 8,
  },
  noteAmount: { fontSize: 14, fontFamily: FontFamily.bold, color: Colors.text },
  noteStatus: { fontSize: 11, fontFamily: FontFamily.medium, marginTop: 2 },
  noteError: { fontSize: 11, fontFamily: FontFamily.regular, color: Colors.error, marginTop: 2 },

  bottomBar: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: Spacing.xl, paddingTop: 12,
    backgroundColor: Colors.surfaceSecondary,
    borderTopWidth: 1, borderTopColor: Colors.surfaceTertiary,
  },
  cta: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 14, borderRadius: BorderRadius.md,
    backgroundColor: P01Colors.cyan,
  },
  ctaText: { fontSize: 14, fontFamily: FontFamily.bold, color: '#000' },
  closeBtn: {
    paddingHorizontal: 16, paddingVertical: 14, borderRadius: BorderRadius.md,
    backgroundColor: Colors.surfaceTertiary,
  },
  closeBtnText: { fontSize: 13, fontFamily: FontFamily.semibold, color: Colors.text },
});

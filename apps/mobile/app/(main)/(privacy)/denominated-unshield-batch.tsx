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
  C3_SUBTREE_DEPTH,
} from '@/services/denominatedPool';
import { routeUnshieldSpend } from '@/services/denominatedPool/spendRouting';
import { vaultDecrypt } from '@/utils/crypto/noteVault';
import { getKeypair } from '@/services/solana/wallet';
import { getConnection } from '@/services/solana/connection';
import { Buffer } from 'buffer';
import { Colors, FontFamily, FontSize, BorderRadius, Spacing } from '@/constants/theme';
import { Button } from '@/components/ui';
import { requireBiometricAuth } from '@/utils/biometricGate';
import { p01Alert } from '@/stores/alertStore';
import { useT } from '@/i18n';

export default function DenominatedUnshieldBatchScreen() {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const {
    notes, unshieldNoteStark, unshieldNoteStarkV3, prepareUnshieldNoteV4, unshieldNoteStarkV4,
  } = useDenominatedPoolStore();
  const { publicKey: walletPublicKey } = useWalletStore();
  const {
    isReady: starkReady,
    generatePoolCommitmentProof,
    generateMerklePathProof,
    generateSpendProof,
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
            const pool = ALL_POOLS_V3.find(p => p.poolPDA.toBase58() === note.poolPDA);
            if (!pool) throw new Error('V3 pool config not found');

            // ── ROUTE: CIRCUIT 7, OR THE C1 + C3 PAIR ─────────────────────
            // Same decision as denominated-unshield.tsx, same helper: the pair
            // below is reached ONLY on `V4Unprovable` from the prepare step,
            // and nothing after the prepare falls back. The pair path is byte
            // for byte what this screen ran before circuit 7, as the closure.
            const spendPair = async (): Promise<string> => {
            // V3: C1 + C3 sequentially (StarkProver is single-threaded).

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

            // [C3-D12] Bottom 12 levels into the circuit; the top 3 travel to
            // the instruction for the on-chain walk. 15 elements panic in the
            // wasm, mid-proof, once per note in the batch.
            const U64 = (1n << 64n) - 1n;
            if (c3Path.length < C3_SUBTREE_DEPTH) {
              throw new Error(
                `Merkle path has ${c3Path.length} elements, need at least ` +
                `${C3_SUBTREE_DEPTH} for the C3 circuit.`,
              );
            }
            const c3Result = await generateMerklePathProof(
              (receipt.commitment & U64).toString(),
              c3Path.slice(0, C3_SUBTREE_DEPTH).map(e => (e & U64).toString()),
              c3Indices.slice(0, C3_SUBTREE_DEPTH),
            );
            // ⛔ POOL root from the walk, not the proof's public input 1.
            const c3Walk = {
              merkleRoot: c3Root,
              siblings: c3Path.slice(C3_SUBTREE_DEPTH).map(e => e & U64),
              directions: c3Indices.slice(C3_SUBTREE_DEPTH),
            };

            updateNote(id, {
              status: 'unshielding',
              progress: t('privacy.batchNoteUnshielding'),
            });

            return unshieldNoteStarkV3(
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
              c3Walk,
              false,
            );
            };

            const routed = await routeUnshieldSpend({
              receipt,
              prepareV4: () => prepareUnshieldNoteV4(id, generateSpendProof),
              spendV4: (prepared) => {
                updateNote(id, {
                  status: 'unshielding',
                  progress: t('privacy.batchNoteUnshielding'),
                });
                return unshieldNoteStarkV4(id, resolved.addr, prepared);
              },
              spendPair,
            });
            console.log(`[BatchUnshield] note ${id.slice(0, 8)}… spent via ${routed.version}`);
            sig = routed.txSig;
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
      generateSpendProof,
      unshieldNoteStark,
      unshieldNoteStarkV3,
      prepareUnshieldNoteV4,
      unshieldNoteStarkV4,
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

  /**
   * ⚠️ In-flight was the caution amber. Amber is for something the user should
   * read twice, and "this note is being proved" is neither a warning nor a
   * result — three rows of amber made a working batch look like a problem.
   */
  const statusColor = (s: BatchNoteStatus | undefined): string => {
    switch (s) {
      case 'done':
        return Colors.primary;
      case 'failed':
        return Colors.error;
      case 'proving':
      case 'unshielding':
      case 'sweeping':
        return Colors.textSecondary;
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
          style={[st.backBtn, running && st.backBtnDisabled]}
          disabled={running}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityRole="button"
          accessibilityLabel={t('common.back')}
          accessibilityState={{ disabled: running }}
        >
          <Ionicons name="chevron-back" size={22} color={Colors.textSecondary} />
        </TouchableOpacity>
        <Text style={st.headerTitle}>{t('privacy.batchUnshieldTitle')}</Text>
        <View style={st.headerSpacer} />
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
            {running && <ActivityIndicator size="small" color={Colors.primary} />}
            {allDone && (
              <Ionicons name="checkmark-circle-outline" size={20} color={Colors.primary} />
            )}
          </View>
        </View>

        {/* Recipient */}
        <Text style={st.sectionLabel}>{t('privacy.batchRecipientLabel')}</Text>
        <View style={st.recipientRow}>
          <TouchableOpacity
            onPress={() => setUseOwnWallet((v) => !v)}
            style={[st.toggleChip, useOwnWallet && st.toggleChipActive]}
            disabled={running}
            accessibilityRole="switch"
            accessibilityState={{ checked: useOwnWallet, disabled: running }}
            accessibilityLabel={t('shieldUnshield.myWallet')}
          >
            <Ionicons
              name={useOwnWallet ? 'person-circle' : 'person-circle-outline'}
              size={16}
              color={useOwnWallet ? Colors.primary : Colors.textSecondary}
            />
            <Text
              style={[
                st.toggleChipText,
                { color: useOwnWallet ? Colors.primary : Colors.textSecondary },
              ]}
            >
              {t('shieldUnshield.myWallet')}
            </Text>
          </TouchableOpacity>
        </View>
        <TextInput
          style={[st.input, (useOwnWallet || running) && st.inputDisabled]}
          value={recipient}
          onChangeText={setRecipient}
          placeholder="Solana pubkey / st:01…"
          placeholderTextColor={Colors.textTertiary}
          editable={!useOwnWallet && !running}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={t('privacy.batchRecipientLabel')}
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
              style={[st.noteRow, isCurrent && st.noteRowCurrent]}
            >
              <View style={{ flex: 1 }}>
                <Text style={st.noteAmount}>
                  {note.denomination} {note.token}
                </Text>
                <Text style={[st.noteStatus, { color: statusColor(s?.status) }]}>
                  {statusLabel(s?.status)}
                  {s?.txSig ? ` · ${s.txSig.slice(0, 8)}…` : ''}
                </Text>
                {s?.error && (
                  <Text style={st.noteError} accessibilityRole="alert">{s.error}</Text>
                )}
              </View>
              {(s?.status === 'proving' ||
                s?.status === 'unshielding' ||
                s?.status === 'sweeping') && (
                <ActivityIndicator size="small" color={Colors.textSecondary} />
              )}
              {s?.status === 'done' && (
                <Ionicons name="checkmark-circle-outline" size={18} color={Colors.primary} />
              )}
              {s?.status === 'failed' && (
                <Ionicons name="alert-circle" size={18} color={Colors.error} />
              )}
            </View>
          );
        })}
      </ScrollView>

      {/* Bottom action bar — one primary at a time. */}
      <View style={[st.bottomBar, { paddingBottom: Math.max(insets.bottom, Spacing.md) }]}>
        {!anyStarted && (
          <View style={st.ctaSlot}>
            <Button
              variant="primary"
              size="lg"
              fullWidth
              disabled={!starkReady}
              loading={running}
              onPress={handleStart}
            >
              {t('privacy.batchStart')}
            </Button>
          </View>
        )}
        {running && anyStarted && (
          <View style={st.ctaSlot}>
            <Button variant="primary" size="lg" fullWidth loading disabled onPress={() => {}}>
              {t('privacy.batchRunning')}
            </Button>
          </View>
        )}
        {anyStarted && !running && failedIds.length > 0 && (
          <View style={st.ctaSlot}>
            <Button
              variant="primary"
              size="lg"
              fullWidth
              onPress={handleRetry}
              icon={<Ionicons name="refresh" size={16} color={Colors.background} />}
            >
              {t('privacy.batchRetry')}
            </Button>
          </View>
        )}
        {anyStarted && !running && (
          <Button variant="secondary" size="lg" onPress={handleClose}>
            {t('privacy.batchClose')}
          </Button>
        )}
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, minHeight: 56,
  },
  backBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  backBtnDisabled: { opacity: 0.4 },
  headerSpacer: { width: 44 },
  headerTitle: {
    flex: 1, fontSize: FontSize.xl, fontFamily: FontFamily.displayMedium, color: Colors.text,
  },

  summaryCard: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.border,
    padding: Spacing.lg,
    marginBottom: Spacing.xl,
    gap: Spacing.sm,
  },
  summaryRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  summaryLabel: {
    fontSize: FontSize.sm, fontFamily: FontFamily.regular, color: Colors.textSecondary,
  },
  summaryVal: {
    fontSize: FontSize.xl, fontFamily: FontFamily.monoMedium, color: Colors.text,
  },

  sectionLabel: {
    fontSize: FontSize.sm, fontFamily: FontFamily.medium, color: Colors.textSecondary,
    marginBottom: Spacing.sm,
  },
  recipientRow: { flexDirection: 'row', gap: Spacing.sm, marginBottom: Spacing.sm },
  toggleChip: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    minHeight: 44, paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.sm,
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.border,
  },
  toggleChipActive: { borderColor: Colors.primary },
  toggleChipText: { fontSize: FontSize.sm, fontFamily: FontFamily.medium },
  input: {
    minHeight: 48,
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.mono,
    color: Colors.text,
  },
  inputDisabled: { opacity: 0.5 },
  helpText: {
    fontSize: FontSize.xs, fontFamily: FontFamily.regular, color: Colors.textTertiary,
    marginTop: Spacing.sm, lineHeight: 16,
  },

  noteRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    borderWidth: 1, borderColor: Colors.border,
    padding: Spacing.lg, marginBottom: Spacing.sm,
  },
  noteRowCurrent: { borderColor: Colors.primary },
  noteAmount: {
    fontSize: FontSize.md, fontFamily: FontFamily.monoMedium, color: Colors.text,
  },
  noteStatus: { fontSize: FontSize.xs, fontFamily: FontFamily.medium, marginTop: 2 },
  noteError: {
    fontSize: FontSize.xs, fontFamily: FontFamily.regular, color: Colors.error, marginTop: 2,
  },

  bottomBar: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    paddingHorizontal: Spacing.xl, paddingTop: Spacing.md,
    backgroundColor: Colors.background,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.borderSoft,
  },
  ctaSlot: { flex: 1 },
});

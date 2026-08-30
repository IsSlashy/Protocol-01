/**
 * Withdraw — take one note back out to a transparent address.
 *
 * 🎯 WHAT CHANGED 2026-08-23. Nothing about what it does; everything about how
 * it reads.
 *   - ⛔ NO MORE ALL-CAPS LABELS. `USED NOTES`, `IMMATURE`, and four uppercase
 *     section headers with letter-spacing. That house style is being removed.
 *   - The emergency mode was painted in an orange (`#FF6B35`) that exists in no
 *     palette this project has ever had — it was neither the caution amber nor
 *     the red, so it read as a third meaning nobody defined. Emergency is
 *     destructive: it is the red now.
 *   - Headings are the display face, and the confirm button is the shared
 *     `Button`, so it inherits the 44pt floor, the disabled treatment and the
 *     busy state instead of restating them.
 *   - Errors sit next to what produced them with `accessibilityRole="alert"`.
 *
 * ⚠️ `executeUnshield` — the stealth resolution, the biometric gate, the C1/C3
 * proofs and both store calls — is untouched, arguments included.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

import {
  useDenominatedPoolStore, type StoredNote, type NoteStatus,
} from '@/stores/denominatedPoolStore';
import { useStarkProver } from '@/providers/StarkProverProvider';
import {
  receiptFromJSON,
  ALL_POOLS_V3,
  fetchPoolLeavesByIndex,
  buildMerkleProofFromLeavesV3,
  goldilocksToLeBytes32,
  C3_SUBTREE_DEPTH,
} from '@/services/denominatedPool';
import { vaultDecrypt } from '@/utils/crypto/noteVault';
import { getKeypair } from '@/services/solana/wallet';
import { getConnection } from '@/services/solana/connection';
import { useWalletStore } from '@/stores/walletStore';
import { PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { Colors, FontFamily, FontSize, BorderRadius, Spacing } from '@/constants/theme';
import { Button } from '@/components/ui/Button';
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
          //
          // [C3-D12] The circuit proves the bottom 12 levels ONLY, since the
          // depth cut that freed 128 trace rows for a blinding region. Handing
          // it 15 elements panics inside the wasm, mid-proof, with no useful
          // message. The top 3 travel to the instruction instead, and the
          // handler walks them to reach a root the pool has published.
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
          // ⛔ `merkleRoot` is the POOL root from the walk above, NOT the C3
          // proof's public input 1 — that one is the subtree root now.
          const c3Walk = {
            merkleRoot: c3Root,
            siblings: c3Path.slice(C3_SUBTREE_DEPTH).map(e => e & U64),
            directions: c3Indices.slice(C3_SUBTREE_DEPTH),
          };

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
            c3Walk,
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
        // Single unified call — `emergency` no longer changes any instruction
        // byte: min_epoch is now always UNSHIELD_MIN_EPOCH (0) on both paths.
        // It only relaxes the client-side maturity gate. Privacy posture
        // (ephemeral signer + ECDH stealth recipient + random sweep) is
        // identical for both paths.
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
      const stealthNote = stealthUsed ? `\n\nStealth → ${finalRecipient.slice(0, 8)}...` : '';
      p01Alert(
        emergency ? t('shieldUnshield.emergencyComplete') : `${t('shieldUnshield.unshieldComplete')} (STARK)`,
        `${selectedNote.denomination} ${selectedNote.token} → ${finalRecipient.slice(0, 8)}...${stealthNote}\n\nTx: ${sig.slice(0, 16)}...`,
        [{ text: 'OK', onPress: () => router.back() }],
      );
    } catch (err: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      p01Alert(t('common.error'), err.message);
    }
    } finally {
      setSubmitting(false);
    }
  }, [selectedNote, recipient, unshieldNoteStark, unshieldNoteStarkV3, starkReady, generatePoolCommitmentProof, generateMerklePathProof, router, t, submitting]);

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


  // ⛔ Sentence case, and one tone per state. A note is ready, waiting, or done.
  const statusTone = (status: NoteStatus) => {
    switch (status) {
      case 'mature': return { label: t('common.ready'), good: true };
      case 'pending': return { label: t('privacy.maturing'), good: false };
      default: return { label: t('privacy.spent'), good: false };
    }
  };

  const canSubmit = !!selectedNote && !isLoading && !submitting;

  return (
    <View style={[st.container, { paddingTop: insets.top }]}>
      {/* ── Header ── */}
      <View style={st.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={st.iconBtn}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="chevron-back" size={22} color={Colors.textSecondary} />
        </TouchableOpacity>
        <Text style={st.headerTitle} accessibilityRole="header">
          {emergencyToggle ? t('privacy.emergencyUnshield') : t('shieldUnshield.unshieldTitle')}
        </Text>
        <View style={st.iconBtn} />
      </View>

      {isLoading && (
        <View style={st.stickyProgress}>
          <ActivityIndicator size="small" color={Colors.primary} />
          <Text style={st.stickyProgressText} numberOfLines={2}>
            {isProving ? `${progress ?? 'Processing'} (proving)` : (progress ?? 'Processing')}
          </Text>
          <TouchableOpacity
            style={st.iconBtn}
            onPress={resetOperationState}
            accessibilityRole="button"
            accessibilityLabel="Cancel stuck operation"
          >
            <Ionicons name="close" size={18} color={Colors.textSecondary} />
          </TouchableOpacity>
        </View>
      )}

      <ScrollView
        style={st.scroll}
        contentContainerStyle={[st.scrollContent, { paddingBottom: insets.bottom + 100 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Mode ── */}
        <View style={st.toggle}>
          <ToggleBtn
            label={t('shieldUnshield.normal')}
            active={!emergencyToggle}
            color={Colors.primary}
            onPress={() => { setEmergencyToggle(false); setSelectedNote(null); }}
          />
          <ToggleBtn
            label={t('shieldUnshield.emergency')}
            icon="warning-outline"
            active={emergencyToggle}
            color={Colors.error}
            onPress={() => { setEmergencyToggle(true); setSelectedNote(null); }}
          />
        </View>

        {emergencyToggle && (
          <Text style={st.emergencyNotice} accessibilityRole="alert">
            {t('shieldUnshield.emergencyWarning')}
          </Text>
        )}

        {/* ── Which note ── */}
        <View style={st.sectionRow}>
          <Text style={st.sectionTitleFlush}>
            {emergencyToggle ? t('shieldUnshield.selectANote') : t('shieldUnshield.selectMatureNote')}
          </Text>
          <TouchableOpacity
            onPress={doRefresh}
            disabled={refreshing}
            style={st.refreshBtn}
            accessibilityRole="button"
            accessibilityLabel="Refresh note statuses"
            accessibilityState={{ disabled: refreshing, busy: refreshing }}
          >
            {refreshing
              ? <ActivityIndicator size="small" color={Colors.primary} />
              : <Ionicons name="refresh" size={16} color={Colors.primary} />}
            <Text style={st.refreshBtnText}>{refreshing ? 'Checking' : 'Refresh'}</Text>
          </TouchableOpacity>
        </View>

        {selectableNotes.length === 0 && notes.filter(n => n.status !== 'spent').length === 0 && (
          <View style={st.empty}>
            <Text style={st.emptyTitle}>{t('shieldUnshield.noNotesFound')}</Text>
            <Button
              variant="secondary"
              size="md"
              fullWidth
              style={st.emptyAction}
              onPress={() => router.push('/(main)/(privacy)/denominated-shield' as any)}
              accessibilityLabel={t('shieldUnshield.goToShield')}
            >
              {t('shieldUnshield.goToShield')}
            </Button>
          </View>
        )}

        {!emergencyToggle && matureNotes.length === 0 && pendingNotes.length > 0 && (
          <Text style={st.waitingNotice}>
            {t('shieldUnshield.notesMaturing', { count: pendingNotes.length })}
          </Text>
        )}

        <View style={st.noteList}>
          {selectableNotes.map((note) => {
            const isSelected = selectedNote?.id === note.id;
            const tone = statusTone(note.status);
            return (
              <TouchableOpacity
                key={note.id}
                style={[st.noteCard, isSelected && st.noteCardSelected]}
                onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setSelectedNote(note); }}
                disabled={isLoading}
                activeOpacity={0.8}
                accessibilityRole="radio"
                accessibilityState={{ selected: isSelected, disabled: isLoading }}
                accessibilityLabel={`${note.denomination} ${note.token}, ${tone.label}`}
              >
                <View style={st.noteMain}>
                  {/* Amount and state. Never an internal identifier. */}
                  <Text style={st.noteAmount}>{note.denomination} {note.token}</Text>
                  <Text style={st.noteSub}>
                    {tone.label} · {new Date(note.shieldedAt).toLocaleDateString()}
                  </Text>
                </View>
                {note.status === 'pending' && emergencyToggle && (
                  <View style={st.immaturePill}>
                    <Text style={st.immaturePillText}>{t('shieldUnshield.immature')}</Text>
                  </View>
                )}
                <Ionicons
                  name={isSelected ? 'radio-button-on' : 'radio-button-off'}
                  size={22}
                  color={isSelected ? Colors.primary : Colors.textTertiary}
                />
              </TouchableOpacity>
            );
          })}
        </View>

        {usedNotes.length > 0 && (
          <>
            <Text style={st.sectionTitle}>Already used</Text>
            <Text style={st.usedHint}>
              {usedNotes.length} note{usedNotes.length === 1 ? '' : 's'} that cannot be spent again.
            </Text>
            {usedNotes.map((note) => (
              <View key={note.id} style={st.usedNote}>
                <Text style={st.usedNoteAmount}>{note.denomination} {note.token}</Text>
                <Text style={st.usedNoteSub}>
                  {note.status === 'spent' ? t('privacy.spent') : t('privacy.transferred')}
                  {' · '}
                  {new Date(note.shieldedAt).toLocaleDateString()}
                </Text>
              </View>
            ))}
          </>
        )}

        {/* ── Where it goes ── */}
        <Text style={st.sectionTitle}>{t('shieldUnshield.recipientAddress')}</Text>

        <View style={st.toggle}>
          <ToggleBtn
            label={t('shieldUnshield.myWallet')}
            active={useOwnWallet}
            color={Colors.primary}
            onPress={() => setUseOwnWallet(true)}
          />
          <ToggleBtn
            label={t('shieldUnshield.custom')}
            active={!useOwnWallet}
            color={Colors.primary}
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
            accessibilityLabel={t('shieldUnshield.recipientAddress')}
          />
        )}

        {useOwnWallet && recipient ? (
          <Text style={st.addressPreview} numberOfLines={1}>{recipient}</Text>
        ) : null}

        {/*
          The one-time recipient is a relay, not a destination, and the screen
          has to say so where the address is chosen. The pool pays a stealth
          address, then this app forwards it to whatever is above after a
          3-7s delay, automatically and without asking
          (stores/denominatedPoolStore.ts:1566-1570; measured at ~8s on
          devnet, :1424-1426). The delay was deliberately NOT grown, because
          the link an analyst uses is algebraic rather than temporal: this
          withdrawal republishes the note commitment the deposit published
          (services/denominatedPool/index.ts:3192 → :3277 → :2941).
        */}
        <Text style={st.recipientNotice}>
          {t('shieldUnshield.recipientRelayNotice')}
        </Text>

        {/* ── The one action ── */}
        <Button
          variant={emergencyToggle ? 'danger' : 'primary'}
          size="lg"
          fullWidth
          style={st.confirm}
          loading={isLoading}
          disabled={!canSubmit}
          onPress={handleUnshield}
          accessibilityLabel={
            selectedNote
              ? t('shieldUnshield.withdraw', { amount: selectedNote.denomination, token: selectedNote.token })
              : t('shieldUnshield.selectNoteFirst')
          }
        >
          {/* ⚠️ A loading Button renders a spinner and drops its children, so
              the running commentary belongs to the sticky banner at the top of
              the screen and to the progress bar below — not in here, where it
              would never be seen. */}
          {selectedNote
            ? (emergencyToggle && selectedNote.status === 'pending'
              ? t('shieldUnshield.emergencyWithdraw', { amount: selectedNote.denomination, token: selectedNote.token })
              : t('shieldUnshield.withdraw', { amount: selectedNote.denomination, token: selectedNote.token }))
            : t('shieldUnshield.selectNoteFirst')}
        </Button>
        {isLoading && (
          <>
            <Text style={st.progressText} accessibilityLiveRegion="polite">
              {isProving ? t('shieldUnshield.generatingProof') : progress || t('shieldUnshield.unshielding')}
            </Text>
            <OperationProgressBar progress={progress} variant="inline" />
          </>
        )}

        {/* ── Error, next to the control that produced it ── */}
        {error && !isLoading && (
          <Text style={st.error} accessibilityRole="alert">{error}</Text>
        )}

        <Text style={st.footnote}>{t('shieldUnshield.starkOnDevice')}</Text>
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
      style={[st.toggleBtn, active && { borderColor: color }]}
      onPress={onPress}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
    >
      {icon && <Ionicons name={icon as any} size={15} color={active ? color : Colors.textTertiary} />}
      <Text style={[st.toggleText, active && { color }]}>{label}</Text>
    </TouchableOpacity>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────

const st = StyleSheet.create({
  // Transparent on purpose: the tab layout paints the ground once.
  container: { flex: 1, backgroundColor: 'transparent' },

  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, minHeight: 56,
  },
  headerTitle: {
    flex: 1, fontSize: FontSize.xl, fontFamily: FontFamily.displayMedium,
    color: Colors.text, paddingHorizontal: Spacing.xs,
  },
  iconBtn: {
    width: 44, height: 44, alignItems: 'center', justifyContent: 'center',
  },

  // Sticky progress (below the header, visible for the whole long flow)
  stickyProgress: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    marginHorizontal: Spacing.xl, marginBottom: Spacing.md,
    paddingLeft: Spacing.lg, paddingRight: Spacing.xs, paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.primaryDim,
    borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.primaryMuted,
  },
  stickyProgressText: {
    flex: 1, color: Colors.text,
    fontSize: FontSize.sm, fontFamily: FontFamily.regular,
  },

  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: Spacing.xl },

  // Toggle
  toggle: { flexDirection: 'row', gap: Spacing.sm, marginBottom: Spacing.lg },
  toggleBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: Spacing.sm, minHeight: 44,
    borderRadius: BorderRadius.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.border,
  },
  toggleText: {
    fontSize: FontSize.md, fontFamily: FontFamily.medium, color: Colors.textSecondary,
  },

  emergencyNotice: {
    fontSize: FontSize.sm, fontFamily: FontFamily.regular,
    color: Colors.error, lineHeight: 19, marginBottom: Spacing.lg,
  },
  waitingNotice: {
    fontSize: FontSize.sm, fontFamily: FontFamily.regular,
    color: Colors.yellow, lineHeight: 19, marginBottom: Spacing.lg,
  },

  // Sections
  sectionRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: Spacing['2xl'], marginBottom: Spacing.md,
  },
  sectionTitle: {
    fontSize: FontSize.lg, fontFamily: FontFamily.displayMedium, color: Colors.text,
    marginTop: Spacing['2xl'], marginBottom: Spacing.md,
  },
  sectionTitleFlush: {
    flex: 1, fontSize: FontSize.lg, fontFamily: FontFamily.displayMedium, color: Colors.text,
  },
  refreshBtn: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.xs,
    minHeight: 44, paddingLeft: Spacing.md,
  },
  refreshBtnText: {
    fontSize: FontSize.sm, fontFamily: FontFamily.medium, color: Colors.primary,
  },

  // Notes
  noteList: { gap: Spacing.sm },
  noteCard: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    minHeight: 64, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md,
    borderRadius: BorderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  noteCardSelected: { borderColor: Colors.primary, backgroundColor: Colors.primaryDim },
  noteMain: { flex: 1, minWidth: 0 },
  noteAmount: {
    fontSize: FontSize.lg, fontFamily: FontFamily.displayMedium,
    color: Colors.text, fontVariant: ['tabular-nums'],
  },
  noteSub: {
    fontSize: FontSize.xs, fontFamily: FontFamily.regular,
    color: Colors.textTertiary, marginTop: 2,
  },
  immaturePill: {
    paddingHorizontal: Spacing.sm, paddingVertical: 2,
    borderRadius: BorderRadius.full,
    borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.error,
    backgroundColor: Colors.errorDim,
  },
  immaturePillText: {
    fontSize: FontSize.xs, fontFamily: FontFamily.medium, color: Colors.error,
  },

  // Used notes
  usedHint: {
    fontSize: FontSize.sm, fontFamily: FontFamily.regular,
    color: Colors.textTertiary, marginBottom: Spacing.md,
  },
  usedNote: {
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.borderSoft,
    opacity: 0.6,
  },
  usedNoteAmount: {
    fontSize: FontSize.md, fontFamily: FontFamily.regular, color: Colors.textSecondary,
  },
  usedNoteSub: {
    fontSize: FontSize.xs, fontFamily: FontFamily.regular,
    color: Colors.textTertiary, marginTop: 2,
  },

  // Empty
  empty: { alignItems: 'center', paddingVertical: Spacing['4xl'] },
  emptyTitle: {
    fontSize: FontSize.lg, fontFamily: FontFamily.display,
    color: Colors.text, textAlign: 'center',
  },
  emptyAction: { marginTop: Spacing.xl },

  // Recipient
  addressInput: {
    minHeight: 48,
    borderRadius: BorderRadius.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.border,
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md,
    color: Colors.text, fontFamily: FontFamily.mono, fontSize: FontSize.sm,
  },
  addressPreview: {
    fontFamily: FontFamily.mono, fontSize: FontSize.sm, color: Colors.textSecondary,
  },
  recipientNotice: {
    fontSize: FontSize.xs, fontFamily: FontFamily.regular,
    color: Colors.textTertiary, lineHeight: 17, marginTop: Spacing.md,
  },

  confirm: { marginTop: Spacing['3xl'] },
  progressText: {
    fontSize: FontSize.sm, fontFamily: FontFamily.regular,
    color: Colors.textSecondary, textAlign: 'center', marginTop: Spacing.md,
  },

  error: {
    fontSize: FontSize.sm, fontFamily: FontFamily.regular,
    color: Colors.error, lineHeight: 19, marginTop: Spacing.md,
  },
  footnote: {
    fontSize: FontSize.xs, fontFamily: FontFamily.regular,
    color: Colors.textTertiary, textAlign: 'center', marginTop: Spacing.xl,
  },
});

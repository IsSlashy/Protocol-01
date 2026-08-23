import React, { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator, Linking, StyleSheet,
} from 'react-native';
import { PublicKey, Transaction, SystemProgram, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';
import * as SecureStore from 'expo-secure-store';
import { p01Alert } from '../../../stores/alertStore';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { useStreamStore } from '../../../stores/streamStore';
import { useDenominatedPoolStore } from '../../../stores/denominatedPoolStore';
import { Stream, StreamPayment, formatFrequency, updateStream as updateStreamRecord } from '../../../services/solana/streams';
import { getExplorerUrl, getConnection } from '../../../services/solana/connection';
import { getKeypair } from '../../../services/solana/wallet';
import { useWalletStore } from '../../../stores/walletStore';
import { useStarkProver } from '../../../providers/StarkProverProvider';
import {
  receiptFromJSON,
  ALL_POOLS,
  ALL_POOLS_V3,
  findPoolByPDA,
  fetchPoolLeavesByIndex,
  buildMerkleProofFromLeavesV3,
  goldilocksToLeBytes32,
} from '../../../services/denominatedPool';
import { vaultDecrypt } from '../../../utils/crypto/noteVault';
import { getServiceById, CATEGORY_CONFIG, ServiceCategory } from '../../../services/subscriptions/serviceRegistry';
import { useSubscriptionVaultStore } from '../../../stores/subscriptionVaultStore';
import {
  computeSubscriptionOutlook,
  fetchVault,
  type SubscriptionOutlook,
} from '../../../services/subscriptionVault';
import { withKeepAwake } from '../../../utils/keepAwakeDuring';
import {
  Colors,
  FontFamily,
  FontSize,
  BorderRadius,
  Spacing,
  Layout,
} from '@/constants/theme';
import { Badge } from '@/components/ui';
import { useT } from '@/i18n';
import OperationProgressBar from '@/components/ui/OperationProgressBar';
import { LicenseKeyCard } from '@/components/LicenseKeyCard';

/** Prefix used by vault-detail.tsx + subscriptionVaultStore to save the
 * subscriber secret in SecureStore, keyed by vault PDA. Must match. */
const SECURE_SECRET_PREFIX = 'p01_vault_secret_';

export default function StreamDetailScreen() {
  return <DetailContent />;
}

function DetailContent() {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { streams, processingPayment, refresh, pauseStream, resumeStream, cancelStream, deleteStream } = useStreamStore();
  const { isReady: starkReady, generateProof: starkGenerate, generatePoolCommitmentProof, generateMerklePathProof } = useStarkProver();
  const {
    pausePrivateStarkAction,
    resumePrivateStarkAction,
  } = useSubscriptionVaultStore();
  const { publicKey } = useWalletStore();

  const [stream, setStream] = useState<Stream | null>(null);
  const [copied, setCopied] = useState(false);
  const [paying, setPaying] = useState(false);
  const [payProgress, setPayProgress] = useState<string | null>(null);
  const [starkStatus, setStarkStatus] = useState<string | null>(null);
  const [isStarkBusy, setIsStarkBusy] = useState(false);
  const [starkStep, setStarkStep] = useState<{ current: number; total: number } | null>(null);

  // Where the money stands on the backing vault (ZK path only). NOT a refund
  // quote: `outstandingToRetailer` is what the RETAILER will still receive. A
  // subscription is a one-way prepaid envelope and nothing returns to the payer.
  const [outlook, setOutlook] = useState<SubscriptionOutlook | null>(null);

  useEffect(() => { setStream(streams.find(s => s.id === id) || null); }, [streams, id]);

  // Read the backing vault so the no-refund notice can name what the retailer
  // is still owed. Best-effort: the notice renders without the figure if the
  // read fails.
  useEffect(() => {
    let cancelled = false;
    const vaultAddress = stream?.vaultAddress;
    if (!vaultAddress) { setOutlook(null); return; }
    (async () => {
      try {
        const vault = await fetchVault(new PublicKey(vaultAddress));
        const slot = await getConnection().getSlot('confirmed');
        if (!cancelled && vault) setOutlook(computeSubscriptionOutlook(vault, slot));
      } catch {
        if (!cancelled) setOutlook(null);
      }
    })();
    return () => { cancelled = true; };
  }, [stream?.vaultAddress]);

  // Reactive subscription to the vault store so this effect re-runs when the
  // persisted vaults hydrate from AsyncStorage (cold boot race).
  const vaults = useSubscriptionVaultStore(s => s.vaults);

  // Auto-backfill vaultAddress for streams created before the field existed.
  //   - Only fires on `useZkVault === true` — one-shot ZK streams (useZkPool
  //     without useZkVault) have no on-chain vault, so they must never be wired
  //     to an unrelated recurring vault.
  //   - Requires an unambiguous single match — if the user has two private
  //     vaults to the same retailer (e.g. SOL + USDC) we refuse to guess.
  useEffect(() => {
    if (!stream) return;
    if (stream.vaultAddress) return;
    if (stream.useZkVault !== true) return;
    const matches = vaults.filter(
      v => v.retailer === stream.recipientAddress && v.isPrivateMode,
    );
    if (matches.length !== 1) {
      if (__DEV__ && matches.length > 1) {
        console.warn(
          `[Streams] Skipping backfill for ${stream.id} — ${matches.length} vaults match retailer ${stream.recipientAddress}`,
        );
      }
      return;
    }
    const match = matches[0];
    updateStreamRecord(stream.id, { vaultAddress: match.vaultAddress })
      .then(() => refresh().catch(() => {}))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream?.id, stream?.vaultAddress, stream?.useZkVault, vaults]);

  const serviceInfo = stream?.serviceId ? getServiceById(stream.serviceId) : null;
  // ⛔ There is no `accent` local any more. It used to branch to pink whenever
  // the subscription was ZK-funded, which turned "paid from a shielded note"
  // into a second colour language running through the whole screen. It is a
  // badge on the headline now, and the accent is the one accent.

  if (!stream) {
    return (
      <View style={st.loadingRoot}>
        <ActivityIndicator size="large" color={Colors.primary} />
      </View>
    );
  }

  const isDue = stream.status === 'active' && stream.nextPaymentDate <= Date.now();
  const progress = stream.totalPayments
    ? (stream.paymentsCompleted / stream.totalPayments) * 100
    : (stream.amountStreamed / stream.totalAmount) * 100;

  // The four states, in the four tones the system has. `completed` is not a
  // failure and not a warning: it is the normal way a subscription ends now
  // that the final claim closes the vault.
  const statusTone: 'good' | 'warn' | 'neutral' | 'bad' =
    stream.status === 'active' ? 'good'
    : stream.status === 'paused' ? 'warn'
    : stream.status === 'completed' ? 'neutral' : 'bad';
  const statusLabel = stream.status === 'active' ? t('common.active')
    : stream.status === 'paused' ? t('common.paused')
    // "Stopped", not "Cancelled": only a LOCAL schedule can reach this state,
    // and stopping one moves no money. A vault has no such control at all.
    : stream.status === 'completed' ? t('common.completed') : 'Stopped';

  // ── Handlers ──────────────────────────────────────────────

  const handleCopy = async () => {
    await Clipboard.setStringAsync(stream.recipientAddress);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };

  /** Load the subscriber secret from SecureStore for a given vault PDA. */
  const loadVaultSecret = async (vaultAddress: string): Promise<bigint> => {
    const s = await SecureStore.getItemAsync(`${SECURE_SECRET_PREFIX}${vaultAddress}`);
    if (!s) throw new Error('Subscriber secret not found — was this vault created on this device?');
    return BigInt(s);
  };

  const handlePauseResume = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    // ZK vault path — pause/resume on-chain via STARK proof
    if (stream.vaultAddress) {
      if (!starkReady) {
        p01Alert('Prover initializing', 'STARK prover not ready — try again in a moment.');
        return;
      }
      const isPause = stream.status === 'active';
      const verb = isPause ? 'Pausing' : 'Resuming';
      try {
        setIsStarkBusy(true);
        await withKeepAwake('p01-vault-pause-resume', async () => {
          const secret = await loadVaultSecret(stream.vaultAddress!);
          setStarkStep({ current: 1, total: 2 });
          setStarkStatus(`${verb} · 1/2 — Generating ownership proof (STARK)`);
          const starkResult = await starkGenerate(secret.toString());
          const proofData = {
            proofBytes: Buffer.from(starkResult.proofHex, 'hex'),
            commitment: BigInt(starkResult.commitment),
            proofSize: starkResult.proofSize,
          };
          setStarkStep({ current: 2, total: 2 });
          setStarkStatus(`${verb} · 2/2 — Uploading proof & sending transaction`);
          if (isPause) {
            await pausePrivateStarkAction(stream.vaultAddress!, proofData);
            await updateStreamRecord(stream.id, { status: 'paused' });
          } else {
            await resumePrivateStarkAction(stream.vaultAddress!, proofData);
            await updateStreamRecord(stream.id, { status: 'active' });
          }
        });
        await refresh();
      } catch (err) {
        p01Alert('Error', (err as Error).message);
      } finally {
        setIsStarkBusy(false);
        setStarkStatus(null);
        setStarkStep(null);
      }
      return;
    }

    // Local fallback — non-ZK streams
    stream.status === 'active' ? await pauseStream(stream.id) : await resumeStream(stream.id);
    await refresh();
  };

  /**
   * Stop a LOCAL, non-vault stream. This is a client-side schedule with no
   * prepaid balance on chain: stopping it just stops future payments, and no
   * money changes hands. It is NOT a subscription cancellation -- a
   * SubscriptionVault (`stream.vaultAddress` set) cannot be cancelled at all,
   * because the protocol has no instruction that could pay the subscriber back.
   */
  const stopLocalStream = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (stream.vaultAddress) return;

    p01Alert(t('streams.cancelStream'), t('streams.cancelStreamConfirm', { name: stream.name }),
      [{ text: t('streams.cancelStream'), style: 'destructive', onPress: async () => {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        await cancelStream(stream.id);
        // Publish a P01_SUB_UPD memo on-chain so cross-device sync (and our own
        // post-wipe recovery) sees the stop. Without this, the stream
        // resurrects from its original P01_SUB_V1 memo as `s:'a'` after wipe.
        try {
          const memoData = 'P01_SUB_UPD:' + JSON.stringify({
            v: 1,
            id: stream.id,
            s: 'c',
            u: Math.floor(Date.now() / 1000),
          });
          const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
          const memoIx = new TransactionInstruction({
            keys: [],
            programId: MEMO_PROGRAM_ID,
            data: Buffer.from(memoData, 'utf-8'),
          });
          const conn = getConnection();
          // Local keypair is the only signing path (Privy removed -- spec section 3 Phase 1).
          const kp = await getKeypair();
          if (kp) {
            const tx = new Transaction().add(memoIx);
            await sendAndConfirmTransaction(conn, tx, [kp], { commitment: 'confirmed' });
          }
        } catch (e) {
          console.warn('[Streams] stop publish memo failed (non-fatal):', (e as Error).message);
        }
        await deleteStream(stream.id);
        router.back();
      }}, { text: t('streams.keepStream'), style: 'cancel' }], 'warning');
  };

  const handlePayNow = async () => {
    const intervalMs = stream.frequency === 'daily' ? 86_400_000 : stream.frequency === 'weekly' ? 604_800_000
      : stream.frequency === 'biweekly' ? 1_209_600_000
      : stream.frequency === 'yearly' ? 31_536_000_000 : 2_592_000_000;

    const doPayment = async () => {
      try {
        setPaying(true);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
        let sig: string; let paid = stream.amountPerPayment;

        if (stream.useZkPool) {
          if (!starkReady) throw new Error('STARK prover not ready — try again in a moment');
          const store = useDenominatedPoolStore.getState();
          const matureSol = store.getActiveNotes()
            .filter((n: any) => n.token === 'SOL' && n.status === 'mature')
            .sort((a: any, b: any) => a.denomination - b.denomination);
          const note = matureSol.find((n: any) => n.denomination >= stream.amountPerPayment);
          if (!note) throw new Error('No mature note large enough.');
          // Resolve pool version (V2 vs V3) so we route to the matching unshield
          // path. Pre-fix this branch always called V2 unshield → on-chain proof
          // verification fail for V3/V4 notes (the post-2026-05-07 default).
          const poolByPda = findPoolByPDA(note.poolPDA);
          const noteIsV3 = (note as any).poolVersion === 'v3' || poolByPda?.version === 'v3';
          console.log('[Sub:Renew:PayNow] note selection', {
            streamId: stream.id,
            streamName: stream.name,
            useZkVault: !!stream.useZkVault,
            amountPerPayment: stream.amountPerPayment,
            matureSolNotesCount: matureSol.length,
            selectedNoteId: note.id,
            selectedDenom: note.denomination,
            poolPDA: note.poolPDA?.slice(0, 12) + '…',
            poolFoundVersion: poolByPda?.version,
            willRoute: noteIsV3 ? 'V3 (Goldilocks: C1+C3)' : 'V2 (BN254: C1)',
          });
          const receipt = receiptFromJSON(vaultDecrypt(note.receiptJSON));

          if (noteIsV3) {
            const pool = ALL_POOLS_V3.find(p => p.poolPDA.toBase58() === note.poolPDA);
            if (!pool) {
              throw new Error(
                `V3 pool config not found for note (poolPDA=${note.poolPDA.slice(0, 8)}…). ` +
                `Pool may have been deprecated.`,
              );
            }

            // C1 — pool_commitment proof (same as V2).
            setPayProgress(t('shieldUnshield.generatingProof'));
            const c1Result = await generatePoolCommitmentProof(
              receipt.nullifierPreimage.toString(),
              receipt.secret.toString(),
              receipt.depositEpoch.toString(),
              receipt.tokenMint.toString(),
            );
            console.log('[Sub:Renew:PayNow] V3 C1 ready', { proofSize: c1Result.proofSize });

            // Build merkle path against on-chain V3 tree.
            const conn = getConnection();
            const SIG_SCAN_LIMIT = 5000;
            let leafScan = await fetchPoolLeavesByIndex(conn, pool.poolPDA, { maxSignatures: SIG_SCAN_LIMIT });
            let merkleProof = buildMerkleProofFromLeavesV3({
              leavesByIndex: leafScan.leavesByIndex,
              targetLeafIndex: receipt.leafIndex,
            });

            // Pre-proof root verification.
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
              console.log(`[Sub:Renew:PayNow] V3 pre-proof ${label}: rebuilt root in pool? ${ok ? 'YES' : 'NO'} mySeen=${leafScan.scannedLeafCount}`);
              return ok;
            };
            const ok1 = await checkRoot(merkleProof.root, 'attempt-1');
            if (ok1 === false) {
              console.warn('[Sub:Renew:PayNow] root mismatch — retrying scan after 8s');
              await new Promise(r => setTimeout(r, 8000));
              leafScan = await fetchPoolLeavesByIndex(conn, pool.poolPDA, { maxSignatures: SIG_SCAN_LIMIT * 2 });
              merkleProof = buildMerkleProofFromLeavesV3({
                leavesByIndex: leafScan.leavesByIndex,
                targetLeafIndex: receipt.leafIndex,
              });
              const ok2 = await checkRoot(merkleProof.root, 'attempt-2');
              if (ok2 === false) {
                throw new Error(
                  'Cannot rebuild merkle root that matches the pool. ' +
                  'Likely a missing LeafInserted event (Helius indexing delay). ' +
                  'Wait ~30s and retry.',
                );
              }
            }
            const { root: c3Root, pathElements: c3Path, pathIndices: c3Indices } = merkleProof;

            receipt.merkleRoot = c3Root;
            receipt.merklePathElements = c3Path;
            receipt.merklePathIndices = c3Indices;

            // C3 — merkle_path proof.
            const U64 = (1n << 64n) - 1n;
            const c3Result = await generateMerklePathProof(
              (receipt.commitment & U64).toString(),
              c3Path.map(e => (e & U64).toString()),
              c3Indices,
            );
            console.log('[Sub:Renew:PayNow] V3 C3 ready', { proofSize: c3Result.proofSize });

            setPayProgress(t('shieldUnshield.sendingTransaction'));
            sig = await store.unshieldNoteStarkV3(
              note.id,
              stream.recipientAddress,
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
            console.log('[Sub:Renew:PayNow] V3 sig', { sigPrefix: sig.slice(0, 16) });
          } else {
            // V2/BN254 path — single C1 proof.
            setPayProgress(t('shieldUnshield.generatingProof'));
            const starkResult = await generatePoolCommitmentProof(
              receipt.nullifierPreimage.toString(),
              receipt.secret.toString(),
              receipt.depositEpoch.toString(),
              receipt.tokenMint.toString(),
            );
            sig = await store.unshieldNoteStark(note.id, stream.recipientAddress, {
              proofBytes: Buffer.from(starkResult.proofHex, 'hex'),
              publicInputs: starkResult.publicInputs.map((s: string) => BigInt(s)),
              proofSize: starkResult.proofSize,
            }, false);
            console.log('[Sub:Renew:PayNow] V2 sig', { sigPrefix: sig.slice(0, 16) });
          }
          paid = note.denomination;
        } else {
          setPayProgress(t('shieldUnshield.sendingTransaction'));
          // Local keypair is the only signing path (Privy removed — spec §3 Phase 1).
          const kp = await getKeypair(); if (!kp) throw new Error('Wallet not found');
          const tx = new Transaction().add(SystemProgram.transfer({
            fromPubkey: kp.publicKey, toPubkey: new PublicKey(stream.recipientAddress),
            lamports: Math.round(stream.amountPerPayment * 1e9),
          }));
          sig = await sendAndConfirmTransaction(getConnection(), tx, [kp], { commitment: 'confirmed' });
        }

        const now = Date.now();
        const payment: StreamPayment = {
          id: `payment_${now}`, amount: stream.amountPerPayment, actualAmount: paid,
          signature: sig, timestamp: now, status: 'success',
        };
        const completed = stream.paymentsCompleted + 1;
        const done = stream.totalPayments ? completed >= stream.totalPayments : false;
        await updateStreamRecord(stream.id, {
          amountStreamed: stream.amountStreamed + paid, paymentsCompleted: completed,
          nextPaymentDate: now + intervalMs, status: done ? 'completed' : stream.status,
          paymentHistory: [...stream.paymentHistory, payment],
        });
        await refresh();
        p01Alert(t('streams.paymentSent'), t('streams.paymentConfirmed', { amount: paid.toFixed(4), tx: sig.slice(0, 8) }), undefined, 'success');
      } catch (e: any) {
        p01Alert(t('streams.paymentFailed'), e.message, undefined, 'error');
      } finally { setPaying(false); setPayProgress(null); }
    };

    p01Alert(stream.useZkPool ? t('streams.zkPrivate') : t('streams.payNow'),
      `Send ${stream.amountPerPayment.toFixed(4)} SOL${stream.useZkPool ? ' via ZK proof' : ''}?`,
      [{ text: stream.useZkPool ? t('streams.payZK') : t('streams.payNow'), onPress: doPayment }, { text: t('common.cancel'), style: 'cancel' }],
      'question');
  };

  const fmt = (ts: number) => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const fmtFull = (ts: number) => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const timeUntil = (ts: number) => {
    const d = ts - Date.now(); if (d <= 0) return t('streams.dueNow');
    const days = Math.floor(d / 86_400_000); const hrs = Math.floor((d % 86_400_000) / 3_600_000);
    return days > 0 ? `${days}d ${hrs}h` : `${hrs}h`;
  };

  return (
    <View style={st.container}>
      {/* ── Header ── */}
      <View style={[st.header, { paddingTop: insets.top + Spacing.sm }]}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={st.iconBtn}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="chevron-back" size={22} color={Colors.textSecondary} />
        </TouchableOpacity>
        <Text style={st.headerTitle} numberOfLines={1}>{stream.name}</Text>
        <View style={st.headerSpacer} />
      </View>

      {/* Sticky STARK progress bar — pause/resume only */}
      {isStarkBusy && starkStatus && (
        <OperationProgressBar
          progress={starkStatus}
          variant="sticky"
          onCancel={() => { setIsStarkBusy(false); setStarkStatus(null); setStarkStep(null); }}
          step={starkStep ?? undefined}
          showKeepOpenWarning={true}
        />
      )}

      <ScrollView
        style={st.flex}
        contentContainerStyle={[
          st.scrollContent,
          { paddingBottom: insets.bottom + Layout.tabBarTotalHeight + Spacing['2xl'] },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* ── What it costs and where it stands ──
            ⛔ The status was a pill reading "ACTIVE" in capitals, centred on
            its own line above everything. It is a badge beside the amount now:
            the amount is the headline, the state is a note on it. */}
        <Animated.View entering={FadeIn.duration(250)} style={st.headline}>
          <Text style={st.headlineLabel}>{t('streams.paymentAmount')}</Text>
          <View style={st.headlineRow}>
            <Text style={st.headlineAmount}>{stream.amountPerPayment.toFixed(4)}</Text>
            <Text style={st.headlineUnit}>SOL {formatFrequency(stream.frequency)}</Text>
          </View>
          <View style={st.headlineMeta}>
            <Badge variant={statusTone} size="sm">{statusLabel}</Badge>
            {(stream.useZkPool || stream.useZkVault) && (
              <Badge variant="neutral" size="sm">Paid from a shielded note</Badge>
            )}
          </View>
        </Animated.View>

        {/* License key — persistent on-chain-derived access token, no PII */}
        <Animated.View entering={FadeInDown.delay(40).duration(220)} style={st.block}>
          <LicenseKeyCard
            status={stream.status as 'active' | 'paused' | 'completed' | 'cancelled'}
            stream={stream}
            serviceName={stream.serviceName || serviceInfo?.name}
            vaultAddress={stream.vaultAddress}
            walletPubkey={publicKey || undefined}
          />
        </Animated.View>

        {/* ── Progress and totals ── */}
        <Animated.View entering={FadeInDown.delay(60).duration(220)} style={st.block}>
          {stream.totalPayments ? (
            <View style={st.progressBlock}>
              <View style={st.rowBetween}>
                <Text style={st.dimText}>{t('streams.progress')}</Text>
                <Text style={st.monoValue}>
                  {stream.paymentsCompleted}/{stream.totalPayments}
                </Text>
              </View>
              <View style={st.progressTrack}>
                <View style={[st.progressFill, { width: `${Math.min(progress, 100)}%` }]} />
              </View>
            </View>
          ) : null}

          <View style={st.statsRow}>
            <View style={st.stat}>
              <Text style={st.dimText}>{t('streams.totalSent')}</Text>
              <Text style={st.statNum}>{stream.amountStreamed.toFixed(4)}</Text>
            </View>
            <View style={st.statDivider} />
            <View style={st.stat}>
              <Text style={st.dimText}>{t('streams.payments')}</Text>
              <Text style={st.statNum}>{stream.paymentsCompleted}</Text>
            </View>
          </View>
        </Animated.View>

        {/* ── Next payment ── */}
        {stream.status === 'active' && (
          <Animated.View entering={FadeInDown.delay(100).duration(220)} style={[st.block, st.rowBetween]}>
            <View style={st.flexShrink}>
              <Text style={st.dimText}>{t('streams.nextPaymentIn')}</Text>
              <Text style={[st.nextTime, isDue && st.nextTimeDue]}>
                {timeUntil(stream.nextPaymentDate)}
              </Text>
              <Text style={st.dimText}>{fmt(stream.nextPaymentDate)}</Text>
            </View>
            {isDue && (
              <TouchableOpacity
                onPress={handlePayNow}
                disabled={paying}
                style={st.payBtn}
                accessibilityRole="button"
                accessibilityState={{ disabled: paying, busy: paying }}
                accessibilityLabel={stream.useZkPool ? t('streams.payZK') : t('streams.payNow')}
              >
                {paying ? (
                  <View style={st.payBusy}>
                    <ActivityIndicator size="small" color={Colors.background} />
                    {payProgress && <Text style={st.payProgressText}>{payProgress}</Text>}
                  </View>
                ) : (
                  <>
                    <Ionicons
                      name={stream.useZkPool ? 'eye-off' : 'flash'}
                      size={16}
                      color={Colors.background}
                    />
                    <Text style={st.payBtnText}>
                      {stream.useZkPool ? t('streams.payZK') : t('streams.payNow')}
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            )}
          </Animated.View>
        )}

        {/* ── Recipient ── */}
        <Animated.View entering={FadeInDown.delay(140).duration(220)} style={st.block}>
          <Text style={st.blockLabel}>{t('streams.recipient')}</Text>
          <TouchableOpacity
            onPress={handleCopy}
            style={st.copyRow}
            accessibilityRole="button"
            accessibilityLabel="Copy the recipient address"
          >
            <Text style={st.monoText} numberOfLines={1}>{stream.recipientAddress}</Text>
            <Ionicons
              name={copied ? 'checkmark' : 'copy-outline'}
              size={16}
              color={copied ? Colors.primary : Colors.textSecondary}
            />
          </TouchableOpacity>
        </Animated.View>

        {/* ── Schedule ── */}
        <Animated.View entering={FadeInDown.delay(180).duration(220)} style={st.block}>
          <Text style={st.blockLabel}>{t('streams.schedule')}</Text>
          {[
            [t('streams.frequency'), formatFrequency(stream.frequency)],
            [t('streams.started'), fmt(stream.startDate)],
            ...(stream.endDate ? [[t('streams.ends'), fmt(stream.endDate)]] : []),
          ].map(([k, v]) => (
            <View key={k} style={st.schedRow}>
              <Text style={st.dimText}>{k}</Text>
              <Text style={st.monoValue}>{v}</Text>
            </View>
          ))}
        </Animated.View>

        {/* ── Actions ── */}
        {(stream.status === 'active' || stream.status === 'paused') && (
          <Animated.View entering={FadeInDown.delay(220).duration(220)} style={st.actions}>
            <TouchableOpacity
              onPress={handlePauseResume}
              style={st.actionBtn}
              accessibilityRole="button"
              accessibilityLabel={stream.status === 'active' ? t('streams.pause') : t('streams.resume')}
            >
              <Ionicons
                name={stream.status === 'active' ? 'pause' : 'play'}
                size={18}
                color={Colors.primary}
              />
              <Text style={st.actionText}>
                {stream.status === 'active' ? t('streams.pause') : t('streams.resume')}
              </Text>
            </TouchableOpacity>
            {/*
              A vault-backed subscription has NO stop control: the deposit is a
              one-way prepaid envelope and the protocol has no instruction that
              could pay any of it back. A local stream has no on-chain balance
              at all, so stopping it only stops future payments.
            */}
            {!stream.vaultAddress && (
              <TouchableOpacity
                onPress={stopLocalStream}
                style={[st.actionBtn, st.actionBtnDanger]}
                accessibilityRole="button"
                accessibilityLabel="Stop this schedule"
              >
                <Ionicons name="close-circle-outline" size={18} color={Colors.error} />
                <Text style={[st.actionText, st.actionTextDanger]}>Stop</Text>
              </TouchableOpacity>
            )}
          </Animated.View>
        )}

        {/* The no-refund rule, where the Cancel button used to be. */}
        {!!stream.vaultAddress && (stream.status === 'active' || stream.status === 'paused') && (
          <Animated.View entering={FadeInDown.delay(260).duration(220)} style={st.noRefundCard}>
            <Ionicons name="information-circle-outline" size={16} color={Colors.textSecondary} />
            <Text style={st.noRefundText}>
              {t('streams.noRefundNotice')}
              {outlook !== null
                ? ` ${(Number(outlook.outstandingToRetailer) / 1e9).toFixed(3)} SOL ${t('streams.stillOwedSuffix')}`
                : ''}
            </Text>
          </Animated.View>
        )}

        {/* ── Payment history ── */}
        {stream.paymentHistory.length > 0 && (
          <Animated.View entering={FadeInDown.delay(300).duration(220)} style={st.block}>
            <Text style={st.blockLabel}>
              {t('streams.paymentHistory')} ({stream.paymentHistory.length})
            </Text>
            {stream.paymentHistory.slice().reverse().map((p, i) => (
              <TouchableOpacity
                key={p.id}
                onPress={() => p.signature ? Linking.openURL(getExplorerUrl(p.signature, 'tx')) : null}
                style={[st.historyRow, i > 0 && st.historyRowDivided]}
                accessibilityRole={p.signature ? 'link' : 'text'}
                accessibilityLabel={
                  p.signature
                    ? `${p.amount.toFixed(4)} SOL on ${fmtFull(p.timestamp)}, open in the explorer`
                    : `${p.amount.toFixed(4)} SOL on ${fmtFull(p.timestamp)}`
                }
              >
                <View style={[st.historyIcon, p.status !== 'success' && st.historyIconFailed]}>
                  <Ionicons
                    name={p.status === 'success' ? 'checkmark' : 'close'}
                    size={12}
                    color={p.status === 'success' ? Colors.primary : Colors.error}
                  />
                </View>
                <View style={st.flexShrink}>
                  <Text style={st.monoValue}>{p.amount.toFixed(4)} SOL</Text>
                  <Text style={st.dimText}>{fmtFull(p.timestamp)}</Text>
                </View>
                {p.signature && (
                  <Ionicons name="open-outline" size={14} color={Colors.textTertiary} />
                )}
              </TouchableOpacity>
            ))}
          </Animated.View>
        )}
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  flex: { flex: 1 },
  flexShrink: { flex: 1, minWidth: 0 },
  loadingRoot: {
    flex: 1,
    backgroundColor: Colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scrollContent: { paddingHorizontal: Layout.screenPadding },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingBottom: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.borderSoft,
  },
  iconBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    flex: 1,
    fontFamily: FontFamily.displayMedium,
    fontSize: FontSize.xl,
    color: Colors.text,
  },
  headerSpacer: { width: 44 },

  // Headline
  headline: { paddingTop: Spacing['2xl'] },
  headlineLabel: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  headlineRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: Spacing.sm,
    marginTop: Spacing.xs,
  },
  headlineAmount: {
    fontFamily: FontFamily.display,
    fontSize: FontSize['4xl'],
    color: Colors.text,
    fontVariant: ['tabular-nums'],
  },
  headlineUnit: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.md,
    color: Colors.textSecondary,
  },
  headlineMeta: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: Spacing.sm,
    marginTop: Spacing.md,
  },

  // Blocks — a fill and a rule, never a shadow.
  block: {
    marginTop: Spacing.xl,
    padding: Spacing.lg,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  blockLabel: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginBottom: Spacing.md,
  },
  rowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: Spacing.md,
  },

  // Progress
  progressBlock: { marginBottom: Spacing.lg, gap: Spacing.sm },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
    backgroundColor: Colors.surfaceTertiary,
  },
  progressFill: { height: '100%', borderRadius: 2, backgroundColor: Colors.primary },

  // Stats
  statsRow: { flexDirection: 'row' },
  stat: { flex: 1, alignItems: 'center', gap: 2 },
  statDivider: { width: StyleSheet.hairlineWidth, backgroundColor: Colors.border },
  statNum: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.lg,
    color: Colors.text,
  },

  // Next payment
  nextTime: {
    fontFamily: FontFamily.displayMedium,
    fontSize: FontSize['2xl'],
    color: Colors.primary,
    marginVertical: 2,
  },
  nextTimeDue: { color: Colors.yellow },
  payBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    minHeight: 44,
    paddingHorizontal: Spacing.lg,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.primary,
  },
  payBusy: { alignItems: 'center' },
  payBtnText: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    color: Colors.background,
  },
  payProgressText: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    color: Colors.background,
    marginTop: 2,
  },

  // Text helpers
  dimText: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  monoValue: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.sm,
    color: Colors.text,
  },
  monoText: {
    flex: 1,
    fontFamily: FontFamily.mono,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },

  // Recipient
  copyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    minHeight: 44,
  },

  // Schedule
  schedRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: Spacing.md,
    marginBottom: Spacing.sm,
  },

  // Actions
  actions: {
    flexDirection: 'row',
    gap: Spacing.md,
    marginTop: Spacing.xl,
  },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    minHeight: 48,
    borderRadius: BorderRadius.md,
    backgroundColor: 'transparent',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  // Destructive is outlined, never the loudest thing on the screen.
  actionBtnDanger: { borderColor: Colors.error, backgroundColor: Colors.errorDim },
  actionText: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.md,
    color: Colors.primary,
  },
  actionTextDanger: { color: Colors.error },

  // No-refund notice
  noRefundCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
    marginTop: Spacing.xl,
    padding: Spacing.lg,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.surfaceSecondary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSoft,
  },
  noRefundText: {
    flex: 1,
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    lineHeight: 19,
    color: Colors.textSecondary,
  },

  // History
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    minHeight: 48,
    paddingVertical: Spacing.sm,
  },
  historyRowDivided: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.borderSoft,
  },
  historyIcon: {
    width: 28,
    height: 28,
    borderRadius: BorderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.primaryDim,
  },
  historyIconFailed: { backgroundColor: Colors.errorDim },
});

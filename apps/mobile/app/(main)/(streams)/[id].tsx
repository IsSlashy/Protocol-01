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
  computeCancelPreview,
  fetchVault,
  REFUND_KEEPER_FEE,
  REFUND_MIN_RESIDUAL,
  type CancelPreview,
  type VaultInfo,
} from '../../../services/subscriptionVault';
import CancelConfirmModal, {
  type CancelPhase,
  type RefundInfo,
} from '../../../components/privacy/CancelConfirmModal';
import { withKeepAwake } from '../../../utils/keepAwakeDuring';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
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
    cancelPrivateStarkAction,
  } = useSubscriptionVaultStore();
  const { publicKey } = useWalletStore();

  const [stream, setStream] = useState<Stream | null>(null);
  const [copied, setCopied] = useState(false);
  const [paying, setPaying] = useState(false);
  const [payProgress, setPayProgress] = useState<string | null>(null);
  const [starkStatus, setStarkStatus] = useState<string | null>(null);
  const [isStarkBusy, setIsStarkBusy] = useState(false);
  const [starkStep, setStarkStep] = useState<{ current: number; total: number } | null>(null);

  // Cancel modal state (ZK vault path) ────────────────────────────
  const [cancelVisible, setCancelVisible] = useState(false);
  const [cancelPhase, setCancelPhase] = useState<CancelPhase>('preview');
  const [cancelPreview, setCancelPreview] = useState<CancelPreview | null>(null);
  const [cancelProgress, setCancelProgress] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelTx, setCancelTx] = useState<string | null>(null);
  const [cancelPoolLabel, setCancelPoolLabel] = useState<string>('');
  /** Cached vault info — used by the cancel modal to decide between legacy
   *  reshield and refund-via-relayer UX. Captured once when the preview is
   *  opened so subsequent renders don't refetch. */
  const [cancelVault, setCancelVault] = useState<VaultInfo | null>(null);

  useEffect(() => { setStream(streams.find(s => s.id === id) || null); }, [streams, id]);

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
  const accent = stream?.useZkPool ? P01Colors.pink : P01Colors.cyan;
  const accentDim = stream?.useZkPool ? P01Colors.pinkDim : P01Colors.cyanDim;

  if (!stream) {
    return (
      <View style={[st.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color={P01Colors.cyan} />
      </View>
    );
  }

  const isDue = stream.status === 'active' && stream.nextPaymentDate <= Date.now();
  const progress = stream.totalPayments
    ? (stream.paymentsCompleted / stream.totalPayments) * 100
    : (stream.amountStreamed / stream.totalAmount) * 100;

  const statusColor = stream.status === 'active' ? P01Colors.cyan
    : stream.status === 'paused' ? P01Colors.yellow
    : stream.status === 'completed' ? P01Colors.green : Colors.error;

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

  const openCancelModal = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    // Local fallback — non-ZK streams keep the old confirm alert
    if (!stream.vaultAddress) {
      p01Alert(t('streams.cancelStream'), t('streams.cancelStreamConfirm', { name: stream.name }),
        [{ text: t('streams.cancelStream'), style: 'destructive', onPress: async () => {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          await cancelStream(stream.id);
          // Publish a P01_SUB_UPD memo on-chain so cross-device sync (and our own
          // post-wipe recovery) sees the cancellation. Without this, the stream
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
            // Local keypair is the only signing path (Privy removed — spec §3 Phase 1).
            const kp = await getKeypair();
            if (kp) {
              const tx = new Transaction().add(memoIx);
              await sendAndConfirmTransaction(conn, tx, [kp], { commitment: 'confirmed' });
            }
          } catch (e) {
            console.warn('[Streams] cancel publish memo failed (non-fatal):', (e as Error).message);
          }
          await deleteStream(stream.id);
          router.back();
        }}, { text: t('streams.keepStream'), style: 'cancel' }], 'warning');
      return;
    }

    // ZK vault path — compute preview + open CancelConfirmModal
    try {
      const vaultPDA = new PublicKey(stream.vaultAddress);
      const vault = await fetchVault(vaultPDA);
      if (!vault) throw new Error('Vault not found on-chain — may have been closed already.');
      // Use the V2+V3-aware lookup — V4 pools live in ALL_POOLS_V3, so a pure
      // ALL_POOLS scan misses every post-2026-05-07 vault. The guard below is
      // load-bearing for BOTH paths: legacy needs the denomination + tree for
      // reshield, refund-via-relayer needs target_pool + target_tree.
      const pool = findPoolByPDA(vault.sourcePool ?? '');
      // Bail before opening the preview — the cancel action does the same
      // findPoolByPDA lookup and throws, so without this guard the user waits
      // ~60s for a STARK proof before seeing "Source pool not found", and
      // the preview UI misleadingly shows "0 notes re-shielded, all dust".
      if (!pool) {
        p01Alert(
          'Pool config missing',
          `Source pool ${vault.sourcePool ?? 'unknown'} is not in this build. Update the app or contact support.`,
        );
        return;
      }
      const connection = getConnection();
      const slot = await connection.getSlot('confirmed');
      setCancelPreview(computeCancelPreview(vault, slot, pool.denominationAtomic));
      setCancelPoolLabel(`${pool.denomination} ${pool.token}`);
      setCancelVault(vault);
      setCancelPhase('preview');
      setCancelProgress(null);
      setCancelError(null);
      setCancelTx(null);
      setCancelVisible(true);
    } catch (err) {
      p01Alert('Error', (err as Error).message);
    }
  };

  const confirmCancel = async () => {
    if (!stream.vaultAddress) return;
    // /3 totals when the refund-via-relayer CPI is reachable (stealth meta + non-dust residual)
    const useRefundJob =
      !!cancelVault?.clientStealthMeta &&
      !!cancelPreview &&
      cancelPreview.refundable >= REFUND_MIN_RESIDUAL;
    const total = useRefundJob ? 3 : 2;
    setCancelPhase('processing');
    setCancelProgress(`1/${total} — Generating ownership proof (STARK)`);
    try {
      if (!starkReady) throw new Error('STARK prover not ready — try again in a moment.');
      await withKeepAwake('p01-vault-cancel', async () => {
        const secret = await loadVaultSecret(stream.vaultAddress!);
        setCancelProgress(`1/${total} — Generating ownership proof (STARK)`);
        const starkResult = await starkGenerate(secret.toString());
        setCancelProgress(`2/${total} — Uploading proof & sending transaction`);
        const sig = await cancelPrivateStarkAction(stream.vaultAddress!, secret, {
          proofBytes: Buffer.from(starkResult.proofHex, 'hex'),
          commitment: BigInt(starkResult.commitment),
          proofSize: starkResult.proofSize,
        });
        if (useRefundJob) {
          setCancelProgress(`3/${total} — Routing residual to refund job`);
        }
        setCancelTx(sig);
      });
      setCancelPhase('success');
      // Mirror the state locally so the Streams UI reflects the cancellation
      await updateStreamRecord(stream.id, { status: 'cancelled' });
      await refresh();
    } catch (err) {
      setCancelError((err as Error).message);
      setCancelPhase('error');
    }
  };

  const closeCancelModal = () => {
    const wasSuccess = cancelPhase === 'success';
    setCancelVisible(false);
    if (wasSuccess) {
      setTimeout(() => router.back(), 150);
    }
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
      {/* Header */}
      <View style={[st.header, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity onPress={() => router.back()} style={st.backBtn}>
          <Ionicons name="arrow-back" size={22} color={Colors.text} />
        </TouchableOpacity>
        <Text style={st.headerTitle}>{stream.name}</Text>
        <View style={{ width: 40 }} />
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

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: Spacing.xl, paddingBottom: 120 }} showsVerticalScrollIndicator={false}>
        {/* Status pill */}
        <Animated.View entering={FadeIn.duration(250)} style={{ alignItems: 'center', marginBottom: 20 }}>
          <View style={[st.statusPill, { backgroundColor: `${statusColor}20` }]}>
            <View style={[st.statusDot, { backgroundColor: statusColor }]} />
            <Text style={[st.statusText, { color: statusColor }]}>{stream.status.toUpperCase()}</Text>
          </View>
        </Animated.View>

        {/* License key — persistent on-chain-derived access token, no PII */}
        <Animated.View entering={FadeInDown.delay(40).duration(250)}>
          <LicenseKeyCard
            status={stream.status as 'active' | 'paused' | 'completed' | 'cancelled'}
            streamId={stream.id}
            serviceId={stream.serviceId}
            serviceName={stream.serviceName || serviceInfo?.name}
            vaultAddress={stream.vaultAddress}
            walletPubkey={publicKey || undefined}
          />
        </Animated.View>

        {/* Main amount card */}
        <Animated.View entering={FadeInDown.delay(60).duration(250)} style={st.card}>
          <Text style={st.cardLabel}>{t('streams.paymentAmount')}</Text>
          <Text style={st.bigAmount}>{stream.amountPerPayment.toFixed(4)}</Text>
          <Text style={[st.bigUnit, { color: accent }]}>SOL {formatFrequency(stream.frequency)}</Text>

          {/* Progress bar */}
          {stream.totalPayments && (
            <View style={{ marginTop: 16 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
                <Text style={st.dimText}>{t('streams.progress')}</Text>
                <Text style={st.smallWhite}>{stream.paymentsCompleted}/{stream.totalPayments}</Text>
              </View>
              <View style={st.progressTrack}>
                <View style={[st.progressFill, { width: `${Math.min(progress, 100)}%`, backgroundColor: accent }]} />
              </View>
            </View>
          )}

          {/* Stats row */}
          <View style={st.statsRow}>
            <View style={{ alignItems: 'center', flex: 1 }}>
              <Text style={st.dimText}>{t('streams.totalSent')}</Text>
              <Text style={st.statNum}>{stream.amountStreamed.toFixed(4)}</Text>
            </View>
            <View style={st.statDivider} />
            <View style={{ alignItems: 'center', flex: 1 }}>
              <Text style={st.dimText}>{t('streams.payments')}</Text>
              <Text style={st.statNum}>{stream.paymentsCompleted}</Text>
            </View>
          </View>
        </Animated.View>

        {/* Next payment */}
        {stream.status === 'active' && (
          <Animated.View entering={FadeInDown.delay(120).duration(250)}
            style={[st.card, { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }]}>
            <View>
              <Text style={st.dimText}>{t('streams.nextPaymentIn')}</Text>
              <Text style={[st.nextTime, { color: isDue ? Colors.error : accent }]}>{timeUntil(stream.nextPaymentDate)}</Text>
              <Text style={st.dimText}>{fmt(stream.nextPaymentDate)}</Text>
            </View>
            {isDue && (
              <TouchableOpacity onPress={handlePayNow} disabled={paying}
                style={[st.payBtn, { backgroundColor: accent }]}>
                {paying ? (
                  <View style={{ alignItems: 'center' }}>
                    <ActivityIndicator size="small" color="#000" />
                    {payProgress && <Text style={st.payProgressText}>{payProgress}</Text>}
                  </View>
                ) : (
                  <>
                    <Ionicons name={stream.useZkPool ? 'eye-off' : 'flash'} size={16} color="#000" />
                    <Text style={st.payBtnText}>{stream.useZkPool ? t('streams.payZK') : t('streams.payNow')}</Text>
                  </>
                )}
              </TouchableOpacity>
            )}
          </Animated.View>
        )}

        {/* Recipient */}
        <Animated.View entering={FadeInDown.delay(180).duration(250)} style={st.card}>
          <Text style={st.cardLabel}>{t('streams.recipient')}</Text>
          <TouchableOpacity onPress={handleCopy} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Text style={st.monoText} numberOfLines={1}>{stream.recipientAddress}</Text>
            <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={16} color={copied ? P01Colors.cyan : Colors.textSecondary} />
          </TouchableOpacity>
        </Animated.View>

        {/* Schedule */}
        <Animated.View entering={FadeInDown.delay(240).duration(250)} style={st.card}>
          <Text style={st.cardLabel}>{t('streams.schedule')}</Text>
          {[
            [t('streams.frequency'), formatFrequency(stream.frequency)],
            [t('streams.started'), fmt(stream.startDate)],
            ...(stream.endDate ? [[t('streams.ends'), fmt(stream.endDate)]] : []),
          ].map(([k, v]) => (
            <View key={k} style={st.schedRow}>
              <Text style={st.dimText}>{k}</Text>
              <Text style={st.smallWhite}>{v}</Text>
            </View>
          ))}
        </Animated.View>

        {/* Actions */}
        {(stream.status === 'active' || stream.status === 'paused') && (
          <Animated.View entering={FadeInDown.delay(300).duration(250)} style={{ flexDirection: 'row', gap: 10, marginBottom: 20 }}>
            <TouchableOpacity onPress={handlePauseResume}
              style={[st.actionBtn, { backgroundColor: accentDim }]}>
              <Ionicons name={stream.status === 'active' ? 'pause' : 'play'} size={18} color={accent} />
              <Text style={[st.actionText, { color: accent }]}>{stream.status === 'active' ? t('streams.pause') : t('streams.resume')}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={openCancelModal}
              style={[st.actionBtn, { backgroundColor: 'rgba(255,51,102,0.12)' }]}>
              <Ionicons name="close-circle" size={18} color={Colors.error} />
              <Text style={[st.actionText, { color: Colors.error }]}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </Animated.View>
        )}

        {/* Payment History */}
        {stream.paymentHistory.length > 0 && (
          <Animated.View entering={FadeInDown.delay(360).duration(250)} style={st.card}>
            <Text style={st.cardLabel}>{t('streams.paymentHistory')} ({stream.paymentHistory.length})</Text>
            {stream.paymentHistory.slice().reverse().map((p, i) => (
              <TouchableOpacity key={p.id}
                onPress={() => p.signature ? Linking.openURL(getExplorerUrl(p.signature, 'tx')) : null}
                style={[st.historyRow, i > 0 && { borderTopWidth: 1, borderTopColor: Colors.surfaceTertiary }]}>
                <View style={[st.historyIcon, { backgroundColor: p.status === 'success' ? P01Colors.cyanDim : 'rgba(255,51,102,0.15)' }]}>
                  <Ionicons name={p.status === 'success' ? 'checkmark' : 'close'} size={12}
                    color={p.status === 'success' ? P01Colors.cyan : Colors.error} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={st.smallWhite}>{p.amount.toFixed(4)} SOL</Text>
                  <Text style={st.dimText}>{fmtFull(p.timestamp)}</Text>
                </View>
                {p.signature && <Ionicons name="open-outline" size={14} color={P01Colors.cyan} />}
              </TouchableOpacity>
            ))}
          </Animated.View>
        )}
      </ScrollView>

      {/* Cancel modal — only active when stream.vaultAddress is set (ZK path) */}
      <CancelConfirmModal
        visible={cancelVisible}
        preview={cancelPreview}
        denominationLabel={cancelPoolLabel}
        retailerLabel={`${stream.recipientAddress.slice(0, 6)}…${stream.recipientAddress.slice(-4)}`}
        phase={cancelPhase}
        progress={cancelProgress}
        errorMessage={cancelError}
        txSignature={cancelTx}
        refundInfo={
          // Refund-via-relayer UX only when the vault has a stealth meta
          // address. Without it, the legacy reshield copy is correct.
          cancelVault?.clientStealthMeta && cancelPreview
            ? (cancelPreview.refundable >= REFUND_MIN_RESIDUAL
                ? {
                    kind: 'refund' as const,
                    keeperFeeLamports: REFUND_KEEPER_FEE,
                    netLamports:
                      cancelPreview.refundable - REFUND_KEEPER_FEE,
                  }
                : {
                    kind: 'dust-only' as const,
                    residualLamports: cancelPreview.refundable,
                  }) satisfies RefundInfo
            : undefined
        }
        onConfirm={confirmCancel}
        onClose={closeCancelModal}
      />
    </View>
  );
}

const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl, paddingBottom: Spacing.md,
  },
  backBtn: {
    width: 40, height: 40, borderRadius: BorderRadius.full,
    backgroundColor: Colors.surfaceSecondary, alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: { fontSize: 18, fontFamily: FontFamily.semibold, color: Colors.text },

  // Status
  statusPill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 14, paddingVertical: 6, borderRadius: BorderRadius.full,
  },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  statusText: { fontSize: 12, fontFamily: FontFamily.semibold },

  // Cards
  card: {
    backgroundColor: Colors.surfaceSecondary, borderRadius: BorderRadius.xl,
    padding: Spacing.xl, marginBottom: 12,
  },
  cardLabel: { fontSize: 12, fontFamily: FontFamily.medium, color: Colors.textSecondary, marginBottom: 10 },

  // Big amount
  bigAmount: { fontSize: 36, fontFamily: FontFamily.bold, color: Colors.text, textAlign: 'center' },
  bigUnit: { fontSize: 15, fontFamily: FontFamily.semibold, textAlign: 'center', marginTop: 2 },

  // Progress
  progressTrack: { height: 6, backgroundColor: Colors.surfaceTertiary, borderRadius: 3, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 3 },

  // Stats
  statsRow: {
    flexDirection: 'row', marginTop: 16, paddingTop: 14,
    borderTopWidth: 1, borderTopColor: Colors.surfaceTertiary,
  },
  statDivider: { width: 1, backgroundColor: Colors.surfaceTertiary },
  statNum: { fontSize: 18, fontFamily: FontFamily.bold, color: Colors.text, marginTop: 2 },

  // Next payment
  nextTime: { fontSize: 22, fontFamily: FontFamily.bold, marginVertical: 2 },
  payBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 16, paddingVertical: 10, borderRadius: BorderRadius.md,
  },
  payBtnText: { fontSize: 13, fontFamily: FontFamily.semibold, color: '#000' },
  payProgressText: { fontSize: 9, fontFamily: FontFamily.medium, color: '#000', marginTop: 2 },

  // Text helpers
  dimText: { fontSize: 12, fontFamily: FontFamily.regular, color: Colors.textSecondary },
  smallWhite: { fontSize: 13, fontFamily: FontFamily.medium, color: Colors.text },
  monoText: { fontSize: 13, fontFamily: FontFamily.mono, color: Colors.textSecondary, flex: 1 },

  // Schedule
  schedRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },

  // Actions
  actionBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 14, borderRadius: BorderRadius.lg,
  },
  actionText: { fontSize: 14, fontFamily: FontFamily.semibold },

  // History
  historyRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  historyIcon: {
    width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
  },
});

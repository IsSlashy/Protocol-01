import React, { useMemo, useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, ActivityIndicator, StyleSheet,
} from 'react-native';
import { p01Alert } from '../../../stores/alertStore';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { PublicKey, Transaction, SystemProgram, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { useStreamStore } from '../../../stores/streamStore';
import { useWalletStore } from '../../../stores/walletStore';
import { useDenominatedPoolStore } from '../../../stores/denominatedPoolStore';
import { useSubscriptionVaultStore } from '../../../stores/subscriptionVaultStore';
import { StreamFrequency, updateStream as updateStreamRecord } from '../../../services/solana/streams';
import { getConnection } from '../../../services/solana/connection';
import { getKeypair } from '../../../services/solana/wallet';
import { sendSolPrivate } from '../../../services/solana/transactions';
import { deriveStealthAddressSimple } from '../../../utils/crypto/stealth';
import { licenseServiceTag } from '../../../services/license/derive';
import { useStarkProver } from '../../../providers/StarkProverProvider';
import { withKeepAwake } from '../../../utils/keepAwakeDuring';
import {
  receiptFromJSON,
  findPool,
  findPoolByPDA,
  ALL_POOLS_V3,
  fetchPoolLeavesByIndex,
  buildMerkleProofFromLeavesV3,
  goldilocksToLeBytes32,
  C3_SUBTREE_DEPTH,
} from '../../../services/denominatedPool';
import { vaultDecrypt } from '../../../utils/crypto/noteVault';
import { iconKeyToIonicons, formatPriceSOL, formatInterval } from '../../../services/solana/serviceRegistry';
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

/**
 * SPL Memo program — used to attach an invoice tag to one-shot unshield
 * payments so merchants can map incoming payments to their service.
 * `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr` is the v2 memo program
 * (supports multiple signers); the mobile app always hits v2.
 */
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

function buildMemoIx(memo: string): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [],
    data: Buffer.from(memo, 'utf-8'),
  });
}

type PaymentMode = 'wallet' | 'zk-oneshot' | 'zk-vault';

export default function SubscribeScreen() {
  return <SubscribeContent />;
}

function SubscribeContent() {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    serviceId: string;
    serviceName: string;
    servicePda?: string;
    retailer?: string;
    priceLamports?: string;
    intervalSlots?: string;
    supportsOneshot?: string;
    supportsVault?: string;
    verified?: string;
    iconKey?: string;
    category?: string;
    // Legacy params (older screens still pass these).
    price: string;
    frequency: string;
  }>();

  const { createNewStream, refresh } = useStreamStore();
  const { publicKey, balance: walletBalanceObj } = useWalletStore();
  const walletSol = walletBalanceObj?.sol ?? 0;
  const { notes: denomNotes, unshieldNoteStarkV3 } = useDenominatedPoolStore();
  const {
    isReady: starkReady,
    generatePoolCommitmentProof,
    generateMerklePathProof,
    generateProof: starkGenerate,
  } = useStarkProver();
  const { subscribePrivateStarkAction } = useSubscriptionVaultStore();

  const availableNotes = denomNotes.filter(n => n.status === 'mature' || n.status === 'pending');
  const privateBalance = availableNotes.reduce((sum, n) => sum + n.denomination, 0);

  const [isSubscribing, setIsSubscribing] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [stepInfo, setStepInfo] = useState<{ current: number; total: number } | null>(null);
  // Combined progress + step setter — keeps sticky bar and CTA text in sync.
  const setProgressStep = (current: number, total: number, label: string) => {
    setStepInfo({ current, total });
    setProgress(label);
  };
  const [enablePrivacy, setEnablePrivacy] = useState(false);
  const [duration, setDuration] = useState<1 | 6 | 12>(1);
  // Prepay all N months upfront at a discount (public wallet path only).
  const [prepay, setPrepay] = useState(false);
  // User-chosen note for the vault funding. `null` = auto-pick smallest
  // mature note ≥ rate (legacy behaviour).
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);

  // Resolve service metadata — prefer on-chain fields passed via router
  // params; fall back to legacy `price`/`frequency` strings.
  const serviceName = params.serviceName || 'Service';
  const serviceId = params.serviceId || '';
  const retailerPubkey = useMemo<PublicKey | null>(() => {
    if (!params.retailer) return null;
    try {
      return new PublicKey(params.retailer);
    } catch {
      return null;
    }
  }, [params.retailer]);
  const priceLamports: bigint = params.priceLamports
    ? BigInt(params.priceLamports)
    : BigInt(Math.round(parseFloat(params.price || '0') * 1e9));
  const intervalSlotsBig: bigint = params.intervalSlots
    ? BigInt(params.intervalSlots)
    : 6_480_000n; // monthly default
  const supportsOneshot = params.supportsOneshot !== '0';
  const supportsVault = params.supportsVault === '1';
  const verified = params.verified === '1';
  const price = Number(priceLamports) / 1e9;
  const frequency = (params.frequency || formatInterval(intervalSlotsBig)) as StreamFrequency;
  const icon = iconKeyToIonicons(params.iconKey || serviceId);

  // 2-mode UX: "classique" (wallet) vs "privé" (ZK). The internal paymentMode
  // is auto-derived — privé picks the best ZK path the merchant supports
  // (vault > oneshot). Hide privé entirely if neither ZK path is supported.
  const supportsPrivate = supportsVault || supportsOneshot;
  const privatePaymentMode: PaymentMode = supportsVault ? 'zk-vault' : 'zk-oneshot';
  const [uiMode, setUiMode] = useState<'classic' | 'private'>(
    supportsPrivate ? 'private' : 'classic',
  );
  const paymentMode: PaymentMode = uiMode === 'private' ? privatePaymentMode : 'wallet';
  const useZkPool = paymentMode === 'zk-oneshot';
  const useZkVault = paymentMode === 'zk-vault';

  // Duration grey-out: disable months the user can't actually fund. For
  // classic, gate on visible wallet SOL; for privé vault (locks total
  // upfront), gate on private balance ≥ price × months; for privé oneshot
  // gate identically — the user is committing to N monthly payments.
  const sourceBalance = uiMode === 'private' ? privateBalance : walletSol;
  const canAffordDuration = (months: number) => sourceBalance >= price * months;

  // Prepay (pay all N months now at -10%) is offered ONLY on the public wallet
  // path. The ZK note path settles fixed denominations and can't pay an
  // arbitrary discounted amount, so it stays monthly (see decision D).
  const PREPAY_DISCOUNT = 0.1;
  const canPrepay = uiMode === 'classic' && duration > 1;
  const isPrepay = canPrepay && prepay;
  // Amount actually charged now: full discounted lifetime for prepay, else one period.
  const chargeNow = isPrepay
    ? Math.round(price * duration * (1 - PREPAY_DISCOUNT) * 1e9) / 1e9
    : price;
  // Duration only applies to one-shot flows; vault is open-ended.
  const totalPrice = useZkVault ? price : (isPrepay ? chargeNow : price * duration);
  const discount = isPrepay;

  const handleSubscribe = async () => {
    if (!publicKey) return p01Alert(t('alerts.walletRequired'), t('alerts.walletRequiredDesc'), undefined, 'warning');
    if (!retailerPubkey) {
      return p01Alert(
        t('common.error'),
        'Service is missing a retailer address. Re-open the services list.',
        undefined,
        'error',
      );
    }
    // Wrap the entire flow in withKeepAwake so the screen stays on during the
    // STARK proof upload (~30s, ~140 chunked txs). Phone-screen-off during
    // batch 4 was producing AccountNotInitialized 3012 errors because the
    // app gets paused mid-upload by Android.
    await withKeepAwake('p01-subscribe-stream', async () => {
    try {
      setIsSubscribing(true); setProgress(null); setStepInfo(null);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      const now = Date.now();
      const endDate = now + duration * 30 * 86_400_000;
      const retailerAddr = retailerPubkey.toBase58();
      // Pre-generate the Stream id so the on-chain memo references the same
      // record we're about to persist locally. This lets memo-scan recovery
      // (onchainSync.ts) find and reconstruct the Stream on re-install /
      // cross-device boot. Format matches `generateId()` in streams.ts.
      const streamId = `stream_${now}_${Math.random().toString(36).slice(2, 11)}`;
      // Map mobile StreamFrequency → single-letter code expected by scanner.
      const freqCode: 'd' | 'w' | 'm' | 'y' = frequency === 'daily' ? 'd'
        : frequency === 'weekly' ? 'w'
        : frequency === 'yearly' ? 'y' : 'm';
      // P01_SUB_V1 compact JSON — matches `OnChainSubscription` interface in
      // onchainSync.ts. Kept small to fit in a single memo (<566 bytes).
      const subMemoPayload = {
        v: 1,
        id: streamId,
        n: serviceName.slice(0, 32),
        r: retailerAddr,
        a: Math.round(price * 1e9),
        i: freqCode,
        s: 'a',
        np: Math.floor((now + duration * 30 * 86_400_000) / 1000),
        mp: duration > 0 ? duration : 0,
        // pm — periods paid now. Monthly flows pay the first period (1);
        // prepay pays all `duration` periods upfront. Recovery uses this to
        // render "X/N completed" (the 1-vs-0 bug surfaced 2026-05-02).
        pm: isPrepay ? duration : 1,
        // pp:1 marks a fully-prepaid (discounted upfront) subscription so
        // recovery doesn't reschedule monthly charges.
        pp: isPrepay ? 1 : 0,
        c: Math.floor(now / 1000),
      };
      const invoiceMemo = `P01_SUB_V1:${JSON.stringify(subMemoPayload)}`;
      let sig: string;
      // Wallet path pays `chargeNow` (discounted lifetime when prepaying, else
      // one period); the ZK paths overwrite this with the note denomination.
      let paid = chargeNow;
      // Set when the subscribe uses the on-chain ZK vault path so we can route
      // pause/resume/cancel from the Streams UI straight to the STARK actions.
      let vaultAddress: string | undefined;

      if (useZkVault) {
        // ───────── Recurring private vault (subscribe_private_stark) ─────────
        if (!starkReady) throw new Error('STARK prover not ready — try again in a moment');
        setProgress(t('common.loading'));

        const store = useDenominatedPoolStore.getState();
        await store.refreshNoteStatuses();
        const matureNotes = store.getActiveNotes()
          .filter(n => n.token === 'SOL' && n.status === 'mature')
          .sort((a, b) => a.denomination - b.denomination);
        // User picked a specific note via the picker UI? Honour it. Otherwise
        // legacy auto-pick: smallest mature ≥ rate.
        const note = selectedNoteId
          ? matureNotes.find(n => n.id === selectedNoteId)
          : matureNotes.find(n => n.denomination >= price);
        if (!note) throw new Error(t('subscribe.noMatureNote'));
        if (note.denomination < price) {
          throw new Error(`Selected note (${note.denomination} SOL) is smaller than rate (${price} SOL)`);
        }

        // Resolve pool across V2+V3 lists. The 2026-05-07 V4 seed bump means
        // active pools are in ALL_POOLS_V3 — pure V2 findPool misses them.
        const poolConfig = findPoolByPDA(note.poolPDA);
        if (!poolConfig) {
          throw new Error(
            `Pool not found for note (poolPDA=${note.poolPDA.slice(0, 8)}…). ` +
            `Pool may have been deprecated.`,
          );
        }
        const noteIsV3 = (note as any).poolVersion === 'v3' || poolConfig.version === 'v3';
        console.log('[Sub:Vault] note picked', {
          noteId: note.id,
          token: note.token,
          denomination: note.denomination,
          poolFoundVersion: poolConfig.version,
          noteIsV3,
        });

        if (priceLamports > poolConfig.denominationAtomic) {
          throw new Error(
            `Rate ${price} SOL exceeds note denomination (${note.denomination} SOL)`,
          );
        }

        const receipt = receiptFromJSON(vaultDecrypt(note.receiptJSON));
        const subscriberSecret = receipt.secret;

        // C3 (merkle_path) proof — NEW on-chain hardening requirement for
        // subscribe_private_stark (proves the C1 commitment is a leaf in the
        // tree at `merkle_root`). Generated inside the V3 block below once the
        // fresh merkle path is rebuilt; the action ships it as a second buffer.
        let c3ProofData: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number } | null = null;
        // [C3-D12] Travels with the proof and is just as required: the pool root
        // plus the levels above the depth-12 circuit.
        let c3WalkData: { merkleRoot: bigint; siblings: bigint[]; directions: number[] } | null = null;

        // V3 receipts don't carry merkle proof data (built fresh from chain
        // each time). subscribe_private_stark on-chain ix needs the current
        // root + path embedded in the receipt → rebuild here.
        if (noteIsV3) {
          setProgressStep(1, 4, 'Rebuilding Merkle proof');
          const conn = getConnection();
          const SIG_SCAN_LIMIT = 5000;
          let leafScan = await fetchPoolLeavesByIndex(conn, poolConfig.poolPDA, { maxSignatures: SIG_SCAN_LIMIT });
          let merkleProof = buildMerkleProofFromLeavesV3({
            leavesByIndex: leafScan.leavesByIndex,
            targetLeafIndex: receipt.leafIndex,
          });

          // Pre-proof verification — abort cheaply if rebuilt root not in pool.
          const { parsePoolAccount } = await import('@/services/denominatedPool/parsePool');
          const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
          const checkRoot = async (rootBigint: bigint, label: string) => {
            const acct = await conn.getAccountInfo(poolConfig.poolPDA, 'confirmed');
            if (!acct) return null;
            const parsed = parsePoolAccount(acct.data);
            if (!parsed) return null;
            const target = new Uint8Array(goldilocksToLeBytes32(rootBigint));
            const inCur = eq(target, parsed.currentRoot);
            const idx = parsed.historicalRoots.findIndex(r => eq(target, r));
            const ok = inCur || idx >= 0;
            console.log(`[Sub:Vault] V3 pre-proof ${label}: rebuilt root in pool? ${ok ? 'YES' : 'NO'} mySeen=${leafScan.scannedLeafCount}`);
            return ok;
          };
          const ok1 = await checkRoot(merkleProof.root, 'attempt-1');
          if (ok1 === false) {
            console.warn('[Sub:Vault] root mismatch — retrying scan after 8s');
            await new Promise(r => setTimeout(r, 8000));
            leafScan = await fetchPoolLeavesByIndex(conn, poolConfig.poolPDA, { maxSignatures: SIG_SCAN_LIMIT * 2 });
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
          // Stash onto receipt for the on-chain ix builder.
          receipt.merkleRoot = merkleProof.root;
          receipt.merklePathElements = merkleProof.pathElements;
          receipt.merklePathIndices = merkleProof.pathIndices;

          // Generate the C3 (merkle_path) proof against the freshly-rebuilt
          // path. publicInputs = [leaf_u64, subtree_root_u64, depth(=12)].
          //
          // 🚨 THE COMMENT HERE SAID depth(=15) AND "the service derives the ix
          // `merkle_root` from publicInputs[1]". Both stopped being true on
          // 2026-08-29: the circuit proves the bottom TWELVE levels, so
          // publicInputs[1] is a SUBTREE root and the pool root has to travel
          // separately, with the three levels above the circuit.
          setProgressStep(1, 4, 'Generating Merkle path proof (C3)');
          const U64 = (1n << 64n) - 1n;
          if (merkleProof.pathElements.length < C3_SUBTREE_DEPTH) {
            throw new Error(
              `Merkle path has ${merkleProof.pathElements.length} elements, need at ` +
              `least ${C3_SUBTREE_DEPTH} for the C3 circuit.`,
            );
          }
          const c3Result = await generateMerklePathProof(
            (receipt.commitment & U64).toString(),
            merkleProof.pathElements.slice(0, C3_SUBTREE_DEPTH).map(e => (e & U64).toString()),
            merkleProof.pathIndices.slice(0, C3_SUBTREE_DEPTH),
          );
          c3ProofData = {
            proofBytes: Buffer.from(c3Result.proofHex, 'hex'),
            publicInputs: c3Result.publicInputs.map((s: string) => BigInt(s)),
            proofSize: c3Result.proofSize,
          };
          c3WalkData = {
            merkleRoot: merkleProof.root,
            siblings: merkleProof.pathElements.slice(C3_SUBTREE_DEPTH).map(e => e & U64),
            directions: merkleProof.pathIndices.slice(C3_SUBTREE_DEPTH),
          };
        }

        if (!c3ProofData || !c3WalkData) {
          // subscribe_private_stark is V3-only (DenominatedPoolV3 / MerkleTreeStateV3
          // + merkle_path C3 gate). A non-V3 note can't satisfy the on-chain C3
          // requirement, so fail fast instead of reverting after burning proof rent.
          throw new Error(
            'Private subscribe requires a V3 pool note (merkle_path C3 proof). This note is not V3.',
          );
        }

        setProgressStep(2, 4, 'Generating ownership proof (STARK)');
        const ownershipResult = await starkGenerate(subscriberSecret.toString());
        const vkHashSubscriber = sha256(Buffer.from(ownershipResult.commitment, 'hex'));

        setProgressStep(3, 4, 'Generating pool commitment proof');
        const poolProof = await generatePoolCommitmentProof(
          receipt.nullifierPreimage.toString(),
          receipt.secret.toString(),
          receipt.depositEpoch.toString(),
          receipt.tokenMint.toString(),
        );

        setProgressStep(4, 4, 'Uploading proof & sending transaction');
        // This screen used to load the user's v1 stealth meta address here and
        // persist it on the vault, so a future cancel could route the refund
        // back through the relayer. There is no cancel and no refund, and the
        // on-chain instruction no longer accepts the argument — so the 64 bytes
        // of [spending_pub(32) || viewing_pub(32)] are no longer read, no
        // longer sent, and no longer published in a transaction anyone can
        // read. `getOrCreateStealthMetaV1` still serves the inbox scanner.
        const subscribeResult = await subscribePrivateStarkAction(
          receipt,
          poolConfig,
          {
            retailer: retailerPubkey,
            rate: priceLamports,
            intervalSlots: intervalSlotsBig,
          },
          subscriberSecret,
          BigInt(ownershipResult.commitment),
          vkHashSubscriber,
          {
            proofBytes: Buffer.from(poolProof.proofHex, 'hex'),
            publicInputs: poolProof.publicInputs.map((s: string) => BigInt(s)),
            proofSize: poolProof.proofSize,
          },
          c3ProofData,
          c3WalkData,
          // Service tag for the license-key commitment (HKDF info). ONE rule,
          // shared with LicenseKeyCard — see licenseServiceTag. Inlining the
          // fallback on both sides is what let them drift apart.
          licenseServiceTag(serviceId, retailerPubkey.toBase58()),
        );
        sig = subscribeResult.signature;
        vaultAddress = subscribeResult.vaultAddress;
        paid = note.denomination;
      } else if (useZkPool) {
        // ───────── One-shot ZK unshield to retailer ─────────
        if (!starkReady) throw new Error('STARK prover not ready — try again in a moment');
        setProgress(t('common.loading'));
        const store = useDenominatedPoolStore.getState();
        // Refresh note statuses before picking: drops any stale "mature" rows
        // whose STARK nullifier PDA is already on-chain (e.g. spent on another
        // device). Otherwise the user waits ~60s for a proof that will fail
        // with `already in use` on submit.
        await store.refreshNoteStatuses();
        const matureSol = store.getActiveNotes()
          .filter(n => n.token === 'SOL' && n.status === 'mature')
          .sort((a, b) => a.denomination - b.denomination);
        const note = selectedNoteId
          ? matureSol.find(n => n.id === selectedNoteId)
          : matureSol.find(n => n.denomination >= price);
        if (!note) throw new Error(t('subscribe.noMatureNote'));
        if (note.denomination < price) {
          throw new Error(`Selected note (${note.denomination} SOL) is smaller than rate (${price} SOL)`);
        }
        // Resolve the note's pool config across V2+V3 lists. The active pools
        // are V3/V4 since the 2026-05-07 seed bump — a pure V2 lookup misses
        // every fresh note and surfaces as "Pool config not found".
        const poolByPda = findPoolByPDA(note.poolPDA);
        const noteIsV3 = (note as any).poolVersion === 'v3' || poolByPda?.version === 'v3';
        console.log('[Sub:OneShot] note picked', {
          noteId: note.id,
          token: note.token,
          denomination: note.denomination,
          notePoolVersion: (note as any).poolVersion ?? 'unknown',
          poolPDA: note.poolPDA,
          poolFound: !!poolByPda,
          poolFoundVersion: poolByPda?.version,
          willRoute: noteIsV3 ? 'V3 (Goldilocks: C1+C3)' : 'V2 (BN254: C1)',
        });
        const receipt = receiptFromJSON(vaultDecrypt(note.receiptJSON));

        if (noteIsV3) {
          // ZK one-shot via V3 path. Mirrors the canonical V3 unshield in
          // `denominated-unshield.tsx:150` — C1 (pool_commitment) + C3
          // (merkle_path) proofs submitted sequentially.
          const pool = ALL_POOLS_V3.find(p => p.poolPDA.toBase58() === note.poolPDA);
          if (!pool) {
            throw new Error(
              `V3 pool config not found for note (poolPDA=${note.poolPDA.slice(0, 8)}…). ` +
              `The pool may have been deprecated. Use the dedicated unshield screen to drain manually.`,
            );
          }

          // C1 — pool_commitment proof.
          setProgressStep(1, 4, 'Generating pool commitment proof');
          const c1Result = await generatePoolCommitmentProof(
            receipt.nullifierPreimage.toString(),
            receipt.secret.toString(),
            receipt.depositEpoch.toString(),
            receipt.tokenMint.toString(),
          );
          console.log('[Sub:OneShot] V3 C1 ready', { proofSize: c1Result.proofSize });

          // Build merkle path against the current on-chain V3 tree.
          setProgressStep(2, 4, 'Building Merkle proof');
          const conn = getConnection();
          const SIG_SCAN_LIMIT = 5000;
          let leafScan = await fetchPoolLeavesByIndex(conn, pool.poolPDA, { maxSignatures: SIG_SCAN_LIMIT });
          let { leavesByIndex } = leafScan;
          let merkleProof = buildMerkleProofFromLeavesV3({
            leavesByIndex,
            targetLeafIndex: receipt.leafIndex,
          });

          // Pre-proof verification against the live pool's known roots.
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
            console.log(`[Sub:OneShot] V3 pre-proof ${label}: rebuilt c3Root in pool? ${ok ? 'YES' : 'NO'} mySeen=${leafScan.scannedLeafCount} missing=${leafScan.missing.length}`);
            return ok;
          };
          const ok1 = await checkRoot(merkleProof.root, 'attempt-1');
          if (ok1 === false) {
            console.warn('[Sub:OneShot] root mismatch — retrying scan after 8s');
            await new Promise(r => setTimeout(r, 8000));
            leafScan = await fetchPoolLeavesByIndex(conn, pool.poolPDA, { maxSignatures: SIG_SCAN_LIMIT * 2 });
            leavesByIndex = leafScan.leavesByIndex;
            merkleProof = buildMerkleProofFromLeavesV3({ leavesByIndex, targetLeafIndex: receipt.leafIndex });
            const ok2 = await checkRoot(merkleProof.root, 'attempt-2');
            if (ok2 === false) {
              throw new Error(
                'Cannot rebuild merkle root that matches the pool. ' +
                'Likely a missing LeafInserted event (Helius indexing delay). ' +
                'Wait ~30s and retry, or restart the app.',
              );
            }
          }
          const { root: c3Root, pathElements: c3Path, pathIndices: c3Indices } = merkleProof;

          // Stash the latest root onto the receipt for the V3 unshield ix.
          receipt.merkleRoot = c3Root;
          receipt.merklePathElements = c3Path;
          receipt.merklePathIndices = c3Indices;

          // C3 — merkle_path proof.
          //
          // [C3-D12] Bottom 12 levels into the circuit; the top 3 travel to the
          // instruction for the on-chain walk.
          setProgressStep(3, 4, 'Generating Merkle path proof');
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
          console.log('[Sub:OneShot] V3 C3 ready', { proofSize: c3Result.proofSize });

          setProgressStep(4, 4, 'Uploading proof & sending transaction');
          sig = await unshieldNoteStarkV3(
            note.id,
            retailerAddr,
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
          console.log('[Sub:OneShot] V3 sig', { sigPrefix: sig.slice(0, 16) });
        } else {
          // V2/BN254 path — single C1 proof.
          setProgressStep(1, 2, 'Generating proof (STARK)');
          const starkResult = await generatePoolCommitmentProof(
            receipt.nullifierPreimage.toString(),
            receipt.secret.toString(),
            receipt.depositEpoch.toString(),
            receipt.tokenMint.toString(),
          );
          setProgressStep(2, 2, 'Sending transaction');
          sig = await store.unshieldNoteStark(note.id, retailerAddr, {
            proofBytes: Buffer.from(starkResult.proofHex, 'hex'),
            publicInputs: starkResult.publicInputs.map((s: string) => BigInt(s)),
            proofSize: starkResult.proofSize,
          }, false);
        }
        paid = note.denomination;
      } else if (enablePrivacy) {
        // ───────── Wallet + Privacy Shield (stealth + ephemeral) ─────────
        setProgress('Sending private transaction');
        setStepInfo(null);
        const kp = await getKeypair();

        // Derive stealth address for initial payment (nonce=0)
        // Stealth spending seed is derived from the local wallet.
        const { getOrCreateStealthKeys } = await import('../../../services/stealth/keys');
        const stealthKeys = await getOrCreateStealthKeys();
        const senderSecret = stealthKeys.spendingKey.secretKey.slice(0, 32);
        const { stealthAddress } = deriveStealthAddressSimple(retailerAddr, senderSecret, 0);

        // Local keypair is the only signing path (Privy removed — spec §3 Phase 1).
        if (!kp) throw new Error('No wallet signer available');
        const walletPub: PublicKey = kp.publicKey;
        const signTx: (tx: Transaction) => Promise<Transaction> =
          async (tx: Transaction) => { tx.sign(kp); return tx; };

        const r = await sendSolPrivate(stealthAddress, chargeNow, walletPub, signTx);
        if (!r.success || !r.signature) throw new Error(r.error || 'Private transaction failed');
        sig = r.signature;
      } else {
        // ───────── Plain wallet transfer (+ invoice memo) ─────────
        setProgress('Sending transaction');
        setStepInfo(null);
        const conn = getConnection();
        const lamports = Math.round(chargeNow * 1e9);
        // Local keypair is the only signing path (Privy removed — spec §3 Phase 1).
        const kp = await getKeypair();
        if (!kp) throw new Error('Wallet keypair not found');
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: kp.publicKey,
            toPubkey: retailerPubkey,
            lamports,
          }),
          buildMemoIx(invoiceMemo),
        );
        sig = await sendAndConfirmTransaction(conn, tx, [kp], { commitment: 'confirmed' });
      }

      setProgress('Recording subscription…');
      setStepInfo(null);
      const stream = await createNewStream({
        id: streamId,
        name: serviceName, recipientAddress: retailerAddr, totalAmount: totalPrice,
        frequency, endDate, serviceId, serviceName,
        // Record the exact tag the vault path hashed into license_commitment,
        // so the detail screen never has to guess it back.
        licenseServiceTag: useZkVault ? licenseServiceTag(serviceId, retailerAddr) : undefined,
        amountNoise: enablePrivacy ? 10 : 0, timingNoise: enablePrivacy ? 4 : 0,
        useStealthAddress: enablePrivacy, useZkPool: useZkPool || useZkVault, useZkVault,
      });
      await updateStreamRecord(stream.id, {
        amountStreamed: paid,
        // Prepay settles every period now → mark them all complete, flag the
        // stream prepaid (scheduler skips billing), and push the next charge out
        // to the end date as a belt-and-braces guard.
        paymentsCompleted: isPrepay ? duration : 1,
        ...(isPrepay ? { prepaid: true, nextPaymentDate: endDate } : {}),
        paymentHistory: [{ id: `pay-${stream.id}-0`, amount: paid, actualAmount: paid, signature: sig, timestamp: now, status: 'success' }],
        ...(vaultAddress ? { vaultAddress } : {}),
      });
      refresh(publicKey || undefined).catch(() => {});
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const successTitle = useZkVault
        ? 'Vault subscription active'
        : (useZkPool ? t('subscribe.privatelySubscribed') : t('subscribe.subscribed'));
      p01Alert(
        successTitle,
        `${paid} SOL confirmed. Tx: ${sig.slice(0, 8)}...`,
        [{ text: t('createStream.viewStream'), onPress: () => router.replace(`/(main)/(streams)/${stream.id}`) },
         { text: t('common.done'), style: 'cancel', onPress: () => router.replace('/(main)/(streams)') }],
        'success',
      );
    } catch (e: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      p01Alert(t('common.error'), e.message || t('alerts.subscriptionFailed'), undefined, 'error');
    } finally { setIsSubscribing(false); setProgress(null); setStepInfo(null); }
    });
  };

  return (
    <View style={st.container}>
      {/* ── Header ── */}
      <View style={[st.header, { paddingTop: insets.top + Spacing.sm }]}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={st.backBtn}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="chevron-back" size={22} color={Colors.textSecondary} />
        </TouchableOpacity>
        <Text style={st.headerTitle} numberOfLines={1}>{t('subscribe.title')}</Text>
        <View style={st.headerSpacer} />
      </View>

      {isSubscribing && (
        <OperationProgressBar
          progress={progress}
          variant="sticky"
          onCancel={() => { setIsSubscribing(false); setProgress(null); setStepInfo(null); }}
          showKeepOpenWarning={true}
          step={stepInfo ?? undefined}
        />
      )}

      <ScrollView
        style={st.flex}
        contentContainerStyle={st.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* ── What you are buying ──
            No panel: the merchant and the price ARE the page, and a border
            around the headline is decoration around the only thing that
            matters. */}
        <Animated.View entering={FadeIn.duration(250)} style={st.hero}>
          <View style={st.heroIcon}>
            <Ionicons name={icon as any} size={26} color={Colors.primary} />
          </View>
          <View style={st.heroText}>
            <View style={st.heroNameRow}>
              <Text style={st.heroName} numberOfLines={2}>{serviceName}</Text>
              {verified && (
                <Ionicons
                  name="checkmark-circle"
                  size={16}
                  color={Colors.primary}
                  accessibilityLabel="Listed as verified in the on-chain registry"
                />
              )}
            </View>
            <View style={st.heroPriceRow}>
              <Text style={st.heroPrice}>{price}</Text>
              <Text style={st.heroPriceUnit}>SOL / {frequency}</Text>
            </View>
          </View>
        </Animated.View>

        {/* ── Duration (hidden in vault mode — a vault is open-ended) ── */}
        {!useZkVault && (
          <Animated.View entering={FadeInDown.delay(60).duration(220)} style={st.section}>
            <Text style={st.sectionLabel}>{t('subscribe.duration')}</Text>
            <View style={st.optionRow}>
              {([1, 6, 12] as const).map(m => {
                const sel = duration === m;
                const affordable = canAffordDuration(m);
                return (
                  <TouchableOpacity
                    key={m}
                    onPress={() => {
                      if (!affordable) return;
                      Haptics.selectionAsync();
                      setDuration(m);
                    }}
                    disabled={!affordable}
                    style={[
                      st.durationBtn,
                      sel && affordable && st.durationBtnSelected,
                      !affordable && st.optionDisabled,
                    ]}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityState={{ selected: sel, disabled: !affordable }}
                    accessibilityLabel={`${m} ${m === 1 ? t('subscribe.month') : t('subscribe.months')}`}
                  >
                    <Text style={[st.durationNum, sel && affordable && st.onAccent]}>{m}</Text>
                    <Text style={[st.durationUnit, sel && affordable && st.onAccentQuiet]}>
                      {m === 1 ? t('subscribe.month') : t('subscribe.months')}
                    </Text>
                    {!affordable && (
                      <Text style={st.durationShort}>
                        {(price * m).toFixed(2)} SOL needed
                      </Text>
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>
          </Animated.View>
        )}

        {/* ── Where the money comes from ── */}
        <Animated.View entering={FadeInDown.delay(120).duration(220)} style={st.section}>
          <Text style={st.sectionLabel}>{t('subscribe.payWith')}</Text>
          <View style={st.optionColumn}>
            {/* Wallet — the merchant sees the paying address. */}
            <TouchableOpacity
              onPress={() => { Haptics.selectionAsync(); setUiMode('classic'); }}
              style={[st.methodCard, uiMode === 'classic' && st.methodCardSelected]}
              activeOpacity={0.7}
              accessibilityRole="radio"
              accessibilityState={{ selected: uiMode === 'classic' }}
            >
              <Radio selected={uiMode === 'classic'} color={Colors.primary} />
              <View style={st.methodBody}>
                <Text style={st.methodTitle}>{t('subscribe.wallet')}</Text>
                <Text style={st.methodDesc}>{t('subscribe.directPayment')}</Text>
              </View>
            </TouchableOpacity>

            {/* Shielded note — routed to the vault when the merchant supports
                one, otherwise a single unshield per period. */}
            {supportsPrivate && (
              <TouchableOpacity
                onPress={() => { Haptics.selectionAsync(); setUiMode('private'); }}
                style={[st.methodCard, uiMode === 'private' && st.methodCardSelected]}
                activeOpacity={0.7}
                accessibilityRole="radio"
                accessibilityState={{ selected: uiMode === 'private' }}
              >
                <Radio selected={uiMode === 'private'} color={Colors.primary} />
                <View style={st.methodBody}>
                  <View style={st.methodTitleRow}>
                    <Text style={st.methodTitle}>Shielded note</Text>
                    <Badge variant={uiMode === 'private' ? 'good' : 'neutral'} size="sm">
                      {supportsVault ? 'Vault' : 'One-shot'}
                    </Badge>
                  </View>
                  {/*
                    Was two sentences of French on an English screen, and the
                    vault one offered "Pause/reprise" beside a stop the
                    protocol cannot perform. Both paths are stated in the same
                    voice now, and neither offers a way back.
                  */}
                  <Text style={st.methodDesc}>
                    {supportsVault
                      ? `The vault pulls ${formatPriceSOL(priceLamports)} SOL every ${formatInterval(intervalSlotsBig)} from the note you deposit. Pause and resume whenever you like. No cancellation and no refund.`
                      : 'One period at a time, paid out of a shielded note. No cancellation and no refund; you repay manually each period.'}
                  </Text>
                </View>
              </TouchableOpacity>
            )}
          </View>

          {/* Shielded balance — both ZK paths need a note at least as big as
              the price, so this is the gate on the button below. */}
          {(useZkPool || useZkVault) && (
            <Animated.View entering={FadeIn.duration(180)} style={st.balanceCard}>
              <View style={st.balanceRow}>
                <View>
                  <Text style={st.balanceLabel}>{t('streams.privateBalance')}</Text>
                  <Text style={st.balanceAmount}>
                    {privateBalance.toFixed(privateBalance < 1 ? 4 : 2)} SOL
                  </Text>
                </View>
                <Ionicons
                  name={privateBalance >= price ? 'checkmark-circle' : 'alert-circle'}
                  size={22}
                  color={privateBalance >= price ? Colors.primary : Colors.error}
                />
              </View>
              {privateBalance < price && (
                <>
                  <Text style={st.balanceShort} accessibilityRole="alert">
                    Not enough shielded. You need a matured note of at least {price} SOL.
                  </Text>
                  <TouchableOpacity
                    onPress={() => router.push('/(main)/(privacy)/denominated-shield' as any)}
                    style={st.shieldMoreBtn}
                    accessibilityRole="button"
                  >
                    <Text style={st.shieldMoreText}>{t('subscribe.shieldMoreSOL')}</Text>
                  </TouchableOpacity>
                </>
              )}
            </Animated.View>
          )}

          {/* Note picker — only when the user actually has a choice to make.
              Default is null: auto-pick the smallest mature note ≥ rate. */}
          {(useZkPool || useZkVault) && (() => {
            const matureForFunding = availableNotes
              .filter(n => n.token === 'SOL' && n.status === 'mature' && n.denomination >= price)
              .sort((a, b) => a.denomination - b.denomination);
            if (matureForFunding.length < 2) return null;
            return (
              <Animated.View entering={FadeIn.duration(180)} style={st.notePicker}>
                <Text style={st.sectionLabel}>Note used to fund this subscription</Text>
                <View style={st.optionColumn}>
                  {matureForFunding.map(n => {
                    const sel = selectedNoteId === n.id;
                    const periodsCovered = price > 0 ? Math.floor(n.denomination / price) : 0;
                    return (
                      <TouchableOpacity
                        key={n.id}
                        onPress={() => { Haptics.selectionAsync(); setSelectedNoteId(sel ? null : n.id); }}
                        style={[st.noteCard, sel && st.methodCardSelected]}
                        activeOpacity={0.7}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: sel }}
                      >
                        <Radio selected={sel} color={Colors.primary} />
                        <View style={st.methodBody}>
                          <Text style={st.noteAmount}>
                            {n.denomination.toFixed(n.denomination < 1 ? 4 : 2)} SOL
                          </Text>
                          <Text style={st.noteMeta}>
                            {n.id.slice(0, 8)}…{n.id.slice(-4)} · covers {periodsCovered} period{periodsCovered === 1 ? '' : 's'}
                          </Text>
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                {/*
                  This said "Residual refunded as fresh notes if you cancel."
                  There is no cancel and no refund, and it sat on the paying
                  screen a few hundred lines above the one-way warning that
                  says so. What actually happens to a note bigger than the
                  price is that the WHOLE note funds the vault, so the excess
                  buys extra periods and, on the closing claim, whatever never
                  bought a period goes to the retailer with the rest.
                */}
                <Text style={st.noteFootnote}>
                  Smallest is picked automatically if you choose none. The whole note funds the
                  vault — anything above the price buys extra periods and never comes back to you.
                </Text>
              </Animated.View>
            );
          })()}

          {/* Stealth + noise, on the public wallet path only. */}
          {paymentMode === 'wallet' && (
            <TouchableOpacity
              onPress={() => { Haptics.selectionAsync(); setEnablePrivacy(!enablePrivacy); }}
              style={[st.toggleRow, enablePrivacy && st.methodCardSelected]}
              activeOpacity={0.8}
              accessibilityRole="switch"
              accessibilityState={{ checked: enablePrivacy }}
              accessibilityLabel={t('subscribe.privacyShield')}
            >
              <Ionicons
                name="shield-checkmark"
                size={18}
                color={enablePrivacy ? Colors.primary : Colors.textSecondary}
              />
              <View style={st.methodBody}>
                <Text style={st.methodTitle}>{t('subscribe.privacyShield')}</Text>
                <Text style={st.methodDesc}>{t('subscribe.noiseAndStealth')}</Text>
              </View>
              <View style={[st.switchTrack, enablePrivacy && st.switchTrackOn]}>
                <View style={[st.switchThumb, enablePrivacy && st.switchThumbOn]} />
              </View>
            </TouchableOpacity>
          )}

          {/* Prepay every period now, at a discount. Wallet path only: the ZK
              path settles fixed denominations and cannot pay an arbitrary
              discounted amount. */}
          {canPrepay && (
            <TouchableOpacity
              onPress={() => { Haptics.selectionAsync(); setPrepay(!prepay); }}
              style={[st.toggleRow, prepay && st.methodCardSelected]}
              activeOpacity={0.8}
              accessibilityRole="switch"
              accessibilityState={{ checked: prepay }}
              accessibilityLabel={`Prepay ${duration} months`}
            >
              <Ionicons
                name="cash-outline"
                size={18}
                color={prepay ? Colors.primary : Colors.textSecondary}
              />
              <View style={st.methodBody}>
                <Text style={st.methodTitle}>Prepay {duration} months</Text>
                <Text style={st.methodDesc}>
                  Pay once now and save 10% ({chargeNow.toFixed(4)} SOL)
                </Text>
              </View>
              <View style={[st.switchTrack, prepay && st.switchTrackOn]}>
                <View style={[st.switchThumb, prepay && st.switchThumbOn]} />
              </View>
            </TouchableOpacity>
          )}
        </Animated.View>

        {/* ── What you are about to pay ── */}
        <Animated.View entering={FadeInDown.delay(180).duration(220)} style={st.summaryCard}>
          {useZkVault ? (
            <>
              <View style={st.summaryRow}>
                <Text style={st.summaryLabel}>{serviceName} — recurring vault</Text>
                <Text style={st.summaryValue}>
                  {price.toFixed(4)} SOL / {formatInterval(intervalSlotsBig)}
                </Text>
              </View>
              <View style={st.summaryDivider} />
              <View style={st.summaryRow}>
                <Text style={st.summaryTotal}>Initial deposit</Text>
                <Text style={st.summaryTotalValue}>≥ {price.toFixed(4)} SOL</Text>
              </View>
            </>
          ) : (
            <>
              <View style={st.summaryRow}>
                <Text style={st.summaryLabel}>{serviceName} × {duration} mo</Text>
                <Text style={st.summaryValue}>{(price * duration).toFixed(4)} SOL</Text>
              </View>
              {discount && (
                <View style={st.summaryRow}>
                  <Text style={st.summaryLabelAccent}>{t('subscribe.discount')}</Text>
                  <Text style={st.summaryValueAccent}>
                    -{(price * duration * 0.1).toFixed(4)}
                  </Text>
                </View>
              )}
              <View style={st.summaryDivider} />
              <View style={st.summaryRow}>
                <Text style={st.summaryTotal}>
                  {isPrepay ? 'Pay now' : t('subscribe.firstPayment')}
                </Text>
                <Text style={st.summaryTotalValue}>
                  {(isPrepay ? chargeNow : price).toFixed(4)} SOL
                </Text>
              </View>
            </>
          )}
        </Animated.View>

        {/*
          THE ONE-WAY WARNING, on the paying screen and above the CTA. The
          vault path deposits the note in full into a SubscriptionVault and the
          protocol has no instruction that can ever pay any of it back. The
          non-vault paths still cannot be refunded by the protocol, so both are
          stated, just with the accuracy each deserves.

          ⛔ It is NOT behind a disclosure. Founder ruling: the sentence that
          costs someone money has to be readable without a tap.
        */}
        <Animated.View entering={FadeInDown.delay(210).duration(220)} style={st.oneWayCard}>
          <View style={st.oneWayHeader}>
            <Ionicons name="warning-outline" size={16} color={Colors.yellow} />
            <Text style={st.oneWayTitle}>
              {useZkVault ? t('subscribe.oneWayTitle') : t('subscribe.finalTitle')}
            </Text>
          </View>
          <Text style={st.oneWayBody}>
            {useZkVault ? t('subscribe.oneWayBody') : t('subscribe.finalBody')}
          </Text>
          <Text style={st.oneWayBody}>{t('subscribe.pauseResumeBody')}</Text>
        </Animated.View>
      </ScrollView>

      {/* ── The one action ── */}
      <View style={[st.cta, { paddingBottom: insets.bottom + Layout.tabBarTotalHeight }]}>
        <TouchableOpacity
          onPress={handleSubscribe}
          disabled={isSubscribing || ((useZkPool || useZkVault) && privateBalance < price)}
          style={[
            st.ctaBtn,
            isSubscribing && st.ctaBtnBusy,
            ((useZkPool || useZkVault) && privateBalance < price) && st.ctaBtnDisabled,
          ]}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityState={{
            disabled: isSubscribing || ((useZkPool || useZkVault) && privateBalance < price),
            busy: isSubscribing,
          }}
        >
          {isSubscribing ? (
            <View style={st.ctaBusyBody}>
              <ActivityIndicator size="small" color={Colors.background} />
              {progress && <Text style={st.ctaProgress}>{progress}</Text>}
            </View>
          ) : (
            <>
              <Ionicons
                name={useZkVault ? 'lock-closed' : useZkPool ? 'eye-off' : 'checkmark-circle'}
                size={20}
                color={Colors.background}
              />
              <Text style={st.ctaText}>
                {useZkVault
                  ? 'Create private vault'
                  : (useZkPool ? t('subscribe.subscribePrivately') : t('subscribe.subscribe'))}
              </Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

function Radio({ selected, color }: { selected: boolean; color: string }) {
  return (
    <View style={[st.radio, { borderColor: selected ? color : Colors.textTertiary }]}>
      {selected && <View style={[st.radioDot, { backgroundColor: color }]} />}
    </View>
  );
}

const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  flex: { flex: 1 },
  scrollContent: {
    paddingHorizontal: Layout.screenPadding,
    paddingBottom: Spacing['5xl'],
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingBottom: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.borderSoft,
  },
  backBtn: {
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

  // Hero
  hero: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.lg,
    paddingTop: Spacing['2xl'],
  },
  heroIcon: {
    width: 52,
    height: 52,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.primaryDim,
  },
  heroText: { flex: 1, minWidth: 0 },
  heroNameRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  heroName: {
    flexShrink: 1,
    fontFamily: FontFamily.display,
    fontSize: FontSize['2xl'],
    color: Colors.text,
  },
  heroPriceRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: Spacing.sm,
    marginTop: Spacing.xs,
  },
  heroPrice: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.lg,
    color: Colors.text,
  },
  heroPriceUnit: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },

  // Sections
  section: { marginTop: Spacing['3xl'] },
  sectionLabel: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginBottom: Spacing.md,
  },
  optionRow: { flexDirection: 'row', gap: Spacing.sm },
  optionColumn: { gap: Spacing.sm },
  optionDisabled: { opacity: 0.35 },

  // Duration
  durationBtn: {
    flex: 1,
    minHeight: 64,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.md,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  durationBtnSelected: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  durationNum: {
    fontFamily: FontFamily.displayMedium,
    fontSize: FontSize.xl,
    color: Colors.text,
  },
  durationUnit: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  durationShort: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    color: Colors.textTertiary,
    marginTop: 2,
  },
  onAccent: { color: Colors.background },
  onAccentQuiet: { color: Colors.background, opacity: 0.7 },

  // Method cards
  methodCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.md,
    minHeight: 44,
    padding: Spacing.lg,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  methodCardSelected: {
    backgroundColor: Colors.primaryDim,
    borderColor: Colors.primaryMuted,
  },
  methodBody: { flex: 1, minWidth: 0 },
  methodTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  methodTitle: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.md,
    color: Colors.text,
  },
  methodDesc: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    lineHeight: 19,
    color: Colors.textSecondary,
    marginTop: 3,
  },

  // Radio
  radio: {
    width: 20,
    height: 20,
    borderRadius: BorderRadius.full,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  radioDot: { width: 10, height: 10, borderRadius: BorderRadius.full },

  // Shielded balance
  balanceCard: {
    marginTop: Spacing.md,
    padding: Spacing.lg,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.surfaceSecondary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSoft,
  },
  balanceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  balanceLabel: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
  },
  balanceAmount: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.lg,
    color: Colors.text,
    marginTop: 2,
  },
  balanceShort: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    lineHeight: 19,
    color: Colors.error,
    marginTop: Spacing.sm,
  },
  shieldMoreBtn: {
    marginTop: Spacing.md,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: BorderRadius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  shieldMoreText: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    color: Colors.text,
  },

  // Note picker
  notePicker: { marginTop: Spacing.lg },
  noteCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    minHeight: 56,
    padding: Spacing.md,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  noteAmount: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.md,
    color: Colors.text,
  },
  noteMeta: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    color: Colors.textTertiary,
    marginTop: 2,
  },
  noteFootnote: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    lineHeight: 17,
    color: Colors.textTertiary,
    marginTop: Spacing.sm,
  },

  // Toggles
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    minHeight: 56,
    padding: Spacing.lg,
    marginTop: Spacing.sm,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  switchTrack: {
    width: 44,
    height: 26,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.surfaceTertiary,
    justifyContent: 'center',
    padding: 2,
  },
  switchTrackOn: { backgroundColor: Colors.primary },
  switchThumb: {
    width: 22,
    height: 22,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.textTertiary,
  },
  switchThumbOn: { alignSelf: 'flex-end', backgroundColor: Colors.background },

  // Summary
  summaryCard: {
    marginTop: Spacing['3xl'],
    padding: Spacing.lg,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: Spacing.md,
    marginBottom: Spacing.sm,
  },
  summaryLabel: {
    flexShrink: 1,
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  summaryLabelAccent: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.primary,
  },
  summaryValue: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.sm,
    color: Colors.text,
  },
  summaryValueAccent: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.sm,
    color: Colors.primary,
  },
  summaryDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Colors.border,
    marginVertical: Spacing.sm,
  },
  summaryTotal: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.md,
    color: Colors.text,
  },
  summaryTotalValue: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.md,
    color: Colors.primary,
  },

  // The one-way warning. Amber is caution, and this is the only amber on the
  // screen.
  oneWayCard: {
    marginTop: Spacing.lg,
    padding: Spacing.lg,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.warningDim,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.yellow,
    gap: Spacing.sm,
  },
  oneWayHeader: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  oneWayTitle: {
    flex: 1,
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    color: Colors.yellow,
  },
  oneWayBody: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    lineHeight: 19,
    color: Colors.textSecondary,
  },

  // CTA
  cta: {
    paddingHorizontal: Layout.screenPadding,
    paddingTop: Spacing.md,
    backgroundColor: Colors.background,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.borderSoft,
  },
  ctaBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    minHeight: 52,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.primary,
  },
  ctaBtnBusy: { backgroundColor: Colors.primaryMuted },
  ctaBtnDisabled: { opacity: 0.4 },
  ctaBusyBody: { alignItems: 'center', gap: 2 },
  ctaText: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.lg,
    color: Colors.background,
  },
  ctaProgress: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    color: Colors.background,
    opacity: 0.75,
  },
});

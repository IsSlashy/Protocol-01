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
import { useWalletStore, getPrivySigner } from '../../../stores/walletStore';
import { useDenominatedPoolStore } from '../../../stores/denominatedPoolStore';
import { useSubscriptionVaultStore } from '../../../stores/subscriptionVaultStore';
import { StreamFrequency, updateStream as updateStreamRecord } from '../../../services/solana/streams';
import { getConnection } from '../../../services/solana/connection';
import { getKeypair } from '../../../services/solana/wallet';
import { sendSolWithSigner, sendSolPrivate } from '../../../services/solana/transactions';
import { deriveStealthAddressSimple } from '../../../utils/crypto/stealth';
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
} from '../../../services/denominatedPool';
import { vaultDecrypt } from '../../../utils/crypto/noteVault';
import { iconKeyToIonicons, formatPriceSOL, formatInterval } from '../../../services/solana/serviceRegistry';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import { useT } from '@/i18n';

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
  const { publicKey, isPrivyWallet, balance: walletBalanceObj } = useWalletStore();
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
  const [enablePrivacy, setEnablePrivacy] = useState(false);
  const [duration, setDuration] = useState<1 | 6 | 12>(1);
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

  // Duration only applies to one-shot flows; vault is open-ended.
  const totalPrice = useZkVault ? price : price * duration;
  const discount = !useZkVault && duration > 1;

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
      setIsSubscribing(true); setProgress(null);
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
        // pm:1 — the subscribe flow always pays the first period now, so the
        // memo MUST reflect that or recovery will display "0/N completed"
        // for an already-paid first period (UX bug surfaced 2026-05-02).
        pm: 1,
        c: Math.floor(now / 1000),
      };
      const invoiceMemo = `P01_SUB_V1:${JSON.stringify(subMemoPayload)}`;
      let sig: string;
      let paid = price;
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

        // V3 receipts don't carry merkle proof data (built fresh from chain
        // each time). subscribe_private_stark on-chain ix needs the current
        // root + path embedded in the receipt → rebuild here.
        if (noteIsV3) {
          setProgress('Rebuilding merkle proof…');
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
        }

        setProgress(t('shieldUnshield.generatingProof'));
        const ownershipResult = await starkGenerate(subscriberSecret.toString());
        const vkHashSubscriber = sha256(Buffer.from(ownershipResult.commitment, 'hex'));

        setProgress(t('shieldUnshield.generatingProof'));
        const poolProof = await generatePoolCommitmentProof(
          receipt.nullifierPreimage.toString(),
          receipt.secret.toString(),
          receipt.depositEpoch.toString(),
          receipt.tokenMint.toString(),
        );

        setProgress(t('shieldUnshield.sendingTransaction'));
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
          setProgress(t('shieldUnshield.generatingProof'));
          const c1Result = await generatePoolCommitmentProof(
            receipt.nullifierPreimage.toString(),
            receipt.secret.toString(),
            receipt.depositEpoch.toString(),
            receipt.tokenMint.toString(),
          );
          console.log('[Sub:OneShot] V3 C1 ready', { proofSize: c1Result.proofSize });

          // Build merkle path against the current on-chain V3 tree.
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
          const U64 = (1n << 64n) - 1n;
          const c3Result = await generateMerklePathProof(
            (receipt.commitment & U64).toString(),
            c3Path.map(e => (e & U64).toString()),
            c3Indices,
          );
          console.log('[Sub:OneShot] V3 C3 ready', { proofSize: c3Result.proofSize });

          setProgress(t('shieldUnshield.sendingTransaction'));
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
            false,
          );
          console.log('[Sub:OneShot] V3 sig', { sigPrefix: sig.slice(0, 16) });
        } else {
          // V2/BN254 path — single C1 proof.
          setProgress(t('shieldUnshield.generatingProof'));
          const starkResult = await generatePoolCommitmentProof(
            receipt.nullifierPreimage.toString(),
            receipt.secret.toString(),
            receipt.depositEpoch.toString(),
            receipt.tokenMint.toString(),
          );
          sig = await store.unshieldNoteStark(note.id, retailerAddr, {
            proofBytes: Buffer.from(starkResult.proofHex, 'hex'),
            publicInputs: starkResult.publicInputs.map((s: string) => BigInt(s)),
            proofSize: starkResult.proofSize,
          }, false);
        }
        paid = note.denomination;
      } else if (enablePrivacy) {
        // ───────── Wallet + Privacy Shield (stealth + ephemeral) ─────────
        setProgress(t('shieldUnshield.sendingTransaction'));
        const privySigner = getPrivySigner();
        const kp = await getKeypair();

        // Derive stealth address for initial payment (nonce=0)
        // Use stealth spending seed (available for all wallet types including Privy)
        const { getOrCreateStealthKeys } = await import('../../../services/stealth/keys');
        const stealthKeys = await getOrCreateStealthKeys();
        const senderSecret = stealthKeys.spendingKey.secretKey.slice(0, 32);
        const { stealthAddress } = deriveStealthAddressSimple(retailerAddr, senderSecret, 0);

        let walletPub: PublicKey;
        let signTx: (tx: Transaction) => Promise<Transaction>;
        if (kp) {
          walletPub = kp.publicKey;
          signTx = async (tx: Transaction) => { tx.sign(kp); return tx; };
        } else if (isPrivyWallet && privySigner && publicKey) {
          walletPub = new PublicKey(publicKey);
          signTx = privySigner;
        } else {
          throw new Error('No wallet signer available');
        }

        const r = await sendSolPrivate(stealthAddress, price, walletPub, signTx);
        if (!r.success || !r.signature) throw new Error(r.error || 'Private transaction failed');
        sig = r.signature;
      } else {
        // ───────── Plain wallet transfer (+ invoice memo) ─────────
        setProgress(t('shieldUnshield.sendingTransaction'));
        const privySigner = getPrivySigner();
        const conn = getConnection();
        const lamports = Math.round(price * 1e9);
        if (isPrivyWallet && privySigner && publicKey) {
          // sendSolWithSigner doesn't expose a memo hook; add a follow-up
          // memo-only TX so the merchant still sees the invoice tag.
          const r = await sendSolWithSigner(retailerAddr, price, new PublicKey(publicKey), privySigner);
          if (!r.success || !r.signature) throw new Error(r.error || 'Transaction failed');
          sig = r.signature;
        } else {
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
      }

      setProgress(t('common.processing'));
      const stream = await createNewStream({
        id: streamId,
        name: serviceName, recipientAddress: retailerAddr, totalAmount: totalPrice,
        frequency, endDate, serviceId, serviceName,
        amountNoise: enablePrivacy ? 10 : 0, timingNoise: enablePrivacy ? 4 : 0,
        useStealthAddress: enablePrivacy, useZkPool: useZkPool || useZkVault, useZkVault,
      });
      await updateStreamRecord(stream.id, {
        amountStreamed: paid, paymentsCompleted: 1,
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
    } finally { setIsSubscribing(false); setProgress(null); }
    });
  };

  const accent = (useZkPool || useZkVault) ? P01Colors.pink : P01Colors.cyan;
  const accentDim = (useZkPool || useZkVault) ? P01Colors.pinkDim : P01Colors.cyanDim;

  return (
    <View style={st.container}>
      {/* Header */}
      <View style={[st.header, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity onPress={() => router.back()} style={st.backBtn}>
          <Ionicons name="arrow-back" size={22} color={Colors.text} />
        </TouchableOpacity>
        <Text style={st.headerTitle}>{t('subscribe.title')}</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: Spacing.xl, paddingBottom: 140 }} showsVerticalScrollIndicator={false}>
        {/* Service Hero */}
        <Animated.View entering={FadeIn.duration(300)} style={st.heroCard}>
          <View style={[st.heroIcon, { backgroundColor: accentDim }]}>
            <Ionicons name={icon as any} size={36} color={accent} />
          </View>
          <Text style={st.heroName}>{serviceName}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4, marginTop: 8 }}>
            <Text style={[st.heroPrice, { color: accent }]}>{price}</Text>
            <Text style={st.heroPriceUnit}>SOL/{frequency}</Text>
          </View>
        </Animated.View>

        {/* Duration (hidden in vault mode — vault is open-ended) */}
        {!useZkVault && (
          <Animated.View entering={FadeInDown.delay(80).duration(250)} style={{ marginTop: 24 }}>
            <Text style={st.sectionLabel}>{t('subscribe.duration')}</Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
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
                      sel && affordable && { backgroundColor: accent },
                      !affordable && { opacity: 0.35 },
                    ]}
                    activeOpacity={0.7}
                  >
                    <Text style={[st.durationNum, sel && affordable && { color: '#000' }]}>{m}</Text>
                    <Text style={[st.durationUnit, sel && affordable && { color: '#000' }]}>
                      {m === 1 ? t('subscribe.month') : t('subscribe.months')}
                    </Text>
                    {m > 1 && affordable && (
                      <View style={[st.saveBadge, sel && { backgroundColor: 'rgba(0,0,0,0.2)' }]}>
                        <Text style={[st.saveText, sel && { color: '#000' }]}>-10%</Text>
                      </View>
                    )}
                    {!affordable && (
                      <Text style={{ fontSize: 10, color: Colors.textTertiary, marginTop: 2 }}>
                        {(price * m).toFixed(2)} SOL needed
                      </Text>
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>
          </Animated.View>
        )}

        {/* Payment Method — 2 modes: Classique (wallet) vs Privé (ZK) */}
        <Animated.View entering={FadeInDown.delay(160).duration(250)} style={{ marginTop: 24 }}>
          <Text style={st.sectionLabel}>{t('subscribe.payWith')}</Text>
          <View style={{ gap: 8 }}>
            {/* Classique — direct wallet payment */}
            <TouchableOpacity
              onPress={() => { Haptics.selectionAsync(); setUiMode('classic'); }}
              style={[st.methodCard, uiMode === 'classic' && { backgroundColor: P01Colors.cyanDim }]}
              activeOpacity={0.7}
            >
              <Radio selected={uiMode === 'classic'} color={P01Colors.cyan} />
              <View style={[st.methodIcon, { backgroundColor: uiMode === 'classic' ? 'rgba(57,197,187,0.2)' : Colors.surfaceTertiary }]}>
                <Ionicons name="wallet" size={20} color={uiMode === 'classic' ? P01Colors.cyan : Colors.textSecondary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={st.methodTitle}>{t('subscribe.wallet')}</Text>
                <Text style={st.methodDesc}>{t('subscribe.directPayment')}</Text>
              </View>
            </TouchableOpacity>

            {/* Privé — auto-route to vault if supported, else oneshot */}
            {supportsPrivate && (
              <TouchableOpacity
                onPress={() => { Haptics.selectionAsync(); setUiMode('private'); }}
                style={[st.methodCard, uiMode === 'private' && { backgroundColor: P01Colors.pinkDim }]}
                activeOpacity={0.7}
              >
                <Radio selected={uiMode === 'private'} color={P01Colors.pink} />
                <View style={[st.methodIcon, { backgroundColor: uiMode === 'private' ? 'rgba(255,119,168,0.2)' : Colors.surfaceTertiary }]}>
                  <Ionicons name={supportsVault ? 'lock-closed' : 'eye-off'} size={20} color={uiMode === 'private' ? P01Colors.pink : Colors.textSecondary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={st.methodTitle}>Privé</Text>
                  <Text style={st.methodDesc}>
                    {supportsVault
                      ? `Vault privé — pull ${formatPriceSOL(priceLamports)} SOL every ${formatInterval(intervalSlotsBig)}. Pause/cancel any time, refund as shielded notes.`
                      : 'Paiement unique privé via note shielded. Pas de refund, repaye manuellement chaque période.'}
                  </Text>
                </View>
                <View style={[st.zkBadge, uiMode === 'private' && { backgroundColor: 'rgba(255,119,168,0.25)' }]}>
                  <Text style={[st.zkBadgeText, uiMode === 'private' && { color: P01Colors.pink }]}>{supportsVault ? 'VAULT' : 'ZK'}</Text>
                </View>
              </TouchableOpacity>
            )}
          </View>

          {/* ZK balance info (both zk-oneshot and zk-vault need a note ≥ price) */}
          {(useZkPool || useZkVault) && (
            <Animated.View entering={FadeIn.duration(200)} style={st.zkInfo}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <View>
                  <Text style={st.zkInfoLabel}>{t('streams.privateBalance')}</Text>
                  <Text style={st.zkInfoAmount}>{privateBalance.toFixed(privateBalance < 1 ? 4 : 2)} SOL</Text>
                </View>
                <Ionicons name={privateBalance >= price ? 'checkmark-circle' : 'alert-circle'}
                  size={22} color={privateBalance >= price ? P01Colors.green : Colors.error} />
              </View>
              {privateBalance < price && (
                <TouchableOpacity onPress={() => router.push('/(main)/(privacy)/denominated-shield' as any)}
                  style={st.shieldMoreBtn}>
                  <Text style={st.shieldMoreText}>{t('subscribe.shieldMoreSOL')}</Text>
                </TouchableOpacity>
              )}
            </Animated.View>
          )}

          {/* Note picker — only when Privé mode is selected and the user has
              ≥ 2 mature SOL notes that could fund the vault. Default = null
              (auto-pick smallest-mature ≥ rate). User can override here. */}
          {(useZkPool || useZkVault) && (() => {
            const matureForFunding = availableNotes
              .filter(n => n.token === 'SOL' && n.status === 'mature' && n.denomination >= price)
              .sort((a, b) => a.denomination - b.denomination);
            if (matureForFunding.length < 2) return null;
            return (
              <Animated.View entering={FadeIn.duration(200)} style={{ marginTop: 12 }}>
                <Text style={[st.zkInfoLabel, { marginBottom: 8 }]}>Note used to fund this subscription</Text>
                <View style={{ gap: 6 }}>
                  {matureForFunding.map(n => {
                    const sel = selectedNoteId === n.id;
                    const periodsCovered = price > 0 ? Math.floor(n.denomination / price) : 0;
                    return (
                      <TouchableOpacity
                        key={n.id}
                        onPress={() => { Haptics.selectionAsync(); setSelectedNoteId(sel ? null : n.id); }}
                        style={{
                          padding: 12,
                          borderRadius: BorderRadius.md,
                          backgroundColor: sel ? P01Colors.pinkDim : Colors.surfaceTertiary,
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 12,
                        }}
                        activeOpacity={0.7}
                      >
                        <Radio selected={sel} color={P01Colors.pink} />
                        <View style={{ flex: 1 }}>
                          <Text style={{ color: sel ? P01Colors.pink : Colors.text, fontWeight: '600', fontFamily: FontFamily.medium }}>
                            {n.denomination.toFixed(n.denomination < 1 ? 4 : 2)} SOL
                            {((n as any).poolVersion === 'v3') && (
                              <Text style={{ fontSize: 10, color: Colors.textTertiary }}>  V3</Text>
                            )}
                          </Text>
                          <Text style={{ fontSize: 11, color: Colors.textTertiary, marginTop: 2, fontFamily: FontFamily.regular }}>
                            {n.id.slice(0, 8)}…{n.id.slice(-4)}  ·  covers {periodsCovered} period{periodsCovered === 1 ? '' : 's'}
                          </Text>
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                <Text style={{ fontSize: 10, color: Colors.textTertiary, marginTop: 6, fontStyle: 'italic' }}>
                  Smallest auto-picked if none selected. Residual refunded as fresh notes if you cancel.
                </Text>
              </Animated.View>
            );
          })()}

          {/* Privacy toggle for normal wallet */}
          {paymentMode === 'wallet' && (
            <TouchableOpacity onPress={() => { Haptics.selectionAsync(); setEnablePrivacy(!enablePrivacy); }}
              style={[st.privacyToggle, enablePrivacy && { backgroundColor: P01Colors.cyanDim }]} activeOpacity={0.8}>
              <Ionicons name="shield-checkmark" size={18} color={enablePrivacy ? P01Colors.cyan : Colors.textSecondary} />
              <View style={{ flex: 1 }}>
                <Text style={st.methodTitle}>{t('subscribe.privacyShield')}</Text>
                <Text style={st.methodDesc}>{t('subscribe.noiseAndStealth')}</Text>
              </View>
              <View style={[st.switchTrack, enablePrivacy && { backgroundColor: P01Colors.cyan }]}>
                <View style={[st.switchThumb, enablePrivacy && { alignSelf: 'flex-end' }]} />
              </View>
            </TouchableOpacity>
          )}
        </Animated.View>

        {/* Summary */}
        <Animated.View entering={FadeInDown.delay(240).duration(250)} style={st.summaryCard}>
          {useZkVault ? (
            <>
              <View style={st.summaryRow}>
                <Text style={st.summaryLabel}>{serviceName} — recurring vault</Text>
                <Text style={st.summaryValue}>{price.toFixed(4)} SOL / {formatInterval(intervalSlotsBig)}</Text>
              </View>
              <View style={st.summaryDivider} />
              <View style={st.summaryRow}>
                <Text style={st.summaryTotal}>Initial deposit</Text>
                <Text style={[st.summaryTotal, { color: accent }]}>≥ {price.toFixed(4)} SOL</Text>
              </View>
            </>
          ) : (
            <>
              <View style={st.summaryRow}>
                <Text style={st.summaryLabel}>{serviceName} x {duration}mo</Text>
                <Text style={st.summaryValue}>{(price * duration).toFixed(4)} SOL</Text>
              </View>
              {discount && (
                <View style={st.summaryRow}>
                  <Text style={[st.summaryLabel, { color: P01Colors.green }]}>{t('subscribe.discount')}</Text>
                  <Text style={[st.summaryValue, { color: P01Colors.green }]}>-{(price * duration * 0.1).toFixed(4)}</Text>
                </View>
              )}
              <View style={st.summaryDivider} />
              <View style={st.summaryRow}>
                <Text style={st.summaryTotal}>{t('subscribe.firstPayment')}</Text>
                <Text style={[st.summaryTotal, { color: accent }]}>{price.toFixed(4)} SOL</Text>
              </View>
            </>
          )}
        </Animated.View>
      </ScrollView>

      {/* CTA */}
      <View style={[st.cta, { paddingBottom: insets.bottom + 90 }]}>
        <TouchableOpacity onPress={handleSubscribe}
          disabled={isSubscribing || ((useZkPool || useZkVault) && privateBalance < price)}
          style={[st.ctaBtn, { backgroundColor: isSubscribing ? Colors.surfaceTertiary : accent },
            ((useZkPool || useZkVault) && privateBalance < price) && { opacity: 0.4 }]}
          activeOpacity={0.8}>
          {isSubscribing ? (
            <View style={{ alignItems: 'center', gap: 4 }}>
              <ActivityIndicator size="small" color="#000" />
              {progress && <Text style={st.ctaProgress}>{progress}</Text>}
            </View>
          ) : (
            <>
              <Ionicons
                name={useZkVault ? 'lock-closed' : useZkPool ? 'eye-off' : 'checkmark-circle'}
                size={20}
                color="#000"
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
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl, paddingBottom: Spacing.md,
  },
  backBtn: {
    width: 40, height: 40, borderRadius: BorderRadius.full,
    backgroundColor: Colors.surfaceSecondary, alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: { fontSize: 18, fontFamily: FontFamily.semibold, color: Colors.text },

  // Hero
  heroCard: {
    alignItems: 'center', padding: 28,
    backgroundColor: Colors.surfaceSecondary, borderRadius: BorderRadius.xl,
  },
  heroIcon: {
    width: 72, height: 72, borderRadius: 18, alignItems: 'center', justifyContent: 'center', marginBottom: 16,
  },
  heroName: { fontSize: 22, fontFamily: FontFamily.bold, color: Colors.text },
  heroPrice: { fontSize: 32, fontFamily: FontFamily.bold },
  heroPriceUnit: { fontSize: 14, fontFamily: FontFamily.regular, color: Colors.textSecondary },

  // Section label
  sectionLabel: { fontSize: 14, fontFamily: FontFamily.semibold, color: Colors.text, marginBottom: 10 },

  // Duration
  durationBtn: {
    flex: 1, alignItems: 'center', padding: 14,
    backgroundColor: Colors.surfaceSecondary, borderRadius: BorderRadius.lg,
  },
  durationNum: { fontSize: 20, fontFamily: FontFamily.bold, color: Colors.text },
  durationUnit: { fontSize: 11, fontFamily: FontFamily.regular, color: Colors.textSecondary, marginTop: 2 },
  saveBadge: {
    marginTop: 6, paddingHorizontal: 6, paddingVertical: 2,
    backgroundColor: P01Colors.greenDim, borderRadius: 4,
  },
  saveText: { fontSize: 9, fontFamily: FontFamily.semibold, color: P01Colors.green },

  // Method cards
  methodCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 14, backgroundColor: Colors.surfaceSecondary, borderRadius: BorderRadius.lg,
  },
  methodIcon: {
    width: 40, height: 40, borderRadius: BorderRadius.sm, alignItems: 'center', justifyContent: 'center',
  },
  methodTitle: { fontSize: 14, fontFamily: FontFamily.semibold, color: Colors.text },
  methodDesc: { fontSize: 12, fontFamily: FontFamily.regular, color: Colors.textSecondary, marginTop: 1 },

  // Radio
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  radioDot: { width: 10, height: 10, borderRadius: 5 },

  // ZK badge
  zkBadge: { paddingHorizontal: 8, paddingVertical: 3, backgroundColor: Colors.surfaceTertiary, borderRadius: 6 },
  zkBadgeText: { fontSize: 10, fontFamily: FontFamily.bold, color: Colors.textTertiary },

  // ZK info
  zkInfo: {
    marginTop: 8, padding: 14,
    backgroundColor: 'rgba(255,119,168,0.06)', borderRadius: BorderRadius.md,
  },
  zkInfoLabel: { fontSize: 11, fontFamily: FontFamily.regular, color: Colors.textSecondary },
  zkInfoAmount: { fontSize: 18, fontFamily: FontFamily.bold, color: Colors.text, marginTop: 2 },
  shieldMoreBtn: {
    marginTop: 10, paddingVertical: 10, borderRadius: BorderRadius.sm,
    backgroundColor: P01Colors.pink, alignItems: 'center',
  },
  shieldMoreText: { fontSize: 12, fontFamily: FontFamily.semibold, color: '#000' },

  // Privacy toggle
  privacyToggle: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 14, marginTop: 8, backgroundColor: Colors.surfaceSecondary, borderRadius: BorderRadius.lg,
  },
  switchTrack: {
    width: 44, height: 26, borderRadius: 13,
    backgroundColor: Colors.surfaceTertiary, justifyContent: 'center', padding: 2,
  },
  switchThumb: { width: 22, height: 22, borderRadius: 11, backgroundColor: '#fff' },

  // Summary
  summaryCard: {
    marginTop: 24, padding: 16,
    backgroundColor: Colors.surfaceSecondary, borderRadius: BorderRadius.lg,
  },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  summaryLabel: { fontSize: 13, fontFamily: FontFamily.regular, color: Colors.textSecondary },
  summaryValue: { fontSize: 13, fontFamily: FontFamily.medium, color: Colors.text },
  summaryDivider: { height: 1, backgroundColor: Colors.surfaceTertiary, marginVertical: 8 },
  summaryTotal: { fontSize: 15, fontFamily: FontFamily.semibold, color: Colors.text },

  // CTA
  cta: { paddingHorizontal: Spacing.xl, paddingTop: Spacing.md, backgroundColor: Colors.background },
  ctaBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 16, borderRadius: BorderRadius.lg,
  },
  ctaText: { fontSize: 16, fontFamily: FontFamily.bold, color: '#000' },
  ctaProgress: { fontSize: 11, fontFamily: FontFamily.medium, color: '#000', opacity: 0.7 },
});

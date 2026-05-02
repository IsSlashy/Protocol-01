import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Switch } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { PublicKey, Transaction, SystemProgram, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';
import { CreateStreamForm, StreamFormData } from '../../../components/streams';
import { useStreamStore } from '../../../stores/streamStore';
import { useWalletStore, getPrivySigner } from '../../../stores/walletStore';
import { StreamFrequency, updateStream as updateStreamRecord } from '../../../services/solana/streams';
import { getConnection } from '../../../services/solana/connection';
import { getKeypair } from '../../../services/solana/wallet';
import { sendSolWithSigner } from '../../../services/solana/transactions';
import { p01Alert } from '@/stores/alertStore';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import { useT } from '@/i18n';

// SPL Memo program v2 — used to tag the first payment with a P01_SUB_V1 memo
// so onchainSync.fetchSubscriptionsFromChain can reconstruct the Stream on
// reinstall / cross-device boot.
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
function buildMemoIx(memo: string): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [],
    data: Buffer.from(memo, 'utf-8'),
  });
}

// Number of Solana slots per "billing period" given the canonical 0.4 s/slot.
// Mirrors the values used by services/solana/subscriptionContract.ts so a
// stream created here lines up with merchant subscriptions on the same chain.
// `custom` falls back to monthly because the form does not surface a custom
// interval input today; it can be extended when CreateStreamForm exposes one.
const SLOTS_PER_PERIOD: Record<StreamFrequency, bigint> = {
  daily:    216_000n,
  weekly:   1_512_000n,
  biweekly: 3_024_000n,
  monthly:  6_480_000n,
  yearly:   78_840_000n,
  custom:   6_480_000n,
};

export default function CreatePersonalStreamScreen() {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { createNewStream, loading } = useStreamStore();
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Off by default — opting in routes through subscribe-private.tsx where
  // the STARK proof + denominated note selection happen.
  const [isPrivate, setIsPrivate] = useState(false);

  const handleCreateStream = async (data: StreamFormData) => {
    try {
      setIsSubmitting(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      try { new PublicKey(data.recipient); } catch {
        p01Alert(t('createStream.invalidAddressShort'), t('alerts.invalidAddress'));
        setIsSubmitting(false); return;
      }

      // Private path — hand off to the existing private-subscription screen
      // (it already does note selection, STARK proof generation, vault open).
      // The vault contract treats every retailer pubkey identically, so a
      // P2P recipient (employee, friend) flows through the same on-chain
      // path as a merchant subscription.
      //
      // Per-payment rate is intentionally NOT pre-filled: it is derived
      // from the denominated note the user picks on the next screen, so
      // collecting a "total amount" here would be misleading. We only
      // pass the recipient + the period cadence (intervalSlots).
      if (isPrivate) {
        const intervalSlots = SLOTS_PER_PERIOD[data.frequency];
        router.push({
          pathname: '/(main)/(privacy)/subscribe-private',
          params: {
            retailer: data.recipient,
            intervalSlots: intervalSlots.toString(),
            mode: 'stream-p2p',
          },
        });
        setIsSubmitting(false);
        return;
      }

      const now = Date.now();
      const endDate = now + data.duration * 86_400_000;
      const frequency: StreamFrequency = data.frequency;

      // Fire the first payment IMMEDIATELY to match subscribe.tsx semantics:
      // creating a recurring payment is a "subscribe = pay first now" action,
      // not a pure scheduler. createStream() alone would leave nextPaymentDate
      // at +intervalMs (24h for daily) with no tx, which is misleading UX.
      //
      // We compute amountPerPayment client-side using the same math as
      // streams.ts:createStream so the local record matches what fires now.
      const intervalMsByFreq: Record<StreamFrequency, number> = {
        daily: 86_400_000,
        weekly: 7 * 86_400_000,
        biweekly: 14 * 86_400_000,
        monthly: 30 * 86_400_000,
        yearly: 365 * 86_400_000,
        custom: 30 * 86_400_000,
      };
      const intervalMs = intervalMsByFreq[frequency];
      const totalPayments = Math.max(Math.ceil((endDate - now) / intervalMs), 1);
      const amountPerPayment = Math.round((data.amount / totalPayments) * 1_000_000) / 1_000_000;

      const recipientPk = new PublicKey(data.recipient);
      const lamports = Math.round(amountPerPayment * 1e9);

      // Pre-generate the streamId so we can stamp it into the on-chain memo.
      // Format matches services/solana/streams.ts:generateId — required for
      // syncFromBlockchain to dedupe properly.
      const streamId = `stream_${now}_${Math.random().toString(36).slice(2, 11)}`;
      const freqCode: 'd' | 'w' | 'm' | 'y' = frequency === 'daily' ? 'd'
        : frequency === 'weekly' ? 'w'
        : frequency === 'yearly' ? 'y' : 'm';
      // P01_SUB_V1 compact JSON — matches OnChainSubscription in onchainSync.ts.
      // Without this memo, syncFromBlockchain cannot reconstruct the stream
      // after a wipe → subscription disappears.
      const subMemoPayload = {
        v: 1,
        id: streamId,
        n: (data.name || `P2P ${data.recipient.slice(0, 6)}`).slice(0, 32),
        r: data.recipient,
        a: lamports,
        i: freqCode,
        s: 'a',
        // Next payment is one interval AFTER the first (which is paid now).
        np: Math.floor((now + intervalMs) / 1000),
        mp: Math.max(Math.floor((endDate - now) / 86_400_000), 0),
        // pm: 1 because the first payment is paid in the same flow as this memo.
        // onchainSync.convertToStream uses sub.pm directly as paymentsCompleted,
        // so pm:0 would show "0/N completed" even though we just paid one.
        pm: 1,
        c: Math.floor(now / 1000),
      };
      const recoveryMemo = `P01_SUB_V1:${JSON.stringify(subMemoPayload)}`;

      // 1. Send first payment on-chain (Privy or local keypair fallback).
      // Memo is added to the same tx for local keypair, or a follow-up
      // memo-only tx for Privy (since sendSolWithSigner doesn't expose a
      // memo hook).
      const walletPub = useWalletStore.getState().publicKey;
      const isPrivy = useWalletStore.getState().isPrivyWallet;
      const privySigner = isPrivy ? getPrivySigner() : null;
      let sig: string;
      if (privySigner && walletPub) {
        const r = await sendSolWithSigner(data.recipient, amountPerPayment, new PublicKey(walletPub), privySigner);
        if (!r.success || !r.signature) throw new Error(r.error || 'First payment failed');
        sig = r.signature;
        // Follow-up memo-only tx so the recovery scanner can find this stream.
        try {
          const conn = getConnection();
          const memoTx = new Transaction().add(buildMemoIx(recoveryMemo));
          memoTx.feePayer = new PublicKey(walletPub);
          const { blockhash } = await conn.getLatestBlockhash('confirmed');
          memoTx.recentBlockhash = blockhash;
          const signed = await privySigner(memoTx);
          await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
        } catch (memoErr) {
          // Non-fatal: the SOL transfer happened, we just lose recovery for this stream.
          console.warn('[create.tsx] follow-up memo tx failed (recovery may not work):', memoErr);
        }
      } else {
        const kp = await getKeypair();
        if (!kp) throw new Error('Wallet not available');
        const conn = getConnection();
        const tx = new Transaction().add(
          SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: recipientPk, lamports }),
          buildMemoIx(recoveryMemo),
        );
        sig = await sendAndConfirmTransaction(conn, tx, [kp], { commitment: 'confirmed' });
      }

      // 2. Create stream record (local) AFTER tx confirms — no orphan if tx fails.
      // Pass the pre-generated streamId so it matches the on-chain memo.
      const stream = await createNewStream({
        id: streamId,
        name: data.name || `Payment to ${data.recipient.slice(0, 8)}...`,
        recipientAddress: data.recipient,
        totalAmount: data.amount,
        frequency,
        endDate,
      });

      // 3. Backfill the first payment in stream history so the UI shows it.
      await updateStreamRecord(stream.id, {
        amountStreamed: amountPerPayment,
        paymentsCompleted: 1,
        paymentHistory: [{
          id: `pay-${stream.id}-0`,
          amount: amountPerPayment,
          actualAmount: amountPerPayment,
          signature: sig,
          timestamp: now,
          status: 'success',
        }],
      });

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      p01Alert(t('createStream.streamCreated'),
        `${amountPerPayment} SOL sent. Tx: ${sig.slice(0, 8)}...`,
        [{ text: t('createStream.viewStream'), onPress: () => router.replace(`/(main)/(streams)/${stream.id}`) },
         { text: t('common.done'), onPress: () => router.back() }]);
    } catch (e: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      p01Alert(t('common.error'), e.message || t('alerts.errorGeneric'));
    } finally { setIsSubmitting(false); }
  };

  return (
    <View style={st.container}>
      <View style={[st.header, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity onPress={() => router.back()} style={st.backBtn}>
          <Ionicons name="close" size={22} color={Colors.text} />
        </TouchableOpacity>
        <View style={{ alignItems: 'center' }}>
          <Text style={st.headerTitle}>{t('createStream.title')}</Text>
          <Text style={st.headerSub}>{t('createStream.subtitle')}</Text>
        </View>
        <View style={{ width: 40 }} />
      </View>

      <View style={{ flex: 1, paddingHorizontal: Spacing.xl, paddingTop: 8 }}>
        <View style={st.privacyRow}>
          <View style={st.privacyIconBubble}>
            <Ionicons name="shield-checkmark" size={18} color={isPrivate ? P01Colors.cyan : Colors.textTertiary} />
          </View>
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={st.privacyTitle}>Private mode</Text>
            <Text style={st.privacySub}>
              {isPrivate
                ? 'Funded from a shielded note. STARK proof breaks the on-chain link to your wallet.'
                : 'Public stream. Recipient and amount visible on chain.'}
            </Text>
          </View>
          <Switch
            value={isPrivate}
            onValueChange={(v) => { Haptics.selectionAsync(); setIsPrivate(v); }}
            trackColor={{ false: Colors.surfaceSecondary, true: P01Colors.cyan }}
            thumbColor={isPrivate ? '#fff' : Colors.textTertiary}
          />
        </View>

        <CreateStreamForm
          onSubmit={handleCreateStream}
          loading={loading || isSubmitting}
          accentColor={isPrivate ? P01Colors.pink : P01Colors.cyan}
          submitLabel={isPrivate ? 'Continue privately' : t('createStream.createStream')}
          hideServiceSelector
          hideAmount={isPrivate}
        />
      </View>
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
  headerSub: { fontSize: 12, fontFamily: FontFamily.regular, color: P01Colors.cyan, marginTop: 2 },
  privacyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.lg,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: Spacing.md,
  },
  privacyIconBubble: {
    width: 36,
    height: 36,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  privacyTitle: { fontSize: 14, fontFamily: FontFamily.semibold, color: Colors.text },
  privacySub: { fontSize: 11, fontFamily: FontFamily.regular, color: Colors.textSecondary, marginTop: 2, lineHeight: 15 },
});

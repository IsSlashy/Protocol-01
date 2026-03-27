import React, { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator, Linking, StyleSheet,
} from 'react-native';
import { PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction } from '@solana/web3.js';
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
import { useWalletStore, getPrivySigner } from '../../../stores/walletStore';
import { sendSolWithSigner } from '../../../services/solana/transactions';
import {
  DenominatedPoolProverProvider, useDenominatedPoolProver,
} from '../../../components/privacy/DenominatedPoolProver';
import { getServiceById, CATEGORY_CONFIG, ServiceCategory } from '../../../services/subscriptions/serviceRegistry';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import { useT } from '@/i18n';

export default function StreamDetailScreen() {
  return <DenominatedPoolProverProvider><DetailContent /></DenominatedPoolProverProvider>;
}

function DetailContent() {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { streams, processingPayment, refresh, pauseStream, resumeStream, cancelStream, deleteStream } = useStreamStore();
  const { generateProof } = useDenominatedPoolProver();
  const { publicKey, isPrivyWallet } = useWalletStore();

  const [stream, setStream] = useState<Stream | null>(null);
  const [copied, setCopied] = useState(false);
  const [paying, setPaying] = useState(false);
  const [payProgress, setPayProgress] = useState<string | null>(null);

  useEffect(() => { setStream(streams.find(s => s.id === id) || null); }, [streams, id]);

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

  const handlePauseResume = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    stream.status === 'active' ? await pauseStream(stream.id) : await resumeStream(stream.id);
    await refresh();
  };

  const handleCancel = () => {
    p01Alert(t('streams.cancelStream'), t('streams.cancelStreamConfirm', { name: stream.name }),
      [{ text: t('streams.cancelStream'), style: 'destructive', onPress: async () => {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        await cancelStream(stream.id); await deleteStream(stream.id); router.back();
      }}, { text: t('streams.keepStream'), style: 'cancel' }], 'warning');
  };

  const handlePayNow = async () => {
    const intervalMs = stream.frequency === 'daily' ? 86_400_000 : stream.frequency === 'weekly' ? 604_800_000
      : stream.frequency === 'biweekly' ? 1_209_600_000 : 2_592_000_000;

    const doPayment = async () => {
      try {
        setPaying(true);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
        let sig: string; let paid = stream.amountPerPayment;

        if (stream.useZkPool) {
          setPayProgress(t('shieldUnshield.generatingProof'));
          const store = useDenominatedPoolStore.getState();
          const note = store.getActiveNotes()
            .filter((n: any) => n.token === 'SOL' && n.status === 'mature')
            .sort((a: any, b: any) => a.denomination - b.denomination)
            .find((n: any) => n.denomination >= stream.amountPerPayment);
          if (!note) throw new Error('No mature note large enough.');
          sig = await store.unshieldNote(note.id, stream.recipientAddress, generateProof);
          paid = note.denomination;
        } else {
          setPayProgress(t('shieldUnshield.sendingTransaction'));
          const signer = getPrivySigner();
          if (isPrivyWallet && signer && publicKey) {
            const r = await sendSolWithSigner(stream.recipientAddress, stream.amountPerPayment, new PublicKey(publicKey), signer);
            if (!r.success || !r.signature) throw new Error(r.error || 'Failed');
            sig = r.signature;
          } else {
            const kp = await getKeypair(); if (!kp) throw new Error('Wallet not found');
            const tx = new Transaction().add(SystemProgram.transfer({
              fromPubkey: kp.publicKey, toPubkey: new PublicKey(stream.recipientAddress),
              lamports: Math.round(stream.amountPerPayment * 1e9),
            }));
            sig = await sendAndConfirmTransaction(getConnection(), tx, [kp], { commitment: 'confirmed' });
          }
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

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: Spacing.xl, paddingBottom: 120 }} showsVerticalScrollIndicator={false}>
        {/* Status pill */}
        <Animated.View entering={FadeIn.duration(250)} style={{ alignItems: 'center', marginBottom: 20 }}>
          <View style={[st.statusPill, { backgroundColor: `${statusColor}20` }]}>
            <View style={[st.statusDot, { backgroundColor: statusColor }]} />
            <Text style={[st.statusText, { color: statusColor }]}>{stream.status.toUpperCase()}</Text>
          </View>
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
            <TouchableOpacity onPress={handleCancel}
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

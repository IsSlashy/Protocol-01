import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, ActivityIndicator, StyleSheet,
} from 'react-native';
import { p01Alert } from '../../../stores/alertStore';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction } from '@solana/web3.js';
import { useStreamStore } from '../../../stores/streamStore';
import { useWalletStore, getPrivySigner } from '../../../stores/walletStore';
import { useDenominatedPoolStore } from '../../../stores/denominatedPoolStore';
import { StreamFrequency, updateStream as updateStreamRecord } from '../../../services/solana/streams';
import { getConnection } from '../../../services/solana/connection';
import { getKeypair } from '../../../services/solana/wallet';
import { sendSolWithSigner, sendSolPrivate } from '../../../services/solana/transactions';
import { deriveStealthAddressSimple } from '../../../utils/crypto/stealth';
import {
  DenominatedPoolProverProvider,
  useDenominatedPoolProver,
} from '../../../components/privacy/DenominatedPoolProver';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import { useT } from '@/i18n';

const SERVICE_ICONS: Record<string, string> = {
  netflix: 'play-circle', spotify: 'musical-notes', chatgpt: 'chatbubbles',
  github: 'logo-github', figma: 'color-palette', notion: 'document-text',
};

export default function SubscribeScreen() {
  return (
    <DenominatedPoolProverProvider>
      <SubscribeContent />
    </DenominatedPoolProverProvider>
  );
}

function SubscribeContent() {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    serviceId: string; serviceName: string; price: string; frequency: string;
  }>();

  const { createNewStream, refresh } = useStreamStore();
  const { publicKey, isPrivyWallet } = useWalletStore();
  const { notes: denomNotes } = useDenominatedPoolStore();
  const { generateProof } = useDenominatedPoolProver();

  const availableNotes = denomNotes.filter(n => n.status === 'mature' || n.status === 'pending');
  const privateBalance = availableNotes.reduce((sum, n) => sum + n.denomination, 0);

  const [isSubscribing, setIsSubscribing] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [enablePrivacy, setEnablePrivacy] = useState(false);
  const [useZkPool, setUseZkPool] = useState(false);
  const [duration, setDuration] = useState<1 | 6 | 12>(1);

  const serviceName = params.serviceName || 'Service';
  const serviceId = params.serviceId || '';
  const price = parseFloat(params.price || '0');
  const frequency = (params.frequency || 'monthly') as StreamFrequency;
  const icon = SERVICE_ICONS[serviceId] || 'cube';
  const totalPrice = price * duration;
  const discount = duration > 1;

  const handleSubscribe = async () => {
    if (!publicKey) return p01Alert(t('alerts.walletRequired'), t('alerts.walletRequiredDesc'), undefined, 'warning');
    try {
      setIsSubscribing(true); setProgress(null);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      const now = Date.now();
      const endDate = now + duration * 30 * 86_400_000;
      const devAddr = 'GJyrdH4xBKjQiWspGUqfwHR1Mqn2pgXMxpXsE3M2aGS6';
      let sig: string; let paid = price;

      if (useZkPool) {
        setProgress(t('common.loading'));
        const store = useDenominatedPoolStore.getState();
        const note = store.getActiveNotes()
          .filter(n => n.token === 'SOL' && n.status === 'mature')
          .sort((a, b) => a.denomination - b.denomination)
          .find(n => n.denomination >= price);
        if (!note) throw new Error(t('subscribe.noMatureNote'));
        setProgress(t('shieldUnshield.generatingProof'));
        sig = await store.unshieldNote(note.id, devAddr, generateProof);
        paid = note.denomination;
      } else if (enablePrivacy) {
        // Privacy Shield: stealth recipient + ephemeral feePayer via relay
        setProgress(t('shieldUnshield.sendingTransaction'));
        const privySigner = getPrivySigner();
        const kp = await getKeypair();

        // Derive stealth address for initial payment (nonce=0)
        // Use stealth spending seed (available for all wallet types including Privy)
        const { getOrCreateStealthKeys } = await import('../../../services/stealth/keys');
        const stealthKeys = await getOrCreateStealthKeys();
        const senderSecret = stealthKeys.spendingKey.secretKey.slice(0, 32);
        const { stealthAddress } = deriveStealthAddressSimple(devAddr, senderSecret, 0);

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
        setProgress(t('shieldUnshield.sendingTransaction'));
        const privySigner = getPrivySigner();
        if (isPrivyWallet && privySigner && publicKey) {
          const r = await sendSolWithSigner(devAddr, price, new PublicKey(publicKey), privySigner);
          if (!r.success || !r.signature) throw new Error(r.error || 'Transaction failed');
          sig = r.signature;
        } else {
          const kp = await getKeypair();
          if (!kp) throw new Error('Wallet keypair not found');
          const conn = getConnection();
          const tx = new Transaction().add(SystemProgram.transfer({
            fromPubkey: kp.publicKey, toPubkey: new PublicKey(devAddr),
            lamports: Math.round(price * 1e9),
          }));
          sig = await sendAndConfirmTransaction(conn, tx, [kp], { commitment: 'confirmed' });
        }
      }

      setProgress(t('common.processing'));
      const stream = await createNewStream({
        name: serviceName, recipientAddress: devAddr, totalAmount: totalPrice,
        frequency, endDate, serviceId, serviceName,
        amountNoise: enablePrivacy ? 10 : 0, timingNoise: enablePrivacy ? 4 : 0,
        useStealthAddress: enablePrivacy, useZkPool,
      });
      await updateStreamRecord(stream.id, {
        amountStreamed: paid, paymentsCompleted: 1,
        paymentHistory: [{ id: `pay-${stream.id}-0`, amount: paid, actualAmount: paid, signature: sig, timestamp: now, status: 'success' }],
      });
      refresh(publicKey || undefined).catch(() => {});
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      p01Alert(useZkPool ? t('subscribe.privatelySubscribed') : t('subscribe.subscribed'),
        `${paid} SOL confirmed. Tx: ${sig.slice(0, 8)}...`,
        [{ text: t('createStream.viewStream'), onPress: () => router.replace(`/(main)/(streams)/${stream.id}`) },
         { text: t('common.done'), style: 'cancel', onPress: () => router.replace('/(main)/(streams)') }],
        'success');
    } catch (e: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      p01Alert(t('common.error'), e.message || t('alerts.subscriptionFailed'), undefined, 'error');
    } finally { setIsSubscribing(false); setProgress(null); }
  };

  const accent = useZkPool ? P01Colors.pink : P01Colors.cyan;
  const accentDim = useZkPool ? P01Colors.pinkDim : P01Colors.cyanDim;

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

        {/* Duration */}
        <Animated.View entering={FadeInDown.delay(80).duration(250)} style={{ marginTop: 24 }}>
          <Text style={st.sectionLabel}>{t('subscribe.duration')}</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {([1, 6, 12] as const).map(m => {
              const sel = duration === m;
              return (
                <TouchableOpacity key={m} onPress={() => { Haptics.selectionAsync(); setDuration(m); }}
                  style={[st.durationBtn, sel && { backgroundColor: accent }]} activeOpacity={0.7}>
                  <Text style={[st.durationNum, sel && { color: '#000' }]}>{m}</Text>
                  <Text style={[st.durationUnit, sel && { color: '#000' }]}>{m === 1 ? t('subscribe.month') : t('subscribe.months')}</Text>
                  {m > 1 && (
                    <View style={[st.saveBadge, sel && { backgroundColor: 'rgba(0,0,0,0.2)' }]}>
                      <Text style={[st.saveText, sel && { color: '#000' }]}>-10%</Text>
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        </Animated.View>

        {/* Payment Method */}
        <Animated.View entering={FadeInDown.delay(160).duration(250)} style={{ marginTop: 24 }}>
          <Text style={st.sectionLabel}>{t('subscribe.payWith')}</Text>
          <View style={{ gap: 8 }}>
            {/* Wallet */}
            <TouchableOpacity onPress={() => { Haptics.selectionAsync(); setUseZkPool(false); }}
              style={[st.methodCard, !useZkPool && { backgroundColor: P01Colors.cyanDim }]} activeOpacity={0.7}>
              <Radio selected={!useZkPool} color={P01Colors.cyan} />
              <View style={[st.methodIcon, { backgroundColor: !useZkPool ? 'rgba(57,197,187,0.2)' : Colors.surfaceTertiary }]}>
                <Ionicons name="wallet" size={20} color={!useZkPool ? P01Colors.cyan : Colors.textSecondary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={st.methodTitle}>{t('subscribe.wallet')}</Text>
                <Text style={st.methodDesc}>{t('subscribe.directPayment')}</Text>
              </View>
            </TouchableOpacity>

            {/* ZK Private */}
            <TouchableOpacity onPress={() => { Haptics.selectionAsync(); setUseZkPool(true); setEnablePrivacy(true); }}
              style={[st.methodCard, useZkPool && { backgroundColor: P01Colors.pinkDim }]} activeOpacity={0.7}>
              <Radio selected={useZkPool} color={P01Colors.pink} />
              <View style={[st.methodIcon, { backgroundColor: useZkPool ? 'rgba(255,119,168,0.2)' : Colors.surfaceTertiary }]}>
                <Ionicons name="eye-off" size={20} color={useZkPool ? P01Colors.pink : Colors.textSecondary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={st.methodTitle}>{t('subscribe.privateWallet')}</Text>
                <Text style={st.methodDesc}>{t('subscribe.anonymousViaZK')}</Text>
              </View>
              <View style={[st.zkBadge, useZkPool && { backgroundColor: 'rgba(255,119,168,0.25)' }]}>
                <Text style={[st.zkBadgeText, useZkPool && { color: P01Colors.pink }]}>ZK</Text>
              </View>
            </TouchableOpacity>
          </View>

          {/* ZK balance info */}
          {useZkPool && (
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

          {/* Privacy toggle for normal wallet */}
          {!useZkPool && (
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
        </Animated.View>
      </ScrollView>

      {/* CTA */}
      <View style={[st.cta, { paddingBottom: insets.bottom + 90 }]}>
        <TouchableOpacity onPress={handleSubscribe}
          disabled={isSubscribing || (useZkPool && privateBalance < price)}
          style={[st.ctaBtn, { backgroundColor: isSubscribing ? Colors.surfaceTertiary : accent },
            (useZkPool && privateBalance < price) && { opacity: 0.4 }]}
          activeOpacity={0.8}>
          {isSubscribing ? (
            <View style={{ alignItems: 'center', gap: 4 }}>
              <ActivityIndicator size="small" color="#000" />
              {progress && <Text style={st.ctaProgress}>{progress}</Text>}
            </View>
          ) : (
            <>
              <Ionicons name={useZkPool ? 'eye-off' : 'checkmark-circle'} size={20} color="#000" />
              <Text style={st.ctaText}>{useZkPool ? t('subscribe.subscribePrivately') : t('subscribe.subscribe')}</Text>
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

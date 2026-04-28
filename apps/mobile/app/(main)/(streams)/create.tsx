import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Switch } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { PublicKey } from '@solana/web3.js';
import { CreateStreamForm, StreamFormData } from '../../../components/streams';
import { useStreamStore } from '../../../stores/streamStore';
import { StreamFrequency } from '../../../services/solana/streams';
import { p01Alert } from '@/stores/alertStore';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import { useT } from '@/i18n';

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

      const stream = await createNewStream({
        name: data.name || `Payment to ${data.recipient.slice(0, 8)}...`,
        recipientAddress: data.recipient,
        totalAmount: data.amount,
        frequency,
        endDate,
      });

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      p01Alert(t('createStream.streamCreated'),
        t('createStream.streamCreatedDesc', { amount: data.amount, token: data.token }),
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

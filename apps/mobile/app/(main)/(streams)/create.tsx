import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
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

export default function CreatePersonalStreamScreen() {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { createNewStream, loading } = useStreamStore();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleCreateStream = async (data: StreamFormData) => {
    try {
      setIsSubmitting(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      try { new PublicKey(data.recipient); } catch {
        p01Alert(t('createStream.invalidAddressShort'), t('alerts.invalidAddress'));
        setIsSubmitting(false); return;
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
        <CreateStreamForm
          onSubmit={handleCreateStream}
          loading={loading || isSubmitting}
          accentColor={P01Colors.cyan}
          submitLabel={t('createStream.createStream')}
          hideServiceSelector
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
});

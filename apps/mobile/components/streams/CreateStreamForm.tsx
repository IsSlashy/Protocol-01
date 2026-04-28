import React, { useState, useMemo, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, TextInput, StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ServiceSelector, ServiceLogo } from './ServiceSelector';
import { ServiceInfo, detectServiceFromName, CATEGORY_CONFIG } from '../../services/subscriptions/serviceRegistry';
import { useWalletStore } from '@/stores/walletStore';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import { useT } from '@/i18n';

interface CreateStreamFormProps {
  balance?: number;
  symbol?: string;
  onCreateStream?: (data: { recipient: string; amount: number; startDate: Date; endDate: Date }) => void;
  onSubmit?: (data: StreamFormData) => void;
  onSelectContact?: () => void;
  loading?: boolean;
  accentColor?: string;
  submitLabel?: string;
  hideServiceSelector?: boolean;
  // In private mode the per-payment rate comes from the denominated note
  // selected on the next screen, so the total-amount input is irrelevant
  // here. Hiding it also drops the matching validation + preview row.
  hideAmount?: boolean;
}

export type PaymentFrequency = 'daily' | 'weekly' | 'biweekly' | 'monthly';

export interface StreamFormData {
  recipient: string;
  name: string;
  token: string;
  amount: number;
  duration: number;
  frequency: PaymentFrequency;
  isPrivate: boolean;
  serviceId?: string;
  serviceName?: string;
  serviceCategory?: string;
  serviceColor?: string;
}

const getDurations = (t: (k: string) => string) => [
  { label: '7d', value: 7 },
  { label: '30d', value: 30 },
  { label: '90d', value: 90 },
  { label: t('createStream.custom'), value: -1 },
];

const getFrequencies = (t: (k: string) => string): { label: string; value: PaymentFrequency }[] => [
  { label: t('createStream.daily'), value: 'daily' },
  { label: t('createStream.weekly'), value: 'weekly' },
  { label: t('createStream.biweekly'), value: 'biweekly' },
  { label: t('createStream.monthly'), value: 'monthly' },
];

export const CreateStreamForm: React.FC<CreateStreamFormProps> = ({
  balance, symbol, onCreateStream, onSubmit, onSelectContact,
  loading = false, accentColor = P01Colors.cyan, submitLabel,
  hideServiceSelector = false, hideAmount = false,
}) => {
  const t = useT();
  const walletBalance = useWalletStore(s => s.balance);
  const solBalance = walletBalance?.sol ?? 0;

  const [recipient, setRecipient] = useState('');
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [selectedDuration, setSelectedDuration] = useState(30);
  const [customDuration, setCustomDuration] = useState('');
  const [frequency, setFrequency] = useState<PaymentFrequency>('monthly');
  const [isPrivate, setIsPrivate] = useState(true);
  const [errors, setErrors] = useState<{ recipient?: string; amount?: string }>({});
  const [selectedService, setSelectedService] = useState<ServiceInfo | null>(null);
  const [autoDetected, setAutoDetected] = useState<ServiceInfo | null>(null);

  useEffect(() => {
    if (!hideServiceSelector && name.length >= 3 && !selectedService) {
      setAutoDetected(detectServiceFromName(name, 0.7));
    } else setAutoDetected(null);
  }, [name, selectedService, hideServiceSelector]);

  const activeService = selectedService || autoDetected;
  const dur = selectedDuration === -1 ? Number(customDuration) || 0 : selectedDuration;
  const amt = Number(amount) || 0;
  const bal = balance || solBalance;
  const tok = symbol || 'SOL';
  const isValid = recipient && (hideAmount || amt > 0) && dur > 0;

  const preview = useMemo(() => {
    if (!dur) return null;
    if (!hideAmount && !amt) return null;
    const end = new Date(); end.setDate(end.getDate() + dur);
    return { rate: hideAmount ? 0 : amt / dur, endDate: end };
  }, [amt, dur, hideAmount]);

  const validate = (): boolean => {
    const e: typeof errors = {};
    if (!recipient.trim()) e.recipient = t('createStream.required');
    else if (recipient.length < 20) e.recipient = t('createStream.invalidAddressShort');
    if (!hideAmount) {
      if (!amount || amt <= 0) e.amount = t('createStream.mustBePositive');
      else if (amt > bal) e.amount = t('common.insufficient');
    }
    setErrors(e); return !Object.keys(e).length;
  };

  const handleSubmit = () => {
    if (!validate()) return;
    const streamName = activeService?.name || name || `Stream to ${recipient.slice(0, 8)}...`;
    onSubmit?.({
      recipient, name: streamName, token: tok, amount: amt, duration: dur,
      frequency, isPrivate, serviceId: activeService?.id, serviceName: activeService?.name,
      serviceCategory: activeService?.category, serviceColor: activeService?.color,
    });
    if (onCreateStream && preview) {
      onCreateStream({ recipient, amount: amt, startDate: new Date(), endDate: preview.endDate });
    }
  };

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 120 }}
      showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="always"
      keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets>

      {/* Recipient */}
      <View style={st.section}>
        <Text style={st.label}>{t('createStream.recipientAddress')}</Text>
        <View style={st.inputWrap}>
          <Ionicons name="wallet-outline" size={18} color={Colors.textSecondary} />
          <TextInput style={st.input} placeholder={t('createStream.enterWalletAddress')}
            placeholderTextColor={Colors.textTertiary} value={recipient}
            onChangeText={setRecipient} autoCapitalize="none" autoCorrect={false} />
        </View>
        {errors.recipient && <Text style={st.error}>{errors.recipient}</Text>}
      </View>

      {/* Service selector */}
      {!hideServiceSelector && (
        <View style={st.section}>
          <Text style={st.label}>Service (Optional)</Text>
          <ServiceSelector selectedService={selectedService}
            onSelectService={s => { setSelectedService(s); if (s) setName(s.name); }}
            placeholder="Select a known service..." />
        </View>
      )}

      {/* Name */}
      <View style={st.section}>
        <Text style={st.label}>{t('createStream.paymentName')}</Text>
        <View style={st.inputWrap}>
          <Ionicons name="pricetag-outline" size={18} color={Colors.textSecondary} />
          <TextInput style={st.input}
            placeholder={t('createStream.namePlaceholder')}
            placeholderTextColor={Colors.textTertiary} value={name}
            onChangeText={setName} editable={!selectedService} />
        </View>
      </View>

      {/* Amount — hidden in private mode (rate is derived from the
          denominated note picked on the subscribe-private screen). */}
      {!hideAmount && (
        <View style={st.section}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
            <Text style={st.label}>{t('createStream.totalAmount')}</Text>
            <Text style={st.dimLabel}>{t('common.balance')}: {bal.toFixed(4)} {tok}</Text>
          </View>
          <View style={st.inputWrap}>
            <TextInput style={st.input} placeholder="0.00"
              placeholderTextColor={Colors.textTertiary} value={amount}
              onChangeText={v => setAmount(v.replace(/[^0-9.]/g, ''))}
              keyboardType="decimal-pad" />
            <Text style={st.dimLabel}>{tok}</Text>
          </View>
          {errors.amount && <Text style={st.error}>{errors.amount}</Text>}
        </View>
      )}

      {/* Duration */}
      <View style={st.section}>
        <Text style={st.label}>{t('createStream.durationLabel')}</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {getDurations(t).map(d => {
            const sel = selectedDuration === d.value;
            return (
              <TouchableOpacity key={d.value} onPress={() => setSelectedDuration(d.value)}
                style={[st.chip, sel && { backgroundColor: `${accentColor}30`, borderColor: `${accentColor}80` }]}>
                <Text style={[st.chipText, sel && { color: accentColor }]} numberOfLines={1}>{d.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        {selectedDuration === -1 && (
          <View style={[st.inputWrap, { marginTop: 8 }]}>
            <TextInput style={st.input} placeholder={t('createStream.enterDays')}
              placeholderTextColor={Colors.textTertiary} value={customDuration}
              onChangeText={setCustomDuration} keyboardType="number-pad" />
          </View>
        )}
      </View>

      {/* Frequency */}
      <View style={st.section}>
        <Text style={st.label}>{t('createStream.paymentFrequency')}</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {getFrequencies(t).map(f => {
            const sel = frequency === f.value;
            return (
              <TouchableOpacity key={f.value} onPress={() => setFrequency(f.value)}
                style={[st.chip, sel && { backgroundColor: `${accentColor}30`, borderColor: `${accentColor}80` }]}>
                <Text style={[st.chipText, { fontSize: 11 }, sel && { color: accentColor }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{f.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {/* Preview */}
      {preview && (
        <View style={st.previewCard}>
          <Text style={st.previewTitle}>{t('createStream.summaryTitle')}</Text>
          {([
            [t('streams.frequency'), getFrequencies(t).find(f => f.value === frequency)?.label || ''],
            // Per-payment row only when the user actually entered an amount
            // here. In private mode the rate comes from the note picked
            // on the next screen, so this row would be misleading.
            ...(hideAmount ? [] : [[t('createStream.perPayment'), `${amt.toFixed(4)} ${tok}`]]),
            [t('createStream.start'), t('createStream.immediately')],
            [t('createStream.end'), preview.endDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })],
          ] as Array<[string, string]>).map(([k, v]) => (
            <View key={k} style={st.previewRow}>
              <Text style={st.dimLabel}>{k}</Text>
              <Text style={st.previewValue}>{v}</Text>
            </View>
          ))}

          {/* Private toggle */}
          <TouchableOpacity onPress={() => setIsPrivate(!isPrivate)} style={st.privacyRow}>
            <Ionicons name="shield-checkmark" size={16} color={isPrivate ? accentColor : Colors.textSecondary} />
            <Text style={[st.previewValue, { flex: 1 }]}>{t('createStream.privateStream')}</Text>
            <View style={[st.switchTrack, isPrivate && { backgroundColor: `${accentColor}50` }]}>
              <View style={[st.switchThumb, isPrivate && { alignSelf: 'flex-end', backgroundColor: accentColor }]} />
            </View>
          </TouchableOpacity>
        </View>
      )}

      {/* Submit */}
      <TouchableOpacity onPress={handleSubmit} disabled={!isValid || loading}
        style={[st.submitBtn, { backgroundColor: isValid ? accentColor : `${accentColor}40` }, loading && { opacity: 0.7 }]}>
        <Ionicons name="water" size={18} color="#000" />
        <Text style={st.submitText}>{loading ? t('createStream.creating') : (submitLabel || t('createStream.createStream'))}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
};

const st = StyleSheet.create({
  section: { marginBottom: 20 },
  label: { fontSize: 13, fontFamily: FontFamily.medium, color: Colors.textSecondary, marginBottom: 8 },
  dimLabel: { fontSize: 12, fontFamily: FontFamily.regular, color: Colors.textSecondary },

  inputWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.surfaceTertiary,
    borderRadius: BorderRadius.md, paddingHorizontal: 14, paddingVertical: 13,
  },
  input: { flex: 1, color: Colors.text, fontSize: 15, fontFamily: FontFamily.regular },
  error: { color: Colors.error, fontSize: 12, fontFamily: FontFamily.regular, marginTop: 6, marginLeft: 4 },

  chip: {
    flex: 1, paddingVertical: 12, borderRadius: BorderRadius.md, alignItems: 'center',
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.surfaceTertiary,
  },
  chipText: { fontSize: 13, fontFamily: FontFamily.semibold, color: Colors.textSecondary },

  previewCard: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.xl,
    padding: Spacing.xl, marginBottom: 20,
  },
  previewTitle: { fontSize: 15, fontFamily: FontFamily.semibold, color: Colors.text, marginBottom: 14 },
  previewRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
  previewValue: { fontSize: 13, fontFamily: FontFamily.medium, color: Colors.text },

  privacyRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginTop: 12, paddingTop: 14, borderTopWidth: 1, borderTopColor: Colors.surfaceTertiary,
  },
  switchTrack: {
    width: 44, height: 26, borderRadius: 13,
    backgroundColor: Colors.surfaceTertiary, justifyContent: 'center', padding: 3,
  },
  switchThumb: { width: 20, height: 20, borderRadius: 10, backgroundColor: Colors.textSecondary },

  submitBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 16, borderRadius: BorderRadius.lg, marginBottom: 32,
  },
  submitText: { fontSize: 16, fontFamily: FontFamily.semibold, color: '#000' },
});

export default CreateStreamForm;

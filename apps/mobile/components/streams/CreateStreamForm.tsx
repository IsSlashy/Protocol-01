import React, { useState, useMemo, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  TextInput,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ServiceSelector, ServiceLogo } from './ServiceSelector';
import {
  ServiceInfo,
  detectServiceFromName,
  CATEGORY_CONFIG,
} from '../../services/subscriptions/serviceRegistry';
import { useWalletStore } from '@/stores/walletStore';

// Protocol 01 Color System
const COLORS = {
  // Primary
  cyan: '#39c5bb',
  cyanDim: '#2a9d95',
  // Accent
  accent: '#ff77a8',
  brightCyan: '#00ffe5',
  yellow: '#ffcc00',
  // Surfaces
  void: '#0a0a0c',
  surface: '#151518',
  surface2: '#1a1a1e',
  border: '#2a2a30',
  borderHover: '#3a3a42',
  // Text
  text: '#ffffff',
  textMuted: '#888892',
  textDim: '#555560',
};

interface CreateStreamFormProps {
  balance?: number;
  symbol?: string;
  onCreateStream?: (data: {
    recipient: string;
    amount: number;
    startDate: Date;
    endDate: Date;
  }) => void;
  onSubmit?: (data: StreamFormData) => void;
  onSelectContact?: () => void;
  loading?: boolean;
  accentColor?: string;
  submitLabel?: string;
  /** Hide service selector for personal payments (default: false) */
  hideServiceSelector?: boolean;
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

const DURATION_OPTIONS = [
  { label: '7d', value: 7 },
  { label: '30d', value: 30 },
  { label: '90d', value: 90 },
  { label: 'Custom', value: -1 },
];

const FREQUENCY_OPTIONS: { label: string; value: PaymentFrequency }[] = [
  { label: 'Daily', value: 'daily' },
  { label: 'Weekly', value: 'weekly' },
  { label: 'Bi-weekly', value: 'biweekly' },
  { label: 'Monthly', value: 'monthly' },
];

interface TokenOption {
  symbol: string;
  name: string;
  balance: number;
  mint?: string;
}

export const CreateStreamForm: React.FC<CreateStreamFormProps> = ({
  balance,
  symbol,
  onCreateStream,
  onSubmit,
  onSelectContact,
  loading = false,
  accentColor = COLORS.accent,
  submitLabel = 'Create Stream',
  hideServiceSelector = false,
}) => {
  // Get real balance from wallet store
  const walletBalance = useWalletStore((state) => state.balance);

  // Build token options dynamically from real wallet balance
  const tokenOptions: TokenOption[] = useMemo(() => {
    const options: TokenOption[] = [];

    // Add SOL as primary option
    const solBalance = walletBalance?.sol ?? 0;
    options.push({
      symbol: 'SOL',
      name: 'Solana',
      balance: solBalance,
    });

    // Add any SPL tokens from wallet
    if (walletBalance?.tokens && walletBalance.tokens.length > 0) {
      for (const token of walletBalance.tokens) {
        options.push({
          symbol: token.symbol || 'Unknown',
          name: token.name || token.symbol || 'Unknown Token',
          balance: token.balance || 0,
          mint: token.mint,
        });
      }
    }

    return options;
  }, [walletBalance]);

  const [recipient, setRecipient] = useState('');
  const [name, setName] = useState('');
  const [selectedToken, setSelectedToken] = useState<TokenOption>(() => ({
    symbol: 'SOL',
    name: 'Solana',
    balance: walletBalance?.sol ?? 0,
  }));
  const [amount, setAmount] = useState('');
  const [selectedDuration, setSelectedDuration] = useState(DURATION_OPTIONS[1].value);
  const [customDuration, setCustomDuration] = useState('');
  const [selectedFrequency, setSelectedFrequency] = useState<PaymentFrequency>('monthly');
  const [isPrivate, setIsPrivate] = useState(true);
  const [showTokenSelector, setShowTokenSelector] = useState(false);
  const [errors, setErrors] = useState<{ recipient?: string; amount?: string }>({});
  const [selectedService, setSelectedService] = useState<ServiceInfo | null>(null);
  const [autoDetectedService, setAutoDetectedService] = useState<ServiceInfo | null>(null);

  // Sync selectedToken balance when wallet balance changes
  useEffect(() => {
    const currentOption = tokenOptions.find(t => t.symbol === selectedToken.symbol);
    if (currentOption && currentOption.balance !== selectedToken.balance) {
      setSelectedToken(currentOption);
    }
  }, [tokenOptions, selectedToken.symbol]);

  // Auto-detect service from name (only if service selector is visible)
  useEffect(() => {
    if (!hideServiceSelector && name && name.length >= 3 && !selectedService) {
      const detected = detectServiceFromName(name, 0.7);
      setAutoDetectedService(detected);
    } else {
      setAutoDetectedService(null);
    }
  }, [name, selectedService, hideServiceSelector]);

  const activeService = selectedService || autoDetectedService;
  const actualDuration = selectedDuration === -1 ? Number(customDuration) || 0 : selectedDuration;
  const amountNum = Number(amount) || 0;
  const tokenBalance = balance || selectedToken.balance;
  const tokenSymbol = symbol || selectedToken.symbol;

  const preview = useMemo(() => {
    if (!amountNum || !actualDuration) return null;

    const ratePerDay = amountNum / actualDuration;
    const ratePerSecond = amountNum / (actualDuration * 24 * 60 * 60);
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + actualDuration);

    return {
      rate: ratePerDay,
      ratePerSecond,
      startDate: new Date(),
      endDate,
    };
  }, [amountNum, actualDuration]);

  const validateForm = (): boolean => {
    const newErrors: { recipient?: string; amount?: string } = {};

    if (!recipient.trim()) {
      newErrors.recipient = 'Recipient address is required';
    } else if (recipient.length < 20) {
      newErrors.recipient = 'Invalid address format';
    }

    if (!amount || amountNum <= 0) {
      newErrors.amount = 'Amount must be greater than 0';
    } else if (amountNum > tokenBalance) {
      newErrors.amount = 'Insufficient balance';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = () => {
    if (!validateForm()) return;

    const streamName = activeService
      ? activeService.name
      : name || `Stream to ${recipient.slice(0, 8)}...`;

    if (onSubmit) {
      onSubmit({
        recipient,
        name: streamName,
        token: tokenSymbol,
        amount: amountNum,
        duration: actualDuration,
        frequency: selectedFrequency,
        isPrivate,
        serviceId: activeService?.id,
        serviceName: activeService?.name,
        serviceCategory: activeService?.category,
        serviceColor: activeService?.color,
      });
    }

    if (onCreateStream && preview) {
      onCreateStream({
        recipient,
        amount: amountNum,
        startDate: preview.startDate,
        endDate: preview.endDate,
      });
    }
  };

  const isValid = recipient && amountNum > 0 && actualDuration > 0;

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingBottom: 40 }}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="always"
      keyboardDismissMode="on-drag"
      automaticallyAdjustKeyboardInsets={true}
    >
        {/* Recipient Input */}
        <View style={{ marginBottom: 20 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <Text style={{ color: COLORS.textMuted, fontSize: 14, fontWeight: '500' }}>
              Recipient Address
            </Text>
            {onSelectContact && (
              <TouchableOpacity
                onPress={onSelectContact}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  borderRadius: 8,
                  backgroundColor: 'rgba(255, 119, 168, 0.2)',
                }}
              >
                <Ionicons name="people-outline" size={16} color={COLORS.accent} />
                <Text style={{ color: COLORS.accent, fontSize: 14, marginLeft: 4 }}>
                  Contacts
                </Text>
              </TouchableOpacity>
            )}
          </View>
          <View style={styles.inputContainer}>
            <Ionicons name="wallet-outline" size={20} color={COLORS.textMuted} style={{ marginRight: 12 }} />
            <TextInput
              style={styles.textInput}
              placeholder="Enter wallet address"
              placeholderTextColor={COLORS.textDim}
              value={recipient}
              onChangeText={setRecipient}
              autoCapitalize="none"
              autoCorrect={false}
              blurOnSubmit={false}
            />
          </View>
          {errors.recipient && (
            <Text style={styles.errorText}>{errors.recipient}</Text>
          )}
        </View>

        {/* Service Selector - Hidden for personal payments */}
        {!hideServiceSelector && (
          <View style={{ marginBottom: 20 }}>
            <Text style={{ color: COLORS.textMuted, fontSize: 14, marginBottom: 8, fontWeight: '500' }}>
              Service (Optional)
            </Text>
            <ServiceSelector
              selectedService={selectedService}
              onSelectService={(service) => {
                setSelectedService(service);
                if (service) {
                  setName(service.name);
                }
              }}
              placeholder="Select a known service..."
            />
          </View>
        )}

        {/* Stream Name */}
        <View style={{ marginBottom: 20 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <Text style={{ color: COLORS.textMuted, fontSize: 14, fontWeight: '500' }}>
              {hideServiceSelector
                ? 'Payment Name (Optional)'
                : selectedService
                  ? 'Service Name'
                  : 'Stream Name (Optional)'}
            </Text>
            {!hideServiceSelector && autoDetectedService && !selectedService && (
              <TouchableOpacity
                onPress={() => setSelectedService(autoDetectedService)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingHorizontal: 8,
                  paddingVertical: 4,
                  borderRadius: 8,
                  backgroundColor: `${autoDetectedService.color || COLORS.cyan}20`,
                }}
              >
                <Ionicons name="sparkles" size={12} color={autoDetectedService.color || COLORS.cyan} />
                <Text style={{ color: autoDetectedService.color || COLORS.cyan, fontSize: 12, marginLeft: 4 }}>
                  Detected: {autoDetectedService.name}
                </Text>
              </TouchableOpacity>
            )}
          </View>
          <View style={styles.inputContainer}>
            <Ionicons name="pricetag-outline" size={20} color={COLORS.textMuted} style={{ marginRight: 12 }} />
            <TextInput
              style={styles.textInput}
              placeholder={hideServiceSelector ? 'e.g., Salary, Rent, Allowance' : selectedService ? selectedService.name : 'e.g., Monthly salary'}
              placeholderTextColor={COLORS.textDim}
              value={name}
              onChangeText={setName}
              editable={!selectedService}
              blurOnSubmit={false}
            />
          </View>
          {!hideServiceSelector && selectedService && (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                marginTop: 8,
                paddingHorizontal: 12,
                paddingVertical: 10,
                borderRadius: 8,
                backgroundColor: `${selectedService.color || COLORS.cyan}15`,
              }}
            >
              <ServiceLogo service={selectedService} size={24} />
              <Text style={{ color: COLORS.text, fontSize: 14, marginLeft: 8, flex: 1 }}>
                {selectedService.name}
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Ionicons
                  name={CATEGORY_CONFIG[selectedService.category].icon as any}
                  size={14}
                  color={CATEGORY_CONFIG[selectedService.category].color}
                />
                <Text style={{ color: COLORS.textMuted, fontSize: 12, marginLeft: 4 }}>
                  {CATEGORY_CONFIG[selectedService.category].label}
                </Text>
              </View>
            </View>
          )}
        </View>

        {/* Token Selector */}
        <View style={{ marginBottom: 20 }}>
          <Text style={{ color: COLORS.textMuted, fontSize: 14, marginBottom: 8, fontWeight: '500' }}>
            Token
          </Text>
          <TouchableOpacity
            onPress={() => setShowTokenSelector(!showTokenSelector)}
            style={{
              backgroundColor: COLORS.surface,
              borderWidth: 1,
              borderColor: COLORS.border,
              borderRadius: 12,
              padding: 16,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 20,
                  backgroundColor: 'rgba(255, 119, 168, 0.2)',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ color: COLORS.accent, fontWeight: 'bold' }}>
                  {selectedToken.symbol.slice(0, 1)}
                </Text>
              </View>
              <View>
                <Text style={{ color: COLORS.text, fontWeight: '600', fontSize: 16 }}>
                  {selectedToken.symbol}
                </Text>
                <Text style={{ color: COLORS.textMuted, fontSize: 12 }}>
                  Balance: {selectedToken.balance} {selectedToken.symbol}
                </Text>
              </View>
            </View>
            <Ionicons
              name={showTokenSelector ? 'chevron-up' : 'chevron-down'}
              size={20}
              color={COLORS.textMuted}
            />
          </TouchableOpacity>

          {showTokenSelector && (
            <View
              style={{
                marginTop: 8,
                backgroundColor: COLORS.surface,
                borderWidth: 1,
                borderColor: COLORS.border,
                borderRadius: 12,
                overflow: 'hidden',
              }}
            >
              {tokenOptions.map((token, index) => (
                <TouchableOpacity
                  key={token.symbol}
                  onPress={() => {
                    setSelectedToken(token);
                    setShowTokenSelector(false);
                  }}
                  style={{
                    padding: 16,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    borderBottomWidth: index < tokenOptions.length - 1 ? 1 : 0,
                    borderBottomColor: COLORS.border,
                    backgroundColor: selectedToken.symbol === token.symbol ? 'rgba(255, 119, 168, 0.1)' : 'transparent',
                  }}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    <View
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: 16,
                        backgroundColor: 'rgba(255, 119, 168, 0.2)',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Text style={{ color: COLORS.accent, fontWeight: 'bold', fontSize: 14 }}>
                        {token.symbol.slice(0, 1)}
                      </Text>
                    </View>
                    <Text style={{ color: COLORS.text, fontSize: 16 }}>{token.symbol}</Text>
                  </View>
                  <Text style={{ color: COLORS.textMuted, fontSize: 14 }}>
                    {token.balance} {token.symbol}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>

        {/* Amount Input */}
        <View style={{ marginBottom: 20 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <Text style={{ color: COLORS.textMuted, fontSize: 14, fontWeight: '500' }}>
              Total Amount
            </Text>
            <Text style={{ color: COLORS.textMuted, fontSize: 14 }}>
              Balance: {tokenBalance.toFixed(4)} {tokenSymbol}
            </Text>
          </View>
          <View style={styles.inputContainer}>
            <Ionicons name="wallet-outline" size={20} color={COLORS.textMuted} style={{ marginRight: 12 }} />
            <TextInput
              style={styles.textInput}
              placeholder="0.00"
              placeholderTextColor={COLORS.textDim}
              value={amount}
              onChangeText={(text) => {
                const cleaned = text.replace(/[^0-9.]/g, '');
                setAmount(cleaned);
              }}
              keyboardType="decimal-pad"
              blurOnSubmit={false}
            />
          </View>
          {errors.amount && (
            <Text style={styles.errorText}>{errors.amount}</Text>
          )}
        </View>

        {/* Duration Selector */}
        <View style={{ marginBottom: 20 }}>
          <Text style={{ color: COLORS.textMuted, fontSize: 14, marginBottom: 8, fontWeight: '500' }}>
            Duration
          </Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {DURATION_OPTIONS.map((option) => (
              <TouchableOpacity
                key={option.value}
                onPress={() => setSelectedDuration(option.value)}
                style={{
                  flex: 1,
                  paddingVertical: 14,
                  borderRadius: 12,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: selectedDuration === option.value ? `${accentColor}30` : COLORS.surface,
                  borderWidth: 1,
                  borderColor: selectedDuration === option.value ? `${accentColor}80` : COLORS.border,
                }}
              >
                <Text
                  style={{
                    fontWeight: '600',
                    color: selectedDuration === option.value ? accentColor : COLORS.textMuted,
                  }}
                >
                  {option.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {selectedDuration === -1 && (
            <View style={[styles.inputContainer, { marginTop: 8 }]}>
              <TextInput
                style={styles.textInput}
                placeholder="Enter days"
                placeholderTextColor={COLORS.textDim}
                value={customDuration}
                onChangeText={setCustomDuration}
                keyboardType="number-pad"
                blurOnSubmit={false}
              />
            </View>
          )}
        </View>

        {/* Frequency Selector */}
        <View style={{ marginBottom: 20 }}>
          <Text style={{ color: COLORS.textMuted, fontSize: 14, marginBottom: 8, fontWeight: '500' }}>
            Payment Frequency
          </Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {FREQUENCY_OPTIONS.map((option) => (
              <TouchableOpacity
                key={option.value}
                onPress={() => setSelectedFrequency(option.value)}
                style={{
                  flex: 1,
                  paddingVertical: 14,
                  borderRadius: 12,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: selectedFrequency === option.value ? `${accentColor}30` : COLORS.surface,
                  borderWidth: 1,
                  borderColor: selectedFrequency === option.value ? `${accentColor}80` : COLORS.border,
                }}
              >
                <Text
                  style={{
                    fontWeight: '600',
                    fontSize: 12,
                    color: selectedFrequency === option.value ? accentColor : COLORS.textMuted,
                  }}
                >
                  {option.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Preview Card */}
        {preview && (
          <View
            style={{
              marginBottom: 20,
              backgroundColor: COLORS.surface,
              borderRadius: 16,
              padding: 16,
              borderWidth: 1,
              borderColor: `${accentColor}50`,
            }}
          >
            <Text style={{ color: COLORS.text, fontWeight: '600', fontSize: 16, marginBottom: 16 }}>
              Stream Preview
            </Text>

            <View style={{ gap: 12 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={{ color: COLORS.textMuted }}>Frequency</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <View
                    style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: accentColor, marginRight: 8 }}
                  />
                  <Text style={{ color: COLORS.text, fontWeight: '600' }}>
                    {FREQUENCY_OPTIONS.find(f => f.value === selectedFrequency)?.label}
                  </Text>
                </View>
              </View>

              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ color: COLORS.textMuted }}>Amount per payment</Text>
                <Text style={{ color: COLORS.text, fontFamily: 'monospace' }}>
                  {amountNum.toFixed(4)} {tokenSymbol}
                </Text>
              </View>

              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ color: COLORS.textMuted }}>Start</Text>
                <Text style={{ color: COLORS.text }}>Immediately</Text>
              </View>

              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ color: COLORS.textMuted }}>End</Text>
                <Text style={{ color: COLORS.text }}>
                  {preview.endDate.toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })}
                </Text>
              </View>
            </View>

            {/* Private Toggle */}
            <TouchableOpacity
              onPress={() => setIsPrivate(!isPrivate)}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginTop: 16,
                paddingTop: 16,
                borderTopWidth: 1,
                borderTopColor: COLORS.border,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Ionicons
                  name="shield-checkmark"
                  size={18}
                  color={isPrivate ? accentColor : COLORS.textMuted}
                />
                <Text style={{ color: COLORS.text }}>Private Stream</Text>
              </View>
              <View
                style={{
                  width: 48,
                  height: 28,
                  borderRadius: 14,
                  justifyContent: 'center',
                  paddingHorizontal: 4,
                  backgroundColor: isPrivate ? `${accentColor}50` : COLORS.border,
                }}
              >
                <View
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: 10,
                    backgroundColor: isPrivate ? accentColor : COLORS.textMuted,
                    alignSelf: isPrivate ? 'flex-end' : 'flex-start',
                  }}
                />
              </View>
            </TouchableOpacity>
          </View>
        )}

        {/* Info Box */}
        <View
          style={{
            marginBottom: 20,
            padding: 12,
            borderRadius: 12,
            flexDirection: 'row',
            alignItems: 'flex-start',
            backgroundColor: `${accentColor}18`,
          }}
        >
          <Ionicons name="information-circle" size={18} color={accentColor} />
          <Text style={{ color: COLORS.textMuted, fontSize: 12, marginLeft: 8, flex: 1 }}>
            The recipient will receive tokens continuously over the stream duration. You can pause
            or cancel the stream at any time.
          </Text>
        </View>

        {/* Submit Button */}
        <TouchableOpacity
          onPress={handleSubmit}
          disabled={!isValid || loading}
          style={{
            paddingVertical: 18,
            borderRadius: 14,
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 32,
            backgroundColor: isValid ? accentColor : `${accentColor}50`,
            shadowColor: accentColor,
            shadowOpacity: isValid ? 0.4 : 0,
            shadowRadius: 12,
            shadowOffset: { width: 0, height: 4 },
            opacity: loading ? 0.7 : 1,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Ionicons name="water" size={20} color="#fff" />
            <Text style={{ color: COLORS.text, fontWeight: '600', fontSize: 18 }}>
              {loading ? 'Creating...' : submitLabel}
            </Text>
          </View>
        </TouchableOpacity>
      </ScrollView>
  );
};

const styles = StyleSheet.create({
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  textInput: {
    flex: 1,
    color: COLORS.text,
    fontSize: 16,
  },
  errorText: {
    color: '#ef4444',
    fontSize: 12,
    marginTop: 6,
    marginLeft: 4,
  },
});

export default CreateStreamForm;

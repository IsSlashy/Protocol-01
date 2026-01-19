import React, { useState, useMemo, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { ServiceSelector, ServiceLogo } from './ServiceSelector';
import {
  ServiceInfo,
  detectServiceFromName,
  CATEGORY_CONFIG,
} from '../../services/subscriptions/serviceRegistry';

const ACCENT_PINK = '#ff77a8';
const VIOLET = '#8b5cf6';

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
}

export interface StreamFormData {
  recipient: string;
  name: string;
  token: string;
  amount: number;
  duration: number; // in days
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

const TOKEN_OPTIONS = [
  { symbol: 'SOL', name: 'Solana', balance: 12.5 },
  { symbol: 'USDC', name: 'USD Coin', balance: 1500.0 },
  { symbol: 'USDT', name: 'Tether', balance: 800.0 },
];

export const CreateStreamForm: React.FC<CreateStreamFormProps> = ({
  balance,
  symbol,
  onCreateStream,
  onSubmit,
  onSelectContact,
  loading = false,
}) => {
  const [recipient, setRecipient] = useState('');
  const [name, setName] = useState('');
  const [selectedToken, setSelectedToken] = useState(TOKEN_OPTIONS[0]);
  const [amount, setAmount] = useState('');
  const [selectedDuration, setSelectedDuration] = useState(DURATION_OPTIONS[1].value);
  const [customDuration, setCustomDuration] = useState('');
  const [isPrivate, setIsPrivate] = useState(true);
  const [showTokenSelector, setShowTokenSelector] = useState(false);
  const [errors, setErrors] = useState<{ recipient?: string; amount?: string }>({});
  const [selectedService, setSelectedService] = useState<ServiceInfo | null>(null);
  const [autoDetectedService, setAutoDetectedService] = useState<ServiceInfo | null>(null);

  // Auto-detect service from name input
  useEffect(() => {
    if (name && name.length >= 3 && !selectedService) {
      const detected = detectServiceFromName(name, 0.7);
      setAutoDetectedService(detected);
    } else {
      setAutoDetectedService(null);
    }
  }, [name, selectedService]);

  // Get the active service (manually selected or auto-detected)
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

    // Determine the name to use (selected service, auto-detected, or custom)
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
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      className="flex-1"
    >
      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
        {/* Recipient Input */}
        <View className="mb-4">
          <View className="flex-row items-center justify-between mb-2">
            <Text className="text-p01-text-secondary text-sm font-medium">
              Recipient Address
            </Text>
            {onSelectContact && (
              <TouchableOpacity
                onPress={onSelectContact}
                className="flex-row items-center px-3 py-1.5 rounded-lg"
                style={{ backgroundColor: 'rgba(255, 119, 168, 0.2)' }}
              >
                <Ionicons name="people-outline" size={16} color={ACCENT_PINK} />
                <Text className="text-sm ml-1" style={{ color: ACCENT_PINK }}>
                  Contacts
                </Text>
              </TouchableOpacity>
            )}
          </View>
          <Input
            placeholder="Enter wallet address"
            value={recipient}
            onChangeText={(text) => {
              setRecipient(text);
              setErrors({ ...errors, recipient: undefined });
            }}
            error={errors.recipient}
            leftIcon="wallet-outline"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>

        {/* Service Selector */}
        <View className="mb-4">
          <Text className="text-p01-text-secondary text-sm mb-2 font-medium">
            Service (Optional)
          </Text>
          <ServiceSelector
            selectedService={selectedService}
            onSelectService={(service) => {
              setSelectedService(service);
              // If a service is selected, update the name to match
              if (service) {
                setName(service.name);
              }
            }}
            placeholder="Select a known service..."
          />
        </View>

        {/* Stream Name - with auto-detection indicator */}
        <View className="mb-4">
          <View className="flex-row items-center justify-between mb-2">
            <Text className="text-p01-text-secondary text-sm font-medium">
              {selectedService ? 'Service Name' : 'Stream Name (Optional)'}
            </Text>
            {autoDetectedService && !selectedService && (
              <TouchableOpacity
                onPress={() => setSelectedService(autoDetectedService)}
                className="flex-row items-center px-2 py-1 rounded-lg"
                style={{ backgroundColor: `${autoDetectedService.color || VIOLET}20` }}
              >
                <Ionicons
                  name="sparkles"
                  size={12}
                  color={autoDetectedService.color || VIOLET}
                />
                <Text
                  className="text-xs ml-1"
                  style={{ color: autoDetectedService.color || VIOLET }}
                >
                  Detected: {autoDetectedService.name}
                </Text>
              </TouchableOpacity>
            )}
          </View>
          <Input
            placeholder={selectedService ? selectedService.name : 'e.g., Monthly salary'}
            value={name}
            onChangeText={setName}
            leftIcon="pricetag-outline"
            editable={!selectedService}
          />
          {selectedService && (
            <View
              className="flex-row items-center mt-2 px-3 py-2 rounded-lg"
              style={{ backgroundColor: `${selectedService.color || VIOLET}15` }}
            >
              <ServiceLogo service={selectedService} size={24} />
              <Text className="text-white text-sm ml-2 flex-1">
                {selectedService.name}
              </Text>
              <View className="flex-row items-center">
                <Ionicons
                  name={CATEGORY_CONFIG[selectedService.category].icon as any}
                  size={14}
                  color={CATEGORY_CONFIG[selectedService.category].color}
                />
                <Text className="text-xs ml-1" style={{ color: '#888892' }}>
                  {CATEGORY_CONFIG[selectedService.category].label}
                </Text>
              </View>
            </View>
          )}
        </View>

        {/* Token Selector */}
        <View className="mb-4">
          <Text className="text-p01-text-secondary text-sm mb-2 font-medium">Token</Text>
          <TouchableOpacity
            onPress={() => setShowTokenSelector(!showTokenSelector)}
            className="bg-p01-surface border border-p01-border rounded-xl p-4 flex-row items-center justify-between"
          >
            <View className="flex-row items-center gap-3">
              <View
                className="w-10 h-10 rounded-full items-center justify-center"
                style={{ backgroundColor: 'rgba(255, 119, 168, 0.2)' }}
              >
                <Text style={{ color: ACCENT_PINK }} className="font-bold">
                  {selectedToken.symbol.slice(0, 1)}
                </Text>
              </View>
              <View>
                <Text className="text-white font-semibold">{selectedToken.symbol}</Text>
                <Text className="text-p01-text-secondary text-xs">
                  Balance: {selectedToken.balance} {selectedToken.symbol}
                </Text>
              </View>
            </View>
            <Ionicons
              name={showTokenSelector ? 'chevron-up' : 'chevron-down'}
              size={20}
              color="#888892"
            />
          </TouchableOpacity>

          {showTokenSelector && (
            <View className="mt-2 bg-p01-surface border border-p01-border rounded-xl overflow-hidden">
              {TOKEN_OPTIONS.map((token, index) => (
                <TouchableOpacity
                  key={token.symbol}
                  onPress={() => {
                    setSelectedToken(token);
                    setShowTokenSelector(false);
                  }}
                  className={`p-4 flex-row items-center justify-between ${
                    index < TOKEN_OPTIONS.length - 1 ? 'border-b border-p01-border' : ''
                  }`}
                  style={
                    selectedToken.symbol === token.symbol
                      ? { backgroundColor: 'rgba(255, 119, 168, 0.1)' }
                      : {}
                  }
                >
                  <View className="flex-row items-center gap-3">
                    <View
                      className="w-8 h-8 rounded-full items-center justify-center"
                      style={{ backgroundColor: 'rgba(255, 119, 168, 0.2)' }}
                    >
                      <Text style={{ color: ACCENT_PINK }} className="font-bold text-sm">
                        {token.symbol.slice(0, 1)}
                      </Text>
                    </View>
                    <Text className="text-white">{token.symbol}</Text>
                  </View>
                  <Text className="text-p01-text-secondary text-sm">
                    {token.balance} {token.symbol}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>

        {/* Amount Input */}
        <View className="mb-4">
          <View className="flex-row items-center justify-between mb-2">
            <Text className="text-p01-text-secondary text-sm font-medium">Total Amount</Text>
            <Text className="text-p01-text-secondary text-sm">
              Balance: {tokenBalance.toFixed(4)} {tokenSymbol}
            </Text>
          </View>
          <Input
            placeholder="0.00"
            value={amount}
            onChangeText={(text) => {
              const cleaned = text.replace(/[^0-9.]/g, '');
              setAmount(cleaned);
              setErrors({ ...errors, amount: undefined });
            }}
            error={errors.amount}
            keyboardType="decimal-pad"
            leftIcon="wallet-outline"
          />
        </View>

        {/* Duration Selector */}
        <View className="mb-4">
          <Text className="text-p01-text-secondary text-sm mb-2 font-medium">Duration</Text>
          <View className="flex-row gap-2">
            {DURATION_OPTIONS.map((option) => (
              <TouchableOpacity
                key={option.value}
                onPress={() => setSelectedDuration(option.value)}
                className="flex-1 py-3 rounded-xl items-center justify-center"
                style={{
                  backgroundColor:
                    selectedDuration === option.value
                      ? 'rgba(255, 119, 168, 0.2)'
                      : 'rgba(21, 21, 24, 1)',
                  borderWidth: 1,
                  borderColor:
                    selectedDuration === option.value
                      ? 'rgba(255, 119, 168, 0.5)'
                      : 'rgba(42, 42, 48, 0.5)',
                }}
              >
                <Text
                  className="font-semibold"
                  style={{
                    color: selectedDuration === option.value ? ACCENT_PINK : '#888892',
                  }}
                >
                  {option.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {selectedDuration === -1 && (
            <Input
              placeholder="Enter days"
              value={customDuration}
              onChangeText={setCustomDuration}
              keyboardType="number-pad"
              containerClassName="mt-2"
            />
          )}
        </View>

        {/* Preview Card */}
        {preview && (
          <Card
            variant="outlined"
            className="mb-4"
            style={{ borderColor: 'rgba(255, 119, 168, 0.3)' }}
          >
            <Text className="text-white font-semibold mb-3">Stream Preview</Text>

            <View className="space-y-3">
              <View className="flex-row justify-between items-center">
                <Text className="text-p01-text-secondary">Rate</Text>
                <View className="flex-row items-center">
                  <View
                    className="w-2 h-2 rounded-full mr-2"
                    style={{ backgroundColor: ACCENT_PINK }}
                  />
                  <Text className="text-white font-mono">
                    {preview.rate.toFixed(4)} {tokenSymbol}/day
                  </Text>
                </View>
              </View>

              <View className="flex-row justify-between">
                <Text className="text-p01-text-secondary">Per Second</Text>
                <Text className="text-white font-mono">
                  {preview.ratePerSecond.toFixed(8)} {tokenSymbol}
                </Text>
              </View>

              <View className="flex-row justify-between">
                <Text className="text-p01-text-secondary">Start</Text>
                <Text className="text-white">Immediately</Text>
              </View>

              <View className="flex-row justify-between">
                <Text className="text-p01-text-secondary">End</Text>
                <Text className="text-white">
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
              className="flex-row items-center justify-between mt-4 pt-4"
              style={{ borderTopWidth: 1, borderTopColor: 'rgba(42, 42, 48, 0.5)' }}
            >
              <View className="flex-row items-center gap-2">
                <Ionicons
                  name="shield-checkmark"
                  size={18}
                  color={isPrivate ? ACCENT_PINK : '#888892'}
                />
                <Text className="text-white">Private Stream</Text>
              </View>
              <View
                className="w-12 h-7 rounded-full justify-center px-1"
                style={{
                  backgroundColor: isPrivate
                    ? 'rgba(255, 119, 168, 0.3)'
                    : 'rgba(42, 42, 48, 0.5)',
                }}
              >
                <View
                  className="w-5 h-5 rounded-full"
                  style={{
                    backgroundColor: isPrivate ? ACCENT_PINK : '#888892',
                    alignSelf: isPrivate ? 'flex-end' : 'flex-start',
                  }}
                />
              </View>
            </TouchableOpacity>
          </Card>
        )}

        {/* Info Box */}
        <View
          className="mb-4 p-3 rounded-xl flex-row items-start"
          style={{ backgroundColor: 'rgba(255, 119, 168, 0.1)' }}
        >
          <Ionicons name="information-circle" size={18} color={ACCENT_PINK} />
          <Text className="text-p01-text-secondary text-xs ml-2 flex-1">
            The recipient will receive tokens continuously over the stream duration. You can pause
            or cancel the stream at any time.
          </Text>
        </View>

        {/* Submit Button */}
        <TouchableOpacity
          onPress={handleSubmit}
          disabled={!isValid || loading}
          className="py-4 rounded-xl items-center justify-center mb-8"
          style={{
            backgroundColor: isValid ? ACCENT_PINK : 'rgba(255, 119, 168, 0.3)',
            shadowColor: ACCENT_PINK,
            shadowOpacity: isValid ? 0.4 : 0,
            shadowRadius: 12,
            shadowOffset: { width: 0, height: 4 },
            opacity: loading ? 0.7 : 1,
          }}
        >
          <View className="flex-row items-center gap-2">
            <Ionicons name="water" size={20} color="#fff" />
            <Text className="text-white font-semibold text-lg">
              {loading ? 'Creating...' : 'Create Stream'}
            </Text>
          </View>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
};

export default CreateStreamForm;

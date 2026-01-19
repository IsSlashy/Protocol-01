import React, { useState } from 'react';
import { View, Text, TouchableOpacity, KeyboardAvoidingView, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';

interface SendFormProps {
  balance: number;
  symbol: string;
  fiatRate?: number;
  onSend: (data: { address: string; amount: number; memo?: string }) => void;
  onScanQR?: () => void;
  onSelectContact?: () => void;
  loading?: boolean;
}

export const SendForm: React.FC<SendFormProps> = ({
  balance,
  symbol,
  fiatRate = 1,
  onSend,
  onScanQR,
  onSelectContact,
  loading = false,
}) => {
  const [address, setAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [errors, setErrors] = useState<{ address?: string; amount?: string }>({});

  const numericAmount = parseFloat(amount) || 0;
  const fiatValue = numericAmount * fiatRate;

  const presetPercentages = [25, 50, 75, 100];

  const handlePresetAmount = (percentage: number) => {
    const presetAmount = (balance * percentage) / 100;
    setAmount(presetAmount.toString());
  };

  const validateForm = (): boolean => {
    const newErrors: { address?: string; amount?: string } = {};

    if (!address.trim()) {
      newErrors.address = 'Recipient address is required';
    } else if (address.length < 20) {
      newErrors.address = 'Invalid address format';
    }

    if (!amount || numericAmount <= 0) {
      newErrors.amount = 'Amount must be greater than 0';
    } else if (numericAmount > balance) {
      newErrors.amount = 'Insufficient balance';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSend = () => {
    if (validateForm()) {
      onSend({ address, amount: numericAmount, memo: memo || undefined });
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      className="flex-1"
    >
      <View className="flex-1 px-4">
        <View className="mb-6">
          <View className="flex-row items-center justify-between mb-2">
            <Text className="text-p01-text-secondary text-sm">To</Text>
            <View className="flex-row gap-2">
              <TouchableOpacity
                onPress={onScanQR}
                className="flex-row items-center px-3 py-1.5 bg-p01-surface rounded-lg"
              >
                <Ionicons name="qr-code-outline" size={16} color="#39c5bb" />
                <Text className="text-p01-cyan text-sm ml-1">Scan</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={onSelectContact}
                className="flex-row items-center px-3 py-1.5 bg-p01-surface rounded-lg"
              >
                <Ionicons name="people-outline" size={16} color="#39c5bb" />
                <Text className="text-p01-cyan text-sm ml-1">Contacts</Text>
              </TouchableOpacity>
            </View>
          </View>
          <Input
            placeholder="Enter wallet address"
            value={address}
            onChangeText={(text) => {
              setAddress(text);
              setErrors({ ...errors, address: undefined });
            }}
            error={errors.address}
            leftIcon="wallet-outline"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>

        <View className="mb-6">
          <View className="flex-row items-center justify-between mb-2">
            <Text className="text-p01-text-secondary text-sm">Amount</Text>
            <Text className="text-p01-text-secondary text-sm">
              Balance: {balance.toFixed(4)} {symbol}
            </Text>
          </View>

          <Card variant="outlined" padding="md" className="mb-3">
            <View className="flex-row items-center">
              <Input
                placeholder="0.00"
                value={amount}
                onChangeText={(text) => {
                  const cleaned = text.replace(/[^0-9.]/g, '');
                  setAmount(cleaned);
                  setErrors({ ...errors, amount: undefined });
                }}
                keyboardType="decimal-pad"
                containerClassName="flex-1"
                className="text-2xl font-bold"
              />
              <View className="ml-2 px-3 py-2 bg-p01-surface rounded-lg">
                <Text className="text-white font-semibold">{symbol}</Text>
              </View>
            </View>
            <Text className="text-p01-text-secondary text-sm mt-2">
              = ${fiatValue.toFixed(2)} USD
            </Text>
            {errors.amount && (
              <View className="flex-row items-center mt-2">
                <Ionicons name="alert-circle" size={14} color="#ef4444" />
                <Text className="text-red-500 text-xs ml-1">{errors.amount}</Text>
              </View>
            )}
          </Card>

          <View className="flex-row gap-2">
            {presetPercentages.map((percentage) => (
              <TouchableOpacity
                key={percentage}
                onPress={() => handlePresetAmount(percentage)}
                className="flex-1 py-2 bg-p01-surface border border-p01-border rounded-lg items-center"
              >
                <Text className="text-p01-cyan text-sm font-medium">
                  {percentage}%
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        <View className="mb-6">
          <Text className="text-p01-text-secondary text-sm mb-2">
            Memo (Optional)
          </Text>
          <Input
            placeholder="Add a note"
            value={memo}
            onChangeText={setMemo}
            leftIcon="document-text-outline"
            multiline
          />
        </View>

        <Card variant="glass" padding="md" className="mb-6">
          <View className="flex-row items-center justify-between mb-2">
            <Text className="text-p01-text-secondary text-sm">
              Network Fee
            </Text>
            <Text className="text-white text-sm">~0.001 {symbol}</Text>
          </View>
          <View className="flex-row items-center justify-between">
            <Text className="text-p01-text-secondary text-sm">
              Total
            </Text>
            <Text className="text-white font-semibold">
              {(numericAmount + 0.001).toFixed(4)} {symbol}
            </Text>
          </View>
        </Card>

        <Button
          variant="primary"
          size="lg"
          fullWidth
          loading={loading}
          disabled={!address || !amount}
          onPress={handleSend}
        >
          Send {symbol}
        </Button>
      </View>
    </KeyboardAvoidingView>
  );
};

export default SendForm;

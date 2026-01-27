import React, { useState } from 'react';
import { View, Text, TouchableOpacity, KeyboardAvoidingView, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Avatar } from '../ui/Avatar';

export interface ContactFormData {
  name: string;
  address: string;
  note?: string;
}

interface AddContactFormProps {
  onAddContact: (data: { name: string; address: string; note?: string }) => void;
  onScanQR?: () => void;
  loading?: boolean;
  resolvedName?: string;
  resolvedAvatar?: string;
}

export const AddContactForm: React.FC<AddContactFormProps> = ({
  onAddContact,
  onScanQR,
  loading = false,
  resolvedName,
  resolvedAvatar,
}) => {
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<{ name?: string; address?: string }>({});
  const [isFavorite, setIsFavorite] = useState(false);

  const validateForm = (): boolean => {
    const newErrors: { name?: string; address?: string } = {};

    if (!name.trim() && !resolvedName) {
      newErrors.name = 'Name is required';
    }

    if (!address.trim()) {
      newErrors.address = 'Address is required';
    } else if (address.length < 20) {
      newErrors.address = 'Invalid address format';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = () => {
    if (validateForm()) {
      onAddContact({
        name: name || resolvedName || 'Unknown',
        address,
        note: note || undefined,
      });
    }
  };

  const displayName = name || resolvedName || '';

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      className="flex-1"
    >
      <View className="flex-1 px-4">
        <View className="items-center mb-8">
          <Avatar
            source={resolvedAvatar}
            name={displayName || '?'}
            size="xl"
          />
          {displayName && (
            <Text className="text-white text-xl font-semibold mt-3">
              {displayName}
            </Text>
          )}
        </View>

        <View className="mb-6">
          <View className="flex-row items-center justify-between mb-2">
            <Text className="text-p01-text-secondary text-sm">
              Wallet Address
            </Text>
            {onScanQR && (
              <TouchableOpacity
                onPress={onScanQR}
                className="flex-row items-center px-3 py-1.5 bg-p01-surface rounded-lg"
              >
                <Ionicons name="qr-code-outline" size={16} color="#39c5bb" />
                <Text className="text-p01-cyan text-sm ml-1">Scan QR</Text>
              </TouchableOpacity>
            )}
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
          <Text className="text-p01-text-secondary text-sm mb-2">
            Contact Name
          </Text>
          <Input
            placeholder={resolvedName || 'Enter a name for this contact'}
            value={name}
            onChangeText={(text) => {
              setName(text);
              setErrors({ ...errors, name: undefined });
            }}
            error={errors.name}
            leftIcon="person-outline"
          />
          {resolvedName && !name && (
            <Text className="text-p01-cyan text-xs mt-1">
              Name resolved from on-chain identity
            </Text>
          )}
        </View>

        <View className="mb-6">
          <Text className="text-p01-text-secondary text-sm mb-2">
            Note (Optional)
          </Text>
          <Input
            placeholder="Add a note about this contact"
            value={note}
            onChangeText={setNote}
            leftIcon="document-text-outline"
            multiline
          />
        </View>

        <TouchableOpacity
          onPress={() => setIsFavorite(!isFavorite)}
          className="flex-row items-center mb-6"
        >
          <View
            className={`
              w-6 h-6 rounded-lg border items-center justify-center mr-3
              ${isFavorite ? 'bg-yellow-500/20 border-yellow-500' : 'border-p01-border'}
            `}
          >
            {isFavorite && <Ionicons name="star" size={14} color="#eab308" />}
          </View>
          <Text className="text-white">Add to favorites</Text>
        </TouchableOpacity>

        <Card variant="outlined" padding="md" className="mb-6">
          <View className="flex-row items-start">
            <Ionicons name="shield-checkmark" size={20} color="#39c5bb" />
            <View className="flex-1 ml-3">
              <Text className="text-white font-medium mb-1">
                Verify Before Sending
              </Text>
              <Text className="text-p01-text-secondary text-sm">
                Always verify the address before sending funds. Double-check with
                the recipient through a separate channel if possible.
              </Text>
            </View>
          </View>
        </Card>

        <Button
          variant="primary"
          size="lg"
          fullWidth
          loading={loading}
          disabled={!address}
          onPress={handleSubmit}
          icon={<Ionicons name="person-add" size={20} color="#0a0a0c" />}
        >
          Add Contact
        </Button>
      </View>
    </KeyboardAvoidingView>
  );
};

export default AddContactForm;

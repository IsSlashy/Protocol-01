import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  Alert,
  ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { FadeInDown } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';

import { useContactsStore } from '@/stores/contactsStore';
import { isValidAddress } from '@/services/solana/transactions';

const COLORS = {
  primary: '#39c5bb',
  cyan: '#00D1FF',
  purple: '#9945FF',
  orange: '#f59e0b',
  background: '#050505',
  surface: '#0a0a0a',
  surfaceSecondary: '#111111',
  border: '#1f1f1f',
  text: '#ffffff',
  textSecondary: '#a0a0a0',
  textTertiary: '#666666',
  error: '#ef4444',
};

export default function AddContactScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { addContact } = useContactsStore();

  const [address, setAddress] = useState('');
  const [alias, setAlias] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [addressError, setAddressError] = useState('');

  const validateAddress = (value: string) => {
    if (!value) {
      setAddressError('');
      return false;
    }
    if (!isValidAddress(value)) {
      setAddressError('Invalid Solana address');
      return false;
    }
    setAddressError('');
    return true;
  };

  const handleAddContact = async () => {
    if (!validateAddress(address)) return;

    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }

    setIsLoading(true);
    try {
      // Manually added addresses are always wallet-only contacts
      // P-01 users can only be added via QR code scan
      await addContact(address.trim(), alias.trim() || address.slice(0, 8), {
        isP01User: false,
        contactSource: 'solana_address',
      });

      if (Platform.OS !== 'web') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }

      router.back();
    } catch (error: any) {
      if (Platform.OS !== 'web') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
      Alert.alert('Error', error.message || 'Failed to add contact');
    } finally {
      setIsLoading(false);
    }
  };

  const handleScan = () => {
    // Go to P-01 QR scanner to add as P-01 user
    router.push('/(main)/(social)/qr-scan');
  };

  const isValid = address.length > 30 && !addressError;

  return (
    <View style={{ flex: 1, backgroundColor: COLORS.background }}>
      {/* Header */}
      <View
        style={{
          paddingTop: insets.top,
          paddingHorizontal: 20,
          paddingBottom: 16,
          backgroundColor: COLORS.surface,
          borderBottomWidth: 1,
          borderBottomColor: COLORS.border,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={{
              width: 40,
              height: 40,
              borderRadius: 20,
              backgroundColor: COLORS.surfaceSecondary,
              justifyContent: 'center',
              alignItems: 'center',
              marginRight: 12,
            }}
          >
            <Ionicons name="arrow-back" size={24} color={COLORS.text} />
          </TouchableOpacity>
          <Text style={{ color: COLORS.text, fontSize: 18, fontWeight: '600' }}>
            Add Contact
          </Text>
        </View>
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 100 }}
          keyboardShouldPersistTaps="handled"
        >
          {/* Info Card */}
          <Animated.View entering={FadeInDown.delay(100)}>
            <LinearGradient
              colors={[COLORS.surfaceSecondary, COLORS.surface]}
              style={{
                borderRadius: 16,
                padding: 16,
                marginBottom: 24,
                borderWidth: 1,
                borderColor: COLORS.cyan + '30',
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <View
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 22,
                    backgroundColor: COLORS.cyan + '20',
                    justifyContent: 'center',
                    alignItems: 'center',
                    marginRight: 12,
                  }}
                >
                  <Ionicons name="information-circle" size={22} color={COLORS.cyan} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: COLORS.text, fontSize: 15, fontWeight: '600' }}>
                    Add Wallet Address
                  </Text>
                  <Text style={{ color: COLORS.textTertiary, fontSize: 12, marginTop: 2 }}>
                    To add a P-01 user and chat, use the QR scanner
                  </Text>
                </View>
              </View>
            </LinearGradient>
          </Animated.View>

          {/* Solana Address Input */}
          <Animated.View entering={FadeInDown.delay(200)}>
            <Text
              style={{
                color: COLORS.textTertiary,
                fontSize: 12,
                fontWeight: '600',
                letterSpacing: 1,
                marginBottom: 8,
              }}
            >
              SOLANA ADDRESS
            </Text>
            <View
              style={{
                backgroundColor: COLORS.surfaceSecondary,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: addressError ? COLORS.error : COLORS.border,
              }}
            >
              <TextInput
                style={{
                  color: COLORS.text,
                  fontSize: 14,
                  fontFamily: 'monospace',
                  padding: 16,
                }}
                placeholder="Enter wallet address..."
                placeholderTextColor={COLORS.textTertiary}
                value={address}
                onChangeText={(text) => {
                  setAddress(text);
                  if (text.length > 30) validateAddress(text);
                }}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>

            {/* Scan P-01 QR Button */}
            <TouchableOpacity
              onPress={handleScan}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: COLORS.primary + '15',
                borderRadius: 12,
                borderWidth: 1,
                borderColor: COLORS.primary + '30',
                paddingVertical: 14,
                marginTop: 12,
                gap: 8,
              }}
            >
              <Ionicons name="qr-code" size={20} color={COLORS.primary} />
              <Text style={{ color: COLORS.primary, fontSize: 14, fontWeight: '600' }}>
                Scan P-01 QR to add & chat
              </Text>
            </TouchableOpacity>
            {addressError && (
              <Text style={{ color: COLORS.error, fontSize: 12, marginTop: 6 }}>
                {addressError}
              </Text>
            )}
          </Animated.View>

          {/* Alias Input */}
          <Animated.View entering={FadeInDown.delay(300)} style={{ marginTop: 24 }}>
            <Text
              style={{
                color: COLORS.textTertiary,
                fontSize: 12,
                fontWeight: '600',
                letterSpacing: 1,
                marginBottom: 8,
              }}
            >
              ALIAS (OPTIONAL)
            </Text>
            <TextInput
              style={{
                backgroundColor: COLORS.surfaceSecondary,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: COLORS.border,
                color: COLORS.text,
                fontSize: 16,
                padding: 16,
              }}
              placeholder="Enter a name for this contact..."
              placeholderTextColor={COLORS.textTertiary}
              value={alias}
              onChangeText={setAlias}
              maxLength={30}
            />
          </Animated.View>

          {/* Wallet-only Info */}
          <Animated.View entering={FadeInDown.delay(350)} style={{ marginTop: 24 }}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: COLORS.orange + '15',
                borderRadius: 12,
                padding: 14,
                borderWidth: 1,
                borderColor: COLORS.orange + '30',
              }}
            >
              <View
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 20,
                  backgroundColor: COLORS.orange + '20',
                  justifyContent: 'center',
                  alignItems: 'center',
                  marginRight: 12,
                }}
              >
                <Ionicons name="wallet" size={20} color={COLORS.orange} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: COLORS.orange, fontSize: 13, fontWeight: '600' }}>
                  Wallet Address
                </Text>
                <Text style={{ color: COLORS.textSecondary, fontSize: 12, marginTop: 2 }}>
                  You can send crypto to this address. To chat, scan their P-01 QR code instead.
                </Text>
              </View>
            </View>
          </Animated.View>

          {/* Security Notice */}
          <Animated.View entering={FadeInDown.delay(400)} style={{ marginTop: 32 }}>
            <View
              style={{
                backgroundColor: COLORS.surfaceSecondary,
                borderRadius: 12,
                padding: 16,
                borderWidth: 1,
                borderColor: COLORS.border,
              }}
            >
              <Text
                style={{
                  color: COLORS.textTertiary,
                  fontSize: 12,
                  fontWeight: '600',
                  letterSpacing: 1,
                  marginBottom: 12,
                }}
              >
                SECURITY
              </Text>
              {[
                { icon: 'key', text: 'Unique encryption key per contact' },
                { icon: 'shield-checkmark', text: 'X25519 key exchange protocol' },
                { icon: 'lock-closed', text: 'AES-256-GCM encryption' },
                { icon: 'refresh', text: 'Forward secrecy enabled' },
              ].map((item, index) => (
                <View
                  key={item.text}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    marginBottom: index < 3 ? 10 : 0,
                  }}
                >
                  <Ionicons
                    name={item.icon as any}
                    size={16}
                    color={COLORS.primary}
                    style={{ marginRight: 10 }}
                  />
                  <Text style={{ color: COLORS.textSecondary, fontSize: 13 }}>
                    {item.text}
                  </Text>
                </View>
              ))}
            </View>
          </Animated.View>
        </ScrollView>

        {/* Add Button */}
        <View
          style={{
            paddingHorizontal: 20,
            paddingBottom: insets.bottom + 20,
            paddingTop: 16,
            backgroundColor: COLORS.background,
          }}
        >
          <TouchableOpacity
            onPress={handleAddContact}
            disabled={!isValid || isLoading}
            style={{ borderRadius: 16, overflow: 'hidden' }}
          >
            <LinearGradient
              colors={isValid ? [COLORS.purple, COLORS.cyan] : [COLORS.surfaceSecondary, COLORS.surfaceSecondary]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={{
                paddingVertical: 16,
                alignItems: 'center',
                justifyContent: 'center',
                flexDirection: 'row',
              }}
            >
              <Ionicons
                name="person-add"
                size={20}
                color={isValid ? '#000' : COLORS.textTertiary}
              />
              <Text
                style={{
                  color: isValid ? '#000' : COLORS.textTertiary,
                  fontSize: 16,
                  fontWeight: '600',
                  marginLeft: 8,
                }}
              >
                {isLoading ? 'Adding...' : 'Add Contact'}
              </Text>
            </LinearGradient>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

import React, { useState } from 'react';
import { View, Text, TouchableOpacity, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { PublicKey } from '@solana/web3.js';
import { CreateStreamForm, StreamFormData } from '../../../components/streams';
import { useStreamStore } from '../../../stores/streamStore';
import { StreamFrequency } from '../../../services/solana/streams';

// Protocol 01 Color System
const COLORS = {
  pink: '#ff77a8',
  pinkDim: '#cc5f86',
  void: '#0a0a0c',
  text: '#ffffff',
};

export default function CreatePersonalStreamScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { createNewStream, loading } = useStreamStore();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleCreateStream = async (data: StreamFormData) => {
    try {
      setIsSubmitting(true);
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      // Validate address
      try {
        new PublicKey(data.recipient);
      } catch {
        Alert.alert('Invalid Address', 'Please enter a valid Solana wallet address.');
        setIsSubmitting(false);
        return;
      }

      // Calculate end date based on duration
      const now = Date.now();
      const endDate = now + data.duration * 24 * 60 * 60 * 1000;

      // Use the frequency selected by user
      const frequency: StreamFrequency = data.frequency;

      // Create the personal payment stream
      const stream = await createNewStream({
        name: data.name || `Payment to ${data.recipient.slice(0, 8)}...`,
        recipientAddress: data.recipient,
        totalAmount: data.amount,
        frequency,
        endDate,
      });

      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      Alert.alert(
        'Payment Stream Created!',
        `Your recurring payment of ${data.amount} ${data.token} has been set up.\n\nFirst payment will be processed immediately.`,
        [
          {
            text: 'View Stream',
            onPress: () => router.replace(`/(main)/(streams)/${stream.id}`),
          },
          {
            text: 'Done',
            onPress: () => router.back(),
          },
        ]
      );
    } catch (error: any) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Error', error.message || 'Failed to create payment stream. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: COLORS.void }}>
      {/* Header */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 16,
          paddingVertical: 12,
          paddingTop: insets.top + 8,
        }}
      >
        <TouchableOpacity
          onPress={() => router.back()}
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            backgroundColor: 'rgba(255, 119, 168, 0.2)',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons name="close" size={24} color={COLORS.pink} />
        </TouchableOpacity>

        <View style={{ alignItems: 'center' }}>
          <Text style={{ color: COLORS.text, fontSize: 17, fontWeight: '600' }}>
            Personal Payment
          </Text>
          <Text style={{ color: COLORS.pink, fontSize: 11, marginTop: 2 }}>
            Salary, allowance, or recurring transfer
          </Text>
        </View>

        <View style={{ width: 40 }} />
      </View>

      {/* Form */}
      <View style={{ flex: 1, paddingHorizontal: 16, paddingTop: 8 }}>
        <CreateStreamForm
          onSubmit={handleCreateStream}
          loading={loading || isSubmitting}
          accentColor={COLORS.pink}
          submitLabel="Create Payment Stream"
          hideServiceSelector={true}
        />
      </View>
    </View>
  );
}

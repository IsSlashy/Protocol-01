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

const VIOLET = '#8b5cf6';

export default function CreateStreamScreen() {
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

      // Determine frequency based on duration
      let frequency: StreamFrequency = 'daily';
      if (data.duration >= 30) {
        frequency = 'weekly';
      } else if (data.duration >= 14) {
        frequency = 'biweekly';
      } else if (data.duration >= 7) {
        frequency = 'daily';
      }

      // Create the stream with service info
      const stream = await createNewStream({
        name: data.name || `Stream to ${data.recipient.slice(0, 8)}...`,
        recipientAddress: data.recipient,
        totalAmount: data.amount,
        frequency,
        endDate,
        // Include detected/selected service info
        serviceId: data.serviceId,
        serviceName: data.serviceName,
        serviceCategory: data.serviceCategory,
        serviceColor: data.serviceColor,
      });

      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      Alert.alert(
        'Stream Created!',
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
      Alert.alert('Error', error.message || 'Failed to create stream. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <View className="flex-1 bg-p01-void">
      {/* Header */}
      <View
        className="flex-row items-center justify-between px-4 py-3"
        style={{ paddingTop: insets.top + 8 }}
      >
        <TouchableOpacity
          onPress={() => router.back()}
          className="w-10 h-10 rounded-full items-center justify-center"
          style={{ backgroundColor: 'rgba(139, 92, 246, 0.2)' }}
        >
          <Ionicons name="close" size={24} color={VIOLET} />
        </TouchableOpacity>

        <Text className="text-white text-lg font-semibold">Create Stream</Text>

        <View className="w-10" />
      </View>

      {/* Form */}
      <View className="flex-1 px-4 pt-4">
        <CreateStreamForm
          onSubmit={handleCreateStream}
          loading={loading || isSubmitting}
        />
      </View>
    </View>
  );
}

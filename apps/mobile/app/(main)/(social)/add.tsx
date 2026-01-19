import React, { useState } from 'react';
import { View, Text, TouchableOpacity, KeyboardAvoidingView, Platform, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { AddContactForm, ContactFormData } from '@/components/social';

export default function AddContactScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (data: ContactFormData) => {
    setLoading(true);

    // Simulate API call
    await new Promise((resolve) => setTimeout(resolve, 1500));

    console.log('Adding contact:', data);

    setLoading(false);

    // Show success and navigate back
    Alert.alert(
      'Contact Added',
      `${data.nickname} has been added to your contacts.`,
      [
        {
          text: 'OK',
          onPress: () => router.back(),
        },
      ]
    );
  };

  const handleScanQR = () => {
    // Navigate to QR scanner
    Alert.alert('QR Scanner', 'QR Scanner would open here');
  };

  return (
    <SafeAreaView className="flex-1 bg-p01-void">
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        {/* Header */}
        <View className="flex-row items-center px-5 py-4">
          <TouchableOpacity
            className="w-10 h-10 rounded-full bg-p01-surface items-center justify-center"
            onPress={() => router.back()}
            style={{
              borderWidth: 1,
              borderColor: 'rgba(59, 130, 246, 0.2)',
            }}
          >
            <Ionicons name="arrow-back" size={20} color="#3b82f6" />
          </TouchableOpacity>
          <Text className="flex-1 text-white text-xl font-bold ml-4">
            Add Contact
          </Text>
        </View>

        {/* Info Banner */}
        <View
          className="mx-5 mb-6 p-4 rounded-xl"
          style={{
            backgroundColor: 'rgba(59, 130, 246, 0.1)',
            borderWidth: 1,
            borderColor: 'rgba(59, 130, 246, 0.2)',
          }}
        >
          <View className="flex-row items-start">
            <Ionicons name="shield-checkmark" size={24} color="#3b82f6" />
            <View className="flex-1 ml-3">
              <Text className="text-white font-semibold">Encrypted Contacts</Text>
              <Text className="text-p01-text-secondary text-sm mt-1">
                Your contact list is encrypted and stored locally. Only you can see your contacts.
              </Text>
            </View>
          </View>
        </View>

        {/* Form */}
        <View className="flex-1 px-5">
          <AddContactForm
            onSubmit={handleSubmit}
            onScanQR={handleScanQR}
            loading={loading}
          />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

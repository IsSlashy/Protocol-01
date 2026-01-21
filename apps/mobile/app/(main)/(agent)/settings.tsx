import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

export default function AISettingsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  return (
    <View className="flex-1 bg-p01-void" style={{ paddingTop: insets.top }}>
      {/* Header */}
      <View className="flex-row items-center px-4 py-4">
        <TouchableOpacity
          onPress={() => router.back()}
          className="w-10 h-10 rounded-full bg-p01-surface items-center justify-center"
        >
          <Ionicons name="arrow-back" size={20} color="#fff" />
        </TouchableOpacity>
        <Text className="text-white text-lg font-semibold ml-3">P-01 Agent</Text>
      </View>

      {/* Coming Soon */}
      <View className="flex-1 items-center justify-center px-8">
        <View
          className="w-20 h-20 rounded-full items-center justify-center mb-4"
          style={{ backgroundColor: 'rgba(34, 211, 238, 0.1)' }}
        >
          <Ionicons name="settings-outline" size={36} color="#22d3ee" />
        </View>
        <Text className="text-white text-xl font-semibold mb-2">
          Configuration
        </Text>
        <Text className="text-cyan-400 text-base mb-4">
          Coming Soon
        </Text>
        <Text className="text-p01-text-muted text-center text-sm">
          AI agent settings will be available soon.
        </Text>
      </View>
    </View>
  );
}

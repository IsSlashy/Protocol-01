import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Animated, { FadeIn, FadeInUp } from 'react-native-reanimated';

export default function ActionHistory() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  return (
    <View className="flex-1 bg-p01-void" style={{ paddingTop: insets.top }}>
      {/* Header */}
      <Animated.View
        entering={FadeIn}
        className="flex-row items-center px-4 py-3 border-b border-p01-border"
      >
        <TouchableOpacity
          onPress={() => router.back()}
          className="w-10 h-10 rounded-full items-center justify-center"
        >
          <Ionicons name="chevron-back" size={24} color="#ffffff" />
        </TouchableOpacity>
        <Text className="text-white font-semibold text-lg ml-2">History</Text>
      </Animated.View>

      {/* Coming Soon Content */}
      <View className="flex-1 items-center justify-center px-8">
        <Animated.View
          entering={FadeInUp.delay(100)}
          className="items-center"
        >
          {/* Icon */}
          <View
            className="w-24 h-24 rounded-full items-center justify-center mb-6"
            style={{ backgroundColor: 'rgba(139, 92, 246, 0.1)' }}
          >
            <Ionicons name="time-outline" size={48} color="#8b5cf6" />
          </View>

          {/* Title */}
          <Text className="text-white text-2xl font-bold mb-3">
            History
          </Text>

          {/* Subtitle */}
          <Text className="text-violet-400 text-lg font-medium mb-6">
            Coming Soon
          </Text>

          {/* Description */}
          <Text className="text-p01-text-muted text-center text-base leading-6">
            Your AI agent interaction history will be available soon.
          </Text>
        </Animated.View>
      </View>
    </View>
  );
}

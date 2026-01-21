import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Animated, { FadeIn, FadeInUp } from 'react-native-reanimated';

export default function AgentChat() {
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
        <Text className="text-white font-semibold text-lg ml-2">P-01 Agent</Text>
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
            style={{ backgroundColor: 'rgba(34, 211, 238, 0.1)' }}
          >
            <Ionicons name="sparkles" size={48} color="#22d3ee" />
          </View>

          {/* Title */}
          <Text className="text-white text-2xl font-bold mb-3">
            P-01 Agent
          </Text>

          {/* Subtitle */}
          <Text className="text-cyan-400 text-lg font-medium mb-6">
            Coming Soon
          </Text>

          {/* Description */}
          <Text className="text-p01-text-muted text-center text-base leading-6">
            Your personal AI assistant to analyze your subscriptions and optimize your finances.
          </Text>

          {/* Features Preview */}
          <View className="mt-8 w-full">
            <FeatureItem
              icon="analytics-outline"
              text="Smart stream analysis"
            />
            <FeatureItem
              icon="cash-outline"
              text="Savings recommendations"
            />
            <FeatureItem
              icon="notifications-outline"
              text="Renewal alerts"
            />
            <FeatureItem
              icon="chatbubbles-outline"
              text="Conversational assistant"
            />
          </View>
        </Animated.View>
      </View>
    </View>
  );
}

function FeatureItem({ icon, text }: { icon: string; text: string }) {
  return (
    <View className="flex-row items-center py-3">
      <View
        className="w-10 h-10 rounded-full items-center justify-center mr-4"
        style={{ backgroundColor: 'rgba(34, 211, 238, 0.1)' }}
      >
        <Ionicons name={icon as any} size={20} color="#22d3ee" />
      </View>
      <Text className="text-white text-base flex-1">{text}</Text>
      <Ionicons name="checkmark" size={18} color="#22d3ee" />
    </View>
  );
}

import React from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';

import { AgentAvatar } from '@/components/agent';

// App theme colors
const COLORS = {
  primary: '#00ff88',
  cyan: '#00D1FF',
  purple: '#9945FF',
  background: '#050505',
  surface: '#0a0a0a',
  surfaceSecondary: '#111111',
  border: '#1f1f1f',
  borderLight: '#2a2a2a',
  text: '#ffffff',
  textSecondary: '#a0a0a0',
  textTertiary: '#666666',
};

// Features coming soon
const UPCOMING_FEATURES = [
  {
    icon: 'analytics-outline',
    title: 'Smart Analysis',
    desc: 'Analyze your streams and optimize spending',
    color: COLORS.cyan,
  },
  {
    icon: 'cash-outline',
    title: 'Recommendations',
    desc: 'Personalized savings suggestions',
    color: COLORS.primary,
  },
  {
    icon: 'notifications-outline',
    title: 'Proactive Alerts',
    desc: 'Renewal notifications and anomaly detection',
    color: COLORS.purple,
  },
  {
    icon: 'chatbubbles-outline',
    title: 'AI Assistant',
    desc: 'Ask questions in natural language',
    color: COLORS.cyan,
  },
  {
    icon: 'shield-checkmark-outline',
    title: 'On-device Security',
    desc: 'Local AI for maximum privacy',
    color: COLORS.primary,
  },
  {
    icon: 'flash-outline',
    title: 'Quick Actions',
    desc: 'Execute transactions by voice',
    color: COLORS.purple,
  },
];

export default function AgentDashboard() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  return (
    <View className="flex-1 bg-p01-void">
      {/* Background gradient */}
      <LinearGradient
        colors={['rgba(0, 209, 255, 0.05)', 'rgba(153, 69, 255, 0.02)', 'transparent']}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 350,
        }}
      />

      <ScrollView
        className="flex-1"
        contentContainerStyle={{
          paddingTop: insets.top,
          paddingBottom: insets.bottom + 40,
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <Animated.View
          entering={FadeInDown.delay(100).springify()}
          className="flex-row items-center justify-between px-6 py-4"
        >
          <View className="flex-row items-center">
            <Ionicons name="sparkles" size={24} color={COLORS.cyan} />
            <Text className="text-white text-xl font-bold ml-2 tracking-wide">
              P-01 AGENT
            </Text>
          </View>
          <TouchableOpacity
            onPress={() => router.back()}
            className="w-10 h-10 rounded-full items-center justify-center"
            style={{ backgroundColor: 'rgba(255, 255, 255, 0.08)' }}
          >
            <Ionicons name="close" size={20} color={COLORS.textSecondary} />
          </TouchableOpacity>
        </Animated.View>

        {/* Agent Status Card - Coming Soon */}
        <Animated.View
          entering={FadeInDown.delay(200).springify()}
          className="px-6 mb-8"
        >
          <LinearGradient
            colors={[COLORS.surfaceSecondary, COLORS.surface]}
            style={{
              borderRadius: 24,
              padding: 32,
              borderWidth: 1,
              borderColor: 'rgba(0, 209, 255, 0.2)',
            }}
          >
            <View className="items-center">
              <AgentAvatar size="xl" isActive={false} />

              <View
                className="mt-5 px-4 py-1.5 rounded-full"
                style={{ backgroundColor: 'rgba(0, 209, 255, 0.15)' }}
              >
                <Text
                  className="text-sm font-semibold tracking-wider"
                  style={{ color: COLORS.cyan }}
                >
                  COMING SOON
                </Text>
              </View>

              <Text className="text-white text-2xl font-bold mt-4 mb-2">
                P-01 Agent
              </Text>

              <Text
                className="text-center px-4 leading-relaxed"
                style={{ color: COLORS.textSecondary }}
              >
                Your personal AI assistant to analyze your subscriptions and optimize your crypto finances.
              </Text>
            </View>
          </LinearGradient>
        </Animated.View>

        {/* Upcoming Features */}
        <Animated.View
          entering={FadeInDown.delay(300).springify()}
          className="px-6"
        >
          <Text
            className="text-sm font-semibold tracking-wider uppercase mb-4"
            style={{ color: COLORS.textTertiary }}
          >
            Upcoming Features
          </Text>

          <LinearGradient
            colors={[COLORS.surfaceSecondary, COLORS.surface]}
            style={{
              borderRadius: 16,
              borderWidth: 1,
              borderColor: COLORS.borderLight,
              overflow: 'hidden',
            }}
          >
            {UPCOMING_FEATURES.map((item, index) => (
              <View
                key={item.title}
                className="flex-row items-center p-4"
                style={{
                  borderBottomWidth: index < UPCOMING_FEATURES.length - 1 ? 1 : 0,
                  borderBottomColor: COLORS.borderLight,
                }}
              >
                <View
                  className="w-10 h-10 rounded-xl items-center justify-center mr-4"
                  style={{ backgroundColor: item.color + '15' }}
                >
                  <Ionicons name={item.icon as any} size={20} color={item.color} />
                </View>
                <View className="flex-1">
                  <Text className="text-white font-medium">{item.title}</Text>
                  <Text
                    className="text-xs mt-0.5"
                    style={{ color: COLORS.textTertiary }}
                  >
                    {item.desc}
                  </Text>
                </View>
                <Ionicons name="checkmark" size={18} color={item.color} />
              </View>
            ))}
          </LinearGradient>
        </Animated.View>

        {/* Bottom info */}
        <Animated.View
          entering={FadeInDown.delay(400).springify()}
          className="px-6 mt-8"
        >
          <View
            className="flex-row items-center p-4 rounded-xl"
            style={{ backgroundColor: 'rgba(153, 69, 255, 0.1)' }}
          >
            <Ionicons name="information-circle" size={24} color={COLORS.purple} />
            <Text
              className="flex-1 ml-3 text-sm"
              style={{ color: COLORS.textSecondary }}
            >
              P-01 Agent will use on-device AI to ensure the privacy of your financial data.
            </Text>
          </View>
        </Animated.View>
      </ScrollView>
    </View>
  );
}

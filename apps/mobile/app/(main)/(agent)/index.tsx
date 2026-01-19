import React from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';

import { AgentAvatar, QuickActionButton } from '@/components/agent';
import { useAIStore } from '@/stores/aiStore';

// App theme colors
const COLORS = {
  primary: '#00ff88',    // Green
  cyan: '#00D1FF',       // Cyan
  purple: '#9945FF',     // Purple
  background: '#050505',
  surface: '#0a0a0a',
  surfaceSecondary: '#111111',
  border: '#1f1f1f',
  borderLight: '#2a2a2a',
  text: '#ffffff',
  textSecondary: '#a0a0a0',
  textTertiary: '#666666',
};

interface RecentAction {
  id: string;
  type: 'swap' | 'send' | 'query';
  description: string;
  timestamp: string;
  status: 'completed' | 'pending' | 'failed';
}

// Real actions will come from aiStore - empty by default
const getRecentActions = (): RecentAction[] => {
  // In production, this would fetch from aiStore history
  return [];
};

const actionTypeIcons: Record<string, keyof typeof Ionicons.glyphMap> = {
  swap: 'swap-horizontal',
  send: 'arrow-up',
  query: 'chatbubble-outline',
};

const actionTypeColors: Record<string, string> = {
  swap: COLORS.cyan,
  send: COLORS.primary,
  query: COLORS.purple,
};

const statusColors: Record<string, string> = {
  completed: COLORS.primary,
  pending: COLORS.cyan,
  failed: '#ef4444',
};

export default function AgentDashboard() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { isConnected, initialize, config } = useAIStore();

  React.useEffect(() => {
    initialize();
  }, []);

  const handleQuickAction = (action: string) => {
    router.push({
      pathname: '/(main)/(agent)/chat',
      params: { action },
    });
  };

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
          paddingBottom: insets.bottom + 100,
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
              AI AGENT
            </Text>
          </View>
          <TouchableOpacity
            onPress={() => router.push('/(main)/(agent)/settings')}
            className="w-10 h-10 rounded-full items-center justify-center"
            style={{ backgroundColor: 'rgba(255, 255, 255, 0.08)' }}
          >
            <Ionicons name="settings-outline" size={20} color={COLORS.textSecondary} />
          </TouchableOpacity>
        </Animated.View>

        {/* Agent Status Card */}
        <Animated.View
          entering={FadeInDown.delay(200).springify()}
          className="px-6 mb-6"
        >
          <LinearGradient
            colors={[COLORS.surfaceSecondary, COLORS.surface]}
            style={{
              borderRadius: 20,
              padding: 24,
              borderWidth: 1,
              borderColor: isConnected ? 'rgba(0, 209, 255, 0.3)' : COLORS.border,
            }}
          >
            <View className="items-center">
              <AgentAvatar size="xl" isActive={isConnected} />

              <Text className="text-white text-lg font-semibold mt-5 mb-2">
                {isConnected ? 'AI Ready' : 'Setup Required'}
              </Text>

              <Text className="text-center px-4 leading-relaxed" style={{ color: COLORS.textSecondary }}>
                {isConnected
                  ? `Connected to ${config.model}\nReady to assist with your queries`
                  : 'Configure an AI provider to enable\nintelligent assistance'}
              </Text>

              {!isConnected && (
                <TouchableOpacity
                  onPress={() => router.push('/(main)/(agent)/settings')}
                  className="mt-5 px-6 py-3 rounded-xl flex-row items-center"
                  style={{ backgroundColor: 'rgba(0, 209, 255, 0.12)' }}
                >
                  <Ionicons name="cog-outline" size={18} color={COLORS.cyan} />
                  <Text className="font-semibold ml-2" style={{ color: COLORS.cyan }}>
                    Configure AI
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          </LinearGradient>
        </Animated.View>

        {/* Quick Actions */}
        <Animated.View
          entering={FadeInDown.delay(300).springify()}
          className="px-6 mb-6"
        >
          <Text className="text-sm font-semibold tracking-wider uppercase mb-4" style={{ color: COLORS.textTertiary }}>
            Quick Actions
          </Text>

          <View className="flex-row gap-3 mb-3">
            <QuickActionButton
              icon="swap-horizontal"
              label="Swap"
              onPress={() => handleQuickAction('swap')}
              color={COLORS.cyan}
            />
            <QuickActionButton
              icon="arrow-up"
              label="Send"
              onPress={() => handleQuickAction('send')}
              color={COLORS.primary}
            />
          </View>

          <View className="flex-row gap-3">
            <QuickActionButton
              icon="wallet-outline"
              label="Balance"
              onPress={() => handleQuickAction('balance')}
              color={COLORS.purple}
            />
            <QuickActionButton
              icon="help-circle-outline"
              label="Ask"
              onPress={() => handleQuickAction('custom')}
              color={COLORS.cyan}
            />
          </View>
        </Animated.View>

        {/* Capabilities */}
        <Animated.View
          entering={FadeInDown.delay(350).springify()}
          className="px-6 mb-6"
        >
          <Text className="text-sm font-semibold tracking-wider uppercase mb-4" style={{ color: COLORS.textTertiary }}>
            Capabilities
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
            {[
              { icon: 'chatbubbles-outline', title: 'Natural Conversations', desc: 'Chat naturally about crypto', color: COLORS.cyan },
              { icon: 'shield-checkmark-outline', title: 'Secure Assistance', desc: 'Private, on-device AI', color: COLORS.primary },
              { icon: 'flash-outline', title: 'Quick Actions', desc: 'Execute transactions fast', color: COLORS.purple },
            ].map((item, index) => (
              <View
                key={item.title}
                className="flex-row items-center p-4"
                style={{
                  borderBottomWidth: index < 2 ? 1 : 0,
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
                  <Text className="text-xs mt-0.5" style={{ color: COLORS.textTertiary }}>
                    {item.desc}
                  </Text>
                </View>
              </View>
            ))}
          </LinearGradient>
        </Animated.View>

        {/* Recent Activity */}
        <Animated.View
          entering={FadeInDown.delay(400).springify()}
          className="px-6"
        >
          <View className="flex-row items-center justify-between mb-4">
            <Text className="text-sm font-semibold tracking-wider uppercase" style={{ color: COLORS.textTertiary }}>
              Recent Activity
            </Text>
            <TouchableOpacity onPress={() => router.push('/(main)/(agent)/history')}>
              <Text className="text-sm font-medium" style={{ color: COLORS.cyan }}>
                See All
              </Text>
            </TouchableOpacity>
          </View>

          <LinearGradient
            colors={[COLORS.surfaceSecondary, COLORS.surface]}
            style={{
              borderRadius: 16,
              borderWidth: 1,
              borderColor: COLORS.borderLight,
              overflow: 'hidden',
            }}
          >
            {getRecentActions().length === 0 ? (
              <View className="items-center py-8 px-4">
                <View
                  className="w-12 h-12 rounded-full items-center justify-center mb-3"
                  style={{ backgroundColor: COLORS.purple + '15' }}
                >
                  <Ionicons name="time-outline" size={24} color={COLORS.purple} />
                </View>
                <Text className="text-center" style={{ color: COLORS.textSecondary }}>
                  No recent activity
                </Text>
                <Text className="text-center text-xs mt-1" style={{ color: COLORS.textTertiary }}>
                  Start a conversation with the AI agent
                </Text>
              </View>
            ) : (
              getRecentActions().map((action, index) => (
                <TouchableOpacity
                  key={action.id}
                  className="flex-row items-center p-4"
                  style={{
                    borderBottomWidth: index < getRecentActions().length - 1 ? 1 : 0,
                    borderBottomColor: COLORS.borderLight,
                  }}
                  activeOpacity={0.7}
                >
                  <View
                    className="w-10 h-10 rounded-xl items-center justify-center mr-3"
                    style={{ backgroundColor: actionTypeColors[action.type] + '15' }}
                  >
                    <Ionicons
                      name={actionTypeIcons[action.type]}
                      size={18}
                      color={actionTypeColors[action.type]}
                    />
                  </View>
                  <View className="flex-1">
                    <Text className="text-white font-medium">{action.description}</Text>
                    <Text className="text-xs mt-0.5" style={{ color: COLORS.textTertiary }}>
                      {action.timestamp}
                    </Text>
                  </View>
                  <View
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: statusColors[action.status] }}
                  />
                </TouchableOpacity>
              ))
            )}
          </LinearGradient>
        </Animated.View>
      </ScrollView>

      {/* Chat Button */}
      <Animated.View
        entering={FadeInDown.delay(500).springify()}
        className="absolute bottom-0 left-0 right-0 px-6"
        style={{ paddingBottom: insets.bottom + 20 }}
      >
        <TouchableOpacity
          onPress={() => router.push('/(main)/(agent)/chat')}
          activeOpacity={0.9}
        >
          <LinearGradient
            colors={[COLORS.cyan, COLORS.purple]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={{
              borderRadius: 16,
              paddingVertical: 18,
              alignItems: 'center',
              justifyContent: 'center',
              flexDirection: 'row',
              shadowColor: COLORS.cyan,
              shadowOpacity: 0.4,
              shadowRadius: 16,
              shadowOffset: { width: 0, height: 4 },
              elevation: 10,
            }}
          >
            <Ionicons name="chatbubble-ellipses" size={20} color="#000000" />
            <Text className="font-bold text-base ml-2" style={{ color: '#000000' }}>
              Start Conversation
            </Text>
          </LinearGradient>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  Pressable,
  Alert,
  ActivityIndicator,
  Dimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown, FadeIn } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { useStreamStore } from '../../../stores/streamStore';
import { useWalletStore } from '../../../stores/walletStore';
import { Stream, formatFrequency } from '../../../services/solana/streams';
import { getKeypair } from '../../../services/solana/wallet';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const TAB_BAR_HEIGHT = 85;

// Protocol 01 Color System - matching website
const COLORS = {
  // Primary
  cyan: '#39c5bb',
  cyanDim: '#2a9d95',
  // Accents
  pink: '#ff77a8',
  brightCyan: '#00ffe5',
  yellow: '#ffcc00',
  red: '#ff3366',
  green: '#00ff88',
  // Text
  text: '#ffffff',
  textMuted: '#888892',
  textDim: '#555560',
  // Surfaces
  void: '#0a0a0c',
  dark: '#0f0f12',
  surface: '#151518',
  surface2: '#1a1a1e',
  border: '#2a2a30',
  borderHover: '#3a3a42',
};

// Mock SDK Services - In production, these come from SDK providers
const SDK_SERVICES = [
  { id: 'netflix', name: 'Netflix', icon: 'play-circle', price: 0.15, frequency: 'monthly' as const, category: 'Entertainment' },
  { id: 'spotify', name: 'Spotify', icon: 'musical-notes', price: 0.08, frequency: 'monthly' as const, category: 'Music' },
  { id: 'chatgpt', name: 'ChatGPT Plus', icon: 'chatbubbles', price: 0.18, frequency: 'monthly' as const, category: 'AI' },
  { id: 'github', name: 'GitHub Pro', icon: 'logo-github', price: 0.04, frequency: 'monthly' as const, category: 'Dev Tools' },
  { id: 'figma', name: 'Figma', icon: 'color-palette', price: 0.12, frequency: 'monthly' as const, category: 'Design' },
  { id: 'notion', name: 'Notion', icon: 'document-text', price: 0.07, frequency: 'monthly' as const, category: 'Productivity' },
];

type FilterType = 'all' | 'active' | 'paused' | 'history';
type SectionType = 'services' | 'personal';

export default function StreamsDashboard() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState<FilterType>('all');
  const [activeSection, setActiveSection] = useState<SectionType>('personal');
  const [showPrivacyInfo, setShowPrivacyInfo] = useState(false);

  const { publicKey } = useWalletStore();
  const {
    streams,
    stats,
    loading,
    refreshing,
    syncing,
    initialize,
    refresh,
    syncFromChain,
    resetAll,
    cancelAllWithSync,
  } = useStreamStore();

  useEffect(() => {
    initialize(publicKey || undefined);
  }, [publicKey]);

  const onRefresh = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await refresh(publicKey || undefined);
  };

  const handleSync = async () => {
    if (!publicKey) {
      Alert.alert('Wallet Required', 'Connect a wallet to sync from blockchain.');
      return;
    }
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      const result = await syncFromChain(publicKey);
      if (result.newStreams > 0 || result.updatedStreams > 0) {
        Alert.alert('Sync Complete', `Found ${result.newStreams} new, ${result.updatedStreams} updated`);
      }
    } catch (error) {
      console.error('Sync failed:', error);
    }
  };

  const handleSubscribeService = (service: typeof SDK_SERVICES[0]) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    // Navigate to subscribe flow with pre-filled service data
    router.push({
      pathname: '/(main)/(streams)/subscribe',
      params: {
        serviceId: service.id,
        serviceName: service.name,
        price: service.price.toString(),
        frequency: service.frequency,
      },
    });
  };

  const handleCreatePersonalStream = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    router.push('/(main)/(streams)/create');
  };

  // Filter subscriptions
  const filteredStreams = streams.filter((s) => {
    if (filter === 'active') return s.status === 'active';
    if (filter === 'paused') return s.status === 'paused';
    if (filter === 'history') return s.status === 'cancelled' || s.status === 'completed';
    return s.status !== 'cancelled' && s.status !== 'completed';
  });

  const sortedStreams = [...filteredStreams].sort((a, b) => {
    if (a.status !== 'active' && b.status === 'active') return 1;
    if (a.status === 'active' && b.status !== 'active') return -1;
    return a.nextPaymentDate - b.nextPaymentDate;
  });

  // Separate streams by type (SDK services vs personal)
  const serviceStreams = sortedStreams.filter(s =>
    SDK_SERVICES.some(svc => s.name.toLowerCase().includes(svc.name.toLowerCase()))
  );
  const personalStreams = sortedStreams.filter(s =>
    !SDK_SERVICES.some(svc => s.name.toLowerCase().includes(svc.name.toLowerCase()))
  );

  // Counts
  const activeCount = streams.filter(s => s.status === 'active').length;
  const pausedCount = streams.filter(s => s.status === 'paused').length;

  // Privacy score
  const privacyScore = activeCount > 0
    ? Math.round(
        (streams.filter(s =>
          s.status === 'active' &&
          (s.amountNoise > 0 || s.timingNoise > 0 || s.useStealthAddress)
        ).length / activeCount) * 100
      )
    : 0;

  // Next payment
  const activeStreams = streams.filter(s => s.status === 'active');
  const nextDue = activeStreams.length > 0
    ? Math.min(...activeStreams.map(s => s.nextPaymentDate))
    : null;

  return (
    <View style={{ flex: 1, backgroundColor: COLORS.void }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingTop: insets.top + 8,
          paddingBottom: TAB_BAR_HEIGHT + insets.bottom + 24,
        }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={COLORS.cyan}
          />
        }
      >
        {/* Summary Card */}
        <View style={{ padding: 16 }}>
          <Animated.View entering={FadeIn.duration(300)}>
            <LinearGradient
              colors={['rgba(57, 197, 187, 0.15)', COLORS.surface]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={{
                borderRadius: 16,
                padding: 16,
                borderWidth: 1,
                borderColor: 'rgba(57, 197, 187, 0.3)',
              }}
            >
              {/* Header row */}
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Ionicons name="repeat" size={20} color={COLORS.cyan} />
                  <Text style={{ color: COLORS.cyan, fontSize: 14, fontWeight: '500' }}>
                    Stream Secure
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TouchableOpacity
                    onPress={handleSync}
                    disabled={syncing}
                    style={{ padding: 6, borderRadius: 8, backgroundColor: 'rgba(21, 21, 24, 0.5)' }}
                  >
                    {syncing ? (
                      <ActivityIndicator size={16} color={COLORS.cyan} />
                    ) : (
                      <Ionicons name="sync" size={16} color={COLORS.cyan} />
                    )}
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => setShowPrivacyInfo(!showPrivacyInfo)}
                    style={{ padding: 6, borderRadius: 8, backgroundColor: 'rgba(21, 21, 24, 0.5)' }}
                  >
                    <Ionicons name="shield" size={16} color={COLORS.cyan} />
                  </TouchableOpacity>
                </View>
              </View>

              {/* Amount */}
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
                <Text style={{ color: COLORS.text, fontSize: 28, fontWeight: '700' }}>
                  {stats.monthlyOutflow.toFixed(2)}
                </Text>
                <Text style={{ color: COLORS.textMuted, fontSize: 14 }}>SOL/month</Text>
              </View>

              {/* Stats row */}
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
                <Text style={{ color: COLORS.textMuted, fontSize: 12 }}>
                  {activeCount} active stream{activeCount !== 1 ? 's' : ''}
                </Text>
                {nextDue && (
                  <Text style={{ color: COLORS.textMuted, fontSize: 12 }}>
                    Next: {new Date(nextDue).toLocaleDateString()}
                  </Text>
                )}
              </View>

              {/* Privacy Score */}
              {streams.length > 0 && (
                <View style={{ marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: 'rgba(42, 42, 48, 0.5)' }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                    <Text style={{ color: COLORS.textMuted, fontSize: 12 }}>Privacy Score</Text>
                    <Text style={{ color: COLORS.cyan, fontSize: 12, fontWeight: '500' }}>{privacyScore}%</Text>
                  </View>
                  <View style={{ height: 6, backgroundColor: COLORS.border, borderRadius: 3, overflow: 'hidden' }}>
                    <Animated.View
                      style={{
                        height: '100%',
                        width: `${privacyScore}%`,
                        borderRadius: 3,
                        backgroundColor: COLORS.cyan,
                      }}
                    />
                  </View>
                </View>
              )}
            </LinearGradient>
          </Animated.View>

          {/* Privacy Info Panel */}
          {showPrivacyInfo && (
            <Animated.View
              entering={FadeInDown.duration(200)}
              style={{
                marginTop: 12,
                backgroundColor: COLORS.surface,
                borderRadius: 16,
                padding: 16,
                borderWidth: 1,
                borderColor: 'rgba(57, 197, 187, 0.3)',
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <Ionicons name="shield-checkmark" size={16} color={COLORS.cyan} />
                <Text style={{ color: COLORS.cyan, fontSize: 14, fontWeight: '600' }}>Privacy Features</Text>
              </View>

              <View style={{ gap: 12 }}>
                <View style={{ flexDirection: 'row', gap: 12 }}>
                  <View style={{ width: 32, height: 32, borderRadius: 8, backgroundColor: 'rgba(57, 197, 187, 0.1)', alignItems: 'center', justifyContent: 'center' }}>
                    <Ionicons name="shuffle" size={16} color={COLORS.cyan} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: COLORS.text, fontSize: 12, fontWeight: '500' }}>Amount Noise</Text>
                    <Text style={{ color: COLORS.textMuted, fontSize: 11 }}>Vary amounts by up to 20%</Text>
                  </View>
                </View>

                <View style={{ flexDirection: 'row', gap: 12 }}>
                  <View style={{ width: 32, height: 32, borderRadius: 8, backgroundColor: 'rgba(57, 197, 187, 0.1)', alignItems: 'center', justifyContent: 'center' }}>
                    <Ionicons name="time" size={16} color={COLORS.cyan} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: COLORS.text, fontSize: 12, fontWeight: '500' }}>Timing Noise</Text>
                    <Text style={{ color: COLORS.textMuted, fontSize: 11 }}>Randomize payment times</Text>
                  </View>
                </View>

                <View style={{ flexDirection: 'row', gap: 12 }}>
                  <View style={{ width: 32, height: 32, borderRadius: 8, backgroundColor: 'rgba(255, 119, 168, 0.1)', alignItems: 'center', justifyContent: 'center' }}>
                    <Ionicons name="eye-off" size={16} color={COLORS.pink} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: COLORS.text, fontSize: 12, fontWeight: '500' }}>Stealth Addresses</Text>
                    <Text style={{ color: COLORS.textMuted, fontSize: 11 }}>Unique address per payment</Text>
                  </View>
                </View>
              </View>
            </Animated.View>
          )}
        </View>

        {/* Section Toggle */}
        <View style={{ paddingHorizontal: 16, marginBottom: 16 }}>
          <View style={{ flexDirection: 'row', gap: 4, padding: 4, backgroundColor: COLORS.surface, borderRadius: 12 }}>
            <Pressable
              onPress={() => {
                Haptics.selectionAsync();
                setActiveSection('personal');
              }}
              style={{
                flex: 1,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                paddingVertical: 12,
                borderRadius: 10,
                backgroundColor: activeSection === 'personal' ? COLORS.cyan : 'transparent',
              }}
            >
              <Ionicons
                name="person"
                size={18}
                color={activeSection === 'personal' ? COLORS.void : COLORS.textMuted}
              />
              <Text style={{
                fontSize: 13,
                fontWeight: '600',
                color: activeSection === 'personal' ? COLORS.void : COLORS.textMuted
              }}>
                Personal
              </Text>
            </Pressable>
            <Pressable
              onPress={() => {
                Haptics.selectionAsync();
                setActiveSection('services');
              }}
              style={{
                flex: 1,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                paddingVertical: 12,
                borderRadius: 10,
                backgroundColor: activeSection === 'services' ? COLORS.pink : 'transparent',
              }}
            >
              <Ionicons
                name="apps"
                size={18}
                color={activeSection === 'services' ? COLORS.void : COLORS.textMuted}
              />
              <Text style={{
                fontSize: 13,
                fontWeight: '600',
                color: activeSection === 'services' ? COLORS.void : COLORS.textMuted
              }}>
                Services
              </Text>
            </Pressable>
          </View>
        </View>

        {/* Services Section */}
        {activeSection === 'services' && (
          <View style={{ paddingHorizontal: 16 }}>
            {/* Section Header */}
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Ionicons name="apps" size={18} color={COLORS.pink} />
                <Text style={{ color: COLORS.text, fontSize: 16, fontWeight: '600' }}>Available Services</Text>
              </View>
              <Text style={{ color: COLORS.textMuted, fontSize: 12 }}>
                {SDK_SERVICES.length} services
              </Text>
            </View>

            {/* Info Banner */}
            <View style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              padding: 12,
              backgroundColor: 'rgba(255, 119, 168, 0.1)',
              borderRadius: 10,
              marginBottom: 16,
              borderWidth: 1,
              borderColor: 'rgba(255, 119, 168, 0.2)',
            }}>
              <Ionicons name="information-circle" size={20} color={COLORS.pink} />
              <Text style={{ color: COLORS.textMuted, fontSize: 12, flex: 1 }}>
                Prices are set by service providers via SDK. Subscribe with one tap.
              </Text>
            </View>

            {/* Services Grid */}
            <View style={{ gap: 10 }}>
              {SDK_SERVICES.map((service, index) => (
                <ServiceCard
                  key={service.id}
                  service={service}
                  index={index}
                  onSubscribe={() => handleSubscribeService(service)}
                  isSubscribed={serviceStreams.some(s =>
                    s.name.toLowerCase().includes(service.name.toLowerCase()) &&
                    s.status === 'active'
                  )}
                />
              ))}
            </View>

            {/* Active Subscriptions */}
            {serviceStreams.length > 0 && (
              <View style={{ marginTop: 24 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <Ionicons name="checkmark-circle" size={18} color={COLORS.green} />
                  <Text style={{ color: COLORS.text, fontSize: 14, fontWeight: '600' }}>
                    Your Subscriptions ({serviceStreams.length})
                  </Text>
                </View>
                <View style={{ gap: 10 }}>
                  {serviceStreams.map((stream, index) => (
                    <SubscriptionCard
                      key={stream.id}
                      subscription={stream}
                      index={index}
                      onPress={() => {
                        router.push({
                          pathname: '/(main)/(streams)/[id]',
                          params: { id: stream.id },
                        });
                      }}
                      accentColor={COLORS.pink}
                    />
                  ))}
                </View>
              </View>
            )}
          </View>
        )}

        {/* Personal Payments Section */}
        {activeSection === 'personal' && (
          <View style={{ paddingHorizontal: 16 }}>
            {/* Section Header */}
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Ionicons name="person" size={18} color={COLORS.cyan} />
                <Text style={{ color: COLORS.text, fontSize: 16, fontWeight: '600' }}>Personal Payments</Text>
              </View>
              <Text style={{ color: COLORS.textMuted, fontSize: 12 }}>
                {personalStreams.length} stream{personalStreams.length !== 1 ? 's' : ''}
              </Text>
            </View>

            {/* Info Banner */}
            <View style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              padding: 12,
              backgroundColor: 'rgba(57, 197, 187, 0.1)',
              borderRadius: 10,
              marginBottom: 16,
              borderWidth: 1,
              borderColor: 'rgba(57, 197, 187, 0.2)',
            }}>
              <Ionicons name="information-circle" size={20} color={COLORS.cyan} />
              <Text style={{ color: COLORS.textMuted, fontSize: 12, flex: 1 }}>
                Create custom payment streams for salaries, allowances, or recurring transfers.
              </Text>
            </View>

            {/* Create Button */}
            <TouchableOpacity
              onPress={handleCreatePersonalStream}
              activeOpacity={0.8}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                paddingVertical: 16,
                backgroundColor: COLORS.cyan,
                borderRadius: 12,
                marginBottom: 16,
              }}
            >
              <Ionicons name="add-circle" size={22} color={COLORS.void} />
              <Text style={{ color: COLORS.void, fontSize: 15, fontWeight: '600' }}>
                Create Payment Stream
              </Text>
            </TouchableOpacity>

            {/* Personal Streams List */}
            {loading && personalStreams.length === 0 ? (
              <View style={{ alignItems: 'center', paddingVertical: 48 }}>
                <ActivityIndicator size="large" color={COLORS.cyan} />
              </View>
            ) : personalStreams.length === 0 ? (
              <View style={{ alignItems: 'center', justifyContent: 'center', paddingVertical: 32 }}>
                <View style={{
                  width: 64,
                  height: 64,
                  borderRadius: 32,
                  backgroundColor: 'rgba(57, 197, 187, 0.1)',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: 16,
                }}>
                  <Ionicons name="wallet-outline" size={28} color={COLORS.cyan} />
                </View>
                <Text style={{ color: COLORS.textMuted, fontSize: 14, textAlign: 'center', marginBottom: 4 }}>
                  No personal streams yet
                </Text>
                <Text style={{ color: COLORS.textDim, fontSize: 12, textAlign: 'center' }}>
                  Create one to pay salaries or recurring transfers
                </Text>
              </View>
            ) : (
              <View style={{ gap: 10 }}>
                {personalStreams.map((stream, index) => (
                  <SubscriptionCard
                    key={stream.id}
                    subscription={stream}
                    index={index}
                    onPress={() => {
                      router.push({
                        pathname: '/(main)/(streams)/[id]',
                        params: { id: stream.id },
                      });
                    }}
                    accentColor={COLORS.cyan}
                  />
                ))}
              </View>
            )}
          </View>
        )}

        {/* Security Info */}
        <View style={{ padding: 16, marginTop: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 12, backgroundColor: 'rgba(57, 197, 187, 0.1)', borderRadius: 10 }}>
            <Ionicons name="shield-checkmark" size={16} color={COLORS.cyan} style={{ marginTop: 1 }} />
            <Text style={{ color: COLORS.textMuted, fontSize: 12, flex: 1 }}>
              <Text style={{ color: COLORS.cyan, fontWeight: '500' }}>Protected: </Text>
              All streams are secured on Solana. Recipients can only receive approved amounts.
            </Text>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

// Service Card Component
function ServiceCard({
  service,
  index,
  onSubscribe,
  isSubscribed,
}: {
  service: typeof SDK_SERVICES[0];
  index: number;
  onSubscribe: () => void;
  isSubscribed: boolean;
}) {
  return (
    <Animated.View entering={FadeInDown.delay(index * 30).springify()}>
      <TouchableOpacity
        onPress={onSubscribe}
        disabled={isSubscribed}
        activeOpacity={0.7}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          padding: 14,
          backgroundColor: COLORS.surface,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: isSubscribed ? 'rgba(0, 255, 136, 0.3)' : COLORS.border,
        }}
      >
        {/* Icon - fixed size */}
        <View
          style={{
            width: 44,
            height: 44,
            borderRadius: 10,
            backgroundColor: isSubscribed ? 'rgba(0, 255, 136, 0.1)' : 'rgba(255, 119, 168, 0.1)',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <Ionicons
            name={service.icon as any}
            size={22}
            color={isSubscribed ? COLORS.green : COLORS.pink}
          />
        </View>

        {/* Info - takes remaining space with proper truncation */}
        <View style={{ flex: 1, minWidth: 0 }}>
          {/* Name */}
          <Text
            style={{ color: COLORS.text, fontSize: 14, fontWeight: '500' }}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {service.name}
          </Text>

          {/* Category row with badge if subscribed */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 }}>
            {isSubscribed && (
              <View style={{
                paddingHorizontal: 5,
                paddingVertical: 1,
                backgroundColor: 'rgba(0, 255, 136, 0.2)',
                borderRadius: 4,
                flexShrink: 0,
              }}>
                <Text style={{ color: COLORS.green, fontSize: 9, fontWeight: '500' }}>ACTIVE</Text>
              </View>
            )}
            <Text
              style={{ color: COLORS.textMuted, fontSize: 12, flex: 1 }}
              numberOfLines={1}
            >
              {service.category}
            </Text>
          </View>
        </View>

        {/* Price - fixed, never shrinks */}
        <View style={{ alignItems: 'flex-end', flexShrink: 0 }}>
          <Text style={{ color: COLORS.text, fontSize: 14, fontWeight: '600' }}>
            {service.price} SOL
          </Text>
          <Text style={{ color: COLORS.textMuted, fontSize: 11, marginTop: 2 }}>
            /{service.frequency}
          </Text>
        </View>

        {/* Subscribe button - only if not subscribed */}
        {!isSubscribed && (
          <View style={{
            paddingHorizontal: 12,
            paddingVertical: 8,
            backgroundColor: COLORS.pink,
            borderRadius: 8,
            flexShrink: 0,
          }}>
            <Text style={{ color: COLORS.void, fontSize: 12, fontWeight: '600' }}>Subscribe</Text>
          </View>
        )}
      </TouchableOpacity>
    </Animated.View>
  );
}

// Subscription Card Component
function SubscriptionCard({
  subscription: sub,
  index,
  onPress,
  accentColor = COLORS.cyan,
}: {
  subscription: Stream;
  index: number;
  onPress: () => void;
  accentColor?: string;
}) {
  const isActive = sub.status === 'active';
  const isPaused = sub.status === 'paused';

  const handlePress = () => {
    onPress();
  };

  const daysUntilNext = Math.ceil(
    (sub.nextPaymentDate - Date.now()) / (1000 * 60 * 60 * 24)
  );

  const hasPrivacyFeatures = sub.amountNoise > 0 || sub.timingNoise > 0 || sub.useStealthAddress;
  const initial = sub.name.slice(0, 1).toUpperCase();

  const getStatusText = () => {
    if (isPaused) return 'Stream paused';
    if (daysUntilNext <= 0) return 'Payment due now';
    if (daysUntilNext === 1) return 'Due tomorrow';
    return `Next in ${daysUntilNext} days`;
  };

  return (
    <Animated.View entering={FadeInDown.delay(index * 40).springify()}>
      <TouchableOpacity
        onPress={handlePress}
        activeOpacity={0.7}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          padding: 14,
          backgroundColor: COLORS.surface,
          borderRadius: 12,
        }}
      >
        {/* Logo */}
        <View
          style={{
            width: 44,
            height: 44,
            borderRadius: 10,
            backgroundColor: isActive ? COLORS.border : 'rgba(42, 42, 48, 0.5)',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
            flexShrink: 0,
          }}
        >
          <Text style={{ color: isActive ? COLORS.textMuted : COLORS.textDim, fontSize: 16, fontWeight: '700' }}>
            {initial}
          </Text>

          {/* Privacy indicator */}
          {hasPrivacyFeatures && isActive && (
            <View style={{
              position: 'absolute',
              top: -4,
              right: -4,
              width: 16,
              height: 16,
              borderRadius: 8,
              backgroundColor: accentColor,
              alignItems: 'center',
              justifyContent: 'center'
            }}>
              <Ionicons name="shield" size={10} color={COLORS.void} />
            </View>
          )}
        </View>

        {/* Info - flex: 1 with minWidth: 0 for proper truncation */}
        <View style={{ flex: 1, minWidth: 0 }}>
          {/* Name with truncation */}
          <Text
            style={{
              color: isActive ? COLORS.text : COLORS.textMuted,
              fontSize: 14,
              fontWeight: '500',
              maxWidth: '100%',
            }}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {sub.name}
          </Text>

          {/* Status row - badge and status text on same line */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 }}>
            {isPaused && (
              <View style={{
                paddingHorizontal: 5,
                paddingVertical: 1,
                backgroundColor: 'rgba(255, 204, 0, 0.2)',
                borderRadius: 4,
                flexShrink: 0,
              }}>
                <Text style={{ color: COLORS.yellow, fontSize: 9, fontWeight: '500' }}>PAUSED</Text>
              </View>
            )}
            <Text
              style={{ color: COLORS.textMuted, fontSize: 12, flex: 1 }}
              numberOfLines={1}
            >
              {getStatusText()}
            </Text>
          </View>

          {/* Auto + Privacy badges */}
          {isActive && (
            <View style={{ flexDirection: 'row', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
              {/* Automatic payments badge */}
              <View style={{ paddingHorizontal: 5, paddingVertical: 1, backgroundColor: 'rgba(0, 255, 136, 0.15)', borderRadius: 4, flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                <Ionicons name="flash" size={8} color={COLORS.green} />
                <Text style={{ color: COLORS.green, fontSize: 9, fontWeight: '500' }}>AUTO</Text>
              </View>
              {sub.amountNoise > 0 && (
                <View style={{ paddingHorizontal: 5, paddingVertical: 1, backgroundColor: `${accentColor}20`, borderRadius: 4 }}>
                  <Text style={{ color: accentColor, fontSize: 9 }}>+/-{sub.amountNoise}%</Text>
                </View>
              )}
              {sub.timingNoise > 0 && (
                <View style={{ paddingHorizontal: 5, paddingVertical: 1, backgroundColor: `${accentColor}20`, borderRadius: 4 }}>
                  <Text style={{ color: accentColor, fontSize: 9 }}>+/-{sub.timingNoise}h</Text>
                </View>
              )}
              {sub.useStealthAddress && (
                <View style={{ paddingHorizontal: 5, paddingVertical: 1, backgroundColor: 'rgba(255, 119, 168, 0.2)', borderRadius: 4 }}>
                  <Text style={{ color: COLORS.pink, fontSize: 9 }}>Stealth</Text>
                </View>
              )}
            </View>
          )}
        </View>

        {/* Amount - fixed width, never shrinks */}
        <View style={{ alignItems: 'flex-end', flexShrink: 0, marginLeft: 8 }}>
          <Text style={{
            color: isActive ? COLORS.text : COLORS.textMuted,
            fontSize: 14,
            fontWeight: '600',
          }}>
            {sub.amountPerPayment.toFixed(sub.amountPerPayment < 1 ? 4 : 2)} SOL
          </Text>
          <Text style={{ color: COLORS.textMuted, fontSize: 11, marginTop: 2 }}>
            {formatFrequency(sub.frequency, sub.customIntervalDays)}
          </Text>
        </View>

        <Ionicons name="chevron-forward" size={16} color={COLORS.textMuted} style={{ flexShrink: 0 }} />
      </TouchableOpacity>
    </Animated.View>
  );
}

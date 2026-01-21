import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Alert,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { useStreamStore } from '../../../stores/streamStore';
import { useWalletStore } from '../../../stores/walletStore';
import { StreamFrequency } from '../../../services/solana/streams';

// Protocol 01 Color System
const COLORS = {
  cyan: '#39c5bb',
  cyanDim: '#2a9d95',
  pink: '#ff77a8',
  yellow: '#ffcc00',
  green: '#00ff88',
  red: '#ff3366',
  text: '#ffffff',
  textMuted: '#888892',
  textDim: '#555560',
  void: '#0a0a0c',
  surface: '#151518',
  surface2: '#1a1a1e',
  border: '#2a2a30',
};

// Service icons mapping
const SERVICE_ICONS: Record<string, string> = {
  netflix: 'play-circle',
  spotify: 'musical-notes',
  chatgpt: 'chatbubbles',
  github: 'logo-github',
  figma: 'color-palette',
  notion: 'document-text',
};

export default function SubscribeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    serviceId: string;
    serviceName: string;
    price: string;
    frequency: string;
  }>();

  const { createNewStream } = useStreamStore();
  const { publicKey } = useWalletStore();
  const [isSubscribing, setIsSubscribing] = useState(false);
  const [enablePrivacy, setEnablePrivacy] = useState(false);
  const [selectedDuration, setSelectedDuration] = useState<'1' | '6' | '12'>('1');

  const serviceName = params.serviceName || 'Service';
  const serviceId = params.serviceId || '';
  const price = parseFloat(params.price || '0');
  const frequency = (params.frequency || 'monthly') as StreamFrequency;
  const icon = SERVICE_ICONS[serviceId] || 'cube';

  // Calculate totals based on duration
  const durationMonths = parseInt(selectedDuration);
  const totalPrice = price * durationMonths;
  const savings = durationMonths > 1 ? (price * durationMonths * 0.1).toFixed(4) : null; // 10% discount for longer subs

  const handleSubscribe = async () => {
    if (!publicKey) {
      Alert.alert('Wallet Required', 'Please connect your wallet to subscribe.');
      return;
    }

    try {
      setIsSubscribing(true);
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      // Calculate end date
      const now = Date.now();
      const endDate = now + durationMonths * 30 * 24 * 60 * 60 * 1000;

      // Create subscription stream
      const stream = await createNewStream({
        name: serviceName,
        recipientAddress: `${serviceId}_provider_address`, // In production, this comes from SDK
        totalAmount: totalPrice,
        frequency,
        endDate,
        serviceId,
        serviceName,
        // Privacy features
        amountNoise: enablePrivacy ? 10 : 0,
        timingNoise: enablePrivacy ? 4 : 0,
        useStealthAddress: enablePrivacy,
      });

      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      Alert.alert(
        'Subscribed!',
        `You're now subscribed to ${serviceName}. Your first payment of ${price} SOL will be processed shortly.`,
        [
          {
            text: 'View Subscription',
            onPress: () => router.replace(`/(main)/(streams)/${stream.id}`),
          },
          {
            text: 'Done',
            onPress: () => router.replace('/(main)/(streams)'),
          },
        ]
      );
    } catch (error: any) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Error', error.message || 'Failed to subscribe. Please try again.');
    } finally {
      setIsSubscribing(false);
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
          paddingTop: insets.top + 8,
          paddingBottom: 12,
        }}
      >
        <TouchableOpacity
          onPress={() => router.back()}
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            backgroundColor: 'rgba(57, 197, 187, 0.2)',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons name="arrow-back" size={22} color={COLORS.cyan} />
        </TouchableOpacity>

        <Text style={{ color: COLORS.text, fontSize: 17, fontWeight: '600' }}>
          Subscribe
        </Text>

        <View style={{ width: 40 }} />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Service Card */}
        <Animated.View entering={FadeIn.duration(300)}>
          <LinearGradient
            colors={['rgba(57, 197, 187, 0.2)', COLORS.surface]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={{
              borderRadius: 20,
              padding: 24,
              alignItems: 'center',
              borderWidth: 1,
              borderColor: 'rgba(57, 197, 187, 0.3)',
            }}
          >
            {/* Service Icon */}
            <View
              style={{
                width: 80,
                height: 80,
                borderRadius: 20,
                backgroundColor: 'rgba(57, 197, 187, 0.2)',
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: 16,
              }}
            >
              <Ionicons name={icon as any} size={40} color={COLORS.cyan} />
            </View>

            <Text style={{ color: COLORS.text, fontSize: 24, fontWeight: '700', marginBottom: 4 }}>
              {serviceName}
            </Text>
            <Text style={{ color: COLORS.textMuted, fontSize: 14, marginBottom: 16 }}>
              Subscription via Stream Secure
            </Text>

            {/* Price */}
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4 }}>
              <Text style={{ color: COLORS.cyan, fontSize: 36, fontWeight: '700' }}>
                {price}
              </Text>
              <Text style={{ color: COLORS.textMuted, fontSize: 16 }}>
                SOL/{frequency}
              </Text>
            </View>
          </LinearGradient>
        </Animated.View>

        {/* Duration Selection */}
        <Animated.View entering={FadeInDown.delay(100).duration(300)} style={{ marginTop: 24 }}>
          <Text style={{ color: COLORS.text, fontSize: 15, fontWeight: '600', marginBottom: 12 }}>
            Subscription Duration
          </Text>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            {(['1', '6', '12'] as const).map((duration) => {
              const isSelected = selectedDuration === duration;
              const months = parseInt(duration);
              const total = (price * months).toFixed(4);

              return (
                <TouchableOpacity
                  key={duration}
                  onPress={() => {
                    Haptics.selectionAsync();
                    setSelectedDuration(duration);
                  }}
                  activeOpacity={0.7}
                  style={{
                    flex: 1,
                    padding: 16,
                    borderRadius: 12,
                    backgroundColor: isSelected ? COLORS.cyan : COLORS.surface,
                    borderWidth: 1,
                    borderColor: isSelected ? COLORS.cyan : COLORS.border,
                    alignItems: 'center',
                  }}
                >
                  <Text style={{
                    color: isSelected ? COLORS.void : COLORS.text,
                    fontSize: 18,
                    fontWeight: '700',
                  }}>
                    {months}
                  </Text>
                  <Text style={{
                    color: isSelected ? COLORS.void : COLORS.textMuted,
                    fontSize: 11,
                    marginTop: 2,
                  }}>
                    {months === 1 ? 'month' : 'months'}
                  </Text>
                  {months > 1 && (
                    <View style={{
                      marginTop: 8,
                      paddingHorizontal: 6,
                      paddingVertical: 2,
                      backgroundColor: isSelected ? 'rgba(10, 10, 12, 0.3)' : 'rgba(0, 255, 136, 0.2)',
                      borderRadius: 4,
                    }}>
                      <Text style={{
                        color: isSelected ? COLORS.void : COLORS.green,
                        fontSize: 9,
                        fontWeight: '500',
                      }}>
                        SAVE 10%
                      </Text>
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        </Animated.View>

        {/* Privacy Toggle */}
        <Animated.View entering={FadeInDown.delay(200).duration(300)} style={{ marginTop: 24 }}>
          <TouchableOpacity
            onPress={() => {
              Haptics.selectionAsync();
              setEnablePrivacy(!enablePrivacy);
            }}
            activeOpacity={0.8}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 14,
              padding: 16,
              backgroundColor: enablePrivacy ? 'rgba(57, 197, 187, 0.15)' : COLORS.surface,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: enablePrivacy ? 'rgba(57, 197, 187, 0.4)' : COLORS.border,
            }}
          >
            <View style={{
              width: 44,
              height: 44,
              borderRadius: 10,
              backgroundColor: enablePrivacy ? 'rgba(57, 197, 187, 0.2)' : 'rgba(42, 42, 48, 0.5)',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <Ionicons
                name="shield-checkmark"
                size={22}
                color={enablePrivacy ? COLORS.cyan : COLORS.textMuted}
              />
            </View>

            <View style={{ flex: 1 }}>
              <Text style={{ color: COLORS.text, fontSize: 14, fontWeight: '600' }}>
                Privacy Shield
              </Text>
              <Text style={{ color: COLORS.textMuted, fontSize: 12, marginTop: 2 }}>
                Add amount noise, timing noise & stealth addresses
              </Text>
            </View>

            <View style={{
              width: 48,
              height: 28,
              borderRadius: 14,
              backgroundColor: enablePrivacy ? COLORS.cyan : COLORS.border,
              justifyContent: 'center',
              padding: 2,
            }}>
              <View style={{
                width: 24,
                height: 24,
                borderRadius: 12,
                backgroundColor: COLORS.text,
                alignSelf: enablePrivacy ? 'flex-end' : 'flex-start',
              }} />
            </View>
          </TouchableOpacity>
        </Animated.View>

        {/* Summary */}
        <Animated.View entering={FadeInDown.delay(300).duration(300)} style={{ marginTop: 24 }}>
          <View style={{
            backgroundColor: COLORS.surface,
            borderRadius: 12,
            padding: 16,
            borderWidth: 1,
            borderColor: COLORS.border,
          }}>
            <Text style={{ color: COLORS.text, fontSize: 15, fontWeight: '600', marginBottom: 12 }}>
              Summary
            </Text>

            <View style={{ gap: 10 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ color: COLORS.textMuted, fontSize: 13 }}>
                  {serviceName} ({durationMonths} {durationMonths === 1 ? 'month' : 'months'})
                </Text>
                <Text style={{ color: COLORS.text, fontSize: 13 }}>
                  {(price * durationMonths).toFixed(4)} SOL
                </Text>
              </View>

              {savings && (
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ color: COLORS.green, fontSize: 13 }}>
                    Duration discount (10%)
                  </Text>
                  <Text style={{ color: COLORS.green, fontSize: 13 }}>
                    -{savings} SOL
                  </Text>
                </View>
              )}

              {enablePrivacy && (
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ color: COLORS.cyan, fontSize: 13 }}>
                    Privacy Shield
                  </Text>
                  <Text style={{ color: COLORS.cyan, fontSize: 13 }}>
                    Enabled
                  </Text>
                </View>
              )}

              <View style={{
                marginTop: 8,
                paddingTop: 12,
                borderTopWidth: 1,
                borderTopColor: COLORS.border,
                flexDirection: 'row',
                justifyContent: 'space-between',
              }}>
                <Text style={{ color: COLORS.text, fontSize: 15, fontWeight: '600' }}>
                  Total
                </Text>
                <Text style={{ color: COLORS.cyan, fontSize: 15, fontWeight: '700' }}>
                  {savings
                    ? (price * durationMonths * 0.9).toFixed(4)
                    : (price * durationMonths).toFixed(4)
                  } SOL
                </Text>
              </View>
            </View>
          </View>
        </Animated.View>

        {/* Features */}
        <Animated.View entering={FadeInDown.delay(400).duration(300)} style={{ marginTop: 16 }}>
          <View style={{ gap: 8 }}>
            {[
              { icon: 'checkmark-circle', text: 'Cancel anytime, no penalties', color: COLORS.green },
              { icon: 'shield-checkmark', text: 'Protected by Stream Secure', color: COLORS.cyan },
              { icon: 'sync', text: 'Automatic recurring payments', color: COLORS.cyan },
            ].map((feature, index) => (
              <View key={index} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Ionicons name={feature.icon as any} size={16} color={feature.color} />
                <Text style={{ color: COLORS.textMuted, fontSize: 12 }}>{feature.text}</Text>
              </View>
            ))}
          </View>
        </Animated.View>
      </ScrollView>

      {/* Subscribe Button */}
      <View style={{
        padding: 16,
        paddingBottom: insets.bottom + 16,
        borderTopWidth: 1,
        borderTopColor: COLORS.border,
        backgroundColor: COLORS.void,
      }}>
        <TouchableOpacity
          onPress={handleSubscribe}
          disabled={isSubscribing}
          activeOpacity={0.8}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            paddingVertical: 16,
            backgroundColor: isSubscribing ? COLORS.cyanDim : COLORS.cyan,
            borderRadius: 12,
          }}
        >
          {isSubscribing ? (
            <ActivityIndicator size="small" color={COLORS.void} />
          ) : (
            <>
              <Ionicons name="checkmark-circle" size={22} color={COLORS.void} />
              <Text style={{ color: COLORS.void, fontSize: 16, fontWeight: '700' }}>
                Subscribe to {serviceName}
              </Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

import { useEffect } from 'react';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Colors, FontFamily } from '../../constants/theme';
import { useWalletStore } from '../../stores/walletStore';
import { useSecuritySettings } from '../../hooks/useSecuritySettings';
import { useRealtimeSync } from '../../hooks/sync';

export default function MainLayout() {
  const { initialize, initialized } = useWalletStore();
  const insets = useSafeAreaInsets();

  // Initialize security settings (applies screenshot blocking)
  useSecuritySettings();

  // Real-time sync for subscriptions from extension
  useRealtimeSync({
    onSubscriptionAdded: (stream) => {
      console.log('[RealtimeSync] New subscription added:', stream.name);
    },
    onSyncComplete: (result) => {
      console.log('[RealtimeSync] Sync complete:', result.newStreams, 'new streams');
    },
    onError: (error) => {
      console.error('[RealtimeSync] Error:', error);
    },
  });

  // Calculate tab bar height based on safe area
  const TAB_BAR_HEIGHT = 60;
  const bottomPadding = Math.max(insets.bottom, 10);
  const totalHeight = TAB_BAR_HEIGHT + bottomPadding;

  // Initialize wallet
  useEffect(() => {
    if (!initialized) {
      initialize();
    }
  }, [initialized, initialize]);

  const handleTabPress = () => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: Colors.surface,
          borderTopColor: Colors.border,
          borderTopWidth: 1,
          height: totalHeight,
          paddingTop: 8,
          paddingBottom: bottomPadding,
          paddingHorizontal: 10,
        },
        tabBarActiveTintColor: Colors.primary,
        tabBarInactiveTintColor: Colors.textTertiary,
        tabBarLabelStyle: {
          fontFamily: FontFamily.medium,
          fontSize: 11,
          marginTop: 4,
        },
        tabBarIconStyle: {
          marginTop: 0,
        },
      }}
      screenListeners={{
        tabPress: handleTabPress,
      }}
    >
      <Tabs.Screen
        name="(wallet)"
        options={{
          title: 'Wallet',
          tabBarIcon: ({ color, focused }) => (
            <Ionicons
              name={focused ? 'wallet' : 'wallet-outline'}
              size={24}
              color={color}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="(streams)"
        options={{
          title: 'Streams',
          tabBarIcon: ({ color, focused }) => (
            <Ionicons
              name={focused ? 'water' : 'water-outline'}
              size={24}
              color={color}
            />
          ),
        }}
      />
      {/* Social tab hidden - focusing on Streams technology
      <Tabs.Screen
        name="(social)"
        options={{
          title: 'Social',
          tabBarIcon: ({ color, focused }) => (
            <Ionicons
              name={focused ? 'people' : 'people-outline'}
              size={24}
              color={color}
            />
          ),
        }}
      />
      */}
      <Tabs.Screen
        name="(social)"
        options={{
          href: null, // Hidden - Social features handled by other protocols (anonemesh, etc.)
        }}
      />
      <Tabs.Screen
        name="(agent)"
        options={{
          title: 'Agent',
          tabBarIcon: ({ color, focused }) => (
            <Ionicons
              name={focused ? 'sparkles' : 'sparkles-outline'}
              size={24}
              color={color}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="(settings)"
        options={{
          href: null, // Hide from tab bar, accessible via header button
        }}
      />
    </Tabs>
  );
}

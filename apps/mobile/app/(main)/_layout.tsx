import React, { useEffect, useRef } from 'react';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors } from '../../constants/theme';
import { useWalletStore } from '../../stores/walletStore';
import { useSecuritySettings } from '../../hooks/useSecuritySettings';
import { useRealtimeSync } from '../../hooks/sync';
import { LiquidGlassTabBar } from '../../components/navigation/LiquidGlassTabBar';

export default function MainLayout() {
  const { initialize, initialized } = useWalletStore();
  const insets = useSafeAreaInsets();

  // Initialize security settings (applies screenshot blocking)
  useSecuritySettings();

  // Real-time sync for subscriptions from extension
  useRealtimeSync({
    onSubscriptionAdded: (stream) => {
    },
    onSyncComplete: (result) => {
    },
    onError: (error) => {
      console.error('[RealtimeSync] Error:', error);
    },
  });

  // Initialize wallet — only once
  const initRef = React.useRef(false);
  useEffect(() => {
    if (!initialized && !initRef.current) {
      initRef.current = true;
      initialize();
    }
  }, [initialized]);

  return (
    <Tabs
      tabBar={(props) => <LiquidGlassTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          position: 'absolute',
          backgroundColor: 'transparent',
          borderTopWidth: 0,
          elevation: 0,
          height: 64 + 16 + insets.bottom,
        },
        tabBarActiveTintColor: Colors.primary,
        tabBarInactiveTintColor: Colors.textTertiary,
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
        name="(privacy)"
        options={{
          title: 'Privacy',
          tabBarIcon: ({ color, focused }) => (
            <Ionicons
              name={focused ? 'shield-half' : 'shield-half-outline'}
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
      <Tabs.Screen
        name="(agent)"
        options={{
          title: 'Agent',
          tabBarIcon: ({ color, focused }) => (
            <Ionicons
              name={focused ? 'aperture' : 'aperture-outline'}
              size={24}
              color={color}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="(settings)"
        options={{
          title: 'Settings',
          href: null, // Hide from tab bar, accessible via header button
        }}
      />
    </Tabs>
  );
}

import React, { useEffect, useRef, useState } from 'react';
import { View, AppState, AppStateStatus, StyleSheet } from 'react-native';
import { Tabs, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import * as SecureStore from 'expo-secure-store';
import { Colors } from '../../constants/theme';
import { lockVault } from '../../utils/crypto/noteVault';
import { useWalletStore } from '../../stores/walletStore';
import { useSecuritySettings } from '../../hooks/useSecuritySettings';
import { useRealtimeSync } from '../../hooks/sync';
import { LiquidGlassTabBar } from '../../components/navigation/LiquidGlassTabBar';
import { checkForUpdate } from '../../services/updates/versionCheck';

export default function MainLayout() {
  const { initialize, initialized } = useWalletStore();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  // H4: Auth gate — verify user passed lock screen before rendering main content
  // H4: Auth gate — verify user passed lock screen before rendering main content
  const [isUnlocked, setIsUnlocked] = useState(false);

  useEffect(() => {
    SecureStore.getItemAsync('p01_session_unlocked').then(val => {
      if (val !== 'true') {
        router.replace('/(auth)/lock');
      } else {
        setIsUnlocked(true);
      }
    });
  }, []);

  // M6 + M7: App backgrounding protection — lock on background, blur on app switcher
  const [appInBackground, setAppInBackground] = useState(false);

  useEffect(() => {
    let lastBackground = 0;
    const subscription = AppState.addEventListener('change', async (state: AppStateStatus) => {
      if (state === 'background') {
        lastBackground = Date.now();
        setAppInBackground(true);
      } else if (state === 'inactive') {
        setAppInBackground(true);
      } else if (state === 'active') {
        setAppInBackground(false);
        if (lastBackground > 0) {
          // Get lock timeout setting from SecureStore (default 0 = immediate)
          const timeoutStr = await SecureStore.getItemAsync('settings_lock_timeout');
          const timeout = timeoutStr ? parseInt(timeoutStr, 10) : 0;
          // timeout -1 means 'never'
          if (timeout >= 0) {
            const elapsed = Date.now() - lastBackground;
            if (elapsed > timeout * 1000) {
              await SecureStore.deleteItemAsync('p01_session_unlocked');
              lockVault(); // Wipe note vault key from memory
              router.replace('/(auth)/lock');
            }
          }
        }
      }
    });
    return () => subscription.remove();
  }, []);

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

  // Check for app updates on launch (throttled to once per 24h)
  useEffect(() => {
    checkForUpdate();
  }, []);

  // H4: Don't render main content until verified unlocked
  if (!isUnlocked) return null;

  return (
    <View style={{ flex: 1, backgroundColor: Colors.background }}>
      {/* M7: Blur overlay when app is in background / app switcher */}
      {appInBackground && (
        <View style={StyleSheet.compose(StyleSheet.absoluteFillObject, { zIndex: 9999 })}>
          <BlurView intensity={100} tint="dark" style={StyleSheet.absoluteFillObject} />
        </View>
      )}
      {/* Ambient glow — visible on every tab */}
      <LinearGradient
        colors={['rgba(57, 197, 187, 0.045)', 'rgba(255, 119, 168, 0.025)', 'transparent']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 0 }}
        pointerEvents="none"
      />
      <Tabs
        tabBar={(props) => <LiquidGlassTabBar {...props} />}
        screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: 'transparent' },
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
    </View>
  );
}

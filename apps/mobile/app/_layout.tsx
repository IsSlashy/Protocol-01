// Polyfills must be imported first - ORDER MATTERS!
import 'react-native-get-random-values';
import { Buffer } from 'buffer';
global.Buffer = Buffer;
import '@ethersproject/shims';
import '../polyfills/pda-fix';

import '../global.css';

import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect } from 'react';
import { Text, TextInput, View } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { P01PrivyProvider } from '../providers/PrivyProvider';
import React from 'react';
import { ZkProverProvider } from '../providers/ZkProverProvider';
import { StarkProverProvider } from '../providers/StarkProverProvider';
import { AlertProvider } from '../providers/AlertProvider';
import { ArciumProvider } from '../providers/ArciumProvider';
import { useLoadFonts } from '../hooks/useLoadFonts';

// Prevent splash screen from auto-hiding
SplashScreen.preventAutoHideAsync();

// Disable font scaling globally to prevent "zoomed" UI
if ((Text as any).defaultProps == null) (Text as any).defaultProps = {};
(Text as any).defaultProps.allowFontScaling = false;
if ((TextInput as any).defaultProps == null) (TextInput as any).defaultProps = {};
(TextInput as any).defaultProps.allowFontScaling = false;

export default function RootLayout() {
  const { fontsLoaded, fontError } = useLoadFonts();

  const onLayoutReady = useCallback(async () => {
    if (fontsLoaded || fontError) {
      await SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  useEffect(() => {
    onLayoutReady();
  }, [onLayoutReady]);

  if (!fontsLoaded && !fontError) {
    return null;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: '#050505' }}>
      <SafeAreaProvider>
        <P01PrivyProvider>
          <ZkProverProvider>
          <StarkProverProvider>
          <ArciumProvider>
            <AlertProvider>
              <View style={{ flex: 1, backgroundColor: '#050505' }}>
                <StatusBar style="light" />
                <Stack
                  screenOptions={{
                    headerShown: false,
                    contentStyle: { backgroundColor: '#050505' },
                    animation: 'fade',
                  }}
                >
                  <Stack.Screen name="index" />
                  <Stack.Screen name="(onboarding)" />
                  <Stack.Screen name="(auth)" />
                  <Stack.Screen name="(main)" />
                </Stack>
              </View>
            </AlertProvider>
          </ArciumProvider>
          </StarkProverProvider>
          </ZkProverProvider>
        </P01PrivyProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

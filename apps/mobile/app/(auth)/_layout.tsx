/**
 * Auth Layout
 *
 * Layout for authentication screens (login, import, etc.)
 */

import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { Colors } from '@/constants/theme';

export default function AuthLayout() {
  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: Colors.background },
          animation: 'slide_from_right',
        }}
      >
        <Stack.Screen name="login" />
        <Stack.Screen name="import" />
        <Stack.Screen name="lock" />
        <Stack.Screen name="scan-connect" />
      </Stack>
    </>
  );
}

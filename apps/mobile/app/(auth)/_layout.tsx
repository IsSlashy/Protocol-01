/**
 * Auth Layout
 *
 * Layout for authentication screens (login, import, etc.)
 */

import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

export default function AuthLayout() {
  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: '#0a0a0c' },
          animation: 'slide_from_right',
        }}
      >
        <Stack.Screen name="login" />
        <Stack.Screen name="import" />
      </Stack>
    </>
  );
}

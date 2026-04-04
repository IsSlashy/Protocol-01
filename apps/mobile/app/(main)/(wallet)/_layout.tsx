import { Stack } from 'expo-router';

// P-01 Design System Background: void = #0a0a0c
export default function WalletLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: 'transparent' },
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen name="send" />
      <Stack.Screen name="send-confirm" />
      <Stack.Screen name="send-success" />
      <Stack.Screen name="send-split" />
      <Stack.Screen name="receive" />
      <Stack.Screen name="swap" />
      <Stack.Screen name="buy" />
      <Stack.Screen name="buy-p2p" />
      <Stack.Screen name="scan" />
      <Stack.Screen name="activity" />
      <Stack.Screen name="view-keys" />
      <Stack.Screen name="auth-confirm" />
    </Stack>
  );
}

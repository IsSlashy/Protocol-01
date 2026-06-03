import { Stack } from 'expo-router';
import { Colors } from '@/constants/theme';

export default function PrivacyLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        // Opaque background on purpose: covering the shared ambient-glow gradient
        // avoids overdraw on this content-heavy stack (kept flat for performance).
        contentStyle: { backgroundColor: Colors.background },
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen name="shielded" />
      <Stack.Screen name="confidential" />
      <Stack.Screen name="shielded-transfer" />
      <Stack.Screen name="denominated-shield" />
      <Stack.Screen name="denominated-unshield" />
      <Stack.Screen name="denominated-unshield-batch" />
      <Stack.Screen name="denominated-notes" />
      <Stack.Screen name="denominated-transfer" />
      <Stack.Screen name="denominated-import" />
      <Stack.Screen name="share-note" />
      <Stack.Screen name="receive-note" />
      <Stack.Screen name="subscription-vaults" />
      <Stack.Screen name="subscribe-normal" />
      <Stack.Screen name="subscribe-private" />
      <Stack.Screen name="vault-detail" />
      <Stack.Screen name="private-send" />
    </Stack>
  );
}

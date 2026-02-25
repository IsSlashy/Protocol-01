import { Stack } from 'expo-router';

export default function PrivacyLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: '#0a0a0c' },
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen name="shielded" />
      <Stack.Screen name="confidential" />
      <Stack.Screen name="shielded-transfer" />
    </Stack>
  );
}

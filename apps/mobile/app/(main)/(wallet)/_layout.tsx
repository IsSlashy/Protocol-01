import { Stack } from 'expo-router';

// P-01 Design System Background: void = #0a0a0c
export default function WalletLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: '#0a0a0c' },
      }}
    />
  );
}

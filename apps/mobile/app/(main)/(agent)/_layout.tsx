import { Stack } from 'expo-router';

export default function AgentLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: '#050505' },
      }}
    />
  );
}

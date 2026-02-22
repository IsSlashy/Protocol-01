import { Redirect } from 'expo-router';

// Chat is now integrated into the main agent dashboard (index.tsx)
export default function AgentChat() {
  return <Redirect href="/(main)/(agent)/" />;
}

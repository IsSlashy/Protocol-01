import { Redirect } from 'expo-router';
import { useEffect, useState } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { walletExists } from '../services/solana/wallet';

export default function Index() {
  const [isLoading, setIsLoading] = useState(true);
  const [hasWallet, setHasWallet] = useState(false);

  useEffect(() => {
    checkAppState();
  }, []);

  const checkAppState = async () => {
    try {
      // Check if user has a wallet
      const hasExistingWallet = await walletExists();
      console.log('[Index] walletExists:', hasExistingWallet);
      setHasWallet(hasExistingWallet);
    } catch (error) {
      console.error('[Index] Error checking app state:', error);
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: '#050505', alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="large" color="#00ff88" />
      </View>
    );
  }

  // If has wallet, go to biometric lock
  if (hasWallet) {
    return <Redirect href="/(auth)/lock" />;
  }

  // No wallet - always show onboarding welcome screen
  return <Redirect href="/(onboarding)" />;
}

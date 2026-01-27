import { Redirect, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { View, ActivityIndicator, Text } from 'react-native';
import { walletExists } from '../services/solana/wallet';

export default function Index() {
  const [isLoading, setIsLoading] = useState(true);
  const [hasWallet, setHasWallet] = useState(false);
  const router = useRouter();

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

  // Navigate after loading completes
  useEffect(() => {
    if (!isLoading) {
      console.log('[Index] Navigating, hasWallet:', hasWallet);
      if (hasWallet) {
        router.replace('/(auth)/lock');
      } else {
        router.replace('/(onboarding)');
      }
    }
  }, [isLoading, hasWallet, router]);

  return (
    <View style={{ flex: 1, backgroundColor: '#050505', alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator size="large" color="#00ff88" />
      <Text style={{ color: '#666', marginTop: 16 }}>Loading...</Text>
    </View>
  );
}

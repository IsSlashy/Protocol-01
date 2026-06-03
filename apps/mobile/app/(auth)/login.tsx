/**
 * P-01 Login Screen
 *
 * Local-wallet entry point. Privy (email / OTP / social / embedded wallet) has
 * been removed — spec §3 Phase 1. The user either creates a new local
 * seed-phrase wallet or imports an existing one.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'expo-router';
import { AuthScreen } from '@/components/auth';
import { useWalletStore } from '@/stores/walletStore';

export default function LoginScreen() {
  const router = useRouter();
  const { hasWallet, initialized } = useWalletStore();
  const redirectedRef = useRef(false);

  // If a local wallet already exists, skip straight to the wallet home.
  useEffect(() => {
    if (initialized && hasWallet && !redirectedRef.current) {
      redirectedRef.current = true;
      router.replace('/(main)/(wallet)');
    }
  }, [initialized, hasWallet, router]);

  const handleCreateWallet = useCallback(() => {
    // Navigate to the manual wallet creation flow — replace to avoid stack remnants.
    router.replace('/(onboarding)/create-wallet');
  }, [router]);

  const handleImportWallet = useCallback(() => {
    router.push('/(auth)/import');
  }, [router]);

  return (
    <AuthScreen
      onCreateWallet={handleCreateWallet}
      onImportWallet={handleImportWallet}
      loading={false}
    />
  );
}

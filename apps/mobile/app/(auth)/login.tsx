/**
 * P-01 Login Screen
 *
 * Main authentication entry point using Privy.
 * Features custom P-01 cyberpunk design.
 */

import React, { useState, useCallback, useEffect } from 'react';
import { Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { AuthScreen } from '@/components/auth';
import { usePrivyAuth } from '@/providers/PrivyProvider';

type LoginMethod = 'email' | 'sms' | 'google' | 'apple' | 'twitter' | 'wallet';

export default function LoginScreen() {
  const router = useRouter();
  const {
    ready,
    authenticated,
    login,
    verifyOtp,
    createWallet,
  } = usePrivyAuth();

  const [loading, setLoading] = useState<LoginMethod | null>(null);

  // Redirect if already authenticated
  useEffect(() => {
    if (ready && authenticated) {
      router.replace('/(main)/(wallet)');
    }
  }, [ready, authenticated, router]);

  const handleLogin = useCallback(async (method: LoginMethod, value?: string) => {
    setLoading(method);

    try {
      switch (method) {
        case 'email':
          if (value) {
            await login.email(value);
          }
          break;
        case 'sms':
          if (value) {
            await login.phone(value);
          }
          break;
        case 'google':
          await login.google();
          break;
        case 'apple':
          await login.apple();
          break;
        case 'twitter':
          await login.twitter();
          break;
        case 'wallet':
          await login.wallet();
          break;
      }
    } catch (error: any) {
      console.error(`[Login] Error with ${method}:`, error);
      Alert.alert(
        'Authentication Failed',
        error.message || 'Please try again.',
        [{ text: 'OK' }]
      );
    } finally {
      // Only clear loading for methods that don't require OTP
      if (method !== 'email' && method !== 'sms') {
        setLoading(null);
      }
    }
  }, [login]);

  const handleVerifyOtp = useCallback(async (otp: string) => {
    try {
      await verifyOtp(otp);
      // Privy will automatically create/retrieve wallet
      // Redirect will happen via useEffect when authenticated changes
    } catch (error: any) {
      console.error('[Login] OTP verification error:', error);
      throw error; // Let the form handle the error display
    } finally {
      setLoading(null);
    }
  }, [verifyOtp]);

  const handleCreateWallet = useCallback(() => {
    // Navigate to the manual wallet creation flow
    router.push('/(onboarding)/create-wallet');
  }, [router]);

  const handleImportWallet = useCallback(() => {
    // Navigate to wallet import flow
    router.push('/(auth)/import');
  }, [router]);

  return (
    <AuthScreen
      onLogin={handleLogin}
      onVerifyOtp={handleVerifyOtp}
      onCreateWallet={handleCreateWallet}
      onImportWallet={handleImportWallet}
      loading={loading}
    />
  );
}

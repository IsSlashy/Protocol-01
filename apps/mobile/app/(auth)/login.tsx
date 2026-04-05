/**
 * P-01 Login Screen
 *
 * Main authentication entry point using Privy.
 * Features custom P-01 cyberpunk design.
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'expo-router';
import { p01Alert } from '@/stores/alertStore';
import { AuthScreen } from '@/components/auth';
import { usePrivyAuth } from '@/providers/PrivyProvider';
import { useWalletStore } from '@/stores/walletStore';
import { useT } from '@/i18n';

type LoginMethod = 'email' | 'sms' | 'google' | 'apple' | 'twitter' | 'wallet';

export default function LoginScreen() {
  const t = useT();
  const router = useRouter();
  const {
    ready,
    authenticated,
    solanaWallet,
    login,
    verifyOtp,
    createWallet,
  } = usePrivyAuth();

  const { hasWallet: hasLocalWallet } = useWalletStore();
  const [loading, setLoading] = useState<LoginMethod | null>(null);
  const redirectedRef = useRef(false);

  // Redirect if already authenticated — wait for wallet to be available
  useEffect(() => {
    if (ready && authenticated && !redirectedRef.current) {
      const hasAnyWallet = solanaWallet?.address || hasLocalWallet;
      if (hasAnyWallet) {
        redirectedRef.current = true;
        router.replace('/(main)/(wallet)');
      }
    }
  }, [ready, authenticated, solanaWallet?.address, hasLocalWallet, router]);

  // Fallback: if authenticated but no wallet after 10s, redirect anyway
  // (Privy wallet may be loading asynchronously)
  useEffect(() => {
    if (ready && authenticated && !redirectedRef.current) {
      const timer = setTimeout(() => {
        if (!redirectedRef.current) {
          redirectedRef.current = true;
          router.replace('/(main)/(wallet)');
        }
      }, 10000);
      return () => clearTimeout(timer);
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
      // If Privy says "already logged in", treat as success and redirect
      if (error.message?.includes('Already logged in') || error.message?.includes('already logged in')) {
        console.log('[Login] Already authenticated — redirecting');
        if (!redirectedRef.current) {
          redirectedRef.current = true;
          router.replace('/(main)/(wallet)');
        }
        return;
      }
      console.error(`[Login] Error with ${method}:`, error);
      p01Alert(
        t('auth.authFailed'),
        error.message || t('onboarding.authFailedDesc'),
        [{ text: t('common.ok') }]
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
    // Navigate to the manual wallet creation flow — replace to avoid stack remnants
    router.replace('/(onboarding)/create-wallet');
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

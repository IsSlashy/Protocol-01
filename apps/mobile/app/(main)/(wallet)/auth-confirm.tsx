/**
 * Sign in to a service with this wallet.
 *
 * 🎯 REWRITTEN IN StyleSheet 2026-08-23, and off three retired palettes at
 * once. This file was Tailwind end to end and carried colours from outside the
 * design system entirely: `bg-green-500/20` with a `#22c55e` tick for an active
 * subscription (this system has NO green — success is cyan, and the theme's own
 * first line says so), `bg-red-500/20` with `#ef4444`, and a `LinearGradient`
 * disc behind the checkmark. Every heading was `text-white font-bold`.
 *
 * ⛔ THE GRADIENTS ARE GONE. Two of them: a cyan→cyan-bright disc on success
 * and a cyan→cyan disc — a gradient between a colour and itself — behind the
 * fallback service icon. Neither carried information.
 *
 * 🚨 THE PRIMARY BUTTON HELD A `<View>`. `ui/Button` renders its children
 * inside a `<Text>`, so the label was a view nested in text with its own
 * hardcoded `#0a0a0a`; it takes the icon through the prop that exists for it.
 *
 * ⚠️ THE SUCCESS STATE HAS NO Done BUTTON AND KEEPS ITS AUTO-RETURN. It is one
 * line and a tick for the two seconds before `router.back()` fires, which is
 * the "go back to where you were" the lean rules ask for, not a page.
 *
 * ⛔ `authenticateWithService`, the payload parsing, the expiry branch and the
 * subscription lookup are untouched.
 */

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  Image,
  StyleSheet,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

import { Button } from '@/components/ui/Button';
import { Colors, FontFamily, FontSize, BorderRadius, Spacing, Layout } from '@/constants/theme';
import {
  AuthQRPayload,
  authenticateWithService,
  checkSubscription,
  SubscriptionStatus,
} from '@/services/auth/p01Auth';
import { getPublicKey } from '@/services/solana/wallet';
import { useWalletStore } from '@/stores/walletStore';

type AuthState = 'loading' | 'ready' | 'authenticating' | 'success' | 'error';

export default function AuthConfirmScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    payload: string;
    serviceName: string;
    serviceLogo?: string;
    requiresSubscription: string;
    isExpired: string;
  }>();

  const [state, setState] = useState<AuthState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [subscription, setSubscription] = useState<SubscriptionStatus | null>(null);

  // Parse payload
  const payload: AuthQRPayload | null = params.payload
    ? JSON.parse(params.payload)
    : null;
  const serviceName = params.serviceName || 'Service';
  const serviceLogo = params.serviceLogo;
  const requiresSubscription = params.requiresSubscription === '1';
  const isExpired = params.isExpired === '1';

  // Get wallet address from the local wallet store.
  const storePublicKey = useWalletStore((s) => s.publicKey);

  const loadData = async () => {
    try {
      // Get wallet address — try store first, then SecureStore.
      const wallet = storePublicKey || (await getPublicKey());
      setWalletAddress(wallet);

      // Check subscription if required
      if (requiresSubscription && payload?.mint) {
        const status = await checkSubscription(payload.mint);
        setSubscription(status);
      }

      setState('ready');
    } catch (err) {
      console.error('[AuthConfirm] Load error:', err);
      setState('error');
      setError('Loading error');
    }
  };

  // Re-run loadData when storePublicKey becomes available (wallet hydration)
  useEffect(() => {
    loadData();
  }, [storePublicKey]);

  const handleConfirm = async () => {
    if (!payload) {
      setError('Invalid data');
      return;
    }

    setState('authenticating');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      const result = await authenticateWithService({
        payload,
        isExpired,
        requiresSubscription,
        serviceName,
        serviceLogo,
      }, walletAddress || storePublicKey || undefined);

      if (result.success) {
        setState('success');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

        // Auto-close after success
        setTimeout(() => {
          router.back();
        }, 2000);
      } else {
        setState('error');
        setError(result.error || 'Authentication failed');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    } catch (err: any) {
      setState('error');
      setError(err.message || 'Unexpected error');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  const handleCancel = () => {
    router.back();
  };

  const closeButton = (
    <TouchableOpacity
      onPress={handleCancel}
      style={styles.headerButton}
      accessibilityRole="button"
      accessibilityLabel="Close"
    >
      <Ionicons name="close" size={22} color={Colors.textSecondary} />
    </TouchableOpacity>
  );

  // The request is stale
  if (isExpired) {
    return (
      <SafeAreaView style={styles.ground}>
        <View style={styles.header}>
          {closeButton}
          <View style={styles.headerButton} />
        </View>
        <View style={styles.centred}>
          <Ionicons name="time-outline" size={40} color={Colors.textTertiary} />
          <Text style={styles.centredTitle} accessibilityRole="header">This request expired</Text>
          <Text style={styles.centredBody}>Ask the service for a new QR code and scan it again.</Text>
          <Button variant="secondary" size="lg" fullWidth style={styles.centredAction} onPress={handleCancel}>
            Back
          </Button>
        </View>
      </SafeAreaView>
    );
  }

  if (state === 'loading') {
    return (
      <SafeAreaView style={[styles.ground, styles.centred]}>
        <ActivityIndicator size="large" color={Colors.primary} />
        <Text style={styles.centredBody}>Checking this request…</Text>
      </SafeAreaView>
    );
  }

  if (state === 'success') {
    return (
      <SafeAreaView style={[styles.ground, styles.centred]}>
        <Ionicons name="checkmark-circle" size={44} color={Colors.primary} />
        <Text style={styles.centredTitle} accessibilityRole="header">Signed in to {serviceName}</Text>
      </SafeAreaView>
    );
  }

  if (state === 'error') {
    return (
      <SafeAreaView style={styles.ground}>
        <View style={styles.header}>
          {closeButton}
          <View style={styles.headerButton} />
        </View>
        <View style={styles.centred}>
          <Ionicons name="alert-circle-outline" size={40} color={Colors.error} />
          <Text style={styles.centredTitle} accessibilityRole="header">Could not sign in</Text>
          <Text style={styles.centredBody} accessibilityRole="alert">{error}</Text>
          <View style={styles.centredActions}>
            <Button variant="primary" size="lg" fullWidth onPress={loadData}>
              Try again
            </Button>
            <Button variant="ghost" size="md" fullWidth onPress={handleCancel}>
              Cancel
            </Button>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  const blockedBySubscription = requiresSubscription && !subscription?.active;

  return (
    <SafeAreaView style={styles.ground}>
      <View style={styles.header}>
        {closeButton}
        <View style={styles.headerButton} />
      </View>

      <View style={styles.body}>
        {/* Who is asking */}
        <View style={styles.service}>
          {serviceLogo ? (
            <Image source={{ uri: serviceLogo }} style={styles.serviceLogo} resizeMode="cover" />
          ) : (
            <View style={[styles.serviceLogo, styles.serviceLogoFallback]}>
              <Ionicons name="apps-outline" size={30} color={Colors.textSecondary} />
            </View>
          )}
          <Text style={styles.serviceName} accessibilityRole="header">{serviceName}</Text>
          <Text style={styles.serviceAsk}>wants to verify who you are</Text>
        </View>

        {/* What it will see */}
        <View style={styles.panel}>
          <View style={styles.panelRow}>
            <Text style={styles.panelLabel}>Wallet</Text>
            <Text style={styles.panelValue}>
              {walletAddress
                ? `${walletAddress.slice(0, 8)}…${walletAddress.slice(-8)}`
                : 'Loading…'}
            </Text>
          </View>

          {requiresSubscription ? (
            <>
              <View style={styles.divider} />
              <View style={styles.panelRow}>
                <Text style={styles.panelLabel}>Subscription</Text>
                <Text
                  style={[
                    styles.panelValue,
                    subscription?.active ? styles.valueGood : styles.valueBad,
                  ]}
                >
                  {subscription?.active ? 'Active' : 'Not active'}
                </Text>
              </View>
            </>
          ) : null}
        </View>

        <Text style={styles.permissionsTitle}>Signing in lets it check</Text>
        <View style={styles.permission}>
          <Ionicons name="finger-print-outline" size={18} color={Colors.textSecondary} />
          <Text style={styles.permissionText}>That this wallet is yours</Text>
        </View>
        {requiresSubscription ? (
          <View style={styles.permission}>
            <Ionicons name="card-outline" size={18} color={Colors.textSecondary} />
            <Text style={styles.permissionText}>That your subscription is paid up</Text>
          </View>
        ) : null}

        {blockedBySubscription ? (
          <Text style={styles.blocked} accessibilityRole="alert">
            {serviceName} needs an active subscription before you can sign in.
          </Text>
        ) : null}
      </View>

      <View style={[styles.footer, { paddingBottom: Layout.tabBarTotalHeight + insets.bottom }]}>
        <Button
          variant="primary"
          size="lg"
          fullWidth
          loading={state === 'authenticating'}
          disabled={blockedBySubscription}
          onPress={handleConfirm}
          icon={<Ionicons name="finger-print" size={20} color={Colors.background} />}
          accessibilityLabel="Confirm with biometrics"
        >
          Confirm with biometrics
        </Button>
        <Button variant="ghost" size="md" fullWidth onPress={handleCancel}>
          Cancel
        </Button>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  ground: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    minHeight: 56,
  },
  headerButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },

  centred: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing['3xl'],
  },
  centredTitle: {
    color: Colors.text,
    fontFamily: FontFamily.display,
    fontSize: FontSize['2xl'],
    textAlign: 'center',
    marginTop: Spacing.lg,
  },
  centredBody: {
    color: Colors.textSecondary,
    fontFamily: FontFamily.regular,
    fontSize: FontSize.md,
    textAlign: 'center',
    lineHeight: 22,
    marginTop: Spacing.sm,
  },
  centredAction: { marginTop: Spacing['3xl'] },
  centredActions: { width: '100%', gap: Spacing.md, marginTop: Spacing['3xl'] },

  body: { flex: 1, paddingHorizontal: Spacing.xl },
  service: { alignItems: 'center', paddingVertical: Spacing['3xl'] },
  serviceLogo: {
    width: 72,
    height: 72,
    borderRadius: BorderRadius.xl,
    marginBottom: Spacing.lg,
  },
  serviceLogoFallback: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  serviceName: {
    color: Colors.text,
    fontFamily: FontFamily.display,
    fontSize: FontSize['3xl'],
    textAlign: 'center',
  },
  serviceAsk: {
    color: Colors.textSecondary,
    fontFamily: FontFamily.regular,
    fontSize: FontSize.md,
    marginTop: Spacing.xs,
  },

  panel: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.lg,
    marginBottom: Spacing['2xl'],
  },
  panelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.lg,
    paddingVertical: Spacing.lg,
  },
  panelLabel: {
    color: Colors.textSecondary,
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
  },
  panelValue: {
    color: Colors.text,
    fontFamily: FontFamily.mono,
    fontSize: FontSize.sm,
    flexShrink: 1,
  },
  valueGood: { color: Colors.primary },
  valueBad: { color: Colors.error },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Colors.borderSoft,
  },

  permissionsTitle: {
    color: Colors.textSecondary,
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    marginBottom: Spacing.md,
  },
  permission: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  permissionText: {
    color: Colors.text,
    fontFamily: FontFamily.regular,
    fontSize: FontSize.md,
    flex: 1,
  },
  blocked: {
    color: Colors.yellow,
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    lineHeight: 20,
    marginTop: Spacing.lg,
  },

  footer: {
    paddingHorizontal: Spacing.xl,
    gap: Spacing.sm,
  },
});

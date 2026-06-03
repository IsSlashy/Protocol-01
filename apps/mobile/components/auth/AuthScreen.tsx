/**
 * P-01 Auth Screen Component
 *
 * Local seed-phrase wallet connect / onboarding screen. Privy (email / OTP /
 * social / embedded wallet) has been removed — spec §3 Phase 1. The only two
 * actions are "Create a new wallet" (mints a local seed-phrase keypair) and
 * "Import wallet" (restore from an existing seed phrase).
 *
 * Hero layout: a centered logo + wordmark, one primary "create" CTA, and a
 * quiet secondary "import" link. Smooth gradient background, no decorative grid.
 */

import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';

import { Logo } from '../onboarding/Logo';
import { useT } from '@/i18n';

// P-01 Colors
const P01 = {
  cyan: '#39c5bb',
  cyanDim: 'rgba(57, 197, 187, 0.15)',
  cyanBright: '#00ffe5',
  pink: '#ff2d7a',
  pinkDim: 'rgba(255, 45, 122, 0.15)',
  void: '#0a0a0c',
  surface: '#151518',
  surfaceElevated: '#1a1a1f',
  border: '#2a2a30',
  textPrimary: '#ffffff',
  textSecondary: '#888892',
  textTertiary: '#555560',
};

interface AuthScreenProps {
  /** Mint a new local seed-phrase wallet. */
  onCreateWallet: () => void;
  /** Restore a wallet from an existing seed phrase. */
  onImportWallet: () => void;
  /** True while a wallet action is in flight (disables the buttons). */
  loading?: boolean;
}

export function AuthScreen({
  onCreateWallet,
  onImportWallet,
  loading = false,
}: AuthScreenProps) {
  const t = useT();

  return (
    <SafeAreaView style={styles.container}>
      {/* Smooth gradient background (no grid) */}
      <LinearGradient
        colors={['rgba(57,197,187,0.06)', 'transparent', 'rgba(255,45,122,0.04)']}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={StyleSheet.absoluteFill}
      />

      {/* Hero: logo + wordmark, centered in the available space */}
      <Animated.View
        entering={FadeInDown.delay(120).duration(650)}
        style={styles.hero}
      >
        <View accessibilityLabel="Protocol 01 logo" accessibilityRole="image">
          <Logo size={112} showText={false} animated />
        </View>
        <Text style={styles.brand} accessibilityRole="header">
          PROTOCOL 01
        </Text>
        <View style={styles.statusIndicator}>
          <View style={styles.statusDot} />
          <Text style={styles.statusText}>{t('auth.secureChannel')}</Text>
        </View>
      </Animated.View>

      {/* Actions: one primary CTA + a quiet import link */}
      <Animated.View
        entering={FadeInUp.delay(320).duration(650)}
        style={styles.actions}
      >
        <TouchableOpacity
          onPress={onCreateWallet}
          activeOpacity={0.85}
          disabled={loading}
          style={[styles.primaryButton, loading && styles.buttonDisabled]}
          accessibilityRole="button"
          accessibilityLabel={t('onboarding.getStarted')}
        >
          {loading ? (
            <ActivityIndicator color={P01.void} />
          ) : (
            <>
              <Ionicons name="add-circle-outline" size={20} color={P01.void} />
              <Text style={styles.primaryButtonLabel}>
                {t('onboarding.getStarted').toUpperCase()}
              </Text>
            </>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          onPress={onImportWallet}
          activeOpacity={0.7}
          disabled={loading}
          style={styles.importLink}
          accessibilityRole="button"
          accessibilityLabel={t('auth.importWalletLabel')}
        >
          <Text style={styles.importLinkText}>{t('auth.import')}</Text>
          <Ionicons name="arrow-forward" size={15} color={P01.cyan} />
        </TouchableOpacity>
      </Animated.View>

      {/* Footer: terms + security badge */}
      <View style={styles.footer}>
        <Text style={styles.terms} accessibilityRole="text">
          {t('auth.termsAgreement')}{' '}
          <Text style={styles.termsLink} accessibilityRole="link">
            {t('auth.termsOfService')}
          </Text>
          {' '}{t('auth.and')}{' '}
          <Text style={styles.termsLink} accessibilityRole="link">
            {t('auth.privacyPolicy')}
          </Text>
        </Text>
        <View
          style={styles.securityBadge}
          accessibilityRole="text"
          accessibilityLabel={t('auth.endToEndEncrypted')}
        >
          <Ionicons name="shield-checkmark" size={14} color={P01.cyan} />
          <Text style={styles.securityText}>{t('auth.endToEndEncrypted')}</Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: P01.void,
    paddingHorizontal: 28,
  },
  hero: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brand: {
    color: P01.textPrimary,
    fontSize: 26,
    fontWeight: '900',
    letterSpacing: 6,
    marginTop: 28,
  },
  statusIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 14,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: P01.cyan,
    marginRight: 8,
  },
  statusText: {
    color: P01.textTertiary,
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 3,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  actions: {
    gap: 18,
    marginBottom: 28,
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: P01.cyan,
    paddingVertical: 17,
    borderRadius: 14,
  },
  primaryButtonLabel: {
    color: P01.void,
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 1,
  },
  importLink: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 4,
  },
  importLinkText: {
    color: P01.cyan,
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 1,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  footer: {
    alignItems: 'center',
    paddingBottom: 16,
    gap: 14,
  },
  terms: {
    color: P01.textTertiary,
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 18,
  },
  termsLink: {
    color: P01.textSecondary,
    textDecorationLine: 'underline',
  },
  securityBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  securityText: {
    color: P01.textTertiary,
    fontSize: 12,
    fontWeight: '500',
  },
});

export default AuthScreen;

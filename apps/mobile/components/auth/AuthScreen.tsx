/**
 * P-01 Auth Screen Component
 *
 * Local-wallet connect / onboarding screen. Privy (email / OTP / social /
 * embedded wallet) has been removed — spec §3 Phase 1. The only two actions are
 * "Create a new wallet" (mints a local seed-phrase keypair) and "Import wallet"
 * (restore from an existing seed phrase).
 */

import React from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  FadeIn,
  FadeInDown,
  FadeInUp,
} from 'react-native-reanimated';

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
      {/* Background Effects */}
      <LinearGradient
        colors={['rgba(57,197,187,0.03)', 'transparent', 'rgba(255,45,122,0.02)']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Animated.View entering={FadeIn.duration(400)} style={styles.mainContent}>
          {/* Logo Section */}
          <Animated.View
            entering={FadeInDown.delay(100).duration(600)}
            style={styles.logoSection}
          >
            <View accessibilityLabel="Protocol 01 logo" accessibilityRole="image">
              <Logo size={100} showText={false} animated />
            </View>

            <View style={styles.titleContainer}>
              <Text style={styles.systemLabel}>{t('auth.authentication')}</Text>
              <Text style={styles.title} accessibilityRole="header">{t('auth.connect')}</Text>
              <View style={styles.statusIndicator}>
                <View style={styles.statusDot} />
                <Text style={styles.statusText}>{t('auth.secureChannel')}</Text>
              </View>
            </View>
          </Animated.View>

          {/* Wallet actions */}
          <Animated.View
            entering={FadeInUp.delay(300).duration(600)}
            style={styles.loginOptions}
          >
            {/* Create a new local wallet */}
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

            {/* Import an existing wallet */}
            <TouchableOpacity
              onPress={onImportWallet}
              activeOpacity={0.85}
              disabled={loading}
              style={[styles.outlineButton, loading && styles.buttonDisabled]}
              accessibilityRole="button"
              accessibilityLabel={t('auth.importWalletLabel')}
            >
              <Ionicons name="key-outline" size={20} color={P01.cyan} />
              <Text style={styles.outlineButtonLabel}>
                {t('auth.import').toUpperCase()}
              </Text>
            </TouchableOpacity>
          </Animated.View>

          {/* Bottom helper copy */}
          <Animated.View
            entering={FadeInUp.delay(500).duration(600)}
            style={styles.bottomActions}
          >
            <Text style={styles.helperText} accessibilityRole="text">
              {t('auth.haveSeedPhrase')}
            </Text>
          </Animated.View>

          {/* Terms */}
          <Text style={styles.terms} accessibilityRole="text">
            {t('auth.termsAgreement')}{' '}
            <Text style={styles.termsLink} accessibilityRole="link">{t('auth.termsOfService')}</Text>
            {' '}{t('auth.and')}{' '}
            <Text style={styles.termsLink} accessibilityRole="link">{t('auth.privacyPolicy')}</Text>
          </Text>
        </Animated.View>
      </ScrollView>

      {/* Security Badge */}
      <View style={styles.securityBadge} accessibilityRole="text" accessibilityLabel={t('auth.endToEndEncrypted')}>
        <Ionicons name="shield-checkmark" size={14} color={P01.cyan} />
        <Text style={styles.securityText}>{t('auth.endToEndEncrypted')}</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: P01.void,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: 40,
  },
  mainContent: {
    flex: 1,
  },
  logoSection: {
    alignItems: 'center',
    marginBottom: 40,
  },
  titleContainer: {
    alignItems: 'center',
    marginTop: 24,
  },
  systemLabel: {
    color: P01.pink,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 4,
    marginBottom: 8,
  },
  title: {
    color: P01.textPrimary,
    fontSize: 32,
    fontWeight: '900',
    letterSpacing: 4,
  },
  statusIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
  },
  statusDot: {
    width: 6,
    height: 6,
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
  loginOptions: {
    marginBottom: 24,
    gap: 16,
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: P01.cyan,
    paddingVertical: 16,
    borderRadius: 12,
  },
  primaryButtonLabel: {
    color: P01.void,
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 1,
  },
  outlineButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: P01.cyan,
    paddingVertical: 16,
    borderRadius: 12,
  },
  outlineButtonLabel: {
    color: P01.cyan,
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 1,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  bottomActions: {
    alignItems: 'center',
    marginTop: 8,
    gap: 12,
  },
  helperText: {
    color: P01.textSecondary,
    fontSize: 14,
    textAlign: 'center',
  },
  terms: {
    color: P01.textTertiary,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 24,
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
    paddingVertical: 12,
    gap: 6,
  },
  securityText: {
    color: P01.textTertiary,
    fontSize: 12,
    fontWeight: '500',
  },
});

export default AuthScreen;

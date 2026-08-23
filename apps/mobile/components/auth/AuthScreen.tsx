/**
 * AuthScreen — the first screen, and the whole of it.
 *
 * Local seed-phrase wallet entry. Privy (email / OTP / social / embedded
 * wallet) was removed in spec §3 Phase 1, so there are exactly two things a
 * person can do here: mint a new wallet, or restore one they already have.
 *
 * 🚨 THIS FILE HELD ITS OWN PALETTE. A local `const P01 = { … }` declared
 * fourteen colours — including `pinkDim: 'rgba(255, 45, 122, 0.15)'`, which is
 * the RETIRED pink, sitting one line under a `pink` key that the theme sweep
 * had already aliased to cyan. That is the failure mode the design-system test
 * exists for: a screen that keeps a private copy of the palette does not move
 * when the palette moves, and this one was the first screen in the app. Every
 * colour here now reads `Colors.*`.
 *
 * ⛔ THREE THINGS ARE GONE, AND NONE OF THEM CARRIED A DECISION:
 *   - the background gradient, whose third stop was `rgba(255,45,122,0.04)`,
 *     i.e. the retired pink again, bleeding into the bottom of the screen
 *   - "● SECURE CHANNEL" in 10pt letter-spaced monospace caps. It is not a
 *     status: nothing is connected yet, there is no channel, and the dot is
 *     hardcoded on. A green light that is always green is decoration.
 *   - the "End-to-end encrypted" shield badge in the footer. Same shape of
 *     claim, same lack of a thing to press.
 *
 * 🎯 The heading is the Wordmark rather than "PROTOCOL 01" in 900-weight
 * 6pt-tracked caps. The mark carries the brand; a shouted string does not.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';

import { Wordmark } from '../common/Wordmark';
import { Button } from '../ui/Button';
import { Colors, Spacing, FontFamily, FontSize } from '@/constants/theme';
import { useT } from '@/i18n';

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
      {/* Hero: the mark, and one line saying what this is. */}
      <Animated.View
        entering={FadeInDown.delay(120).duration(650)}
        style={styles.hero}
      >
        <Wordmark size={64} showText />
        <Text style={styles.tagline} accessibilityRole="header">
          {t('onboarding.tagline')}
        </Text>
      </Animated.View>

      {/* Actions. One primary; restoring is the quieter of the two because
          most people arriving here do not have a phrase yet. */}
      <Animated.View
        entering={FadeInUp.delay(320).duration(650)}
        style={styles.actions}
      >
        <Button
          onPress={onCreateWallet}
          loading={loading}
          fullWidth
          size="lg"
          accessibilityLabel={t('onboarding.createWallet')}
        >
          {t('onboarding.createWallet')}
        </Button>

        <Button
          variant="secondary"
          onPress={onImportWallet}
          disabled={loading}
          fullWidth
          size="lg"
          accessibilityLabel={t('auth.importWalletLabel')}
        >
          {t('onboarding.importWallet')}
        </Button>
      </Animated.View>

      <View style={styles.footer}>
        <Text style={styles.terms}>
          {t('auth.termsAgreement')}{' '}
          <Text style={styles.termsLink} accessibilityRole="link">
            {t('auth.termsOfService')}
          </Text>
          {' '}{t('auth.and')}{' '}
          <Text style={styles.termsLink} accessibilityRole="link">
            {t('auth.privacyPolicy')}
          </Text>
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
    paddingHorizontal: Spacing['2xl'],
  },
  hero: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tagline: {
    color: Colors.textSecondary,
    fontFamily: FontFamily.regular,
    fontSize: FontSize.md,
    textAlign: 'center',
    marginTop: Spacing.lg,
  },
  actions: {
    gap: Spacing.md,
    marginBottom: Spacing['3xl'],
  },
  footer: {
    alignItems: 'center',
    paddingBottom: Spacing.lg,
  },
  terms: {
    color: Colors.textTertiary,
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    textAlign: 'center',
    lineHeight: 18,
  },
  termsLink: {
    color: Colors.textSecondary,
    textDecorationLine: 'underline',
  },
});

export default AuthScreen;

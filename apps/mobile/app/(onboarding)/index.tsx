/**
 * The welcome — the phone's version of protocol-01.dev's first screen.
 *
 * Rewritten 2026-09-13 to be the same page as the web home: the river under
 * everything (StyxRiver, the site's StyxField shader in Skia), the mono
 * overline, the same headline as the site's h1, one lede, the paper button,
 * and the amber devnet line. What it replaced: "[ SYSTEM STATUS ] / SHIELDED /
 * READY" in white at weight 900 with 6pt of tracking, a cyan button with a
 * white label and an elevation halo, and a '#a0a0a0' grey. Three surfaces,
 * one product; this screen is where a person decides whether that is true.
 *
 * The routing is unchanged: the wallet store redirects when a wallet exists,
 * "Get started" goes straight to creation (this screen IS the chooser), import
 * and scan-to-connect keep their routes.
 */
import React, { useEffect } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, { FadeIn, FadeInDown, FadeInUp } from 'react-native-reanimated';

import { Wordmark } from '../../components/common/Wordmark';
import {
  Accent,
  DevnetLine,
  GhostLink,
  Hairline,
  Lede,
  Overline,
  PaperButton,
  Screen,
  Title,
} from '../../components/onboarding/Styx';
import { useWalletStore } from '@/stores/walletStore';
import { useT } from '@/i18n';

export default function WelcomeScreen() {
  const t = useT();
  const router = useRouter();
  // Local wallet only (Privy removed — spec §3 Phase 1).
  const { initialized, hasWallet } = useWalletStore();

  // Redirect if a local wallet already exists.
  useEffect(() => {
    if (initialized && hasWallet) {
      try {
        router.replace('/(main)/(wallet)');
      } catch (err) {
        console.error('[Onboarding] Navigation error:', err);
      }
    }
  }, [initialized, hasWallet, router]);

  const handleGetStarted = () => {
    // Single-screen onboarding: this welcome IS the chooser, so "Get Started"
    // goes straight to wallet creation.
    router.replace('/(onboarding)/create-wallet');
  };
  const handleImportWallet = () => router.replace('/(auth)/import');
  const handleScanConnect = () => router.push('/(auth)/scan-connect');

  return (
    <Screen river={{ flow: 0.2, dim: 0.3, touch: true }}>
      <Animated.View entering={FadeIn.delay(200).duration(700)} style={{ paddingTop: 18 }} pointerEvents="none">
        <Wordmark size={22} showText />
      </Animated.View>

      <View style={{ flex: 1, justifyContent: 'flex-end', paddingBottom: 36 }} pointerEvents="box-none">
        <Animated.View entering={FadeInDown.delay(400).duration(700)} pointerEvents="none">
          <Overline>{t('onboarding.overline')}</Overline>
        </Animated.View>
        <Animated.View entering={FadeInDown.delay(520).duration(800)} style={{ marginTop: 14 }} pointerEvents="none">
          <Title size={42}>{t('onboarding.h1')}</Title>
        </Animated.View>
        <Animated.View entering={FadeIn.delay(900).duration(600)} style={{ marginTop: 22, width: '72%' }} pointerEvents="none">
          <Hairline seal />
        </Animated.View>
        <Animated.View entering={FadeInDown.delay(980).duration(700)} style={{ marginTop: 18 }} pointerEvents="none">
          <Lede>{t('onboarding.lede')}</Lede>
        </Animated.View>
      </View>

      <View style={{ paddingBottom: 20, gap: 4 }}>
        <Animated.View entering={FadeInUp.delay(1150).duration(600)}>
          <PaperButton label={t('onboarding.getStarted')} onPress={handleGetStarted} />
        </Animated.View>
        <Animated.View entering={FadeInUp.delay(1300).duration(600)} style={{ marginTop: 10 }}>
          <GhostLink onPress={handleImportWallet} accessibilityLabel={t('onboarding.import')}>
            {t('onboarding.alreadyHaveWallet')} <Accent>{t('onboarding.import')}</Accent>
          </GhostLink>
          <GhostLink onPress={handleScanConnect} accessibilityLabel={t('onboarding.scanToConnect')}>
            <Accent>{t('onboarding.scanToConnect')}</Accent>
          </GhostLink>
        </Animated.View>
        <DevnetLine tag={t('onboarding.devnetTag')}>{t('onboarding.devnetLine')}</DevnetLine>
      </View>
    </Screen>
  );
}

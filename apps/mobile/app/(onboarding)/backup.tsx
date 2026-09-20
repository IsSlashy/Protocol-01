/**
 * Backup — the twelve words.
 *
 * Restyled 2026-09-13 onto the onboarding vocabulary (components/onboarding/
 * Styx.tsx): overline, Newsreader title, lede, hairline panels, the paper
 * button. Gone: the key icon in a teal bubble, the '#a0a0a0' grey, the
 * '#ef4444' red box (the theme's caution colour is amber, and "never share
 * these words" is a caution, not an error), the button's elevation halo.
 *
 * ⚠️ Untouched: the screen-capture block, the mnemonic lookup order (temp with
 * keychainService → temp without → permanent), the 60-second clipboard scrub,
 * and the acknowledgement gate on the continue button.
 */
import React, { useState, useEffect } from 'react';
import { View, Text, Pressable, ScrollView, ActivityIndicator, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, { FadeIn, FadeInDown, FadeInUp } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import * as SecureStore from 'expo-secure-store';
import * as ScreenCapture from 'expo-screen-capture';

import { SeedPhraseGrid } from '../../components/onboarding';
import {
  Accent,
  GhostLink,
  Lede,
  Overline,
  Panel,
  PaperButton,
  Screen,
  Title,
} from '../../components/onboarding/Styx';
import { Colors, FontFamily } from '../../constants/theme';
import { useT } from '@/i18n';

export default function BackupScreen() {
  const t = useT();
  const router = useRouter();
  const [hasAcknowledged, setHasAcknowledged] = useState(false);
  const [copied, setCopied] = useState(false);
  const [seedPhrase, setSeedPhrase] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    ScreenCapture.preventScreenCaptureAsync();
    return () => {
      ScreenCapture.allowScreenCaptureAsync();
    };
  }, []);

  useEffect(() => {
    loadMnemonic();
    return () => {
      setSeedPhrase([]);
    };
  }, []);

  const loadMnemonic = async () => {
    try {
      const secOpts = { keychainService: 'protocol-01' };
      // Try with keychainService first (new), then without (legacy), then permanent fallback
      let mnemonic =
        (await SecureStore.getItemAsync('p01_temp_mnemonic', secOpts)) ||
        (await SecureStore.getItemAsync('p01_temp_mnemonic'));

      if (!mnemonic || !mnemonic.trim()) {
        console.warn('[Backup] No temp mnemonic, falling back to permanent storage');
        mnemonic = await SecureStore.getItemAsync('p01_mnemonic', secOpts);
      }

      if (mnemonic && mnemonic.trim()) {
        const words = mnemonic.trim().split(' ').filter((w) => w.length > 0);
        if (words.length === 12) {
          setSeedPhrase(words);
        } else {
          console.error('[Backup] Invalid word count:', words.length);
        }
      } else {
        console.error('[Backup] No mnemonic found in any storage');
      }
    } catch (error) {
      console.error('[Backup] Error loading mnemonic:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCopyAll = async () => {
    await Clipboard.setStringAsync(seedPhrase.join(' '));
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setCopied(true);

    // Security: Auto-clear clipboard after 60 seconds
    setTimeout(async () => {
      try {
        const currentClipboard = await Clipboard.getStringAsync();
        if (currentClipboard === seedPhrase.join(' ')) {
          await Clipboard.setStringAsync('');
        }
      } catch {}
    }, 60000);

    setTimeout(() => setCopied(false), 2000);
  };

  const handleContinue = () => {
    if (hasAcknowledged) {
      router.replace('/(onboarding)/verify');
    }
  };

  if (isLoading) {
    return (
      <Screen style={styles.centred}>
        <ActivityIndicator size="large" color={Colors.primary} />
      </Screen>
    );
  }

  // Show error if seed phrase failed to load
  if (seedPhrase.length === 0) {
    return (
      <Screen style={styles.centred}>
        <Overline>{t('onboarding.overline')}</Overline>
        <View style={{ marginTop: 12 }}>
          <Title size={28}>{t('onboarding.failedToLoadSeed')}</Title>
        </View>
        <View style={{ marginTop: 12, marginBottom: 28 }}>
          <Lede>{t('onboarding.failedToLoadSeedDesc')}</Lede>
        </View>
        <PaperButton label={t('onboarding.tryAgain')} onPress={() => router.replace('/(onboarding)/create-wallet')} />
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: 28, paddingBottom: 16 }}
        showsVerticalScrollIndicator={false}
      >
        <Animated.View entering={FadeInDown.delay(150).duration(600)}>
          <Overline>{t('onboarding.overline')}</Overline>
          <View style={{ marginTop: 12 }}>
            <Title size={30}>{t('onboarding.backupSeedPhrase')}</Title>
          </View>
          <View style={{ marginTop: 10, marginBottom: 24 }}>
            <Lede>{t('onboarding.writeDownWords')}</Lede>
          </View>
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(350).duration(600)}>
          <Panel>
            <SeedPhraseGrid words={seedPhrase} showCopyButton={false} revealDelay={80} />
            <GhostLink onPress={handleCopyAll} accessibilityLabel={t('onboarding.copyAll')}>
              <Accent>{copied ? t('common.copied') : t('onboarding.copyAll')}</Accent>
            </GhostLink>
          </Panel>
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(550).duration(600)} style={{ marginTop: 16 }}>
          <Panel tone="warn">
            <Text style={styles.warnTitle}>{t('onboarding.neverShareWords')}</Text>
            <Text style={styles.warnBody}>{t('onboarding.neverShareWordsDesc')}</Text>
          </Panel>
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(750).duration(600)}>
          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              setHasAcknowledged(!hasAcknowledged);
            }}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: hasAcknowledged }}
            accessibilityLabel={t('onboarding.acknowledgeSeed')}
            style={styles.ack}
          >
            <View style={[styles.box, hasAcknowledged && styles.boxOn]}>
              {hasAcknowledged ? <Text style={styles.boxTick}>{'✓'}</Text> : null}
            </View>
            <Text style={styles.ackText}>{t('onboarding.acknowledgeSeed')}</Text>
          </Pressable>
        </Animated.View>
      </ScrollView>

      <Animated.View entering={FadeInUp.delay(900).duration(600)} style={{ paddingBottom: 24 }}>
        <PaperButton label={t('onboarding.writtenThemDown')} onPress={handleContinue} disabled={!hasAcknowledged} />
      </Animated.View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  centred: { justifyContent: 'center' },
  warnTitle: { fontFamily: FontFamily.medium, fontSize: 14, color: Colors.warning, marginBottom: 6 },
  warnBody: { fontFamily: FontFamily.regular, fontSize: 13, lineHeight: 19, color: Colors.textSecondary },
  ack: { flexDirection: 'row', alignItems: 'center', paddingVertical: 18, gap: 12 },
  box: {
    width: 22,
    height: 22,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: { backgroundColor: Colors.text, borderColor: Colors.text },
  boxTick: { fontFamily: FontFamily.mono, fontSize: 13, color: Colors.background },
  ackText: { flex: 1, fontFamily: FontFamily.regular, fontSize: 14, lineHeight: 20, color: Colors.text },
});

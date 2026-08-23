/**
 * About — what this build is, and where the project lives.
 *
 * 🎯 REBUILT ON THE REALIGNED THEME AND THE SHARED KIT 2026-08-23.
 *
 * ⛔ THE 01 RASTER IS GONE. This screen opened with a 96pt rounded tile of
 * `assets/images/Protocol.png` — the retired mark, shipped as an image, sitting
 * above a line of hot-pink `RELEASE_CODENAME.toUpperCase()` with a snowflake
 * next to it. Founder ruling 2026-08-23: the mark is the serif S cut by a cyan
 * diagonal, and it is composed, not rastered. It comes from
 * `components/common/Wordmark.tsx` here like everywhere else.
 *
 * ⛔ THE SOCIAL TILES NO LONGER CARRY OTHER COMPANIES' BRAND COLOURS.
 * `#1DA1F2` and `#5865F2` are Twitter's and Discord's blues — two more colours
 * from outside the palette, on a screen whose job is to say what this product
 * is. One accent, four identical rows, each one a link that says where it goes.
 *
 * ⛔ AND THE GLASS IS GONE: a `BlurView` with a cyan→pink `LinearGradient`
 * wash, on four separate panels, all four hardcoded.
 */

import React, { useRef } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Linking, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';

import { Header, Wordmark } from '@/components/common';
import { SettingsRow, SettingsSection } from '@/components/settings';
import { Colors, FontFamily, FontSize, BorderRadius, Spacing, Layout } from '@/constants/theme';
import { RELEASE_CODENAME } from '@/constants/release';
import { checkForUpdate } from '@/services/updates/versionCheck';
import { useT } from '@/i18n';

const APP_VERSION = Constants.expoConfig?.version ?? '0.0.0';
const BUILD_NUMBER = String(Constants.expoConfig?.android?.versionCode ?? Constants.expoConfig?.ios?.buildNumber ?? '1');

const SOCIAL_LINKS: { icon: keyof typeof Ionicons.glyphMap; label: string; value: string; url: string }[] = [
  { icon: 'globe-outline', label: 'Website', value: 'protocol-01.dev', url: 'https://protocol-01.dev' },
  { icon: 'logo-github', label: 'GitHub', value: 'IsSlashy/Protocol-01', url: 'https://github.com/IsSlashy/Protocol-01' },
  { icon: 'logo-twitter', label: 'X', value: '@Protocol01_', url: 'https://x.com/Protocol01_' },
  { icon: 'logo-discord', label: 'Discord', value: 'Join', url: 'https://discord.gg/EfqnVmb2dV' },
];

const LEGAL_LINKS: { key: 'privacyPolicy' | 'termsOfService' | 'openSource'; url: string }[] = [
  { key: 'privacyPolicy', url: 'https://protocol-01.dev/privacy' },
  { key: 'termsOfService', url: 'https://protocol-01.dev/terms' },
  { key: 'openSource', url: 'https://protocol-01.dev/licenses' },
];

const TECH = ['Solana', 'React Native', 'Expo', 'STARKs', 'Poseidon', 'ML-KEM'];

export default function AboutScreen() {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const devTapCount = useRef(0);

  return (
    <View style={styles.screen}>
      <Header title={t('settings.about')} showBack onBackPress={() => router.back()} />

      <ScrollView
        style={styles.flex}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingBottom: Layout.tabBarTotalHeight + insets.bottom + Spacing['3xl'],
        }}
      >
        {/* ── The mark, the name, the build. Nothing else above the fold. ── */}
        <View style={styles.masthead}>
          <Wordmark size={44} />
          <Text style={styles.name}>Styx</Text>
          <Text style={styles.tagline}>{t('settings.yourKeys')}</Text>
          <Text style={styles.build}>
            {t('settings.version')} {APP_VERSION} · {t('settings.build')} {BUILD_NUMBER} · {RELEASE_CODENAME}
          </Text>
        </View>

        <Text style={styles.description}>{t('settings.aboutDescription')}</Text>

        <SettingsSection>
          <SettingsRow
            label={t('settings.checkForUpdates')}
            leftIcon="cloud-download-outline"
            onPress={() => checkForUpdate(true)}
          />
        </SettingsSection>

        {/* ── Where the project lives ── */}
        <SettingsSection title="Links">
          {SOCIAL_LINKS.map((link) => (
            <SettingsRow
              key={link.label}
              label={link.label}
              value={link.value}
              leftIcon={link.icon}
              rightIcon="open-outline"
              accessibilityLabel={`${link.label}, opens in the browser`}
              onPress={() => Linking.openURL(link.url)}
            />
          ))}
        </SettingsSection>

        {/* ── Legal ── */}
        <SettingsSection title={t('settings.legal')}>
          {LEGAL_LINKS.map((link) => (
            <SettingsRow
              key={link.key}
              label={t(`settings.${link.key}`)}
              rightIcon="open-outline"
              accessibilityLabel={`${t(`settings.${link.key}`)}, opens in the browser`}
              onPress={() => Linking.openURL(link.url)}
            />
          ))}
        </SettingsSection>

        {/* ── Built with ── */}
        <View style={styles.techWrap}>
          <Text style={styles.techLabel}>{t('settings.builtWith')}</Text>
          <View style={styles.techRow}>
            {TECH.map((tech) => (
              <View key={tech} style={styles.techChip}>
                <Text style={styles.techChipText}>{tech}</Text>
              </View>
            ))}
          </View>
        </View>

        <Text style={styles.credits}>{t('settings.madeBy')}</Text>

        {/* The developer-mode door. Deliberately quiet, deliberately labelled:
            an unlabelled tap target is a trap for anyone using a screen reader. */}
        <TouchableOpacity
          style={styles.devDoor}
          onPress={() => {
            devTapCount.current += 1;
            if (devTapCount.current >= 7) {
              devTapCount.current = 0;
              router.push('/(main)/(settings)/privacy-test');
            }
          }}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel="Tap seven times to open the developer tools"
        >
          <Text style={styles.devDoorText}>Tap 7 times for developer tools</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  flex: {
    flex: 1,
  },

  /* Masthead */
  masthead: {
    alignItems: 'center',
    paddingTop: Spacing['3xl'],
    paddingBottom: Spacing['2xl'],
    paddingHorizontal: Spacing.xl,
  },
  name: {
    color: Colors.text,
    fontSize: FontSize['3xl'],
    fontFamily: FontFamily.display,
    letterSpacing: -0.5,
    marginTop: Spacing.md,
  },
  tagline: {
    color: Colors.textSecondary,
    fontSize: FontSize.md,
    fontFamily: FontFamily.regular,
    marginTop: Spacing.xs,
  },
  build: {
    color: Colors.textTertiary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.mono,
    marginTop: Spacing.md,
  },

  description: {
    color: Colors.textSecondary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    lineHeight: 21,
    paddingHorizontal: Spacing.xl,
  },

  /* Built with */
  techWrap: {
    marginTop: Spacing['2xl'],
    paddingHorizontal: Spacing.xl,
  },
  techLabel: {
    color: Colors.textTertiary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.medium,
    marginBottom: Spacing.md,
  },
  techRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
  },
  techChip: {
    paddingHorizontal: Spacing.md,
    paddingVertical: 6,
    borderRadius: BorderRadius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSoft,
    backgroundColor: Colors.surfaceSecondary,
  },
  techChipText: {
    color: Colors.textSecondary,
    fontSize: FontSize.xs,
    fontFamily: FontFamily.regular,
  },

  credits: {
    color: Colors.textTertiary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    textAlign: 'center',
    marginTop: Spacing['3xl'],
  },

  devDoor: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: Spacing.lg,
  },
  devDoorText: {
    color: Colors.textTertiary,
    fontSize: FontSize.xs,
    fontFamily: FontFamily.regular,
    opacity: 0.6,
  },
});

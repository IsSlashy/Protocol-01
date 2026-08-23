/**
 * import — restore a wallet from its recovery phrase.
 *
 * 🚨 THIS FILE CARRIED A GREEN, TWICE. `rgba(0, 255, 136, 0.1)` was the
 * background of both the key-icon disc and the footer note — a colour from a
 * palette this product has never used, in a design system whose header says NO
 * green in its first paragraph. It survived the token sweep because it was
 * written inline in `StyleSheet.create`, where nothing in `constants/theme.ts`
 * can reach it. Sixteen other literals sat beside it, including `#ff4444` for
 * errors (the theme's red is `#e0574f`) and `#333333` for the disabled button.
 * Every colour on this screen is now a token.
 *
 * 🎯 THE PHRASE FIELD IS THE SHARED `Input`. That is not tidying: the
 * hand-rolled TextInput rendered its error as a bare red `<Text>` with no
 * `accessibilityRole`, so a mistyped phrase — the single most likely failure on
 * this screen — was announced to a screen reader by nothing at all. `Input`
 * puts the message under the field it belongs to and marks it `alert`.
 *
 * ⛔ THE TIPS CARD IS GONE, AND THE REASON IS IN `handleImport` TWENTY LINES
 * BELOW. It listed three rules: separate words with spaces, check spelling, use
 * lowercase only. Two of the three are things the code already does for the
 * user — `.toLowerCase()` and `.replace(/\s+/g, ' ')` — so the screen was
 * asking a person to hand-perform a normalisation that had already run, and
 * charging them a card of vertical space for it. The third is covered by the
 * validator's own message.
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
} from 'react-native';
import { p01Alert } from '@/stores/alertStore';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as SecureStore from 'expo-secure-store';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { validateMnemonic } from '../../services/solana/wallet';
import { useWalletStore } from '../../stores/walletStore';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Colors, Spacing, FontFamily, FontSize, BorderRadius } from '@/constants/theme';
import { useT } from '@/i18n';

export default function ImportWalletScreen() {
  const t = useT();
  const router = useRouter();
  const { importExistingWallet } = useWalletStore();
  const [mnemonic, setMnemonic] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleImport = async () => {
    const normalizedMnemonic = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
    const words = normalizedMnemonic.split(' ').filter(w => w.length > 0);

    // Validate word count
    if (words.length !== 12 && words.length !== 24) {
      setError(t('auth.invalidWordCount'));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }

    // Validate mnemonic
    if (!validateMnemonic(normalizedMnemonic)) {
      setError(t('auth.invalidRecoveryPhrase'));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }

    setError(null);
    setIsLoading(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      await importExistingWallet(normalizedMnemonic);

      const pubKey = useWalletStore.getState().publicKey || '';
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      // Mark as onboarded and go to security setup
      await SecureStore.setItemAsync('p01_onboarded', 'true');

      p01Alert(
        t('auth.walletImported'),
        t('auth.walletImportedDesc', { address: `${pubKey.slice(0, 8)}...${pubKey.slice(-8)}` }),
        [
          {
            text: t('auth.setUpSecurity'),
            onPress: () => router.replace('/(onboarding)/security'),
          },
        ]
      );
    } catch (err: any) {
      console.error('Import error:', err);
      setError(err.message || 'Failed to import wallet');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={styles.header}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={styles.backButton}
            accessibilityRole="button"
            accessibilityLabel={t('common.back')}
          >
            <Ionicons name="arrow-back" size={22} color={Colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('onboarding.importWallet')}</Text>
          <View style={styles.backButton} />
        </View>

        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <Animated.View entering={FadeInDown.delay(100)}>
            <Text style={styles.title} accessibilityRole="header">
              {t('auth.enterRecoveryPhrase')}
            </Text>
            <Text style={styles.subtitle}>{t('auth.enterRecoveryPhraseDesc')}</Text>
          </Animated.View>

          {/* The field, and its error, together. */}
          <Animated.View entering={FadeInDown.delay(200)} style={styles.field}>
            <Input
              placeholder={t('auth.enterRecoveryPlaceholder')}
              value={mnemonic}
              onChangeText={(text) => {
                setMnemonic(text);
                setError(null);
              }}
              error={error ?? undefined}
              multiline
              numberOfLines={4}
              autoCapitalize="none"
              autoCorrect={false}
              textAlignVertical="top"
              accessibilityLabel={t('auth.enterRecoveryPhrase')}
              style={styles.phraseInput}
            />
          </Animated.View>

          {/* The other way in. A phone paired to the extension never types a
              phrase at all, which is the safer path of the two. */}
          <Animated.View entering={FadeInDown.delay(300)}>
            <TouchableOpacity
              onPress={() => router.push('/(auth)/scan-connect')}
              activeOpacity={0.7}
              style={styles.scanLink}
              accessibilityRole="button"
              accessibilityLabel={t('onboarding.scanToConnect')}
            >
              <Ionicons name="qr-code-outline" size={16} color={Colors.primary} />
              <Text style={styles.scanLinkText}>{t('onboarding.scanToConnect')}</Text>
            </TouchableOpacity>
          </Animated.View>

          <Animated.View entering={FadeInDown.delay(400)} style={styles.note}>
            <Ionicons name="lock-closed-outline" size={16} color={Colors.textTertiary} />
            <Text style={styles.noteText}>{t('auth.secureStorageNote')}</Text>
          </Animated.View>
        </ScrollView>

        <View style={styles.bottomSection}>
          <Button
            onPress={handleImport}
            disabled={!mnemonic.trim()}
            loading={isLoading}
            fullWidth
            size="lg"
            accessibilityLabel={t('onboarding.importWallet')}
          >
            {t('onboarding.importWallet')}
          </Button>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  keyboardView: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
  },
  backButton: {
    // 44pt, not the 40 it was. The floor is the floor.
    width: 44,
    height: 44,
    borderRadius: BorderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    color: Colors.text,
    fontFamily: FontFamily.displayMedium,
    fontSize: FontSize.lg,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: Spacing['2xl'],
    paddingTop: Spacing['2xl'],
    paddingBottom: Spacing['2xl'],
  },
  title: {
    color: Colors.text,
    fontFamily: FontFamily.display,
    fontSize: FontSize['2xl'],
  },
  subtitle: {
    color: Colors.textSecondary,
    fontFamily: FontFamily.regular,
    fontSize: FontSize.md,
    lineHeight: 22,
    marginTop: Spacing.sm,
  },
  field: {
    marginTop: Spacing['3xl'],
  },
  phraseInput: {
    minHeight: 112,
    fontFamily: FontFamily.mono,
    fontSize: FontSize.md,
    lineHeight: 24,
  },
  scanLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    minHeight: 44,
    marginTop: Spacing.lg,
  },
  scanLinkText: {
    color: Colors.primary,
    fontFamily: FontFamily.medium,
    fontSize: FontSize.md,
  },
  note: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.md,
    marginTop: Spacing['3xl'],
  },
  noteText: {
    flex: 1,
    color: Colors.textTertiary,
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    lineHeight: 20,
  },
  bottomSection: {
    paddingHorizontal: Spacing['2xl'],
    paddingTop: Spacing.lg,
    paddingBottom: Spacing['3xl'],
  },
});

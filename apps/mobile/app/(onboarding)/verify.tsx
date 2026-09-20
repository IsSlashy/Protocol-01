/**
 * Verify — the twelve words back, in order.
 *
 * Restyled 2026-09-13 onto the onboarding vocabulary. Gone: the shield icon in
 * a teal bubble, the '#a0a0a0' grey, the '#ef4444'/'#f87171' reds (the theme's
 * error red is Colors.error), the button's elevation halo. The drop zone is a
 * hairline panel whose border turns to the error colour on a wrong order.
 *
 * ⚠️ Untouched: the mnemonic lookup, the shuffle, the selection logic, the
 * verify/skip routes and the skip confirmation.
 */
import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { View, Text, ScrollView, ActivityIndicator, StyleSheet } from 'react-native';
import { p01Alert } from '@/stores/alertStore';
import { useRouter } from 'expo-router';
import Animated, { FadeIn, FadeInDown, FadeInUp, Layout } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import * as SecureStore from 'expo-secure-store';

import { WordChip } from '../../components/onboarding';
import { GhostLink, Lede, Mono, Overline, Panel, PaperButton, Screen, Title } from '../../components/onboarding/Styx';
import { Colors, FontFamily } from '../../constants/theme';
import { useT } from '@/i18n';

export default function VerifyScreen() {
  const t = useT();
  const router = useRouter();
  const [selectedWords, setSelectedWords] = useState<string[]>([]);
  const [error, setError] = useState(false);
  const [correctOrder, setCorrectOrder] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadMnemonic();
    return () => {
      setCorrectOrder([]);
      setSelectedWords([]);
    };
  }, []);

  const loadMnemonic = async () => {
    try {
      const secOpts = { keychainService: 'protocol-01' };
      const mnemonic =
        (await SecureStore.getItemAsync('p01_temp_mnemonic', secOpts)) ||
        (await SecureStore.getItemAsync('p01_temp_mnemonic')) ||
        (await SecureStore.getItemAsync('p01_mnemonic', secOpts));
      if (mnemonic) {
        setCorrectOrder(mnemonic.split(' '));
      }
    } catch (error) {
      console.error('Error loading mnemonic:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const shuffledWords = useMemo(() => {
    return [...correctOrder].sort(() => Math.random() - 0.5);
  }, [correctOrder]);

  const isComplete = selectedWords.length === correctOrder.length;
  const isCorrect = isComplete && selectedWords.every((word, index) => word === correctOrder[index]);

  const handleSelectWord = useCallback(
    (word: string) => {
      if (selectedWords.includes(word)) return;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setSelectedWords((prev) => [...prev, word]);
      setError(false);
    },
    [selectedWords],
  );

  const handleRemoveWord = useCallback((index: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedWords((prev) => prev.filter((_, i) => i !== index));
    setError(false);
  }, []);

  const handleClearAll = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSelectedWords([]);
    setError(false);
  }, []);

  const handleVerify = useCallback(() => {
    if (!isComplete) return;
    if (isCorrect) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace('/(onboarding)/security');
    } else {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(true);
    }
  }, [isComplete, isCorrect, router]);

  const handleSkip = useCallback(() => {
    p01Alert(t('onboarding.skipVerification'), t('onboarding.skipVerificationDesc'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('onboarding.skip'),
        style: 'destructive',
        onPress: () => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          router.replace('/(onboarding)/security');
        },
      },
    ]);
  }, [router, t]);

  const getWordVariant = (index: number): 'selected' | 'correct' | 'incorrect' => {
    if (!error) return 'selected';
    return selectedWords[index] === correctOrder[index] ? 'correct' : 'incorrect';
  };

  if (isLoading || correctOrder.length === 0) {
    return (
      <Screen style={{ justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" color={Colors.primary} />
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
            <Title size={30}>{t('onboarding.verifyBackup')}</Title>
          </View>
          <View style={{ marginTop: 10, marginBottom: 20 }}>
            <Lede>{t('onboarding.verifyBackupDesc')}</Lede>
          </View>
        </Animated.View>

        {/* Selected words */}
        <Animated.View entering={FadeInDown.delay(350).duration(600)}>
          <Panel tone={error ? 'error' : 'ink'} style={{ minHeight: 168, padding: 12 }}>
            <View style={styles.zoneHead}>
              <Mono size={12} color={Colors.textTertiary}>
                {selectedWords.length} / {correctOrder.length}
              </Mono>
              {selectedWords.length > 0 ? (
                <Text onPress={handleClearAll} style={styles.clear} accessibilityRole="button">
                  {t('onboarding.clearAll')}
                </Text>
              ) : null}
            </View>

            {selectedWords.length === 0 ? (
              <View style={styles.empty}>
                <Mono color={Colors.textTertiary}>{t('onboarding.tapWordsToAdd')}</Mono>
              </View>
            ) : (
              <View style={styles.wrap}>
                {selectedWords.map((word, index) => (
                  <Animated.View
                    key={`selected-${word}-${index}`}
                    entering={FadeIn.duration(200)}
                    layout={Layout.springify()}
                  >
                    <WordChip
                      word={word}
                      index={index}
                      showIndex
                      variant={getWordVariant(index)}
                      onPress={() => handleRemoveWord(index)}
                    />
                  </Animated.View>
                ))}
              </View>
            )}

            {error ? (
              <Animated.View entering={FadeIn.duration(200)} style={{ marginTop: 10 }}>
                <Mono size={12} color={Colors.error}>
                  {t('onboarding.incorrectOrder')}
                </Mono>
              </Animated.View>
            ) : null}
          </Panel>
        </Animated.View>

        {/* Word pool */}
        <Animated.View entering={FadeInDown.delay(550).duration(600)} style={{ marginTop: 20 }}>
          <Overline>{t('onboarding.availableWords')}</Overline>
          <View style={[styles.wrap, { marginTop: 10 }]}>
            {shuffledWords.map((word, index) => {
              const isSelected = selectedWords.includes(word);
              return (
                <Animated.View key={`pool-${word}-${index}`} layout={Layout.springify()}>
                  <WordChip word={word} selected={isSelected} onPress={() => handleSelectWord(word)} />
                </Animated.View>
              );
            })}
          </View>
        </Animated.View>
      </ScrollView>

      <Animated.View entering={FadeInUp.delay(750).duration(600)} style={{ paddingBottom: 20 }}>
        <PaperButton label={t('onboarding.verify')} onPress={handleVerify} disabled={!isComplete} />
        <GhostLink onPress={handleSkip} accessibilityLabel={t('onboarding.skipForNow')}>
          {t('onboarding.skipForNow')}
        </GhostLink>
      </Animated.View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  zoneHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  clear: { fontFamily: FontFamily.mono, fontSize: 12, color: Colors.primary, letterSpacing: 0.2 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 28 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
});

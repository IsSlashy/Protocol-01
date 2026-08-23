/**
 * SeedPhraseGrid — twelve words, and the one button that copies them.
 *
 * Colour literals replaced with tokens 2026-08-23. The word itself is now set
 * in the MONO face: a seed phrase is data to be transcribed character by
 * character, and the rule in this design system is that addresses, hashes and
 * amounts are mono for exactly that reason. `rn` and `m` should not be
 * ambiguous in the one place where getting a letter wrong loses the wallet.
 *
 * ⚠️ The 60-second clipboard scrub in `handleCopyAll` is untouched.
 */
import React, { useState } from 'react';
import { View, Text, TouchableOpacity, Pressable } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';

import { Colors, Spacing, FontFamily, FontSize, BorderRadius } from '../../constants/theme';

interface SeedPhraseGridProps {
  words: string[];
  showCopyButton?: boolean;
  onWordPress?: (word: string, index: number) => void;
  selectable?: boolean;
  revealDelay?: number;
}

export const SeedPhraseGrid: React.FC<SeedPhraseGridProps> = ({
  words,
  showCopyButton = true,
  onWordPress,
  selectable = false,
  revealDelay = 50,
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopyAll = async () => {
    const phrase = words.join(' ');
    await Clipboard.setStringAsync(phrase);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    // Security: Auto-clear clipboard after 60 seconds
    setTimeout(async () => {
      try {
        const current = await Clipboard.getStringAsync();
        if (current === phrase) {
          await Clipboard.setStringAsync('');
        }
      } catch (_) {}
    }, 60000);
  };

  const handleWordPress = (word: string, index: number) => {
    if (onWordPress) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      onWordPress(word, index);
    }
  };

  return (
    <View style={{ width: '100%' }}>
      {/* Grid of words — 3 columns */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' }}>
        {words.map((word, index) => (
          <Animated.View
            key={`${word}-${index}`}
            entering={FadeInDown.delay(index * revealDelay).duration(400)}
            style={{ width: '31%', marginBottom: Spacing.md }}
          >
            <Pressable
              onPress={() => selectable && handleWordPress(word, index)}
              disabled={!selectable}
              style={{
                backgroundColor: Colors.surface,
                borderWidth: 1,
                borderColor: Colors.border,
                borderRadius: BorderRadius.md,
                paddingVertical: Spacing.md,
                paddingHorizontal: Spacing.sm,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text
                  style={{
                    color: Colors.textTertiary,
                    fontFamily: FontFamily.mono,
                    fontSize: FontSize.xs,
                    width: 20,
                  }}
                >
                  {index + 1}
                </Text>
                <Text
                  style={{
                    color: Colors.text,
                    fontFamily: FontFamily.mono,
                    fontSize: FontSize.sm,
                    flex: 1,
                    textAlign: 'center',
                  }}
                >
                  {word}
                </Text>
              </View>
            </Pressable>
          </Animated.View>
        ))}
      </View>

      {/* Copy button */}
      {showCopyButton && (
        <Animated.View entering={FadeIn.delay(words.length * revealDelay + 200)}>
          <TouchableOpacity
            onPress={handleCopyAll}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Copy the whole recovery phrase"
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              minHeight: 44,
              marginTop: Spacing.lg,
              paddingVertical: Spacing.md,
            }}
          >
            <Ionicons
              name={copied ? 'checkmark-circle' : 'copy-outline'}
              size={18}
              color={Colors.primary}
            />
            <Text
              style={{
                color: Colors.primary,
                marginLeft: Spacing.sm,
                fontFamily: FontFamily.medium,
                fontSize: FontSize.md,
              }}
            >
              {copied ? 'Copied!' : 'Copy All'}
            </Text>
          </TouchableOpacity>
        </Animated.View>
      )}
    </View>
  );
};

export default SeedPhraseGrid;

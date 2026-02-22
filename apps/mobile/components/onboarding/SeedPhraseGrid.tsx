import React, { useState } from 'react';
import { View, Text, TouchableOpacity, Pressable } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';

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
    await Clipboard.setStringAsync(words.join(' '));
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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
            style={{ width: '31%', marginBottom: 12 }}
          >
            <Pressable
              onPress={() => selectable && handleWordPress(word, index)}
              disabled={!selectable}
              style={{
                backgroundColor: '#151518',
                borderWidth: 1,
                borderColor: '#2a2a30',
                borderRadius: 12,
                paddingVertical: 12,
                paddingHorizontal: 8,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text style={{ color: '#39c5bb', fontSize: 11, width: 20 }}>
                  {index + 1}.
                </Text>
                <Text
                  style={{
                    color: '#ffffff',
                    fontSize: 14,
                    fontWeight: '500',
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
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              marginTop: 16,
              paddingVertical: 12,
            }}
          >
            <Ionicons
              name={copied ? 'checkmark-circle' : 'copy-outline'}
              size={18}
              color="#39c5bb"
            />
            <Text style={{ color: '#39c5bb', marginLeft: 8, fontWeight: '500' }}>
              {copied ? 'Copied!' : 'Copy All'}
            </Text>
          </TouchableOpacity>
        </Animated.View>
      )}
    </View>
  );
};

export default SeedPhraseGrid;

import React from 'react';
import { View, Text, TouchableOpacity, Pressable } from 'react-native';
import Animated, {
  FadeIn,
  FadeInDown,
  Layout,
} from 'react-native-reanimated';
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
  const handleCopyAll = async () => {
    await Clipboard.setStringAsync(words.join(' '));
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const handleWordPress = (word: string, index: number) => {
    if (onWordPress) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      onWordPress(word, index);
    }
  };

  return (
    <View className="w-full">
      {/* Grid of words */}
      <View className="flex-row flex-wrap justify-between">
        {words.map((word, index) => (
          <Animated.View
            key={`${word}-${index}`}
            entering={FadeInDown.delay(index * revealDelay).duration(400)}
            className="w-[31%] mb-3"
          >
            <Pressable
              onPress={() => selectable && handleWordPress(word, index)}
              disabled={!selectable}
              className={`
                bg-[#151518] border border-[#2a2a30] rounded-xl py-3 px-2
                ${selectable ? 'active:bg-[#151518] active:border-[#39c5bb]' : ''}
              `}
            >
              <View className="flex-row items-center">
                <Text className="text-[#39c5bb] text-xs w-5">{index + 1}.</Text>
                <Text className="text-white text-sm font-medium flex-1 text-center">
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
            className="flex-row items-center justify-center mt-4 py-3"
            activeOpacity={0.7}
          >
            <Ionicons name="copy-outline" size={18} color="#39c5bb" />
            <Text className="text-[#39c5bb] ml-2 font-medium">Copy All</Text>
          </TouchableOpacity>
        </Animated.View>
      )}
    </View>
  );
};

export default SeedPhraseGrid;

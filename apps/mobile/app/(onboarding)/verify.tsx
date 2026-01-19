import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { View, Text, TouchableOpacity, ScrollView, ActivityIndicator, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, {
  FadeIn,
  FadeInDown,
  FadeInUp,
  FadeOut,
  Layout,
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as SecureStore from 'expo-secure-store';
import { WordChip } from '../../components/onboarding';

export default function VerifyScreen() {
  const router = useRouter();
  const [selectedWords, setSelectedWords] = useState<string[]>([]);
  const [error, setError] = useState(false);
  const [correctOrder, setCorrectOrder] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadMnemonic();
  }, []);

  const loadMnemonic = async () => {
    try {
      const mnemonic = await SecureStore.getItemAsync('p01_temp_mnemonic');
      if (mnemonic) {
        setCorrectOrder(mnemonic.split(' '));
      }
    } catch (error) {
      console.error('Error loading mnemonic:', error);
    } finally {
      setIsLoading(false);
    }
  };

  // Shuffle the words for the pool
  const shuffledWords = useMemo(() => {
    return [...correctOrder].sort(() => Math.random() - 0.5);
  }, [correctOrder]);

  const isComplete = selectedWords.length === correctOrder.length;
  const isCorrect = isComplete && selectedWords.every((word, index) => word === correctOrder[index]);

  const handleSelectWord = useCallback((word: string) => {
    if (selectedWords.includes(word)) return;

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedWords((prev) => [...prev, word]);
    setError(false);
  }, [selectedWords]);

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
    Alert.alert(
      'Skip Verification?',
      'Are you sure you have backed up your recovery phrase? You cannot recover your wallet without it.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Skip',
          style: 'destructive',
          onPress: () => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            router.replace('/(onboarding)/security');
          },
        },
      ]
    );
  }, [router]);

  const getWordVariant = (index: number): 'selected' | 'correct' | 'incorrect' => {
    if (!error) return 'selected';
    return selectedWords[index] === correctOrder[index] ? 'correct' : 'incorrect';
  };

  if (isLoading || correctOrder.length === 0) {
    return (
      <SafeAreaView className="flex-1 bg-[#0a0a0c] items-center justify-center">
        <ActivityIndicator size="large" color="#39c5bb" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-[#0a0a0c]">
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 80, paddingBottom: 24 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <Animated.View
          entering={FadeInDown.delay(200).duration(600)}
          className="items-center mb-6"
        >
          <View
            className="w-16 h-16 rounded-full bg-[#39c5bb]/20 items-center justify-center mb-4"
            style={{
              shadowColor: '#39c5bb',
              shadowOpacity: 0.3,
              shadowRadius: 15,
              shadowOffset: { width: 0, height: 0 },
            }}
          >
            <Ionicons name="shield-checkmark" size={32} color="#39c5bb" />
          </View>
          <Text className="text-white text-2xl font-bold text-center mb-2">
            Verify Your Backup
          </Text>
          <Text className="text-[#a0a0a0] text-base text-center">
            Tap the words in the correct order to verify your backup
          </Text>
        </Animated.View>

        {/* Selected Words Drop Zone */}
        <Animated.View
          entering={FadeInDown.delay(400).duration(600)}
          className={`bg-[#0f0f12] border rounded-2xl p-4 mb-6 min-h-[180px] ${
            error ? 'border-red-500/50' : 'border-[#2a2a30]'
          }`}
        >
          <View className="flex-row justify-between items-center mb-3">
            <Text className="text-[#555560] text-sm">
              {selectedWords.length} / {correctOrder.length} words
            </Text>
            {selectedWords.length > 0 && (
              <TouchableOpacity onPress={handleClearAll} activeOpacity={0.7}>
                <Text className="text-[#39c5bb] text-sm">Clear All</Text>
              </TouchableOpacity>
            )}
          </View>

          {selectedWords.length === 0 ? (
            <View className="flex-1 items-center justify-center py-8">
              <Ionicons name="arrow-down" size={32} color="#2a2a30" />
              <Text className="text-[#2a2a30] mt-2">Tap words below to add</Text>
            </View>
          ) : (
            <View className="flex-row flex-wrap">
              {selectedWords.map((word, index) => (
                <Animated.View
                  key={`selected-${word}-${index}`}
                  entering={FadeIn.duration(200)}
                  layout={Layout.springify()}
                >
                  <TouchableOpacity
                    onPress={() => handleRemoveWord(index)}
                    activeOpacity={0.7}
                  >
                    <WordChip
                      word={word}
                      index={index}
                      showIndex={true}
                      variant={getWordVariant(index)}
                    />
                  </TouchableOpacity>
                </Animated.View>
              ))}
            </View>
          )}

          {error && (
            <Animated.View
              entering={FadeIn.duration(200)}
              className="mt-3 flex-row items-center"
            >
              <Ionicons name="alert-circle" size={16} color="#ef4444" />
              <Text className="text-red-400 text-sm ml-2">
                Incorrect order. Please try again.
              </Text>
            </Animated.View>
          )}
        </Animated.View>

        {/* Word Pool */}
        <Animated.View entering={FadeInDown.delay(600).duration(600)}>
          <Text className="text-[#555560] text-sm mb-3">Available words:</Text>
          <View className="flex-row flex-wrap">
            {shuffledWords.map((word, index) => {
              const isSelected = selectedWords.includes(word);
              return (
                <Animated.View
                  key={`pool-${word}-${index}`}
                  layout={Layout.springify()}
                >
                  <WordChip
                    word={word}
                    selected={isSelected}
                    onPress={() => handleSelectWord(word)}
                  />
                </Animated.View>
              );
            })}
          </View>
        </Animated.View>
      </ScrollView>

      {/* Bottom Buttons */}
      <View className="px-6 pb-8">
        <Animated.View entering={FadeInUp.delay(800).duration(600)}>
          <TouchableOpacity
            onPress={handleVerify}
            activeOpacity={0.8}
            disabled={!isComplete}
            className={`py-4 rounded-xl items-center mb-4 ${
              isComplete ? 'bg-[#39c5bb]' : 'bg-[#2a2a30]'
            }`}
            style={
              isComplete
                ? {
                    shadowColor: '#39c5bb',
                    shadowOpacity: 0.4,
                    shadowRadius: 20,
                    shadowOffset: { width: 0, height: 4 },
                    elevation: 8,
                  }
                : {}
            }
          >
            <Text
              className={`text-lg font-bold ${
                isComplete ? 'text-white' : 'text-[#555560]'
              }`}
            >
              VERIFY
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={handleSkip}
            activeOpacity={0.7}
            className="py-3 items-center"
          >
            <Text className="text-[#555560] text-base">Skip for now</Text>
          </TouchableOpacity>
        </Animated.View>
      </View>
    </SafeAreaView>
  );
}

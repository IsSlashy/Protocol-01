import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { View, Text, TouchableOpacity, ScrollView, ActivityIndicator, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeIn, FadeInDown, FadeInUp, Layout } from 'react-native-reanimated';
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
    return () => {
      setCorrectOrder([]);
      setSelectedWords([]);
    };
  }, []);

  const loadMnemonic = async () => {
    try {
      const secOpts = { keychainService: 'protocol-01' };
      const mnemonic = await SecureStore.getItemAsync('p01_temp_mnemonic', secOpts)
        || await SecureStore.getItemAsync('p01_temp_mnemonic')
        || await SecureStore.getItemAsync('p01_mnemonic', secOpts);
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
      <SafeAreaView style={{ flex: 1, backgroundColor: '#0a0a0c', alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="large" color="#39c5bb" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#0a0a0c' }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 60, paddingBottom: 24 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <Animated.View
          entering={FadeInDown.delay(200).duration(600)}
          style={{ alignItems: 'center', marginBottom: 24 }}
        >
          <View
            style={{
              width: 64,
              height: 64,
              borderRadius: 32,
              backgroundColor: 'rgba(57, 197, 187, 0.2)',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 16,
            }}
          >
            <Ionicons name="shield-checkmark" size={32} color="#39c5bb" />
          </View>
          <Text style={{ color: '#ffffff', fontSize: 24, fontWeight: 'bold', textAlign: 'center', marginBottom: 8 }}>
            Verify Your Backup
          </Text>
          <Text style={{ color: '#a0a0a0', fontSize: 16, textAlign: 'center' }}>
            Tap the words in the correct order to verify your backup
          </Text>
        </Animated.View>

        {/* Selected Words Drop Zone */}
        <Animated.View
          entering={FadeInDown.delay(400).duration(600)}
          style={{
            backgroundColor: '#0f0f12',
            borderWidth: 1,
            borderColor: error ? 'rgba(239, 68, 68, 0.5)' : '#2a2a30',
            borderRadius: 16,
            padding: 16,
            marginBottom: 24,
            minHeight: 180,
          }}
        >
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <Text style={{ color: '#555560', fontSize: 13 }}>
              {selectedWords.length} / {correctOrder.length} words
            </Text>
            {selectedWords.length > 0 && (
              <TouchableOpacity onPress={handleClearAll} activeOpacity={0.7}>
                <Text style={{ color: '#39c5bb', fontSize: 13 }}>Clear All</Text>
              </TouchableOpacity>
            )}
          </View>

          {selectedWords.length === 0 ? (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 32 }}>
              <Ionicons name="arrow-down" size={32} color="#2a2a30" />
              <Text style={{ color: '#2a2a30', marginTop: 8 }}>Tap words below to add</Text>
            </View>
          ) : (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
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
              style={{ marginTop: 12, flexDirection: 'row', alignItems: 'center' }}
            >
              <Ionicons name="alert-circle" size={16} color="#ef4444" />
              <Text style={{ color: '#f87171', fontSize: 13, marginLeft: 8 }}>
                Incorrect order. Please try again.
              </Text>
            </Animated.View>
          )}
        </Animated.View>

        {/* Word Pool */}
        <Animated.View entering={FadeInDown.delay(600).duration(600)}>
          <Text style={{ color: '#555560', fontSize: 13, marginBottom: 12 }}>Available words:</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
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
      <View style={{ paddingHorizontal: 24, paddingBottom: 32 }}>
        <Animated.View entering={FadeInUp.delay(800).duration(600)}>
          <TouchableOpacity
            onPress={handleVerify}
            activeOpacity={0.8}
            disabled={!isComplete}
            style={{
              paddingVertical: 16,
              borderRadius: 12,
              alignItems: 'center',
              marginBottom: 16,
              backgroundColor: isComplete ? '#39c5bb' : '#2a2a30',
              ...(isComplete
                ? {
                    shadowColor: '#39c5bb',
                    shadowOpacity: 0.4,
                    shadowRadius: 20,
                    shadowOffset: { width: 0, height: 4 },
                    elevation: 8,
                  }
                : {}),
            }}
          >
            <Text
              style={{
                fontSize: 17,
                fontWeight: 'bold',
                color: isComplete ? '#ffffff' : '#555560',
              }}
            >
              VERIFY
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={handleSkip}
            activeOpacity={0.7}
            style={{ paddingVertical: 12, alignItems: 'center' }}
          >
            <Text style={{ color: '#555560', fontSize: 16 }}>Skip for now</Text>
          </TouchableOpacity>
        </Animated.View>
      </View>
    </SafeAreaView>
  );
}

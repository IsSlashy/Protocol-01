import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, ScrollView, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, {
  FadeIn,
  FadeInDown,
  FadeInUp,
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import * as SecureStore from 'expo-secure-store';
import { SeedPhraseGrid } from '../../components/onboarding';

export default function BackupScreen() {
  const router = useRouter();
  const [hasAcknowledged, setHasAcknowledged] = useState(false);
  const [copied, setCopied] = useState(false);
  const [seedPhrase, setSeedPhrase] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadMnemonic();
  }, []);

  const loadMnemonic = async () => {
    try {
      console.log('[Backup] Loading mnemonic from secure storage...');
      const mnemonic = await SecureStore.getItemAsync('p01_temp_mnemonic');
      console.log('[Backup] Mnemonic retrieved, length:', mnemonic?.length, 'word count:', mnemonic?.split(' ').length);

      if (mnemonic && mnemonic.trim()) {
        const words = mnemonic.trim().split(' ').filter(w => w.length > 0);
        console.log('[Backup] Parsed words:', words.length, 'First word:', words[0]);

        if (words.length === 12) {
          setSeedPhrase(words);
        } else {
          console.error('[Backup] Invalid word count:', words.length);
          // Try to get from main storage as fallback
          const fallbackMnemonic = await SecureStore.getItemAsync('p01_mnemonic', {
            keychainService: 'protocol-01',
          });
          if (fallbackMnemonic) {
            const fallbackWords = fallbackMnemonic.trim().split(' ').filter(w => w.length > 0);
            if (fallbackWords.length === 12) {
              setSeedPhrase(fallbackWords);
              // Also store in temp for consistency
              await SecureStore.setItemAsync('p01_temp_mnemonic', fallbackMnemonic);
            }
          }
        }
      } else {
        console.error('[Backup] No mnemonic found in temp storage');
        // Try fallback
        const fallbackMnemonic = await SecureStore.getItemAsync('p01_mnemonic', {
          keychainService: 'protocol-01',
        });
        if (fallbackMnemonic) {
          const fallbackWords = fallbackMnemonic.trim().split(' ').filter(w => w.length > 0);
          if (fallbackWords.length === 12) {
            setSeedPhrase(fallbackWords);
            await SecureStore.setItemAsync('p01_temp_mnemonic', fallbackMnemonic);
          }
        }
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
        // Only clear if clipboard still contains the seed phrase
        if (currentClipboard === seedPhrase.join(' ')) {
          await Clipboard.setStringAsync('');
        }
      } catch {
        // Silently fail - clipboard may have been cleared by user
      }
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
      <SafeAreaView className="flex-1 bg-[#0a0a0c] items-center justify-center">
        <ActivityIndicator size="large" color="#39c5bb" />
      </SafeAreaView>
    );
  }

  // Show error if seed phrase failed to load
  if (seedPhrase.length === 0) {
    return (
      <SafeAreaView className="flex-1 bg-[#0a0a0c] items-center justify-center px-8">
        <View className="items-center">
          <Ionicons name="warning" size={48} color="#ef4444" />
          <Text className="text-white text-xl font-bold text-center mt-4 mb-2">
            Failed to Load Seed Phrase
          </Text>
          <Text className="text-gray-400 text-center mb-6">
            There was an error loading your seed phrase. Please try creating a new wallet.
          </Text>
          <TouchableOpacity
            onPress={() => router.replace('/(onboarding)/create-wallet')}
            className="bg-[#39c5bb] px-6 py-3 rounded-xl"
          >
            <Text className="text-white font-semibold">Try Again</Text>
          </TouchableOpacity>
        </View>
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
          className="items-center mb-8"
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
            <Ionicons name="key" size={32} color="#39c5bb" />
          </View>
          <Text className="text-white text-2xl font-bold text-center mb-2">
            Backup Your Seed Phrase
          </Text>
          <Text className="text-[#a0a0a0] text-base text-center">
            Write down these 12 words in order and store them safely
          </Text>
        </Animated.View>

        {/* Seed Phrase Grid */}
        <Animated.View
          entering={FadeInDown.delay(400).duration(600)}
          className="bg-[#0f0f12] border border-[#2a2a30] rounded-2xl p-5 mb-6"
        >
          <SeedPhraseGrid
            words={seedPhrase}
            showCopyButton={false}
            revealDelay={80}
          />

          {/* Copy Button */}
          <TouchableOpacity
            onPress={handleCopyAll}
            activeOpacity={0.7}
            className="flex-row items-center justify-center mt-4 py-3 border border-[#2a2a30] rounded-xl"
          >
            <Ionicons
              name={copied ? 'checkmark-circle' : 'copy-outline'}
              size={20}
              color="#39c5bb"
            />
            <Text className="text-[#39c5bb] ml-2 font-medium">
              {copied ? 'Copied!' : 'Copy All'}
            </Text>
          </TouchableOpacity>
        </Animated.View>

        {/* Warning */}
        <Animated.View
          entering={FadeInDown.delay(600).duration(600)}
          className="bg-red-500/10 border border-red-500/30 rounded-2xl p-4 mb-6"
        >
          <View className="flex-row items-start">
            <Ionicons name="warning" size={24} color="#ef4444" />
            <View className="flex-1 ml-3">
              <Text className="text-red-400 font-semibold mb-1">
                Never share these words!
              </Text>
              <Text className="text-red-300/70 text-sm leading-5">
                Anyone with these words can access your wallet. Store them offline in a secure location.
              </Text>
            </View>
          </View>
        </Animated.View>

        {/* Acknowledgment Checkbox */}
        <Animated.View entering={FadeInDown.delay(800).duration(600)}>
          <TouchableOpacity
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              setHasAcknowledged(!hasAcknowledged);
            }}
            activeOpacity={0.8}
            className="flex-row items-center py-4"
          >
            <View
              className={`w-6 h-6 rounded-lg border-2 items-center justify-center mr-3 ${
                hasAcknowledged
                  ? 'bg-[#39c5bb] border-[#39c5bb]'
                  : 'border-[#2a2a30]'
              }`}
            >
              {hasAcknowledged && (
                <Ionicons name="checkmark" size={16} color="#ffffff" />
              )}
            </View>
            <Text className="text-white flex-1">
              I have written down my seed phrase and stored it securely
            </Text>
          </TouchableOpacity>
        </Animated.View>
      </ScrollView>

      {/* Bottom Button */}
      <View className="px-6 pb-8">
        <Animated.View entering={FadeInUp.delay(1000).duration(600)}>
          <TouchableOpacity
            onPress={handleContinue}
            activeOpacity={0.8}
            disabled={!hasAcknowledged}
            className={`py-4 rounded-xl items-center ${
              hasAcknowledged ? 'bg-[#39c5bb]' : 'bg-[#2a2a30]'
            }`}
            style={
              hasAcknowledged
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
                hasAcknowledged ? 'text-white' : 'text-[#555560]'
              }`}
            >
              I'VE WRITTEN THEM DOWN
            </Text>
          </TouchableOpacity>
        </Animated.View>
      </View>
    </SafeAreaView>
  );
}

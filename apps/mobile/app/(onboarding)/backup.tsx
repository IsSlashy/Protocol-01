import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, ScrollView, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeIn, FadeInDown, FadeInUp } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import * as SecureStore from 'expo-secure-store';
import * as ScreenCapture from 'expo-screen-capture';
import { SeedPhraseGrid } from '../../components/onboarding';
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
      let mnemonic = await SecureStore.getItemAsync('p01_temp_mnemonic', secOpts)
        || await SecureStore.getItemAsync('p01_temp_mnemonic');

      if (!mnemonic || !mnemonic.trim()) {
        console.warn('[Backup] No temp mnemonic, falling back to permanent storage');
        mnemonic = await SecureStore.getItemAsync('p01_mnemonic', secOpts);
      }

      if (mnemonic && mnemonic.trim()) {
        const words = mnemonic.trim().split(' ').filter(w => w.length > 0);
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
      <SafeAreaView style={{ flex: 1, backgroundColor: '#070709', alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="large" color="#39c5bb" />
      </SafeAreaView>
    );
  }

  // Show error if seed phrase failed to load
  if (seedPhrase.length === 0) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: '#070709', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }}>
        <View style={{ alignItems: 'center' }}>
          <Ionicons name="warning" size={48} color="#ef4444" />
          <Text style={{ color: '#eae7df', fontSize: 20, fontWeight: 'bold', textAlign: 'center', marginTop: 16, marginBottom: 8 }}>
            {t('onboarding.failedToLoadSeed')}
          </Text>
          <Text style={{ color: '#a0a0a0', textAlign: 'center', marginBottom: 24 }}>
            {t('onboarding.failedToLoadSeedDesc')}
          </Text>
          <TouchableOpacity
            onPress={() => router.replace('/(onboarding)/create-wallet')}
            style={{ backgroundColor: '#39c5bb', paddingHorizontal: 24, paddingVertical: 14, borderRadius: 12 }}
          >
            <Text style={{ color: '#eae7df', fontWeight: '600', fontSize: 16 }}>{t('onboarding.tryAgain')}</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#070709' }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 60, paddingBottom: 24 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <Animated.View
          entering={FadeInDown.delay(200).duration(600)}
          style={{ alignItems: 'center', marginBottom: 32 }}
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
            <Ionicons name="key" size={32} color="#39c5bb" />
          </View>
          <Text style={{ color: '#eae7df', fontSize: 24, fontWeight: 'bold', textAlign: 'center', marginBottom: 8 }}>
            {t('onboarding.backupSeedPhrase')}
          </Text>
          <Text style={{ color: '#a0a0a0', fontSize: 16, textAlign: 'center' }}>
            {t('onboarding.writeDownWords')}
          </Text>
        </Animated.View>

        {/* Seed Phrase Grid */}
        <Animated.View
          entering={FadeInDown.delay(400).duration(600)}
          style={{
            backgroundColor: '#0d0d10',
            borderWidth: 1,
            borderColor: 'rgba(234, 231, 223, 0.14)',
            borderRadius: 16,
            padding: 20,
            marginBottom: 24,
          }}
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
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              marginTop: 16,
              paddingVertical: 12,
              borderWidth: 1,
              borderColor: 'rgba(234, 231, 223, 0.14)',
              borderRadius: 12,
            }}
          >
            <Ionicons
              name={copied ? 'checkmark-circle' : 'copy-outline'}
              size={20}
              color="#39c5bb"
            />
            <Text style={{ color: '#39c5bb', marginLeft: 8, fontWeight: '500' }}>
              {copied ? t('common.copied') : t('onboarding.copyAll')}
            </Text>
          </TouchableOpacity>
        </Animated.View>

        {/* Warning */}
        <Animated.View
          entering={FadeInDown.delay(600).duration(600)}
          style={{
            backgroundColor: 'rgba(239, 68, 68, 0.1)',
            borderWidth: 1,
            borderColor: 'rgba(239, 68, 68, 0.3)',
            borderRadius: 16,
            padding: 16,
            marginBottom: 24,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
            <Ionicons name="warning" size={24} color="#ef4444" />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={{ color: '#f87171', fontWeight: '600', marginBottom: 4 }}>
                {t('onboarding.neverShareWords')}
              </Text>
              <Text style={{ color: 'rgba(252, 165, 165, 0.7)', fontSize: 14, lineHeight: 20 }}>
                {t('onboarding.neverShareWordsDesc')}
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
            style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 16 }}
          >
            <View
              style={{
                width: 24,
                height: 24,
                borderRadius: 8,
                borderWidth: 2,
                alignItems: 'center',
                justifyContent: 'center',
                marginRight: 12,
                backgroundColor: hasAcknowledged ? '#39c5bb' : 'transparent',
                borderColor: hasAcknowledged ? '#39c5bb' : 'rgba(234, 231, 223, 0.14)',
              }}
            >
              {hasAcknowledged && (
                <Ionicons name="checkmark" size={16} color="#eae7df" />
              )}
            </View>
            <Text style={{ color: '#eae7df', flex: 1, fontSize: 15 }}>
              {t('onboarding.acknowledgeSeed')}
            </Text>
          </TouchableOpacity>
        </Animated.View>
      </ScrollView>

      {/* Bottom Button */}
      <View style={{ paddingHorizontal: 24, paddingBottom: 32 }}>
        <Animated.View entering={FadeInUp.delay(1000).duration(600)}>
          <TouchableOpacity
            onPress={handleContinue}
            activeOpacity={0.8}
            disabled={!hasAcknowledged}
            style={{
              paddingVertical: 16,
              borderRadius: 12,
              alignItems: 'center',
              backgroundColor: hasAcknowledged ? '#39c5bb' : 'rgba(234, 231, 223, 0.14)',
              ...(hasAcknowledged
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
                color: hasAcknowledged ? '#eae7df' : 'rgba(234, 231, 223, 0.40)',
              }}
            >
              {t('onboarding.writtenThemDown')}
            </Text>
          </TouchableOpacity>
        </Animated.View>
      </View>
    </SafeAreaView>
  );
}

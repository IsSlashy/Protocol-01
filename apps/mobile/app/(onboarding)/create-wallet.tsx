import React, { useState, useEffect } from 'react';
import { View, Text, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
  FadeIn,
  FadeInDown,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import * as SecureStore from 'expo-secure-store';
import { Logo } from '../../components/onboarding';
import { ProgressSteps, type Step } from '../../components/onboarding';
import { createWallet } from '../../services/solana/wallet';

const STEPS: Step[] = [
  { id: '1', label: 'Generating keypair', status: 'pending' },
  { id: '2', label: 'Creating secure storage', status: 'pending' },
  { id: '3', label: 'Encrypting keys', status: 'pending' },
  { id: '4', label: 'Setting up wallet', status: 'pending' },
];

const STEP_DURATION = 800;

export default function CreateWalletScreen() {
  const router = useRouter();
  const [steps, setSteps] = useState<Step[]>(STEPS);
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const progressWidth = useSharedValue(0);

  useEffect(() => {
    startWalletCreation();
  }, []);

  const startWalletCreation = async () => {
    try {
      // Step 1: Generating keypair
      updateStep(0, 'in_progress');
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      await delay(STEP_DURATION);
      updateStep(0, 'completed');
      progressWidth.value = withTiming(25, { duration: 300 });

      // Step 2: Creating secure storage
      updateStep(1, 'in_progress');
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      await delay(STEP_DURATION);
      updateStep(1, 'completed');
      progressWidth.value = withTiming(50, { duration: 300 });

      // Step 3: Encrypting keys - Actually create the wallet here
      updateStep(2, 'in_progress');
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      const walletInfo = await createWallet();

      if (!walletInfo.mnemonic || walletInfo.mnemonic.split(' ').length !== 12) {
        throw new Error('Invalid mnemonic generated');
      }

      setMnemonic(walletInfo.mnemonic);

      await delay(STEP_DURATION);
      updateStep(2, 'completed');
      progressWidth.value = withTiming(75, { duration: 300 });

      // Step 4: Setting up wallet
      updateStep(3, 'in_progress');
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      // Store mnemonic temporarily for backup screen
      await SecureStore.setItemAsync('p01_temp_mnemonic', walletInfo.mnemonic);

      // Verify it was stored correctly
      const storedMnemonic = await SecureStore.getItemAsync('p01_temp_mnemonic');
      if (!storedMnemonic || storedMnemonic !== walletInfo.mnemonic) {
        console.error('[CreateWallet] Mnemonic storage verification failed');
        throw new Error('Failed to store mnemonic securely');
      }

      await delay(STEP_DURATION);
      updateStep(3, 'completed');
      progressWidth.value = withTiming(100, { duration: 300 });

      // Success!
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      // Navigate to backup screen using replace to avoid navigation stack issues
      setTimeout(() => {
        router.replace('/(onboarding)/backup');
      }, 500);

    } catch (err: any) {
      console.error('[CreateWallet] Wallet creation error:', err);
      setError(err.message || 'Failed to create wallet');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);

      Alert.alert(
        'Error',
        err.message || 'Failed to create wallet. Please try again.',
        [{ text: 'Retry', onPress: () => startWalletCreation() }]
      );
    }
  };

  const updateStep = (index: number, status: 'pending' | 'in_progress' | 'completed') => {
    setSteps((prev) =>
      prev.map((step, idx) => ({
        ...step,
        status: idx < index ? 'completed' : idx === index ? status : step.status,
      }))
    );
  };

  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const progressBarStyle = useAnimatedStyle(() => ({
    width: `${progressWidth.value}%`,
  }));

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#0a0a0c' }}>
      <View style={{ flex: 1, paddingHorizontal: 32, paddingTop: 80 }}>
        {/* Logo */}
        <Animated.View
          entering={FadeIn.delay(200).duration(600)}
          style={{ alignItems: 'center', marginBottom: 48 }}
        >
          <Logo size={80} showText={false} animated={true} />
        </Animated.View>

        {/* Title */}
        <Animated.View
          entering={FadeInDown.delay(400).duration(600)}
          style={{ alignItems: 'center', marginBottom: 48 }}
        >
          <Text style={{ color: '#ffffff', fontSize: 24, fontWeight: 'bold', textAlign: 'center', marginBottom: 8 }}>
            Creating Your Wallet
          </Text>
          <Text style={{ color: '#a0a0a0', fontSize: 16, textAlign: 'center' }}>
            Please wait while we set up your secure wallet
          </Text>
        </Animated.View>

        {/* Progress Bar */}
        <Animated.View
          entering={FadeInDown.delay(600).duration(600)}
          style={{ marginBottom: 48 }}
        >
          <View style={{ height: 8, backgroundColor: '#151518', borderRadius: 999, overflow: 'hidden' }}>
            <Animated.View
              style={[
                progressBarStyle,
                {
                  height: '100%',
                  backgroundColor: '#39c5bb',
                  borderRadius: 999,
                },
              ]}
            />
          </View>
        </Animated.View>

        {/* Progress Steps */}
        <Animated.View
          entering={FadeInDown.delay(800).duration(600)}
          style={{
            backgroundColor: '#0f0f12',
            borderWidth: 1,
            borderColor: '#2a2a30',
            borderRadius: 16,
            padding: 24
          }}
        >
          <ProgressSteps steps={steps} />
        </Animated.View>

        {/* Error Message */}
        {error && (
          <Animated.View
            entering={FadeIn}
            style={{
              marginTop: 24,
              padding: 16,
              backgroundColor: 'rgba(255, 68, 68, 0.1)',
              borderRadius: 12,
              borderWidth: 1,
              borderColor: 'rgba(255, 68, 68, 0.3)'
            }}
          >
            <Text style={{ color: '#ff4444', textAlign: 'center' }}>{error}</Text>
          </Animated.View>
        )}

        {/* Security Note */}
        <Animated.View
          entering={FadeInDown.delay(1000).duration(600)}
          style={{ marginTop: 32, alignItems: 'center' }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#39c5bb', marginRight: 8 }} />
            <Text style={{ color: '#555560', fontSize: 14 }}>
              Encrypted with military-grade security
            </Text>
          </View>
        </Animated.View>
      </View>
    </SafeAreaView>
  );
}

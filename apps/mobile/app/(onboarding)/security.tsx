import React, { useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, Alert, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, {
  FadeIn,
  FadeInDown,
  FadeInUp,
  FadeOut,
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { PinInput } from '../../components/onboarding';

type SecurityMethod = 'none' | 'pin' | 'biometrics';

export default function SecurityScreen() {
  const router = useRouter();
  const [selectedMethod, setSelectedMethod] = useState<SecurityMethod>('none');
  const [showPinSetup, setShowPinSetup] = useState(false);
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [isConfirming, setIsConfirming] = useState(false);
  const [pinError, setPinError] = useState(false);
  const [biometricsAvailable, setBiometricsAvailable] = useState(false);
  const [biometricType, setBiometricType] = useState<'face' | 'fingerprint'>('fingerprint');

  // Check biometrics availability
  React.useEffect(() => {
    checkBiometrics();
  }, []);

  const checkBiometrics = async () => {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const isEnrolled = await LocalAuthentication.isEnrolledAsync();
    const supportedTypes = await LocalAuthentication.supportedAuthenticationTypesAsync();

    setBiometricsAvailable(hasHardware && isEnrolled);

    if (supportedTypes.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) {
      setBiometricType('face');
    } else {
      setBiometricType('fingerprint');
    }
  };

  const handleSelectMethod = useCallback(async (method: SecurityMethod) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedMethod(method);

    if (method === 'pin') {
      setShowPinSetup(true);
    } else if (method === 'biometrics') {
      // Test biometric authentication
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Authenticate to enable biometrics',
        cancelLabel: 'Cancel',
        disableDeviceFallback: true,
      });

      if (!result.success) {
        setSelectedMethod('none');
        Alert.alert('Authentication Failed', 'Please try again or choose another method.');
      }
    }
  }, []);

  const handlePinComplete = useCallback((enteredPin: string) => {
    if (!isConfirming) {
      // First PIN entry
      setPin(enteredPin);
      setIsConfirming(true);
      setConfirmPin('');
    } else {
      // Confirming PIN
      if (enteredPin === pin) {
        // PINs match - save and continue
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        savePinAndContinue(enteredPin);
      } else {
        // PINs don't match
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setPinError(true);
        setConfirmPin('');
        setTimeout(() => {
          setPinError(false);
          setIsConfirming(false);
          setPin('');
        }, 1500);
      }
    }
  }, [isConfirming, pin]);

  const savePinAndContinue = async (pinCode: string) => {
    try {
      await SecureStore.setItemAsync('wallet_pin', pinCode);
      await SecureStore.setItemAsync('security_method', 'pin');
      completeOnboarding();
    } catch (error) {
      Alert.alert('Error', 'Failed to save PIN. Please try again.');
    }
  };

  const handleContinue = useCallback(async () => {
    if (selectedMethod === 'biometrics') {
      await SecureStore.setItemAsync('security_method', 'biometrics');
    } else {
      await SecureStore.setItemAsync('security_method', 'none');
    }
    completeOnboarding();
  }, [selectedMethod]);

  const completeOnboarding = async () => {
    console.log('[Security] Completing onboarding...');
    await SecureStore.setItemAsync('p01_onboarded', 'true');
    // Clean up temp mnemonic
    await SecureStore.deleteItemAsync('p01_temp_mnemonic');
    console.log('[Security] Navigating to lock screen...');
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    // Navigate directly to lock screen (which handles security method and redirects to wallet)
    router.replace('/(auth)/lock');
  };

  const handleSkip = useCallback(() => {
    Alert.alert(
      'Skip Security Setup?',
      'Your wallet will be less secure without PIN or biometric protection.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Skip',
          style: 'destructive',
          onPress: async () => {
            await SecureStore.setItemAsync('security_method', 'none');
            completeOnboarding();
          },
        },
      ]
    );
  }, []);

  // PIN Setup View
  if (showPinSetup) {
    return (
      <SafeAreaView className="flex-1 bg-[#0a0a0c]">
        <View className="flex-1 px-8 pt-20">
          {/* Back Button */}
          <TouchableOpacity
            onPress={() => {
              setShowPinSetup(false);
              setSelectedMethod('none');
              setPin('');
              setConfirmPin('');
              setIsConfirming(false);
              setPinError(false);
            }}
            className="absolute top-20 left-6 z-10"
            activeOpacity={0.7}
          >
            <Ionicons name="arrow-back" size={24} color="#39c5bb" />
          </TouchableOpacity>

          {/* Header */}
          <Animated.View
            entering={FadeInDown.delay(200).duration(600)}
            className="items-center mb-12 mt-8"
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
              <Ionicons name="keypad" size={32} color="#39c5bb" />
            </View>
            <Text className="text-white text-2xl font-bold text-center mb-2">
              {isConfirming ? 'Confirm Your PIN' : 'Create a PIN'}
            </Text>
            <Text className="text-[#a0a0a0] text-base text-center">
              {isConfirming
                ? 'Enter your PIN again to confirm'
                : 'Choose a 6-digit PIN to secure your wallet'}
            </Text>
          </Animated.View>

          {/* PIN Input */}
          <Animated.View
            entering={FadeIn.delay(400).duration(600)}
            className="items-center"
          >
            <PinInput
              length={6}
              value={isConfirming ? confirmPin : pin}
              onChange={isConfirming ? setConfirmPin : setPin}
              onComplete={handlePinComplete}
              error={pinError}
              secureEntry={true}
            />

            {pinError && (
              <Animated.Text
                entering={FadeIn}
                className="text-red-400 text-center mt-4"
              >
                PINs don't match. Please try again.
              </Animated.Text>
            )}
          </Animated.View>
        </View>
      </SafeAreaView>
    );
  }

  // Main Security Selection View
  return (
    <SafeAreaView className="flex-1 bg-[#0a0a0c]">
      <View className="flex-1 px-8 pt-20">
        {/* Header */}
        <Animated.View
          entering={FadeInDown.delay(200).duration(600)}
          className="items-center mb-10"
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
            <Ionicons name="lock-closed" size={32} color="#39c5bb" />
          </View>
          <Text className="text-white text-2xl font-bold text-center mb-2">
            Secure Your Wallet
          </Text>
          <Text className="text-[#a0a0a0] text-base text-center">
            Add an extra layer of protection
          </Text>
        </Animated.View>

        {/* Security Options */}
        <View className="space-y-4">
          {/* PIN Code Option */}
          <Animated.View entering={FadeInDown.delay(400).duration(600)}>
            <TouchableOpacity
              onPress={() => handleSelectMethod('pin')}
              activeOpacity={0.8}
              className={`flex-row items-center p-5 rounded-2xl border ${
                selectedMethod === 'pin'
                  ? 'bg-[#39c5bb]/10 border-[#39c5bb]'
                  : 'bg-[#0f0f12] border-[#2a2a30]'
              }`}
            >
              <View
                className={`w-12 h-12 rounded-full items-center justify-center mr-4 ${
                  selectedMethod === 'pin' ? 'bg-[#39c5bb]/20' : 'bg-[#151518]'
                }`}
              >
                <Ionicons
                  name="keypad"
                  size={24}
                  color={selectedMethod === 'pin' ? '#39c5bb' : '#555560'}
                />
              </View>
              <View className="flex-1">
                <Text className="text-white text-lg font-semibold">PIN Code</Text>
                <Text className="text-[#a0a0a0] text-sm">6-digit security code</Text>
              </View>
              {selectedMethod === 'pin' && (
                <Ionicons name="checkmark-circle" size={24} color="#39c5bb" />
              )}
            </TouchableOpacity>
          </Animated.View>

          {/* Biometrics Option */}
          <Animated.View entering={FadeInDown.delay(500).duration(600)}>
            <TouchableOpacity
              onPress={() => handleSelectMethod('biometrics')}
              activeOpacity={0.8}
              disabled={!biometricsAvailable}
              className={`flex-row items-center p-5 rounded-2xl border ${
                !biometricsAvailable
                  ? 'bg-[#0a0a0c] border-[#151518] opacity-50'
                  : selectedMethod === 'biometrics'
                  ? 'bg-[#39c5bb]/10 border-[#39c5bb]'
                  : 'bg-[#0f0f12] border-[#2a2a30]'
              }`}
            >
              <View
                className={`w-12 h-12 rounded-full items-center justify-center mr-4 ${
                  selectedMethod === 'biometrics' ? 'bg-[#39c5bb]/20' : 'bg-[#151518]'
                }`}
              >
                <Ionicons
                  name={biometricType === 'face' ? 'scan' : 'finger-print'}
                  size={24}
                  color={selectedMethod === 'biometrics' ? '#39c5bb' : '#555560'}
                />
              </View>
              <View className="flex-1">
                <Text className="text-white text-lg font-semibold">
                  {biometricType === 'face' ? 'Face ID' : 'Fingerprint'}
                </Text>
                <Text className="text-[#a0a0a0] text-sm">
                  {biometricsAvailable
                    ? 'Quick and secure authentication'
                    : 'Not available on this device'}
                </Text>
              </View>
              {selectedMethod === 'biometrics' && (
                <Ionicons name="checkmark-circle" size={24} color="#39c5bb" />
              )}
            </TouchableOpacity>
          </Animated.View>
        </View>
      </View>

      {/* Bottom Buttons */}
      <View className="px-6 pb-8">
        <Animated.View entering={FadeInUp.delay(700).duration(600)}>
          <TouchableOpacity
            onPress={handleContinue}
            activeOpacity={0.8}
            disabled={selectedMethod === 'none' || selectedMethod === 'pin'}
            className={`py-4 rounded-xl items-center mb-4 ${
              selectedMethod !== 'none' && selectedMethod !== 'pin'
                ? 'bg-[#39c5bb]'
                : 'bg-[#2a2a30]'
            }`}
            style={
              selectedMethod !== 'none' && selectedMethod !== 'pin'
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
                selectedMethod !== 'none' && selectedMethod !== 'pin'
                  ? 'text-white'
                  : 'text-[#555560]'
              }`}
            >
              CONTINUE
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

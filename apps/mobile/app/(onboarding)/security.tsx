import React, { useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeIn, FadeInDown, FadeInUp } from 'react-native-reanimated';
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
      setPin(enteredPin);
      setIsConfirming(true);
      setConfirmPin('');
    } else {
      if (enteredPin === pin) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        savePinAndContinue(enteredPin);
      } else {
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
    await SecureStore.setItemAsync('p01_onboarded', 'true');
    await SecureStore.deleteItemAsync('p01_temp_mnemonic');
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    // Go directly to wallet — user just authenticated during onboarding
    // Lock screen is for app re-opens, not first-time setup
    router.replace('/(main)/(wallet)');
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
      <SafeAreaView style={{ flex: 1, backgroundColor: '#0a0a0c' }}>
        <View style={{ flex: 1, paddingHorizontal: 32, paddingTop: 80 }}>
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
            activeOpacity={0.7}
            style={{ position: 'absolute', top: 80, left: 24, zIndex: 10 }}
          >
            <Ionicons name="arrow-back" size={24} color="#39c5bb" />
          </TouchableOpacity>

          {/* Header */}
          <Animated.View
            entering={FadeInDown.delay(200).duration(600)}
            style={{ alignItems: 'center', marginBottom: 48, marginTop: 32 }}
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
              <Ionicons name="keypad" size={32} color="#39c5bb" />
            </View>
            <Text style={{ color: '#ffffff', fontSize: 24, fontWeight: 'bold', textAlign: 'center', marginBottom: 8 }}>
              {isConfirming ? 'Confirm Your PIN' : 'Create a PIN'}
            </Text>
            <Text style={{ color: '#a0a0a0', fontSize: 16, textAlign: 'center' }}>
              {isConfirming
                ? 'Enter your PIN again to confirm'
                : 'Choose a 6-digit PIN to secure your wallet'}
            </Text>
          </Animated.View>

          {/* PIN Input */}
          <Animated.View
            entering={FadeIn.delay(400).duration(600)}
            style={{ alignItems: 'center' }}
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
                style={{ color: '#f87171', textAlign: 'center', marginTop: 16 }}
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
  const canContinue = selectedMethod !== 'none' && selectedMethod !== 'pin';

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#0a0a0c' }}>
      <View style={{ flex: 1, paddingHorizontal: 32, paddingTop: 80 }}>
        {/* Header */}
        <Animated.View
          entering={FadeInDown.delay(200).duration(600)}
          style={{ alignItems: 'center', marginBottom: 40 }}
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
            <Ionicons name="lock-closed" size={32} color="#39c5bb" />
          </View>
          <Text style={{ color: '#ffffff', fontSize: 24, fontWeight: 'bold', textAlign: 'center', marginBottom: 8 }}>
            Secure Your Wallet
          </Text>
          <Text style={{ color: '#a0a0a0', fontSize: 16, textAlign: 'center' }}>
            Add an extra layer of protection
          </Text>
        </Animated.View>

        {/* Security Options */}
        <View style={{ gap: 16 }}>
          {/* PIN Code Option */}
          <Animated.View entering={FadeInDown.delay(400).duration(600)}>
            <TouchableOpacity
              onPress={() => handleSelectMethod('pin')}
              activeOpacity={0.8}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                padding: 20,
                borderRadius: 16,
                borderWidth: 1,
                backgroundColor: selectedMethod === 'pin' ? 'rgba(57, 197, 187, 0.1)' : '#0f0f12',
                borderColor: selectedMethod === 'pin' ? '#39c5bb' : '#2a2a30',
              }}
            >
              <View
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: 24,
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginRight: 16,
                  backgroundColor: selectedMethod === 'pin' ? 'rgba(57, 197, 187, 0.2)' : '#151518',
                }}
              >
                <Ionicons
                  name="keypad"
                  size={24}
                  color={selectedMethod === 'pin' ? '#39c5bb' : '#555560'}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: '#ffffff', fontSize: 18, fontWeight: '600' }}>PIN Code</Text>
                <Text style={{ color: '#a0a0a0', fontSize: 14 }}>6-digit security code</Text>
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
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                padding: 20,
                borderRadius: 16,
                borderWidth: 1,
                opacity: biometricsAvailable ? 1 : 0.5,
                backgroundColor: !biometricsAvailable
                  ? '#0a0a0c'
                  : selectedMethod === 'biometrics'
                  ? 'rgba(57, 197, 187, 0.1)'
                  : '#0f0f12',
                borderColor: !biometricsAvailable
                  ? '#151518'
                  : selectedMethod === 'biometrics'
                  ? '#39c5bb'
                  : '#2a2a30',
              }}
            >
              <View
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: 24,
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginRight: 16,
                  backgroundColor: selectedMethod === 'biometrics' ? 'rgba(57, 197, 187, 0.2)' : '#151518',
                }}
              >
                <Ionicons
                  name={biometricType === 'face' ? 'scan' : 'finger-print'}
                  size={24}
                  color={selectedMethod === 'biometrics' ? '#39c5bb' : '#555560'}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: '#ffffff', fontSize: 18, fontWeight: '600' }}>
                  {biometricType === 'face' ? 'Face ID' : 'Fingerprint'}
                </Text>
                <Text style={{ color: '#a0a0a0', fontSize: 14 }}>
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
      <View style={{ paddingHorizontal: 24, paddingBottom: 32 }}>
        <Animated.View entering={FadeInUp.delay(700).duration(600)}>
          <TouchableOpacity
            onPress={handleContinue}
            activeOpacity={0.8}
            disabled={!canContinue}
            style={{
              paddingVertical: 16,
              borderRadius: 12,
              alignItems: 'center',
              marginBottom: 16,
              backgroundColor: canContinue ? '#39c5bb' : '#2a2a30',
              ...(canContinue
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
                color: canContinue ? '#ffffff' : '#555560',
              }}
            >
              CONTINUE
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

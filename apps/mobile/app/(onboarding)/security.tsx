import React, { useState, useCallback } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { p01Alert } from '@/stores/alertStore';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeIn, FadeInDown, FadeInUp } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { PinInput } from '../../components/onboarding';
import { useWalletStore } from '../../stores/walletStore';
import { hashPin } from '../../utils/crypto/pinHash';
import { enableVault, unlockVault } from '../../utils/crypto/noteVault';
import { useT } from '@/i18n';

type SecurityMethod = 'none' | 'pin' | 'biometrics';

export default function SecurityScreen() {
  const t = useT();
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
        promptMessage: t('onboarding.authenticateToEnable'),
        cancelLabel: t('common.cancel'),
        disableDeviceFallback: true,
      });

      if (!result.success) {
        setSelectedMethod('none');
        p01Alert(t('onboarding.authFailed'), t('onboarding.authFailedDesc'));
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
      const pinHash = await hashPin(pinCode);
      await SecureStore.setItemAsync('wallet_pin', pinHash);
      await SecureStore.setItemAsync('security_method', 'pin');
      // Enable note vault — shielded note receipts will be PIN-encrypted
      await enableVault();
      await unlockVault(pinHash);
      completeOnboarding();
    } catch (error) {
      p01Alert(t('common.error'), t('onboarding.failedToSavePin'));
    }
  };

  const handleContinue = useCallback(async () => {
    if (selectedMethod === 'biometrics') {
      await SecureStore.setItemAsync('security_method', 'biometrics');
      completeOnboarding();
    }
  }, [selectedMethod]);

  const completeOnboarding = async () => {
    await SecureStore.setItemAsync('p01_onboarded', 'true');
    // Clean up temp mnemonic from both keychain services
    await SecureStore.deleteItemAsync('p01_temp_mnemonic', { keychainService: 'protocol-01' }).catch(() => {});
    await SecureStore.deleteItemAsync('p01_temp_mnemonic').catch(() => {});
    // Initialize wallet store so the wallet screen finds the wallet
    await useWalletStore.getState().initialize();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    // Go directly to wallet — user just authenticated during onboarding
    // Lock screen is for app re-opens, not first-time setup
    router.replace('/(main)/(wallet)');
  };

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
            accessibilityRole="button"
            accessibilityLabel={t('onboarding.goBack')}
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
              {isConfirming ? t('onboarding.confirmYourPin') : t('onboarding.createPin')}
            </Text>
            <Text style={{ color: '#a0a0a0', fontSize: 16, textAlign: 'center' }}>
              {isConfirming
                ? t('onboarding.confirmPinDesc')
                : t('onboarding.choosePinDesc')}
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
                {t('onboarding.pinsDontMatch')}
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
            {t('onboarding.secureWallet')}
          </Text>
          <Text style={{ color: '#a0a0a0', fontSize: 16, textAlign: 'center' }}>
            {t('onboarding.secureWalletDesc')}
          </Text>
        </Animated.View>

        {/* Security Options */}
        <View style={{ gap: 16 }}>
          {/* PIN Code Option */}
          <Animated.View entering={FadeInDown.delay(400).duration(600)}>
            <TouchableOpacity
              onPress={() => handleSelectMethod('pin')}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel={`${t('onboarding.pinCode')}, ${t('onboarding.sixDigitCode')}`}
              accessibilityState={{ selected: selectedMethod === 'pin' }}
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
                <Text style={{ color: '#ffffff', fontSize: 18, fontWeight: '600' }}>{t('onboarding.pinCode')}</Text>
                <Text style={{ color: '#a0a0a0', fontSize: 14 }}>{t('onboarding.sixDigitCode')}</Text>
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
              accessibilityRole="button"
              accessibilityLabel={`${biometricType === 'face' ? t('onboarding.faceId') : t('onboarding.fingerprint')}, ${biometricsAvailable ? t('onboarding.quickSecureAuth') : t('onboarding.notAvailableDevice')}`}
              accessibilityState={{ selected: selectedMethod === 'biometrics', disabled: !biometricsAvailable }}
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
                  {biometricType === 'face' ? t('onboarding.faceId') : t('onboarding.fingerprint')}
                </Text>
                <Text style={{ color: '#a0a0a0', fontSize: 14 }}>
                  {biometricsAvailable
                    ? t('onboarding.quickSecureAuth')
                    : t('onboarding.notAvailableDevice')}
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
            accessibilityRole="button"
            accessibilityLabel={t('onboarding.continue')}
            accessibilityState={{ disabled: !canContinue }}
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
              {t('onboarding.continue')}
            </Text>
          </TouchableOpacity>

        </Animated.View>
      </View>
    </SafeAreaView>
  );
}

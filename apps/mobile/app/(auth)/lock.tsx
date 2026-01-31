import { View, Text, Pressable, Alert, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useEffect, useState } from 'react';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import * as Haptics from 'expo-haptics';
import Animated, { FadeIn, FadeInDown, FadeOut } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';

export default function LockScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [isBiometricSupported, setIsBiometricSupported] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [securityMethod, setSecurityMethod] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState(false);
  const [showPinEntry, setShowPinEntry] = useState(false);

  useEffect(() => {
    checkSecurityMethod();
  }, []);

  const checkSecurityMethod = async () => {
    const method = await SecureStore.getItemAsync('security_method');
    setSecurityMethod(method);

    if (method === 'biometrics') {
      const compatible = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      setIsBiometricSupported(compatible && enrolled);

      if (compatible && enrolled) {
        setTimeout(() => authenticate(), 500);
      }
    } else if (method === 'pin') {
      // Show PIN entry
      setShowPinEntry(true);
    } else if (method === 'none' || !method) {
      // No security, go directly to wallet
      router.replace('/(main)/(wallet)');
    }
  };

  const handlePinDigit = (digit: string) => {
    if (pin.length < 6) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      const newPin = pin + digit;
      setPin(newPin);

      if (newPin.length === 6) {
        verifyPin(newPin);
      }
    }
  };

  const handlePinDelete = () => {
    if (pin.length > 0) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setPin(pin.slice(0, -1));
    }
  };

  const verifyPin = async (enteredPin: string) => {
    const storedPin = await SecureStore.getItemAsync('wallet_pin');

    if (enteredPin === storedPin) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace('/(main)/(wallet)');
    } else {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setPinError(true);
      setPin('');
      setTimeout(() => setPinError(false), 1500);
    }
  };

  const authenticate = async () => {
    if (isAuthenticating) return;

    setIsAuthenticating(true);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Unlock P-01',
        cancelLabel: 'Cancel',
        disableDeviceFallback: false,
        fallbackLabel: 'Use Passcode',
      });

      if (result.success) {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        router.replace('/(main)/(wallet)');
      } else {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    } catch (error) {
      console.error('[Lock] Authentication error:', error);
      Alert.alert('Error', 'Authentication failed. Please try again.');
    } finally {
      setIsAuthenticating(false);
    }
  };

  // PIN Entry View
  if (showPinEntry) {
    return (
      <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        {/* Header */}
        <Animated.View entering={FadeIn.delay(100)} style={styles.logoContainer}>
          <View style={styles.logoBox}>
            <Ionicons name="keypad" size={36} color="#39c5bb" />
          </View>
          <Text style={styles.title}>Enter PIN</Text>
          <Text style={styles.subtitle}>
            {pinError ? 'Incorrect PIN' : 'Enter your 6-digit PIN'}
          </Text>
        </Animated.View>

        {/* PIN Dots */}
        <Animated.View entering={FadeIn.delay(200)} style={styles.pinDotsContainer}>
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <View
              key={index}
              style={[
                styles.pinDot,
                pin.length > index && styles.pinDotFilled,
                pinError && styles.pinDotError,
              ]}
            />
          ))}
        </Animated.View>

        {/* Keypad */}
        <Animated.View entering={FadeInDown.delay(300)} style={styles.keypadContainer}>
          {[
            ['1', '2', '3'],
            ['4', '5', '6'],
            ['7', '8', '9'],
            ['', '0', 'delete'],
          ].map((row, rowIndex) => (
            <View key={rowIndex} style={styles.keypadRow}>
              {row.map((key, keyIndex) => (
                <TouchableOpacity
                  key={keyIndex}
                  style={[styles.keypadButton, key === '' && styles.keypadButtonEmpty]}
                  onPress={() => {
                    if (key === 'delete') {
                      handlePinDelete();
                    } else if (key !== '') {
                      handlePinDigit(key);
                    }
                  }}
                  disabled={key === ''}
                  activeOpacity={0.6}
                >
                  {key === 'delete' ? (
                    <Ionicons name="backspace-outline" size={28} color="#ffffff" />
                  ) : (
                    <Text style={styles.keypadButtonText}>{key}</Text>
                  )}
                </TouchableOpacity>
              ))}
            </View>
          ))}
        </Animated.View>
      </View>
    );
  }

  // Biometric / Default View
  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      {/* Logo */}
      <Animated.View entering={FadeIn.delay(100)} style={styles.logoContainer}>
        <View style={styles.logoBox}>
          <Text style={styles.logoText}>01</Text>
        </View>
        <Text style={styles.title}>P-01</Text>
        <Text style={styles.subtitle}>Locked</Text>
      </Animated.View>

      {/* Unlock Button */}
      <Animated.View entering={FadeInDown.delay(300).springify()}>
        {isBiometricSupported ? (
          <Pressable
            onPress={authenticate}
            disabled={isAuthenticating}
            style={styles.unlockButton}
          >
            <View style={[styles.fingerprintCircle, isAuthenticating && styles.fingerprintCircleDisabled]}>
              <Ionicons
                name="finger-print"
                size={40}
                color={isAuthenticating ? '#666666' : '#39c5bb'}
              />
            </View>
            <Text style={styles.unlockText}>
              {isAuthenticating ? 'Authenticating...' : 'Tap to unlock'}
            </Text>
          </Pressable>
        ) : (
          <View style={styles.unlockButton}>
            <Text style={styles.biometricUnavailableText}>
              Loading...
            </Text>
          </View>
        )}
      </Animated.View>

      {/* Switch/Add Wallet Option */}
      <Animated.View entering={FadeInDown.delay(500)} style={styles.switchWalletContainer}>
        <TouchableOpacity
          onPress={() => router.push('/(onboarding)')}
          style={styles.switchWalletButton}
          activeOpacity={0.7}
        >
          <Ionicons name="swap-horizontal-outline" size={16} color="#666" />
          <Text style={styles.switchWalletText}>
            Utiliser un autre wallet
          </Text>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0c',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  logoContainer: {
    alignItems: 'center',
    marginBottom: 48,
  },
  logoBox: {
    width: 80,
    height: 80,
    borderRadius: 20,
    backgroundColor: '#0f0f12',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#2a2a30',
  },
  logoText: {
    color: '#39c5bb',
    fontSize: 36,
    fontWeight: 'bold',
  },
  title: {
    color: '#ffffff',
    fontSize: 24,
    fontWeight: 'bold',
  },
  subtitle: {
    color: '#888892',
    marginTop: 4,
  },
  unlockButton: {
    alignItems: 'center',
  },
  fingerprintCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#0f0f12',
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.3)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  fingerprintCircleDisabled: {
    borderColor: '#333333',
  },
  unlockText: {
    color: '#888892',
  },
  biometricUnavailableText: {
    color: '#555560',
    fontSize: 14,
  },
  // PIN Entry Styles
  pinDotsContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 16,
    marginBottom: 48,
  },
  pinDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#2a2a30',
    borderWidth: 1,
    borderColor: '#3a3a40',
  },
  pinDotFilled: {
    backgroundColor: '#39c5bb',
    borderColor: '#39c5bb',
  },
  pinDotError: {
    backgroundColor: '#ef4444',
    borderColor: '#ef4444',
  },
  keypadContainer: {
    gap: 12,
  },
  keypadRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 24,
  },
  keypadButton: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#151518',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#2a2a30',
  },
  keypadButtonEmpty: {
    backgroundColor: 'transparent',
    borderWidth: 0,
  },
  keypadButtonText: {
    color: '#ffffff',
    fontSize: 28,
    fontWeight: '600',
  },
  switchWalletContainer: {
    position: 'absolute',
    bottom: 40,
    alignItems: 'center',
  },
  switchWalletButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 20,
  },
  switchWalletText: {
    color: '#666',
    fontSize: 14,
    marginLeft: 8,
  },
});

import { View, Text, Pressable, Alert, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useEffect, useState } from 'react';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import * as Haptics from 'expo-haptics';
import Animated, { FadeIn, FadeInDown, FadeInUp, FadeOut } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import { scheduleLocalNotification } from '@/services/notifications';
import { hashPin, constantTimeEqual } from '@/utils/crypto/pinHash';

export default function LockScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [isBiometricSupported, setIsBiometricSupported] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [securityMethod, setSecurityMethod] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState(false);
  const [showPinEntry, setShowPinEntry] = useState(false);
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [lockoutUntil, setLockoutUntil] = useState(0);

  // Persist lockout state so restarting the app does not bypass brute-force protection (M13)
  useEffect(() => {
    (async () => {
      try {
        const stored = await SecureStore.getItemAsync('p01_lockout_state');
        if (stored) {
          const { attempts, until } = JSON.parse(stored);
          setFailedAttempts(attempts);
          setLockoutUntil(until);
        }
      } catch { /* ignore parse errors */ }
    })();
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
      // No explicit security method set — try device-level auth as minimum protection
      try {
        const compatible = await LocalAuthentication.hasHardwareAsync();
        const enrolled = compatible && await LocalAuthentication.isEnrolledAsync();
        if (enrolled) {
          const result = await LocalAuthentication.authenticateAsync({
            promptMessage: 'Unlock P-01',
            cancelLabel: 'Cancel',
            disableDeviceFallback: false,
            fallbackLabel: 'Use Passcode',
          });
          if (result.success) {
            router.replace('/(main)/(wallet)');
          }
          // If auth fails, stay on lock screen — user can retry via biometric button
          setIsBiometricSupported(true);
        } else {
          // No biometrics enrolled or no hardware — use device screen lock (PIN/pattern/password)
          const deviceResult = await LocalAuthentication.authenticateAsync({
            promptMessage: 'Authenticate to access wallet',
            disableDeviceFallback: false,
            cancelLabel: 'Cancel',
          });
          if (deviceResult.success) {
            router.replace('/(main)/(wallet)');
          }
          // If fails, stay on lock screen
        }
      } catch {
        // Authentication error — stay on lock screen for safety
      }
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

  /** Persist lockout state to SecureStore so app restarts cannot bypass it (M13) */
  const updateLockout = async (attempts: number, until: number) => {
    setFailedAttempts(attempts);
    setLockoutUntil(until);
    await SecureStore.setItemAsync(
      'p01_lockout_state',
      JSON.stringify({ attempts, until }),
    );
  };

  const verifyPin = async (enteredPin: string) => {
    // Enforce lockout
    if (lockoutUntil > Date.now()) {
      const remaining = Math.ceil((lockoutUntil - Date.now()) / 1000);
      setPinError(true);
      setPin('');
      Alert.alert('Too many attempts', `Try again in ${remaining} seconds.`);
      return;
    }

    const storedPinHash = await SecureStore.getItemAsync('wallet_pin');
    const enteredPinHash = await hashPin(enteredPin);

    // Constant-time comparison to prevent timing side-channels (L9)
    if (storedPinHash && constantTimeEqual(enteredPinHash, storedPinHash)) {
      await updateLockout(0, 0);
      await SecureStore.deleteItemAsync('p01_lockout_state');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace('/(main)/(wallet)');
    } else {
      const attempts = failedAttempts + 1;
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setPinError(true);
      setPin('');

      // Progressive lockout: 5 fails → 30s, 8 fails → 60s, 10+ fails → 300s
      let lockoutSeconds = 0;
      let newLockoutUntil = 0;
      if (attempts >= 10) {
        lockoutSeconds = 300;
        newLockoutUntil = Date.now() + 300_000;
      } else if (attempts >= 8) {
        lockoutSeconds = 60;
        newLockoutUntil = Date.now() + 60_000;
      } else if (attempts >= 5) {
        lockoutSeconds = 30;
        newLockoutUntil = Date.now() + 30_000;
      }

      await updateLockout(attempts, newLockoutUntil);

      // Security alert notifications (fire-and-forget, don't block auth flow)
      if (lockoutSeconds > 0) {
        scheduleLocalNotification(
          'Account Locked',
          `Too many failed attempts. Locked for ${lockoutSeconds} seconds.`,
          { category: 'security', action: 'lockout', failedAttempts: attempts },
          { channelId: 'security' },
        ).catch(() => {});
      } else {
        scheduleLocalNotification(
          'Security Alert',
          'Failed authentication attempt detected.',
          { category: 'security', action: 'failed_pin' },
          { channelId: 'security' },
        ).catch(() => {});
      }

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
        scheduleLocalNotification(
          'Security Alert',
          'Failed authentication attempt detected.',
          { category: 'security', action: 'failed_biometric' },
          { channelId: 'security' },
        ).catch(() => {});
      }
    } catch (error) {
      console.error('[Lock] Authentication error:', error);
      Alert.alert('Error', 'Authentication failed. Please try again.');
    } finally {
      setIsAuthenticating(false);
    }
  };

  // Glass card wrapper component
  const GlassCard = ({ children, style }: { children: React.ReactNode; style?: any }) => (
    <View style={[styles.glassCardOuter, style]}>
      <BlurView intensity={14} tint="dark" style={styles.glassCardBlur}>
        <LinearGradient
          colors={['rgba(57, 197, 187, 0.06)', 'rgba(255, 119, 168, 0.03)', 'transparent']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.glassCardInner}>
          {children}
        </View>
      </BlurView>
    </View>
  );

  // PIN Entry View
  if (showPinEntry) {
    return (
      <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        {/* Header */}
        <Animated.View entering={FadeInUp.delay(100).springify()} style={styles.logoContainer}>
          <GlassCard style={styles.logoCardWrapper}>
            <Ionicons name="keypad" size={36} color={P01Colors.cyan} />
          </GlassCard>
          <Text style={styles.title}>Enter PIN</Text>
          <Text style={[styles.subtitle, pinError && styles.subtitleError]}>
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
        <Animated.View entering={FadeInDown.delay(300).springify()} style={styles.keypadContainer}>
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
                  accessibilityRole="button"
                  accessibilityLabel={key === 'delete' ? 'Delete last digit' : key === '' ? undefined : `Digit ${key}`}
                >
                  {key === 'delete' ? (
                    <Ionicons name="backspace-outline" size={28} color={Colors.text} />
                  ) : key !== '' ? (
                    <BlurView intensity={12} tint="dark" style={styles.keypadButtonBlur}>
                      <LinearGradient
                        colors={['rgba(57, 197, 187, 0.06)', 'rgba(255, 119, 168, 0.03)', 'transparent']}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 1 }}
                        style={StyleSheet.absoluteFill}
                      />
                      <Text style={styles.keypadButtonText}>{key}</Text>
                    </BlurView>
                  ) : null}
                </TouchableOpacity>
              ))}
            </View>
          ))}
        </Animated.View>

        {/* Lockout warning */}
        {lockoutUntil > Date.now() && (
          <Animated.View entering={FadeIn} style={styles.lockoutContainer}>
            <GlassCard>
              <View style={styles.lockoutContent}>
                <Ionicons name="lock-closed" size={16} color={Colors.error} />
                <Text style={styles.lockoutText}>Too many attempts. Try again later.</Text>
              </View>
            </GlassCard>
          </Animated.View>
        )}
      </View>
    );
  }

  // Biometric / Default View
  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, 24) }]}>
      {/* Top spacer */}
      <View style={{ flex: 1 }} />

      {/* Logo */}
      <Animated.View entering={FadeInUp.delay(100).springify()} style={styles.logoContainer}>
        <View style={styles.logoGlowRing}>
          <GlassCard style={styles.logoCardWrapper}>
            <Text style={styles.logoText}>01</Text>
          </GlassCard>
        </View>
        <Text style={styles.title}>P-01</Text>
        <Text style={styles.subtitle}>Tap to unlock your wallet</Text>
      </Animated.View>

      {/* Unlock Button */}
      <Animated.View entering={FadeInDown.delay(300).springify()} style={{ marginTop: 48 }}>
        {isBiometricSupported ? (
          <Pressable
            onPress={authenticate}
            disabled={isAuthenticating}
            style={styles.unlockButton}
            accessibilityRole="button"
            accessibilityLabel="Unlock with biometrics"
            accessibilityState={{ disabled: isAuthenticating }}
          >
            <View style={styles.fingerprintOuter}>
              <BlurView intensity={14} tint="dark" style={styles.fingerprintBlur}>
                <LinearGradient
                  colors={[
                    isAuthenticating
                      ? 'rgba(85, 85, 96, 0.08)'
                      : 'rgba(57, 197, 187, 0.12)',
                    'rgba(255, 119, 168, 0.04)',
                    'transparent',
                  ]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={StyleSheet.absoluteFill}
                />
                <Ionicons
                  name="finger-print"
                  size={44}
                  color={isAuthenticating ? Colors.textTertiary : P01Colors.cyan}
                />
              </BlurView>
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

      {/* Bottom spacer */}
      <View style={{ flex: 1.2 }} />

      {/* Switch/Add Wallet Option — safely above gesture bar */}
      <Animated.View entering={FadeInDown.delay(500)} style={styles.switchWalletContainer}>
        <TouchableOpacity
          onPress={() => router.push('/(onboarding)')}
          style={styles.switchWalletButton}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Use another wallet"
        >
          <BlurView intensity={12} tint="dark" style={styles.switchWalletBlur}>
            <LinearGradient
              colors={['rgba(57, 197, 187, 0.04)', 'transparent']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFill}
            />
            <Ionicons name="swap-horizontal-outline" size={16} color={Colors.textSecondary} />
            <Text style={styles.switchWalletText}>
              Use another wallet
            </Text>
          </BlurView>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'transparent',
    alignItems: 'center',
    paddingHorizontal: Spacing['2xl'],
  },

  // Logo area
  logoContainer: {
    alignItems: 'center',
  },
  logoGlowRing: {
    borderRadius: 999,
    padding: 3,
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.12)',
    shadowColor: P01Colors.cyan,
    shadowOpacity: 0.15,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 0 },
    elevation: 6,
  },
  logoCardWrapper: {
    marginBottom: 0,
  },
  logoText: {
    color: P01Colors.cyan,
    fontSize: 36,
    fontFamily: FontFamily.bold,
    fontWeight: 'bold',
  },
  title: {
    color: Colors.text,
    fontSize: 28,
    fontFamily: FontFamily.bold,
    fontWeight: 'bold',
    marginTop: Spacing.xl,
    letterSpacing: 2,
  },
  subtitle: {
    color: Colors.textSecondary,
    fontSize: 14,
    fontFamily: FontFamily.regular,
    marginTop: Spacing.sm,
  },
  subtitleError: {
    color: Colors.error,
  },

  // Glass card
  glassCardOuter: {
    borderRadius: BorderRadius.xl,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.07)',
  },
  glassCardBlur: {
    overflow: 'hidden',
    backgroundColor: 'rgba(12, 12, 14, 0.65)',
  },
  glassCardInner: {
    padding: Spacing.xl,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Biometric unlock
  unlockButton: {
    alignItems: 'center',
  },
  fingerprintOuter: {
    width: 88,
    height: 88,
    borderRadius: 44,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.2)',
    marginBottom: Spacing.lg,
    shadowColor: P01Colors.cyan,
    shadowOpacity: 0.2,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
  fingerprintBlur: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(12, 12, 14, 0.65)',
  },
  unlockText: {
    color: Colors.textSecondary,
    fontSize: 14,
    fontFamily: FontFamily.regular,
  },
  biometricUnavailableText: {
    color: Colors.textTertiary,
    fontSize: 14,
    fontFamily: FontFamily.regular,
  },

  // PIN Dots
  pinDotsContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: Spacing.lg,
    marginBottom: Spacing['5xl'],
  },
  pinDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: 'rgba(42, 42, 48, 0.6)',
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.1)',
  },
  pinDotFilled: {
    backgroundColor: P01Colors.cyan,
    borderColor: P01Colors.cyan,
  },
  pinDotError: {
    backgroundColor: Colors.error,
    borderColor: Colors.error,
  },

  // Keypad
  keypadContainer: {
    gap: Spacing.md,
  },
  keypadRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: Spacing['2xl'],
  },
  keypadButton: {
    width: 72,
    height: 72,
    borderRadius: 36,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.07)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  keypadButtonBlur: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(12, 12, 14, 0.65)',
  },
  keypadButtonEmpty: {
    backgroundColor: 'transparent',
    borderWidth: 0,
  },
  keypadButtonText: {
    color: Colors.text,
    fontSize: 28,
    fontWeight: '600',
    fontFamily: FontFamily.semibold,
  },

  // Switch wallet
  switchWalletContainer: {
    alignItems: 'center',
    marginBottom: 16,
  },
  switchWalletButton: {
    borderRadius: BorderRadius.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.07)',
  },
  switchWalletBlur: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.xl,
    backgroundColor: 'rgba(12, 12, 14, 0.65)',
  },
  switchWalletText: {
    color: Colors.textSecondary,
    fontSize: 14,
    fontFamily: FontFamily.regular,
    marginLeft: Spacing.sm,
  },

  // Lockout warning
  lockoutContainer: {
    marginTop: Spacing['2xl'],
  },
  lockoutContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  lockoutText: {
    color: Colors.error,
    fontSize: 13,
    fontFamily: FontFamily.regular,
  },
});

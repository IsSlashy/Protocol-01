import { View, Text, Pressable, Image, StyleSheet, TouchableOpacity } from 'react-native';
import { p01Alert } from '@/stores/alertStore';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useEffect, useState } from 'react';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import * as Haptics from 'expo-haptics';
import Animated, { FadeIn, FadeInDown, FadeInUp, FadeOut } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import { scheduleLocalNotification } from '@/services/notifications';
import { unlockVault, unlockVaultBiometric, isVaultEnabled } from '@/utils/crypto/noteVault';
import { hashPin, constantTimeEqual } from '@/utils/crypto/pinHash';
import { useT } from '@/i18n';

export default function LockScreen() {
  const t = useT();
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
            promptMessage: t('lock.unlockP01'),
            cancelLabel: t('common.cancel'),
            disableDeviceFallback: false,
            fallbackLabel: t('lock.usePasscode'),
          });
          if (result.success) {
            if (await isVaultEnabled()) await unlockVaultBiometric();
            await SecureStore.setItemAsync('p01_session_unlocked', 'true');
            router.replace('/(main)/(wallet)');
          }
          // If auth fails, stay on lock screen — user can retry via biometric button
          setIsBiometricSupported(true);
        } else {
          // No biometrics enrolled or no hardware — use device screen lock (PIN/pattern/password)
          const deviceResult = await LocalAuthentication.authenticateAsync({
            promptMessage: t('lock.authenticateToAccess'),
            disableDeviceFallback: false,
            cancelLabel: t('common.cancel'),
          });
          if (deviceResult.success) {
            if (await isVaultEnabled()) await unlockVaultBiometric();
            await SecureStore.setItemAsync('p01_session_unlocked', 'true');
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
      p01Alert(t('lock.tooManyAttempts'), t('lock.tryAgainIn', { seconds: remaining }));
      return;
    }

    const storedPinHash = await SecureStore.getItemAsync('wallet_pin');
    const enteredPinHash = await hashPin(enteredPin);

    // Constant-time comparison to prevent timing side-channels (L9)
    if (storedPinHash && constantTimeEqual(enteredPinHash, storedPinHash)) {
      await updateLockout(0, 0);
      await SecureStore.deleteItemAsync('p01_lockout_state');
      // Unlock note vault with PIN-derived key (protects shielded notes at rest)
      if (await isVaultEnabled()) {
        await unlockVault(enteredPinHash);
      }
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await SecureStore.setItemAsync('p01_session_unlocked', 'true');
      router.replace('/(main)/(wallet)');
    } else {
      const attempts = failedAttempts + 1;
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setPinError(true);
      setPin('');

      // Progressive lockout: 5 fails → 30s, 8 fails → 60s, 10+ fails → 300s
      // L10 accepted risk: lockout uses Date.now() which can be manipulated via device
      // settings, but this requires physical device access which implies compromise.
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
          t('lock.accountLocked'),
          t('lock.accountLockedDesc', { seconds: lockoutSeconds }),
          { category: 'security', action: 'lockout', failedAttempts: attempts },
          { channelId: 'security' },
        ).catch(() => {});
      } else {
        scheduleLocalNotification(
          t('lock.securityAlert'),
          t('lock.failedAuthAttempt'),
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
        promptMessage: t('lock.unlockP01'),
        cancelLabel: t('common.cancel'),
        disableDeviceFallback: false,
        fallbackLabel: t('lock.usePasscode'),
      });

      if (result.success) {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        if (await isVaultEnabled()) await unlockVaultBiometric();
        await SecureStore.setItemAsync('p01_session_unlocked', 'true');
        router.replace('/(main)/(wallet)');
      } else {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        scheduleLocalNotification(
          t('lock.securityAlert'),
          t('lock.failedAuthAttempt'),
          { category: 'security', action: 'failed_biometric' },
          { channelId: 'security' },
        ).catch(() => {});
      }
    } catch (error) {
      console.error('[Lock] Authentication error:', error);
      p01Alert(t('common.error'), t('lock.authError'));
    } finally {
      setIsAuthenticating(false);
    }
  };

  // PIN Entry View
  if (showPinEntry) {
    return (
      <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        {/* Header */}
        <Animated.View entering={FadeInUp.delay(100).springify()} style={styles.logoContainer}>
          <View style={styles.pinIconWrap}>
            <Ionicons name="keypad" size={32} color={P01Colors.cyan} />
          </View>
          <Text style={styles.title}>{t('lock.enterPin')}</Text>
          <Text style={[styles.subtitle, pinError && styles.subtitleError]}>
            {pinError ? t('lock.incorrectPin') : t('lock.enterYourPin')}
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
                  accessibilityLabel={key === 'delete' ? t('lock.deleteLastDigit') : key === '' ? undefined : `${key}`}
                >
                  {key === 'delete' ? (
                    <Ionicons name="backspace-outline" size={28} color={Colors.text} />
                  ) : key !== '' ? (
                    <View style={styles.keypadButtonInner}>
                      <Text style={styles.keypadButtonText}>{key}</Text>
                    </View>
                  ) : null}
                </TouchableOpacity>
              ))}
            </View>
          ))}
        </Animated.View>

        {/* Lockout warning */}
        {lockoutUntil > Date.now() && (
          <Animated.View entering={FadeIn} style={styles.lockoutContainer}>
            <View style={styles.lockoutCard}>
              <Ionicons name="lock-closed" size={16} color={Colors.error} />
              <Text style={styles.lockoutText}>{t('lock.tooManyAttemptsLater')}</Text>
            </View>
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

      {/* Logo — App icon */}
      <Animated.View entering={FadeInUp.delay(100).springify()} style={styles.logoContainer}>
        <Image
          source={require('@/assets/images/01-miku.png')}
          style={styles.appLogo}
          resizeMode="contain"
          accessibilityLabel="Protocol 01 logo"
        />
        <Text style={styles.title}>PROTOCOL 01</Text>
        <Text style={styles.subtitle}>{t('lock.tapToUnlock')}</Text>
      </Animated.View>

      {/* Unlock Button */}
      <Animated.View entering={FadeInDown.delay(300).springify()} style={{ marginTop: 48 }}>
        {isBiometricSupported ? (
          <Pressable
            onPress={authenticate}
            disabled={isAuthenticating}
            style={styles.unlockButton}
            accessibilityRole="button"
            accessibilityLabel={t('lock.unlockWithBiometrics')}
            accessibilityState={{ disabled: isAuthenticating }}
          >
            <View style={[
              styles.fingerprintCircle,
              isAuthenticating && styles.fingerprintCircleActive,
            ]}>
              <Ionicons
                name="finger-print"
                size={40}
                color={isAuthenticating ? Colors.textTertiary : P01Colors.cyan}
              />
            </View>
            <Text style={styles.unlockText}>
              {isAuthenticating ? t('lock.authenticating') : t('lock.tapToUnlock')}
            </Text>
          </Pressable>
        ) : (
          <View style={styles.unlockButton}>
            <Text style={styles.biometricUnavailableText}>
              {t('common.loading')}
            </Text>
          </View>
        )}
      </Animated.View>

      {/* Bottom spacer */}
      <View style={{ flex: 1.2 }} />

      {/* Switch/Add Wallet Option */}
      <Animated.View entering={FadeInDown.delay(500)} style={styles.switchWalletContainer}>
        <TouchableOpacity
          onPress={async () => {
            // M2: Require authentication before allowing wallet switch
            try {
              const result = await LocalAuthentication.authenticateAsync({
                promptMessage: t('lock.authenticateToSwitch'),
                disableDeviceFallback: false,
                cancelLabel: t('common.cancel'),
              });
              if (result.success) {
                router.push('/(onboarding)');
              }
            } catch {
              // Authentication error — stay on lock screen
            }
          }}
          style={styles.switchWalletButton}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={t('lock.useAnotherWallet')}
        >
          <Ionicons name="swap-horizontal-outline" size={16} color={Colors.textTertiary} />
          <Text style={styles.switchWalletText}>{t('lock.useAnotherWallet')}</Text>
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
  appLogo: {
    width: 80,
    height: 80,
    marginBottom: Spacing.lg,
  },
  pinIconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: P01Colors.cyanDim,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.lg,
  },
  title: {
    color: Colors.text,
    fontSize: 22,
    fontFamily: FontFamily.bold,
    letterSpacing: 2,
  },
  subtitle: {
    color: Colors.textTertiary,
    fontSize: 14,
    fontFamily: FontFamily.regular,
    marginTop: Spacing.sm,
  },
  subtitleError: {
    color: Colors.error,
  },

  // Biometric unlock
  unlockButton: {
    alignItems: 'center',
  },
  fingerprintCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: Colors.surfaceSecondary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.lg,
  },
  fingerprintCircleActive: {
    backgroundColor: 'rgba(85, 85, 96, 0.2)',
  },
  unlockText: {
    color: Colors.textTertiary,
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
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: Colors.surfaceSecondary,
  },
  pinDotFilled: {
    backgroundColor: P01Colors.cyan,
  },
  pinDotError: {
    backgroundColor: Colors.error,
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
    alignItems: 'center',
    justifyContent: 'center',
  },
  keypadButtonInner: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: 36,
  },
  keypadButtonEmpty: {
    backgroundColor: 'transparent',
  },
  keypadButtonText: {
    color: Colors.text,
    fontSize: 28,
    fontFamily: FontFamily.semibold,
  },

  // Switch wallet
  switchWalletContainer: {
    alignItems: 'center',
    marginBottom: 16,
  },
  switchWalletButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.xl,
    borderRadius: BorderRadius.lg,
    backgroundColor: Colors.surfaceSecondary,
  },
  switchWalletText: {
    color: Colors.textTertiary,
    fontSize: 14,
    fontFamily: FontFamily.regular,
    marginLeft: Spacing.sm,
  },

  // Lockout warning
  lockoutContainer: {
    marginTop: Spacing['2xl'],
  },
  lockoutCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.errorDim,
  },
  lockoutText: {
    color: Colors.error,
    fontSize: 13,
    fontFamily: FontFamily.regular,
  },
});

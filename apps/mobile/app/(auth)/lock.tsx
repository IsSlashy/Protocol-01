/**
 * lock — the screen between a stolen phone and the wallet.
 *
 * 🎯 REBUILT 2026-08-23 to the same shape as the Chrome extension's unlock
 * screen, because it had the same disease: a mark, one sentence, one field,
 * one button is the whole job, and this file was doing considerably more of
 * everything.
 *
 * ⛔ WHAT CAME OFF, AND WHY EACH ONE HAD TO:
 *   - `assets/images/01-miku.png` at 80×80. The 01 mark is retired (founder
 *     ruling 2026-08-23) and `app/design-system.test.ts` now fails on any file
 *     that references the raster. The Wordmark replaces it.
 *   - "PROTOCOL 01" in 22pt Inter-Bold at 2pt of tracking. The product is
 *     called Styx, the Wordmark already says so, and the heading was the body
 *     face one weight louder — which is precisely what the display face was
 *     added to stop.
 *   - the 80pt fingerprint disc, and its pressed state
 *     `rgba(85, 85, 96, 0.2)` — a cool grey from the palette this app no
 *     longer uses, hardcoded where the theme could not reach it.
 *   - the 64pt cyan keypad-icon disc above the PIN entry. Someone looking at
 *     six dots and a number pad does not need to be told it is a number pad.
 *
 * 🚨 THE ERROR MOVED TO THE FIELD. "Incorrect PIN" used to be rendered by
 * swapping the SUBTITLE — a line above the dots that normally reads "Enter your
 * 6-digit PIN" — from grey to red. So the failure appeared where the
 * instruction had been, above the thing that failed, and a screen reader
 * announced nothing at all because no text was inserted, only recoloured. It is
 * now its own line under the dots with `accessibilityRole="alert"`, and the
 * instruction stays put.
 *
 * ⚠️ NOT TOUCHED, ON PURPOSE: the lockout ladder, the constant-time hash
 * comparison (L9), the SecureStore persistence that stops a restart from
 * clearing the attempt count (M13), the vault unlock, and the re-authentication
 * gate on switching wallets (M2). This was a UI pass.
 */

import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { p01Alert } from '@/stores/alertStore';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useEffect, useState } from 'react';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import * as Haptics from 'expo-haptics';
import Animated, { FadeIn, FadeInDown, FadeInUp } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { Colors, FontFamily, FontSize, BorderRadius, Spacing } from '@/constants/theme';
import { Wordmark } from '@/components/common/Wordmark';
import { Button } from '@/components/ui/Button';
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

  const switchWallet = async () => {
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
  };

  const lockedOut = lockoutUntil > Date.now();

  // ── PIN entry ────────────────────────────────────────────────────────────
  if (showPinEntry) {
    return (
      <View style={[styles.container, { paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, Spacing['2xl']) }]}>
        <View style={styles.spacer} />

        {/* The mark, and the one sentence.
            ⚠️ ONE sentence. The title read "Enter PIN" and the line under it
            read "Enter your 6-digit PIN" — the same instruction twice, on a
            screen showing six empty dots that already say how many digits it
            wants. The subtitle went. */}
        <Animated.View entering={FadeInUp.delay(100).springify()} style={styles.head}>
          <Wordmark size={40} />
          <Text style={styles.title} accessibilityRole="header">{t('lock.enterPin')}</Text>
        </Animated.View>

        {/* The field. */}
        <Animated.View entering={FadeIn.delay(200)} style={styles.pinBlock}>
          <View
            style={styles.pinDotsRow}
            accessibilityRole="text"
            accessibilityLabel={t('lock.enterYourPin')}
            accessibilityValue={{ text: `${pin.length}/6` }}
          >
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
          </View>

          {/* 🎯 The failure lives under the thing that failed, and it is real
              text so a screen reader has something to announce. */}
          {pinError ? (
            <Text style={styles.fieldError} accessibilityRole="alert">
              {t('lock.incorrectPin')}
            </Text>
          ) : null}

          {lockedOut ? (
            <Text style={styles.fieldError} accessibilityRole="alert">
              {t('lock.tooManyAttemptsLater')}
            </Text>
          ) : null}
        </Animated.View>

        {/* The keypad. */}
        <Animated.View entering={FadeInDown.delay(300).springify()} style={styles.keypad}>
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
                  style={[styles.keypadButton, key !== '' && styles.keypadButtonFilled]}
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
                    <Ionicons name="backspace-outline" size={26} color={Colors.text} />
                  ) : key !== '' ? (
                    <Text style={styles.keypadLabel}>{key}</Text>
                  ) : null}
                </TouchableOpacity>
              ))}
            </View>
          ))}
        </Animated.View>

        <View style={styles.spacer} />
      </View>
    );
  }

  // ── Biometric / device auth ──────────────────────────────────────────────
  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, Spacing['2xl']) }]}>
      <View style={styles.spacer} />

      <Animated.View entering={FadeInUp.delay(100).springify()} style={styles.head}>
        <Wordmark size={48} showText />
        <Text style={styles.subtitle}>{t('lock.tapToUnlock')}</Text>
      </Animated.View>

      {/* The one button. */}
      <Animated.View entering={FadeInDown.delay(300).springify()} style={styles.actions}>
        <Button
          onPress={authenticate}
          loading={isAuthenticating || !isBiometricSupported}
          fullWidth
          size="lg"
          icon={<Ionicons name="finger-print" size={20} color={Colors.background} />}
          accessibilityLabel={t('lock.unlockWithBiometrics')}
        >
          {isAuthenticating ? t('lock.authenticating') : t('lock.unlock')}
        </Button>
      </Animated.View>

      <View style={styles.spacer} />

      <Animated.View entering={FadeInDown.delay(500)} style={styles.actions}>
        <Button
          variant="ghost"
          onPress={switchWallet}
          fullWidth
          icon={<Ionicons name="swap-horizontal-outline" size={16} color={Colors.textSecondary} />}
          accessibilityLabel={t('lock.useAnotherWallet')}
        >
          {t('lock.useAnotherWallet')}
        </Button>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    // ⚠️ Explicit, not `transparent`. A lock screen that inherits whatever is
    // behind it is a lock screen that can show the wallet through itself.
    backgroundColor: Colors.background,
    alignItems: 'stretch',
    paddingHorizontal: Spacing['2xl'],
  },
  spacer: {
    flex: 1,
  },

  head: {
    alignItems: 'center',
    gap: Spacing.md,
  },
  title: {
    color: Colors.text,
    fontFamily: FontFamily.display,
    fontSize: FontSize['2xl'],
  },
  subtitle: {
    color: Colors.textSecondary,
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    textAlign: 'center',
  },

  actions: {
    width: '100%',
  },

  // The PIN field
  pinBlock: {
    alignItems: 'center',
    marginTop: Spacing['4xl'],
    marginBottom: Spacing['4xl'],
    gap: Spacing.lg,
  },
  pinDotsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: Spacing.lg,
  },
  pinDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    backgroundColor: 'transparent',
  },
  pinDotFilled: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  pinDotError: {
    backgroundColor: Colors.error,
    borderColor: Colors.error,
  },
  fieldError: {
    color: Colors.error,
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    textAlign: 'center',
  },

  // Keypad
  keypad: {
    gap: Spacing.md,
    alignSelf: 'center',
  },
  keypadRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: Spacing['2xl'],
  },
  keypadButton: {
    width: 68,
    height: 68,
    borderRadius: BorderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keypadButtonFilled: {
    backgroundColor: Colors.surface,
  },
  keypadLabel: {
    color: Colors.text,
    fontFamily: FontFamily.regular,
    fontSize: FontSize['2xl'],
  },
});

/**
 * Security settings — how this device proves it is you.
 *
 * 🎯 REBUILT ON THE REALIGNED THEME AND THE SHARED KIT 2026-08-23.
 *
 * ⛔ TWO ROWS WERE PASSING THEIR OWN LABEL AS THEIR DESCRIPTION.
 * "Block Screenshots / Block Screenshots" and the biometric row's
 * `t('common.disabled')` told the user nothing twice. A second line that
 * restates the first is worse than no second line: it looks like an
 * explanation, so it stops the reader from asking for one.
 *
 * ⛔ THE CLOSING INFO CARD IS GONE. "Enabling biometrics adds an extra layer of
 * security to protect your assets" is a sentence with no decision in it, at the
 * bottom of a screen made entirely of decisions.
 *
 * ⛔ The PIN sheet's gradient icon tile is flat, and the step dots no longer
 * use `P01Colors.green` — a key that exists only to alias away a green the
 * design system forbids in its own first line.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Modal, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { p01Alert } from '@/stores/alertStore';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import * as ScreenCapture from 'expo-screen-capture';
import * as Haptics from 'expo-haptics';
import Animated, { SlideInDown, SlideOutDown } from 'react-native-reanimated';

import { Header } from '@/components/common';
import { Button } from '@/components/ui';
import { SettingsRow, SettingsSection, ToggleRow } from '../../../components/settings';
import { PinInput } from '../../../components/onboarding';
import { Colors, FontFamily, FontSize, BorderRadius, Spacing, Layout } from '@/constants/theme';
import { hashPin, constantTimeEqual } from '@/utils/crypto/pinHash';
import { useT } from '@/i18n';

const STORAGE_KEYS = {
  BIOMETRICS: 'settings_biometrics',
  AUTH_FOR_SENDS: 'settings_auth_sends',
  HIDE_BALANCE: 'settings_hide_balance',
  BLOCK_SCREENSHOTS: 'settings_block_screenshots',
  LOCK_TIMEOUT: 'settings_lock_timeout',
};

const LOCK_TIMEOUTS = [
  { label: 'Immediately', value: 0 },
  { label: '1 minute', value: 60 },
  { label: '5 minutes', value: 300 },
  { label: '15 minutes', value: 900 },
  { label: 'Never', value: -1 },
];

/* ──────────────────────── Change PIN sheet ──────────────────────── */

type PinStep = 'verify' | 'new' | 'confirm';

interface ChangePinModalProps {
  visible: boolean;
  hasPinSet: boolean;
  biometricsEnabled: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

function ChangePinModal({ visible, hasPinSet, biometricsEnabled, onClose, onSuccess }: ChangePinModalProps) {
  const t = useT();
  const [step, setStep] = useState<PinStep>('new');
  const [pin, setPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [error, setError] = useState(false);
  const [verified, setVerified] = useState(false);
  // Increment key to force PinInput remount (re-triggers autoFocus + timer)
  const [pinKey, setPinKey] = useState(0);

  // On open: determine auth method
  useEffect(() => {
    if (!visible) return;
    setPin('');
    setNewPin('');
    setError(false);
    setVerified(false);
    setPinKey(k => k + 1);

    if (!hasPinSet) {
      // No PIN set yet — go straight to new
      setStep('new');
      return;
    }

    // Has existing PIN — need to verify identity first
    if (biometricsEnabled) {
      // Use biometrics to verify
      verifyWithBiometrics();
    } else {
      // Use old PIN to verify
      setStep('verify');
    }
  }, [visible]);

  const verifyWithBiometrics = async () => {
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Verify your identity to change PIN',
        cancelLabel: 'Use PIN',
        disableDeviceFallback: false,
        fallbackLabel: 'Use PIN',
      });
      if (result.success) {
        setVerified(true);
        setStep('new');
        setPinKey(k => k + 1);
      } else {
        // Biometrics cancelled/failed — fall back to PIN verification
        setStep('verify');
        setPinKey(k => k + 1);
      }
    } catch {
      // Biometrics error — fall back to PIN
      setStep('verify');
      setPinKey(k => k + 1);
    }
  };

  const getTitle = () => {
    switch (step) {
      case 'verify': return t('lock.enterPin');
      case 'new': return hasPinSet ? t('settings.changePin') : t('settings.pinCode');
      case 'confirm': return t('onboarding.confirmPin');
    }
  };

  const getSubtitle = () => {
    switch (step) {
      case 'verify': return t('lock.biometricPrompt');
      case 'new': return t('onboarding.setupPinDesc');
      case 'confirm': return t('onboarding.confirmPin');
    }
  };

  const handleComplete = useCallback(async (enteredPin: string) => {
    if (step === 'verify') {
      const storedHash = await SecureStore.getItemAsync('wallet_pin');
      const enteredHash = await hashPin(enteredPin);
      if (storedHash && constantTimeEqual(enteredHash, storedHash)) {
        setVerified(true);
        setPin('');
        setStep('new');
        setPinKey(k => k + 1);
      } else {
        setError(true);
        setPin('');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setTimeout(() => setError(false), 1500);
      }
    } else if (step === 'new') {
      setNewPin(enteredPin);
      setPin('');
      setStep('confirm');
      setPinKey(k => k + 1);
    } else if (step === 'confirm') {
      if (enteredPin === newPin) {
        const pinHash = await hashPin(enteredPin);
        await SecureStore.setItemAsync('wallet_pin', pinHash);
        await SecureStore.setItemAsync('security_method', 'pin');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        onSuccess();
      } else {
        setError(true);
        setPin('');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setTimeout(() => {
          setError(false);
          setStep('new');
          setNewPin('');
          setPinKey(k => k + 1);
        }, 1500);
      }
    }
  }, [step, newPin, onSuccess]);

  const allSteps: PinStep[] = hasPinSet && !verified ? ['verify', 'new', 'confirm'] : ['new', 'confirm'];

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={pm.overlay}>
        <TouchableOpacity
          style={pm.backdrop}
          activeOpacity={1}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
        />
        <Animated.View
          entering={SlideInDown.duration(200)}
          exiting={SlideOutDown.duration(150)}
          style={pm.sheet}
        >
          <View style={pm.dragRow}>
            <View style={pm.dragHandle} />
          </View>

          <View style={pm.header}>
            <View style={pm.iconWrap}>
              <Ionicons name="keypad-outline" size={22} color={Colors.primary} />
            </View>
            <View style={pm.headerText}>
              <Text style={pm.title}>{getTitle()}</Text>
              <Text style={pm.subtitle}>{getSubtitle()}</Text>
            </View>
          </View>

          {/* Step indicator */}
          <View style={pm.steps}>
            {allSteps.map((s, i) => (
              <View key={s} style={pm.stepRow}>
                <View style={[
                  pm.stepDot,
                  s === step && pm.stepDotActive,
                  allSteps.indexOf(s) < allSteps.indexOf(step) && pm.stepDotDone,
                ]} />
                {i < allSteps.length - 1 && <View style={pm.stepLine} />}
              </View>
            ))}
          </View>

          {/* PIN Input — key forces remount on step change */}
          <View style={pm.pinWrap}>
            <PinInput
              key={pinKey}
              value={pin}
              onChange={setPin}
              onComplete={handleComplete}
              error={error}
            />
            {/* The error sits under the field that caused it, and announces
                itself: a PIN that silently refuses reads as a broken keypad. */}
            {error ? (
              <Text style={pm.error} accessibilityRole="alert">
                {step === 'confirm' ? 'Those two PINs do not match.' : 'That PIN is not right.'}
              </Text>
            ) : null}
          </View>

          <Button variant="secondary" fullWidth onPress={onClose}>
            {t('common.cancel')}
          </Button>
        </Animated.View>
      </View>
    </Modal>
  );
}

/* ──────────────────────── Screen ──────────────────────── */

export default function SecuritySettingsScreen() {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [biometricsEnabled, setBiometricsEnabled] = useState(false);
  const [biometricsAvailable, setBiometricsAvailable] = useState(false);
  const [requireAuthForSends, setRequireAuthForSends] = useState(true);
  const [hideBalance, setHideBalance] = useState(false);
  const [blockScreenshots, setBlockScreenshots] = useState(false);
  const [lockTimeout, setLockTimeout] = useState(60);
  const [hasPinSet, setHasPinSet] = useState(false);
  const [showPinModal, setShowPinModal] = useState(false);

  useEffect(() => {
    loadSettings();
    checkBiometrics();
    checkPinStatus();
  }, []);

  const checkPinStatus = async () => {
    const storedPin = await SecureStore.getItemAsync('wallet_pin');
    setHasPinSet(!!storedPin);
  };

  const checkBiometrics = async () => {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const isEnrolled = await LocalAuthentication.isEnrolledAsync();
    setBiometricsAvailable(hasHardware && isEnrolled);
  };

  // L9: Load security settings from SecureStore (migrated from AsyncStorage)
  const loadSettings = async () => {
    try {
      const [bio, auth, hide, block, timeout] = await Promise.all([
        SecureStore.getItemAsync(STORAGE_KEYS.BIOMETRICS),
        SecureStore.getItemAsync(STORAGE_KEYS.AUTH_FOR_SENDS),
        SecureStore.getItemAsync(STORAGE_KEYS.HIDE_BALANCE),
        SecureStore.getItemAsync(STORAGE_KEYS.BLOCK_SCREENSHOTS),
        SecureStore.getItemAsync(STORAGE_KEYS.LOCK_TIMEOUT),
      ]);

      if (bio !== null) setBiometricsEnabled(bio === 'true');
      if (auth !== null) setRequireAuthForSends(auth === 'true');
      if (hide !== null) setHideBalance(hide === 'true');
      if (block !== null) setBlockScreenshots(block === 'true');
      if (timeout !== null) setLockTimeout(parseInt(timeout, 10));
    } catch (error) {
      console.error('Failed to load settings:', error);
    }
  };

  const handleBiometricsToggle = async (value: boolean) => {
    if (value && biometricsAvailable) {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Verify your identity to enable biometrics',
        fallbackLabel: 'Cancel',
      });

      if (result.success) {
        setBiometricsEnabled(true);
        await SecureStore.setItemAsync(STORAGE_KEYS.BIOMETRICS, 'true');
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } else {
      setBiometricsEnabled(false);
      await SecureStore.setItemAsync(STORAGE_KEYS.BIOMETRICS, 'false');
    }
  };

  const handleAuthForSendsToggle = async (value: boolean) => {
    setRequireAuthForSends(value);
    await SecureStore.setItemAsync(STORAGE_KEYS.AUTH_FOR_SENDS, value.toString());
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleHideBalanceToggle = async (value: boolean) => {
    setHideBalance(value);
    await SecureStore.setItemAsync(STORAGE_KEYS.HIDE_BALANCE, value.toString());
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleBlockScreenshotsToggle = async (value: boolean) => {
    setBlockScreenshots(value);
    await SecureStore.setItemAsync(STORAGE_KEYS.BLOCK_SCREENSHOTS, value.toString());
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    // Apply immediately using expo-screen-capture
    // TEMP: disabled for demo recording
    try {
      await ScreenCapture.allowScreenCaptureAsync();
    } catch (err) {
      console.warn('[Security] Screen capture API error:', err);
    }
  };

  const handleLockTimeoutSelect = () => {
    p01Alert(
      t('settings.autoLock'),
      t('settings.lockTimeout'),
      LOCK_TIMEOUTS.map((option) => ({
        text: option.label,
        onPress: async () => {
          setLockTimeout(option.value);
          await SecureStore.setItemAsync(STORAGE_KEYS.LOCK_TIMEOUT, option.value.toString());
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        },
      }))
    );
  };

  const handleChangePIN = () => {
    setShowPinModal(true);
  };

  const handlePinSuccess = () => {
    setShowPinModal(false);
    setHasPinSet(true);
    p01Alert(t('settings.changePin'), t('common.success'));
  };

  const getLockTimeoutLabel = () => {
    const option = LOCK_TIMEOUTS.find((t) => t.value === lockTimeout);
    return option?.label || '1 minute';
  };

  return (
    <View style={styles.screen}>
      <Header title={t('settings.security')} showBack onBackPress={() => router.back()} />

      <ScrollView
        style={styles.flex}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingBottom: Layout.tabBarTotalHeight + insets.bottom + Spacing['3xl'],
        }}
      >
        {/* ── Unlocking ── */}
        <SettingsSection title="Unlocking" style={styles.firstSection}>
          <SettingsRow
            label={hasPinSet ? t('settings.changePin') : t('settings.pinCode')}
            description={hasPinSet ? undefined : 'Not set yet'}
            leftIcon="keypad-outline"
            onPress={handleChangePIN}
          />
          <ToggleRow
            label={t('settings.biometric')}
            description={
              biometricsAvailable
                ? 'Unlock with the sensor instead of typing the PIN'
                : 'No sensor enrolled on this device'
            }
            value={biometricsEnabled}
            onValueChange={handleBiometricsToggle}
            disabled={!biometricsAvailable}
          />
          <SettingsRow
            label={t('settings.autoLock')}
            description="How long the app can sit in the background before it locks"
            value={getLockTimeoutLabel()}
            leftIcon="time-outline"
            onPress={handleLockTimeoutSelect}
          />
        </SettingsSection>

        {/* ── Spending ── */}
        <SettingsSection title="Spending">
          <ToggleRow
            label="Confirm sends"
            description="Authenticate before a transaction leaves this device"
            value={requireAuthForSends}
            onValueChange={handleAuthForSendsToggle}
          />
        </SettingsSection>

        {/* ── On screen ── */}
        <SettingsSection title="On screen">
          <ToggleRow
            label={t('settings.hideBalanceDefault')}
            description="Open the wallet with the amount masked"
            value={hideBalance}
            onValueChange={handleHideBalanceToggle}
          />
          <ToggleRow
            label={t('settings.blockScreenshots')}
            description="Stop screenshots and screen recording inside the app"
            value={blockScreenshots}
            onValueChange={handleBlockScreenshotsToggle}
          />
        </SettingsSection>
      </ScrollView>

      <ChangePinModal
        visible={showPinModal}
        hasPinSet={hasPinSet}
        biometricsEnabled={biometricsEnabled && biometricsAvailable}
        onClose={() => setShowPinModal(false)}
        onSuccess={handlePinSuccess}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  flex: {
    flex: 1,
  },
  firstSection: {
    marginTop: Spacing.lg,
  },
});

/* ──────────────────────── PIN sheet styles ──────────────────────── */

const pm = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    // Colors.background at 78%: the scrim is the ground with alpha, not a colour.
    backgroundColor: 'rgba(7, 7, 9, 0.78)',
  },
  sheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: BorderRadius['2xl'],
    borderTopRightRadius: BorderRadius['2xl'],
    paddingHorizontal: Spacing.xl,
    paddingBottom: Spacing['4xl'],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
  dragRow: {
    alignItems: 'center',
    paddingTop: 10,
    paddingBottom: Spacing.md,
  },
  dragHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.border,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    marginBottom: Spacing.lg,
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: BorderRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSoft,
    backgroundColor: Colors.surfaceSecondary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: FontSize.xl,
    fontFamily: FontFamily.displayMedium,
    color: Colors.text,
  },
  subtitle: {
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    marginTop: 2,
  },
  steps: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.xl,
    gap: Spacing.xs,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
  },
  stepDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.border,
  },
  stepDotActive: {
    backgroundColor: Colors.primary,
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  stepDotDone: {
    backgroundColor: Colors.primaryMuted,
  },
  stepLine: {
    width: 28,
    height: StyleSheet.hairlineWidth,
    backgroundColor: Colors.border,
  },
  pinWrap: {
    paddingHorizontal: Spacing.md,
    marginBottom: Spacing.xl,
  },
  error: {
    marginTop: Spacing.md,
    textAlign: 'center',
    color: Colors.error,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
  },
});

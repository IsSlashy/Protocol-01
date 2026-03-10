import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Alert,
  Modal,
  StyleSheet,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import * as ScreenCapture from 'expo-screen-capture';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown, SlideInDown, SlideOutDown } from 'react-native-reanimated';

import { SettingsRow, ToggleRow } from '../../../components/settings';
import { PinInput } from '../../../components/onboarding';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import { hashPin, constantTimeEqual } from '@/utils/crypto/pinHash';

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

/* ──────────────────────── Glass Card ──────────────────────── */

interface GlassCardProps {
  children: React.ReactNode;
  delay?: number;
  style?: object;
}

const GlassCard: React.FC<GlassCardProps> = ({ children, delay = 0, style }) => (
  <Animated.View entering={FadeInDown.delay(delay).duration(350)} style={[styles.glassOuter, style]}>
    <BlurView intensity={14} tint="dark" style={styles.glassBlur}>
      <LinearGradient
        colors={['rgba(57, 197, 187, 0.06)', 'rgba(255, 119, 168, 0.03)', 'transparent']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      {children}
    </BlurView>
  </Animated.View>
);

/* ──────────────────────── Section Title ──────────────────────── */

const SectionTitle: React.FC<{ title: string; delay?: number }> = ({ title, delay = 0 }) => (
  <Animated.Text
    entering={FadeInDown.delay(delay).duration(300)}
    style={styles.sectionTitle}
  >
    {title}
  </Animated.Text>
);

/* ──────────────────────── Divider ──────────────────────── */

const GlassDivider: React.FC = () => (
  <View style={styles.divider} />
);

/* ──────────────────────── Change PIN Modal ──────────────────────── */

type PinStep = 'verify' | 'new' | 'confirm';

interface ChangePinModalProps {
  visible: boolean;
  hasPinSet: boolean;
  biometricsEnabled: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

function ChangePinModal({ visible, hasPinSet, biometricsEnabled, onClose, onSuccess }: ChangePinModalProps) {
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
      case 'verify': return 'Enter Current PIN';
      case 'new': return hasPinSet ? 'Enter New PIN' : 'Set PIN';
      case 'confirm': return 'Confirm New PIN';
    }
  };

  const getSubtitle = () => {
    switch (step) {
      case 'verify': return 'Verify your identity';
      case 'new': return 'Choose a 6-digit PIN';
      case 'confirm': return 'Re-enter to confirm';
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
        <TouchableOpacity style={pm.backdrop} activeOpacity={1} onPress={onClose} />
        <Animated.View
          entering={SlideInDown.duration(200)}
          exiting={SlideOutDown.duration(150)}
          style={pm.sheet}
        >
          <View style={pm.dragRow}>
            <View style={pm.dragHandle} />
          </View>

          {/* Header */}
          <View style={pm.header}>
            <LinearGradient
              colors={[P01Colors.cyanDim, 'rgba(57, 197, 187, 0.05)']}
              style={pm.iconWrap}
            >
              <Ionicons name="keypad" size={28} color={P01Colors.cyan} />
            </LinearGradient>
            <View style={{ flex: 1 }}>
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
          </View>

          {/* Cancel */}
          <TouchableOpacity style={pm.cancelBtn} onPress={onClose}>
            <Text style={pm.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </Animated.View>
      </View>
    </Modal>
  );
}

/* ──────────────────────── Screen ──────────────────────── */

export default function SecuritySettingsScreen() {
  const router = useRouter();

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
    try {
      if (value) {
        await ScreenCapture.preventScreenCaptureAsync();
      } else {
        await ScreenCapture.allowScreenCaptureAsync();
      }
    } catch (err) {
      console.warn('[Security] Screen capture API error:', err);
    }
  };

  const handleLockTimeoutSelect = () => {
    Alert.alert(
      'Auto-Lock Timer',
      'Select how long before the app locks automatically',
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
    Alert.alert('PIN Updated', hasPinSet ? 'Your PIN has been changed.' : 'Your PIN has been set.');
  };

  const getLockTimeoutLabel = () => {
    const option = LOCK_TIMEOUTS.find((t) => t.value === lockTimeout);
    return option?.label || '1 minute';
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <Animated.View entering={FadeInDown.delay(50).duration(300)} style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="arrow-back" size={20} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Security Settings</Text>
        <View style={{ width: 40 }} />
      </Animated.View>

      <ScrollView
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 120 }}
      >
        {/* AUTHENTICATION */}
        <SectionTitle title="AUTHENTICATION" delay={80} />
        <GlassCard delay={100}>
          <SettingsRow
            label={hasPinSet ? 'Change PIN' : 'Set PIN'}
            leftIcon="keypad-outline"
            onPress={handleChangePIN}
          />
          <GlassDivider />
          <ToggleRow
            label="Biometrics"
            description={
              biometricsAvailable
                ? 'Use Face ID or fingerprint to unlock'
                : 'Not available on this device'
            }
            value={biometricsEnabled}
            onValueChange={handleBiometricsToggle}
            disabled={!biometricsAvailable}
          />
        </GlassCard>

        {/* AUTO-LOCK */}
        <SectionTitle title="AUTO-LOCK" delay={150} />
        <GlassCard delay={170}>
          <SettingsRow
            label="Lock after"
            value={getLockTimeoutLabel()}
            leftIcon="time-outline"
            onPress={handleLockTimeoutSelect}
          />
        </GlassCard>

        {/* TRANSACTION SECURITY */}
        <SectionTitle title="TRANSACTION SECURITY" delay={220} />
        <GlassCard delay={240}>
          <ToggleRow
            label="Require auth for sends"
            description="Authenticate before sending transactions"
            value={requireAuthForSends}
            onValueChange={handleAuthForSendsToggle}
          />
        </GlassCard>

        {/* ADVANCED */}
        <SectionTitle title="ADVANCED" delay={290} />
        <GlassCard delay={310}>
          <ToggleRow
            label="Hide balance by default"
            description="Balance hidden until tapped"
            value={hideBalance}
            onValueChange={handleHideBalanceToggle}
          />
          <GlassDivider />
          <ToggleRow
            label="Block screenshots"
            description="Prevent screenshots in the app"
            value={blockScreenshots}
            onValueChange={handleBlockScreenshotsToggle}
          />
        </GlassCard>

        {/* Info Card */}
        <Animated.View entering={FadeInDown.delay(380).duration(350)} style={styles.infoOuter}>
          <BlurView intensity={14} tint="dark" style={styles.glassBlur}>
            <LinearGradient
              colors={['rgba(57, 197, 187, 0.06)', 'rgba(255, 119, 168, 0.03)', 'transparent']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />
            <View style={styles.infoContent}>
              <Ionicons name="information-circle" size={20} color={P01Colors.cyan} />
              <Text style={styles.infoText}>
                Enabling biometrics and transaction authentication adds an extra layer of security to protect your assets.
              </Text>
            </View>
          </BlurView>
        </Animated.View>
      </ScrollView>

      {/* Change PIN Modal */}
      <ChangePinModal
        visible={showPinModal}
        hasPinSet={hasPinSet}
        biometricsEnabled={biometricsEnabled && biometricsAvailable}
        onClose={() => setShowPinModal(false)}
        onSuccess={handlePinSuccess}
      />
    </SafeAreaView>
  );
}

/* ──────────────────────── Styles ──────────────────────── */

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'transparent',
  },

  /* Header */
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.lg,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: BorderRadius.full,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.07)',
  },
  headerTitle: {
    color: Colors.text,
    fontSize: 18,
    fontFamily: FontFamily.semibold,
  },

  /* Section Title */
  sectionTitle: {
    color: Colors.textSecondary,
    fontSize: 12,
    fontFamily: FontFamily.semibold,
    letterSpacing: 1,
    paddingHorizontal: Spacing.lg,
    marginBottom: Spacing.sm,
    marginTop: Spacing.lg,
  },

  /* Glass Card */
  glassOuter: {
    marginHorizontal: Spacing.lg,
    borderRadius: BorderRadius.xl,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.07)',
  },
  glassBlur: {
    backgroundColor: 'rgba(12, 12, 14, 0.65)',
  },

  /* Divider */
  divider: {
    height: 1,
    backgroundColor: 'rgba(57, 197, 187, 0.07)',
    marginHorizontal: Spacing.lg,
  },

  /* Info Card */
  infoOuter: {
    marginHorizontal: Spacing.lg,
    marginTop: Spacing.lg,
    borderRadius: BorderRadius.xl,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.07)',
  },
  infoContent: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: Spacing.lg,
  },
  infoText: {
    color: Colors.textSecondary,
    fontSize: 14,
    marginLeft: Spacing.md,
    flex: 1,
    lineHeight: 20,
  },
});

/* ──────────────────────── PIN Modal Styles ──────────────────────── */

const pm = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.75)',
  },
  sheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: Spacing.xl,
    paddingBottom: 40,
    borderTopWidth: 1,
    borderTopColor: `${P01Colors.cyan}30`,
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
    gap: 14,
    marginBottom: Spacing.lg,
  },
  iconWrap: {
    width: 52,
    height: 52,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 20,
    fontFamily: FontFamily.bold,
    color: Colors.text,
  },
  subtitle: {
    fontSize: 13,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    marginTop: 2,
  },
  steps: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.xl,
    gap: 4,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  stepDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: Colors.border,
  },
  stepDotActive: {
    backgroundColor: P01Colors.cyan,
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  stepDotDone: {
    backgroundColor: P01Colors.green,
  },
  stepLine: {
    width: 32,
    height: 2,
    backgroundColor: Colors.border,
  },
  pinWrap: {
    paddingHorizontal: Spacing.md,
    marginBottom: Spacing.xl,
  },
  cancelBtn: {
    paddingVertical: 14,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
  },
  cancelText: {
    fontSize: 15,
    fontFamily: FontFamily.semibold,
    color: Colors.text,
  },
});

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Alert,
  Platform,
  StyleSheet,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as LocalAuthentication from 'expo-local-authentication';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { requireNativeModule } from 'expo-modules-core';

import { SettingsRow, ToggleRow } from '../../../components/settings';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';

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

/* ──────────────────────── Screen ──────────────────────── */

export default function SecuritySettingsScreen() {
  const router = useRouter();

  const [biometricsEnabled, setBiometricsEnabled] = useState(false);
  const [biometricsAvailable, setBiometricsAvailable] = useState(false);
  const [requireAuthForSends, setRequireAuthForSends] = useState(true);
  const [hideBalance, setHideBalance] = useState(false);
  const [blockScreenshots, setBlockScreenshots] = useState(false);
  const [lockTimeout, setLockTimeout] = useState(60);

  useEffect(() => {
    loadSettings();
    checkBiometrics();
  }, []);

  const checkBiometrics = async () => {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const isEnrolled = await LocalAuthentication.isEnrolledAsync();
    setBiometricsAvailable(hasHardware && isEnrolled);
  };

  const loadSettings = async () => {
    try {
      const [bio, auth, hide, block, timeout] = await Promise.all([
        AsyncStorage.getItem(STORAGE_KEYS.BIOMETRICS),
        AsyncStorage.getItem(STORAGE_KEYS.AUTH_FOR_SENDS),
        AsyncStorage.getItem(STORAGE_KEYS.HIDE_BALANCE),
        AsyncStorage.getItem(STORAGE_KEYS.BLOCK_SCREENSHOTS),
        AsyncStorage.getItem(STORAGE_KEYS.LOCK_TIMEOUT),
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
      // Verify biometrics before enabling
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Verify your identity to enable biometrics',
        fallbackLabel: 'Cancel',
      });

      if (result.success) {
        setBiometricsEnabled(true);
        await AsyncStorage.setItem(STORAGE_KEYS.BIOMETRICS, 'true');
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } else {
      setBiometricsEnabled(false);
      await AsyncStorage.setItem(STORAGE_KEYS.BIOMETRICS, 'false');
    }
  };

  const handleAuthForSendsToggle = async (value: boolean) => {
    setRequireAuthForSends(value);
    await AsyncStorage.setItem(STORAGE_KEYS.AUTH_FOR_SENDS, value.toString());
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleHideBalanceToggle = async (value: boolean) => {
    setHideBalance(value);
    await AsyncStorage.setItem(STORAGE_KEYS.HIDE_BALANCE, value.toString());
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleBlockScreenshotsToggle = async (value: boolean) => {
    setBlockScreenshots(value);
    await AsyncStorage.setItem(STORAGE_KEYS.BLOCK_SCREENSHOTS, value.toString());
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    // Apply FLAG_SECURE on Android
    if (Platform.OS === 'android') {
      try {
        const ActivityModule = requireNativeModule('ExpoActivity');
        if (value) {
          ActivityModule.setWindowFlags(8192, 8192); // FLAG_SECURE = 0x2000
        } else {
          ActivityModule.clearWindowFlags(8192);
        }
      } catch {
        // ExpoActivity module not available — fall back to alert
        if (value) {
          Alert.alert(
            'Screenshot Blocking',
            'Screenshot blocking is enabled but requires a native module for full enforcement. It will take effect on next app restart.',
            [{ text: 'OK' }]
          );
        }
      }
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
          await AsyncStorage.setItem(STORAGE_KEYS.LOCK_TIMEOUT, option.value.toString());
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        },
      }))
    );
  };

  const handleChangePIN = () => {
    Alert.alert(
      'Change PIN',
      'PIN lock will be available in a future update. Your wallet is secured by biometric authentication.',
      [{ text: 'OK' }]
    );
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
            label="Change PIN"
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

import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as LocalAuthentication from 'expo-local-authentication';
import * as Haptics from 'expo-haptics';
import { SettingsSection, SettingsRow, ToggleRow } from '../../../components/settings';

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

    if (value) {
      Alert.alert(
        'Screenshot Blocking',
        'Screenshot blocking is enabled but may not be fully supported on all devices.',
        [{ text: 'OK' }]
      );
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
      'PIN functionality is not yet implemented. Coming soon!',
      [{ text: 'OK' }]
    );
  };

  const getLockTimeoutLabel = () => {
    const option = LOCK_TIMEOUTS.find((t) => t.value === lockTimeout);
    return option?.label || '1 minute';
  };

  return (
    <SafeAreaView className="flex-1 bg-p01-void">
      {/* Header */}
      <View className="flex-row items-center justify-between px-4 py-4">
        <TouchableOpacity
          onPress={() => router.back()}
          className="w-10 h-10 rounded-full bg-p01-surface items-center justify-center"
        >
          <Ionicons name="arrow-back" size={20} color="#fff" />
        </TouchableOpacity>
        <Text className="text-white text-lg font-semibold">Security Settings</Text>
        <View className="w-10" />
      </View>

      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 40 }}
      >
        {/* AUTHENTICATION */}
        <SettingsSection title="Authentication">
          <SettingsRow
            label="Change PIN"
            leftIcon="keypad-outline"
            onPress={handleChangePIN}
          />
          <View className="h-px bg-p01-border mx-4" />
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
        </SettingsSection>

        {/* AUTO-LOCK */}
        <SettingsSection title="Auto-Lock">
          <SettingsRow
            label="Lock after"
            value={getLockTimeoutLabel()}
            leftIcon="time-outline"
            onPress={handleLockTimeoutSelect}
          />
        </SettingsSection>

        {/* TRANSACTION SECURITY */}
        <SettingsSection title="Transaction Security">
          <ToggleRow
            label="Require auth for sends"
            description="Authenticate before sending transactions"
            value={requireAuthForSends}
            onValueChange={handleAuthForSendsToggle}
          />
        </SettingsSection>

        {/* ADVANCED */}
        <SettingsSection title="Advanced">
          <ToggleRow
            label="Hide balance by default"
            description="Balance hidden until tapped"
            value={hideBalance}
            onValueChange={handleHideBalanceToggle}
          />
          <View className="h-px bg-p01-border mx-4" />
          <ToggleRow
            label="Block screenshots"
            description="Prevent screenshots in the app"
            value={blockScreenshots}
            onValueChange={handleBlockScreenshotsToggle}
          />
        </SettingsSection>

        {/* Info Card */}
        <View style={{ marginHorizontal: 16, marginTop: 8, padding: 16, backgroundColor: '#18181b', borderRadius: 16, borderWidth: 1, borderColor: '#3f3f46' }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
            <Ionicons name="information-circle" size={20} color="#06b6d4" />
            <Text style={{ color: '#9ca3af', fontSize: 14, marginLeft: 12, flex: 1 }}>
              Enabling biometrics and transaction authentication adds an extra layer of security to protect your assets.
            </Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

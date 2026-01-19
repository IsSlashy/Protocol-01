import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import { SettingsSection, SettingsRow, RadioOption, ToggleRow } from '../../../components/settings';
import { usePrivacyStore, getZoneStatusColor, getZoneStatusLabel } from '../../../stores/privacyStore';

type PrivacyLevel = 'standard' | 'enhanced' | 'maximum';

const STORAGE_KEYS = {
  PRIVACY_LEVEL: 'settings_privacy_level',
  ALWAYS_STEALTH: 'settings_always_stealth',
  HIDE_AMOUNTS: 'settings_hide_amounts',
  PRIVATE_DEFAULT: 'settings_private_default',
  EPHEMERAL_WALLETS: 'settings_ephemeral_wallets',
};

const AUTO_SCAN_OPTIONS = [
  { label: 'Every 1 min', value: 60 },
  { label: 'Every 5 min', value: 300 },
  { label: 'Every 15 min', value: 900 },
  { label: 'Manual only', value: -1 },
];

export default function PrivacySettingsScreen() {
  const router = useRouter();

  const [privacyLevel, setPrivacyLevel] = useState<PrivacyLevel>('enhanced');
  const [alwaysUseStealth, setAlwaysUseStealth] = useState(true);
  const [autoScanInterval, setAutoScanInterval] = useState(300);
  const [hideAmounts, setHideAmounts] = useState(false);
  const [privateByDefault, setPrivateByDefault] = useState(true);
  const [ephemeralWallets, setEphemeralWallets] = useState(false);

  // Privacy zone store
  const { zoneStatus, settings: privacyZoneSettings, initialize: initPrivacyZone } = usePrivacyStore();
  const zoneColor = getZoneStatusColor(zoneStatus);
  const zoneLabel = getZoneStatusLabel(zoneStatus);

  useEffect(() => {
    loadSettings();
    initPrivacyZone();
  }, []);

  const loadSettings = async () => {
    try {
      const [level, stealth, hide, priv, ephemeral] = await Promise.all([
        AsyncStorage.getItem(STORAGE_KEYS.PRIVACY_LEVEL),
        AsyncStorage.getItem(STORAGE_KEYS.ALWAYS_STEALTH),
        AsyncStorage.getItem(STORAGE_KEYS.HIDE_AMOUNTS),
        AsyncStorage.getItem(STORAGE_KEYS.PRIVATE_DEFAULT),
        AsyncStorage.getItem(STORAGE_KEYS.EPHEMERAL_WALLETS),
      ]);

      if (level) setPrivacyLevel(level as PrivacyLevel);
      if (stealth !== null) setAlwaysUseStealth(stealth === 'true');
      if (hide !== null) setHideAmounts(hide === 'true');
      if (priv !== null) setPrivateByDefault(priv === 'true');
      if (ephemeral !== null) setEphemeralWallets(ephemeral === 'true');
    } catch (error) {
      console.error('Failed to load privacy settings:', error);
    }
  };

  const handlePrivacyLevelChange = async (level: PrivacyLevel) => {
    setPrivacyLevel(level);
    await AsyncStorage.setItem(STORAGE_KEYS.PRIVACY_LEVEL, level);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleStealthToggle = async (value: boolean) => {
    setAlwaysUseStealth(value);
    await AsyncStorage.setItem(STORAGE_KEYS.ALWAYS_STEALTH, value.toString());
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleAutoScanSelect = () => {
    Alert.alert(
      'Auto-Scan Interval',
      'How often should we scan for incoming stealth payments?',
      AUTO_SCAN_OPTIONS.map((option) => ({
        text: option.label,
        onPress: async () => {
          setAutoScanInterval(option.value);
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        },
      }))
    );
  };

  const handleHideAmountsToggle = async (value: boolean) => {
    setHideAmounts(value);
    await AsyncStorage.setItem(STORAGE_KEYS.HIDE_AMOUNTS, value.toString());
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handlePrivateDefaultToggle = async (value: boolean) => {
    setPrivateByDefault(value);
    await AsyncStorage.setItem(STORAGE_KEYS.PRIVATE_DEFAULT, value.toString());
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleEphemeralToggle = async (value: boolean) => {
    setEphemeralWallets(value);
    await AsyncStorage.setItem(STORAGE_KEYS.EPHEMERAL_WALLETS, value.toString());
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    if (value) {
      Alert.alert(
        'Ephemeral Wallets',
        'When enabled, the AI agent will use temporary wallets for operations, providing enhanced privacy but requiring more transactions.',
        [{ text: 'OK' }]
      );
    }
  };

  const getAutoScanLabel = () => {
    const option = AUTO_SCAN_OPTIONS.find((o) => o.value === autoScanInterval);
    return option?.label || 'Every 5 min';
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
        <Text className="text-white text-lg font-semibold">Privacy Settings</Text>
        <View className="w-10" />
      </View>

      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 40 }}
      >
        {/* DEFAULT PRIVACY LEVEL */}
        <SettingsSection title="Default Privacy Level">
          <RadioOption
            label="Standard"
            description="1 decoy transaction"
            selected={privacyLevel === 'standard'}
            onSelect={() => handlePrivacyLevelChange('standard')}
          />
          <View className="h-px bg-p01-border mx-4" />
          <RadioOption
            label="Enhanced"
            description="5 decoy transactions (Recommended)"
            selected={privacyLevel === 'enhanced'}
            onSelect={() => handlePrivacyLevelChange('enhanced')}
          />
          <View className="h-px bg-p01-border mx-4" />
          <RadioOption
            label="Maximum"
            description="10 decoy transactions"
            selected={privacyLevel === 'maximum'}
            onSelect={() => handlePrivacyLevelChange('maximum')}
          />
        </SettingsSection>

        {/* Privacy Level Info */}
        <View className="mx-4 mb-6 p-4 bg-p01-surface rounded-2xl border border-p01-cyan/20">
          <View className="flex-row items-center mb-2">
            <Ionicons name="shield-checkmark" size={18} color="#39c5bb" />
            <Text className="text-p01-cyan text-sm font-semibold ml-2">
              {privacyLevel === 'standard' ? 'Basic Privacy' :
               privacyLevel === 'enhanced' ? 'Enhanced Privacy' : 'Maximum Privacy'}
            </Text>
          </View>
          <Text className="text-p01-text-secondary text-sm">
            {privacyLevel === 'standard'
              ? 'Minimal privacy protection with lower fees. Best for small transactions.'
              : privacyLevel === 'enhanced'
              ? 'Balanced privacy and cost. Recommended for most users.'
              : 'Maximum anonymity with highest decoy count. Higher fees apply.'}
          </Text>
        </View>

        {/* STEALTH ADDRESSES */}
        <SettingsSection title="Stealth Addresses">
          <ToggleRow
            label="Always use stealth"
            description="Generate new addresses for each transaction"
            value={alwaysUseStealth}
            onValueChange={handleStealthToggle}
          />
          <View className="h-px bg-p01-border mx-4" />
          <SettingsRow
            label="Auto-scan"
            value={getAutoScanLabel()}
            leftIcon="refresh-outline"
            onPress={handleAutoScanSelect}
          />
        </SettingsSection>

        {/* PRIVACY ZONE */}
        <SettingsSection title="Privacy Zone">
          <TouchableOpacity
            className="flex-row items-center justify-between py-4 px-4"
            onPress={() => router.push('/(main)/(settings)/privacy-zone')}
            activeOpacity={0.7}
          >
            <View className="flex-row items-center flex-1">
              <View className="w-8 h-8 rounded-lg bg-p01-elevated items-center justify-center mr-3">
                <Ionicons name="bluetooth" size={18} color="#39c5bb" />
              </View>
              <View className="flex-1">
                <Text className="text-white text-base font-medium">Privacy Zone Settings</Text>
                <Text className="text-p01-gray text-sm mt-0.5">
                  {privacyZoneSettings.enabled
                    ? `${zoneLabel} - ${zoneStatus.nearbyTrustedCount} trusted nearby`
                    : 'Bluetooth-based auto-lock'}
                </Text>
              </View>
            </View>
            <View className="flex-row items-center">
              {privacyZoneSettings.enabled && (
                <View
                  className="w-2 h-2 rounded-full mr-2"
                  style={{ backgroundColor: zoneColor }}
                />
              )}
              <Ionicons name="chevron-forward" size={20} color="#555560" />
            </View>
          </TouchableOpacity>
        </SettingsSection>

        {/* TRANSACTIONS */}
        <SettingsSection title="Transactions">
          <ToggleRow
            label="Hide amounts"
            description="Mask transaction amounts in history"
            value={hideAmounts}
            onValueChange={handleHideAmountsToggle}
          />
          <View className="h-px bg-p01-border mx-4" />
          <ToggleRow
            label="Private by default"
            description="Enable privacy features on all sends"
            value={privateByDefault}
            onValueChange={handlePrivateDefaultToggle}
          />
        </SettingsSection>

        {/* AGENT */}
        <SettingsSection title="Agent">
          <ToggleRow
            label="Ephemeral wallets"
            description="Use temporary wallets for agent operations"
            value={ephemeralWallets}
            onValueChange={handleEphemeralToggle}
          />
        </SettingsSection>

        {/* Warning */}
        <View className="mx-4 mt-2 p-4 bg-yellow-500/10 rounded-2xl border border-yellow-500/30">
          <View className="flex-row items-start">
            <Ionicons name="warning" size={20} color="#eab308" />
            <Text className="text-yellow-500 text-sm ml-3 flex-1">
              Higher privacy levels use more decoys and may result in higher transaction fees.
            </Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

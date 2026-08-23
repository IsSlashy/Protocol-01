/**
 * Privacy settings — decoys, stealth addresses, relay routing.
 *
 * 🎯 REBUILT ON THE REALIGNED THEME AND THE SHARED KIT 2026-08-23.
 *
 * ⛔ THREE CARDS BECAME ONE LINE. The privacy-level group was followed by a
 * "Basic / Enhanced / Maximum Privacy" card that repeated the description of
 * the row the user had just selected, and then by a warning card that repeated
 * the fee the first card had already quoted. Three panels, two facts. The fee
 * and the feature list now sit under the group as its footer, once.
 *
 * 🚨 AND ONE OF THOSE CARDS OVERSTATED THE PRODUCT. It called the top level
 * "Maximum anonymity". Decoys are self-transfers that add noise to a wallet's
 * own history; they are not an anonymity system, and this app is not allowed to
 * say they are — `app/privacy-claims.test.ts` exists because that sentence
 * class shipped before. The copy states what a decoy does and stops there.
 *
 * ⛔ The BlurView + LinearGradient stack behind every panel is gone: a cyan-to-
 * pink wash, hardcoded in five places, drawn under content that reads better
 * on the flat ground.
 */

import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { p01Alert } from '@/stores/alertStore';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';

import { Header } from '@/components/common';
import { SettingsRow, SettingsSection, RadioOption, ToggleRow } from '../../../components/settings';
import { Colors, FontFamily, FontSize, BorderRadius, Spacing, Layout } from '@/constants/theme';
import {
  calculateDecoyFees,
  getPrivacyLevelDescription,
  type PrivacyLevel,
} from '../../../services/solana/decoyTransactions';
import { useAutoShieldStore } from '@/stores/autoShieldStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useT } from '@/i18n';

const STORAGE_KEYS = {
  PRIVACY_LEVEL: 'settings_privacy_level',
  ALWAYS_STEALTH: 'settings_always_stealth',
  HIDE_AMOUNTS: 'settings_hide_amounts',
  PRIVATE_DEFAULT: 'settings_private_default',
};

const AUTO_SCAN_OPTIONS = [
  { label: 'Every 1 min', value: 60 },
  { label: 'Every 5 min', value: 300 },
  { label: 'Every 15 min', value: 900 },
  { label: 'Manual only', value: -1 },
];

export default function PrivacySettingsScreen() {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [privacyLevel, setPrivacyLevel] = useState<PrivacyLevel>('enhanced');
  const [alwaysUseStealth, setAlwaysUseStealth] = useState(true);
  const [autoScanInterval, setAutoScanInterval] = useState(300);
  const [hideAmounts, setHideAmounts] = useState(false);
  const [privateByDefault, setPrivateByDefault] = useState(true);
  const autoShieldEnabled = useAutoShieldStore((s) => s.enabled);
  const setAutoShieldEnabled = useAutoShieldStore((s) => s.setEnabled);
  const relayerV3Enabled = useSettingsStore((s) => s.relayerV3Enabled);
  const setRelayerV3Enabled = useSettingsStore((s) => s.setRelayerV3Enabled);
  const relayerStrictMode = useSettingsStore((s) => s.relayerStrictMode);
  const setRelayerStrictMode = useSettingsStore((s) => s.setRelayerStrictMode);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const [level, stealth, hide, priv] = await Promise.all([
        AsyncStorage.getItem(STORAGE_KEYS.PRIVACY_LEVEL),
        AsyncStorage.getItem(STORAGE_KEYS.ALWAYS_STEALTH),
        AsyncStorage.getItem(STORAGE_KEYS.HIDE_AMOUNTS),
        AsyncStorage.getItem(STORAGE_KEYS.PRIVATE_DEFAULT),
      ]);

      if (level) setPrivacyLevel(level as PrivacyLevel);
      if (stealth !== null) setAlwaysUseStealth(stealth === 'true');
      if (hide !== null) setHideAmounts(hide === 'true');
      if (priv !== null) setPrivateByDefault(priv === 'true');
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
    p01Alert(
      t('common.refresh'),
      t('common.refresh'),
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

  const getAutoScanLabel = () => {
    const option = AUTO_SCAN_OPTIONS.find((o) => o.value === autoScanInterval);
    return option?.label || 'Every 5 min';
  };

  const extraFee = calculateDecoyFees(privacyLevel, 1).totalFees.toFixed(6);

  return (
    <View style={styles.screen}>
      <Header title={t('settings.privacy')} showBack onBackPress={() => router.back()} />

      <ScrollView
        style={styles.flex}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingBottom: Layout.tabBarTotalHeight + insets.bottom + Spacing['3xl'],
        }}
      >
        {/* ── Decoys ── */}
        <SettingsSection
          title="Decoy transactions"
          style={styles.firstSection}
          footer={`${getPrivacyLevelDescription(privacyLevel)} Adds about ${extraFee} SOL per transaction.`}
        >
          <RadioOption
            label={t('privateSend.standard')}
            description="1 decoy"
            selected={privacyLevel === 'standard'}
            onSelect={() => handlePrivacyLevelChange('standard')}
          />
          <RadioOption
            label={t('privateSend.enhanced')}
            description="5 decoys"
            selected={privacyLevel === 'enhanced'}
            onSelect={() => handlePrivacyLevelChange('enhanced')}
          />
          <RadioOption
            label={t('privateSend.maximum')}
            description="10 decoys, and the highest fee"
            selected={privacyLevel === 'maximum'}
            onSelect={() => handlePrivacyLevelChange('maximum')}
          />
        </SettingsSection>

        {/* One explainer, kept because it says what a decoy IS — which nothing
            else on the screen does — and because it states the limit. */}
        <View style={styles.note}>
          <Ionicons name="information-circle-outline" size={18} color={Colors.textTertiary} />
          <Text style={styles.noteText}>
            A decoy is a small transfer from your wallet back to itself, sent before the real
            one. It adds noise to your own history. It does not hide the sender, and it costs
            a network fee each time.
          </Text>
        </View>

        {/* ── Stealth addresses ── */}
        <SettingsSection title="Stealth addresses">
          <ToggleRow
            label="Always use stealth"
            description={t('privacy.zeroWalletFootprint')}
            value={alwaysUseStealth}
            onValueChange={handleStealthToggle}
          />
          <ToggleRow
            label="Auto-shield incoming"
            description="Shield funds received on a stealth address as they arrive"
            value={autoShieldEnabled}
            onValueChange={(v) => {
              setAutoShieldEnabled(v);
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            }}
          />
          <SettingsRow
            label="Auto-scan"
            value={getAutoScanLabel()}
            leftIcon="refresh-outline"
            onPress={handleAutoScanSelect}
          />
        </SettingsSection>

        {/* ── Transactions ── */}
        <SettingsSection title="Transactions">
          <ToggleRow
            label="Hide amounts"
            description="Mask amounts in your local history"
            value={hideAmounts}
            onValueChange={handleHideAmountsToggle}
          />
          <ToggleRow
            label="Private by default"
            description="Start every send with the privacy options on"
            value={privateByDefault}
            onValueChange={handlePrivateDefaultToggle}
          />
        </SettingsSection>

        {/* ── Relay routing ── */}
        <SettingsSection title="Relay routing">
          <ToggleRow
            label="Route via the relayer"
            description="Keeps your IP and submission pattern away from RPC nodes. Costs a few seconds."
            value={relayerV3Enabled}
            onValueChange={(v) => {
              setRelayerV3Enabled(v);
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            }}
          />
          <ToggleRow
            label="Fail closed"
            description="If the relayer fails, abort instead of submitting directly — a direct fallback would expose your IP."
            value={relayerStrictMode}
            onValueChange={(v) => {
              setRelayerStrictMode(v);
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            }}
          />
        </SettingsSection>
      </ScrollView>
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
  note: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.md,
    marginTop: Spacing.lg,
    marginHorizontal: Spacing.xl,
    padding: Spacing.lg,
    borderRadius: BorderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSoft,
    backgroundColor: Colors.surfaceSecondary,
  },
  noteText: {
    flex: 1,
    color: Colors.textSecondary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    lineHeight: 19,
  },
});

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { useRouter } from 'expo-router';
import { p01Alert } from '@/stores/alertStore';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { SettingsRow, RadioOption, ToggleRow } from '../../../components/settings';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import {
  PRIVACY_LEVELS,
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

export default function PrivacySettingsScreen() {
  const t = useT();
  const router = useRouter();

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
        <Text style={styles.headerTitle}>{t('settings.privacy')}</Text>
        <View style={{ width: 40 }} />
      </Animated.View>

      <ScrollView
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 120 }}
      >
        {/* DEFAULT PRIVACY LEVEL */}
        <SectionTitle title="DEFAULT PRIVACY LEVEL" delay={80} />
        <GlassCard delay={100}>
          <RadioOption
            label={t('privateSend.standard')}
            description="1 decoy transaction"
            selected={privacyLevel === 'standard'}
            onSelect={() => handlePrivacyLevelChange('standard')}
          />
          <GlassDivider />
          <RadioOption
            label={t('privateSend.enhanced')}
            description="5 decoy transactions"
            selected={privacyLevel === 'enhanced'}
            onSelect={() => handlePrivacyLevelChange('enhanced')}
          />
          <GlassDivider />
          <RadioOption
            label={t('privateSend.maximum')}
            description="10 decoy transactions"
            selected={privacyLevel === 'maximum'}
            onSelect={() => handlePrivacyLevelChange('maximum')}
          />
        </GlassCard>

        {/* Privacy Level Info */}
        <Animated.View entering={FadeInDown.delay(170).duration(350)} style={styles.privacyInfoOuter}>
          <BlurView intensity={14} tint="dark" style={styles.glassBlur}>
            <LinearGradient
              colors={['rgba(57, 197, 187, 0.06)', 'rgba(255, 119, 168, 0.03)', 'transparent']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />
            <View style={styles.privacyInfoContent}>
              <View style={styles.privacyInfoHeader}>
                <Ionicons name="shield-checkmark" size={18} color={P01Colors.cyan} />
                <Text style={styles.privacyInfoTitle}>
                  {privacyLevel === 'standard' ? 'Basic Privacy' :
                   privacyLevel === 'enhanced' ? 'Enhanced Privacy' : 'Maximum Privacy'}
                </Text>
              </View>
              <Text style={styles.privacyInfoDesc}>
                {privacyLevel === 'standard'
                  ? 'Minimal privacy protection with lower fees. Best for small transactions.'
                  : privacyLevel === 'enhanced'
                  ? 'Balanced privacy and cost. Recommended for most users.'
                  : 'Maximum anonymity with highest decoy count. Higher fees apply.'}
              </Text>
              <View style={styles.privacyInfoFeatures}>
                <Text style={styles.privacyInfoFeaturesLabel}>Features:</Text>
                <Text style={styles.privacyInfoFeaturesText}>
                  {getPrivacyLevelDescription(privacyLevel)}
                </Text>
                <Text style={styles.privacyInfoFee}>
                  Est. extra fee: ~{calculateDecoyFees(privacyLevel, 1).totalFees.toFixed(6)} SOL per transaction
                </Text>
              </View>
            </View>
          </BlurView>
        </Animated.View>

        {/* STEALTH ADDRESSES */}
        <SectionTitle title="STEALTH ADDRESSES" delay={220} />
        <GlassCard delay={240}>
          <ToggleRow
            label="Always use stealth"
            description={t('privacy.zeroWalletFootprint')}
            value={alwaysUseStealth}
            onValueChange={handleStealthToggle}
          />
          <GlassDivider />
          <ToggleRow
            label="Auto-shield incoming"
            description="Automatically shield funds received on stealth addresses"
            value={autoShieldEnabled}
            onValueChange={(v) => {
              setAutoShieldEnabled(v);
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            }}
          />
          <GlassDivider />
          <SettingsRow
            label="Auto-scan"
            value={getAutoScanLabel()}
            leftIcon="refresh-outline"
            onPress={handleAutoScanSelect}
          />
        </GlassCard>

        {/* TRANSACTIONS */}
        <SectionTitle title="TRANSACTIONS" delay={290} />
        <GlassCard delay={310}>
          <ToggleRow
            label="Hide amounts"
            description="Mask transaction amounts in history"
            value={hideAmounts}
            onValueChange={handleHideAmountsToggle}
          />
          <GlassDivider />
          <ToggleRow
            label="Private by default"
            description="Enable privacy features on all sends"
            value={privateByDefault}
            onValueChange={handlePrivateDefaultToggle}
          />
        </GlassCard>

        {/* RELAY ROUTING */}
        <SectionTitle title="RELAY ROUTING" delay={320} />
        <GlassCard delay={335}>
          <ToggleRow
            label="Route via decentralized relayer"
            description="Hides your IP and submission patterns from RPC nodes. Adds a few seconds of latency."
            value={relayerV3Enabled}
            onValueChange={(v) => {
              setRelayerV3Enabled(v);
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            }}
          />
          <GlassDivider />
          <ToggleRow
            label="Strict mode (fail closed)"
            description="If the relayer fails, the transaction is aborted instead of falling back to direct submission (which would expose your IP). Recommended for maximum privacy."
            value={relayerStrictMode}
            onValueChange={(v) => {
              setRelayerStrictMode(v);
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            }}
          />
        </GlassCard>

        {/* How Decoys Work */}
        <Animated.View entering={FadeInDown.delay(430).duration(350)} style={styles.infoOuter}>
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
              <View style={{ marginLeft: Spacing.md, flex: 1 }}>
                <Text style={styles.infoTitle}>How Decoy Transactions Work</Text>
                <Text style={styles.infoText}>
                  Decoys are small self-transfers sent before your real transaction to confuse chain analysis.
                  They create noise on the blockchain, making it harder to identify your actual payment.
                </Text>
              </View>
            </View>
          </BlurView>
        </Animated.View>

        {/* Warning */}
        <Animated.View entering={FadeInDown.delay(500).duration(350)} style={styles.warningOuter}>
          <BlurView intensity={14} tint="dark" style={styles.warningBlur}>
            <LinearGradient
              colors={['rgba(255, 204, 0, 0.06)', 'rgba(255, 204, 0, 0.02)', 'transparent']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />
            <View style={styles.warningContent}>
              <Ionicons name="warning" size={20} color="#eab308" />
              <Text style={styles.warningText}>
                Higher privacy levels send more decoy transactions, resulting in additional network fees (~0.000005 SOL each).
                Decoys are self-transfers and do not reduce your balance beyond fees.
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

  /* Privacy Level Info Card */
  privacyInfoOuter: {
    marginHorizontal: Spacing.lg,
    marginTop: Spacing.md,
    borderRadius: BorderRadius.xl,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.07)',
  },
  privacyInfoContent: {
    padding: Spacing.lg,
  },
  privacyInfoHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Spacing.sm,
  },
  privacyInfoTitle: {
    color: P01Colors.cyan,
    fontSize: 14,
    fontFamily: FontFamily.semibold,
    marginLeft: Spacing.sm,
  },
  privacyInfoDesc: {
    color: Colors.textSecondary,
    fontSize: 14,
    marginBottom: Spacing.sm,
    lineHeight: 20,
  },
  privacyInfoFeatures: {
    backgroundColor: 'rgba(12, 12, 14, 0.4)',
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginTop: Spacing.sm,
  },
  privacyInfoFeaturesLabel: {
    color: Colors.textTertiary,
    fontSize: 12,
    marginBottom: 4,
  },
  privacyInfoFeaturesText: {
    color: Colors.text,
    fontSize: 14,
  },
  privacyInfoFee: {
    color: Colors.textTertiary,
    fontSize: 12,
    marginTop: Spacing.sm,
  },

  /* Info Card (How Decoys Work) */
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
  infoTitle: {
    color: P01Colors.cyan,
    fontSize: 14,
    fontFamily: FontFamily.medium,
    marginBottom: 4,
  },
  infoText: {
    color: Colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },

  /* Warning Card */
  warningOuter: {
    marginHorizontal: Spacing.lg,
    marginTop: Spacing.md,
    borderRadius: BorderRadius.xl,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255, 204, 0, 0.12)',
  },
  warningBlur: {
    backgroundColor: 'rgba(12, 12, 14, 0.65)',
  },
  warningContent: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: Spacing.lg,
  },
  warningText: {
    color: '#eab308',
    fontSize: 14,
    marginLeft: Spacing.md,
    flex: 1,
    lineHeight: 20,
  },
});

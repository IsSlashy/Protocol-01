import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { useRouter } from 'expo-router';
import { p01Alert } from '@/stores/alertStore';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';

import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import { getCluster, getConnection, setCluster } from '../../../services/solana/connection';
import { useT } from '@/i18n';

type NetworkType = 'mainnet-beta' | 'devnet' | 'testnet';

const STORAGE_KEYS = {
  NETWORK: 'settings_network',
  CUSTOM_RPC: 'settings_custom_rpc',
};

/* ──────────────────────── Glass Card ──────────────────────── */

interface GlassCardProps {
  children: React.ReactNode;
  delay?: number;
  style?: object;
}

const GlassCard: React.FC<GlassCardProps> = ({ children, delay = 0, style }) => (
  <Animated.View entering={FadeInDown.delay(delay).duration(350)} style={[styles.glassOuter, style]}>
    <View style={styles.glassBlur}>
      {children}
    </View>
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

/* ──────────────────────── Glass Divider ──────────────────────── */

const GlassDivider: React.FC = () => (
  <View style={styles.divider} />
);

/* ──────────────────────── Network Radio Row ──────────────────────── */

interface NetworkRadioProps {
  label: string;
  description: string;
  selected: boolean;
  color: string;
  onSelect: () => void;
}

const NetworkRadio: React.FC<NetworkRadioProps> = ({ label, description, selected, color, onSelect }) => (
  <TouchableOpacity
    style={styles.radioRow}
    onPress={onSelect}
    activeOpacity={0.7}
    accessibilityRole="radio"
    accessibilityState={{ selected }}
    accessibilityLabel={`${label}: ${description}`}
  >
    <View style={styles.radioLeft}>
      <View style={[styles.networkDot, { backgroundColor: color }]} />
      <View style={{ flex: 1 }}>
        <Text style={styles.radioLabel}>{label}</Text>
        <Text style={styles.radioDescription}>{description}</Text>
      </View>
    </View>
    <View style={[styles.radioCircle, selected && styles.radioCircleSelected]}>
      {selected && <View style={styles.radioCircleInner} />}
    </View>
  </TouchableOpacity>
);

/* ──────────────────────── Screen ──────────────────────── */

export default function NetworkSettingsScreen() {
  const t = useT();
  const router = useRouter();

  const [selectedNetwork, setSelectedNetwork] = useState<NetworkType>(getCluster());
  const [customRpcUrl, setCustomRpcUrl] = useState('');
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<'success' | 'error' | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const [network, customRpc] = await Promise.all([
        AsyncStorage.getItem(STORAGE_KEYS.NETWORK),
        AsyncStorage.getItem(STORAGE_KEYS.CUSTOM_RPC),
      ]);

      if (network) setSelectedNetwork(network as NetworkType);
      if (customRpc) setCustomRpcUrl(customRpc);
    } catch (error) {
      console.error('Failed to load network settings:', error);
    }
  };

  const handleNetworkSelect = async (network: NetworkType) => {
    setSelectedNetwork(network);
    setTestResult(null);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestResult(null);

    try {
      const connection = getConnection();
      // Try to get the latest blockhash as a connection test
      await connection.getLatestBlockhash('confirmed');
      setTestResult('success');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      console.error('Connection test failed:', error);
      setTestResult('error');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setIsTesting(false);
    }
  };

  const handleSaveNetwork = async () => {
    setIsSaving(true);

    try {
      // Save and apply the network selection
      await setCluster(selectedNetwork);

      // Force full app reload to cleanly switch networks
      // This is the only reliable way: reset connection, caches, and re-initialize
      console.log('[Network] Switching to', selectedNetwork, '— restarting app');
      const { resetConnection } = require('../../../services/solana/connection');
      resetConnection();

      // Clear ALL balance caches so stale data never appears
      const { useWalletStore } = require('../../../stores/walletStore');
      const pk = useWalletStore.getState().publicKey;
      if (pk) {
        const AsyncStorage = require('@react-native-async-storage/async-storage').default;
        await Promise.all([
          AsyncStorage.removeItem(`p01_balance_cache_devnet_${pk}`),
          AsyncStorage.removeItem(`p01_balance_cache_mainnet-beta_${pk}`),
          AsyncStorage.removeItem(`p01_balance_cache_testnet_${pk}`),
          AsyncStorage.removeItem(`p01_tx_cache_${pk}`),
        ]).catch(() => {});
      }

      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      const label = selectedNetwork === 'mainnet-beta' ? 'Mainnet' :
                    selectedNetwork === 'devnet' ? 'Devnet' : 'Testnet';

      // Reset wallet state and re-initialize with new network
      useWalletStore.setState({
        balance: { sol: 0, tokens: [], totalUsd: 0 },
        transactions: [],
        initialized: false,
      });

      p01Alert(
        t('settings.network'),
        `Switched to ${label}.`,
        [
          {
            text: t('common.ok'),
            onPress: () => {
              // Re-initialize wallet with new network
              useWalletStore.getState().initialize();
              router.replace('/(main)/(wallet)');
            },
          },
        ]
      );
    } catch (error) {
      console.error('Failed to save network:', error);
      p01Alert(t('common.error'), t('alerts.errorGeneric'));
    } finally {
      setIsSaving(false);
    }
  };

  const getNetworkColor = (network?: NetworkType) => {
    switch (network || selectedNetwork) {
      case 'mainnet-beta':
        return '#22c55e';
      case 'devnet':
        return '#eab308';
      case 'testnet':
        return '#3b82f6';
      default:
        return '#888';
    }
  };

  const getNetworkLabel = () => {
    switch (selectedNetwork) {
      case 'mainnet-beta':
        return 'Mainnet-Beta';
      case 'devnet':
        return 'Devnet';
      case 'testnet':
        return 'Testnet';
    }
  };

  const getNetworkDescription = () => {
    switch (selectedNetwork) {
      case 'mainnet-beta':
        return 'Production Solana network. All transactions use real SOL.';
      case 'devnet':
        return 'Development network. Get free test SOL from the faucet.';
      case 'testnet':
        return 'Testnet for experimental features. May be unstable.';
    }
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
        <Text style={styles.headerTitle}>{t('settings.network')}</Text>
        <View style={{ width: 40 }} />
      </Animated.View>

      <ScrollView
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 200 }}
      >
        {/* SELECT NETWORK */}
        <SectionTitle title="SELECT NETWORK" delay={80} />
        <GlassCard delay={100}>
          <NetworkRadio
            label={t('settings.mainnet')}
            description="Production network (real funds)"
            selected={selectedNetwork === 'mainnet-beta'}
            color="#22c55e"
            onSelect={() => handleNetworkSelect('mainnet-beta')}
          />
          <GlassDivider />
          <NetworkRadio
            label={t('settings.devnet')}
            description="Development network (test tokens)"
            selected={selectedNetwork === 'devnet'}
            color="#eab308"
            onSelect={() => handleNetworkSelect('devnet')}
          />
          <GlassDivider />
          <NetworkRadio
            label="Testnet"
            description={t('common.experimental')}
            selected={selectedNetwork === 'testnet'}
            color="#3b82f6"
            onSelect={() => handleNetworkSelect('testnet')}
          />
        </GlassCard>

        {/* Network Status */}
        <SectionTitle title="STATUS" delay={160} />
        <GlassCard delay={180}>
          <View style={styles.statusRow}>
            <View style={[styles.statusDot, { backgroundColor: getNetworkColor() }]} />
            <Text style={styles.statusLabel}>{getNetworkLabel()}</Text>
          </View>
          <Text style={styles.statusDescription}>{getNetworkDescription()}</Text>
        </GlassCard>

        {/* Test Connection */}
        <Animated.View entering={FadeInDown.delay(240).duration(350)} style={styles.testSection}>
          <TouchableOpacity
            style={styles.testButton}
            onPress={handleTestConnection}
            disabled={isTesting}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Test network connection"
          >
            <View style={styles.testButtonBlur}>
              {isTesting ? (
                <ActivityIndicator color={P01Colors.cyan} />
              ) : (
                <View style={styles.testButtonContent}>
                  <Ionicons name="pulse-outline" size={20} color={P01Colors.cyan} />
                  <Text style={styles.testButtonText}>Test Connection</Text>
                </View>
              )}
            </View>
          </TouchableOpacity>

          {/* Test Result */}
          {testResult && (
            <Animated.View
              entering={FadeInUp.duration(250)}
              style={[
                styles.testResultContainer,
                testResult === 'success' ? styles.testResultSuccess : styles.testResultError,
              ]}
            >
              <Ionicons
                name={testResult === 'success' ? 'checkmark-circle' : 'close-circle'}
                size={20}
                color={testResult === 'success' ? P01Colors.cyan : '#ef4444'}
              />
              <Text
                style={[
                  styles.testResultText,
                  { color: testResult === 'success' ? P01Colors.cyan : '#ef4444' },
                ]}
              >
                {testResult === 'success'
                  ? t('common.success')
                  : t('common.failed')}
              </Text>
            </Animated.View>
          )}
        </Animated.View>

        {/* Warning for Mainnet */}
        {selectedNetwork === 'mainnet-beta' && (
          <Animated.View entering={FadeInDown.duration(300)} style={styles.alertOuter}>
            <View style={styles.glassBlur}>
              <View style={styles.alertContent}>
                <Ionicons name="warning" size={20} color="#eab308" />
                <Text style={styles.alertTextYellow}>
                  You are connecting to Mainnet. All transactions will use real SOL and tokens. Make sure you understand the risks.
                </Text>
              </View>
            </View>
          </Animated.View>
        )}

        {/* Info for Devnet */}
        {selectedNetwork === 'devnet' && (
          <Animated.View entering={FadeInDown.duration(300)} style={styles.alertOuter}>
            <View style={styles.glassBlur}>
              <View style={styles.alertContent}>
                <Ionicons name="information-circle" size={20} color={P01Colors.cyan} />
                <Text style={styles.alertTextMuted}>
                  Devnet tokens have no real value. You can get free test SOL using the airdrop button on the wallet screen.
                </Text>
              </View>
            </View>
          </Animated.View>
        )}

        {/* Info for Testnet */}
        {selectedNetwork === 'testnet' && (
          <Animated.View entering={FadeInDown.duration(300)} style={styles.alertOuter}>
            <View style={styles.glassBlur}>
              <View style={styles.alertContent}>
                <Ionicons name="flask-outline" size={20} color="#3b82f6" />
                <Text style={styles.alertTextBlue}>
                  Testnet is used for experimental features and may experience downtime or resets. Not recommended for regular use.
                </Text>
              </View>
            </View>
          </Animated.View>
        )}
      </ScrollView>

      {/* Save Button — fixed above tab bar */}
      <Animated.View entering={FadeInUp.delay(300).duration(350)} style={styles.saveWrapper}>
        <TouchableOpacity
          style={styles.saveButton}
          onPress={handleSaveNetwork}
          disabled={isSaving}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel="Save network settings"
        >
          {isSaving ? (
            <ActivityIndicator color="#0a0a0a" />
          ) : (
            <Text style={styles.saveButtonText}>{t('common.save')}</Text>
          )}
        </TouchableOpacity>
      </Animated.View>
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
    backgroundColor: '#0f0f12',
    alignItems: 'center',
    justifyContent: 'center',
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
  },
  glassBlur: {
    backgroundColor: '#0f0f12',
  },

  /* Divider */
  divider: {
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    marginHorizontal: Spacing.lg,
  },

  /* Network Radio Row */
  radioRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.lg,
    paddingHorizontal: Spacing.lg,
  },
  radioLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  networkDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: Spacing.md,
  },
  radioLabel: {
    color: Colors.text,
    fontSize: 16,
    fontFamily: FontFamily.medium,
  },
  radioDescription: {
    color: Colors.textSecondary,
    fontSize: 13,
    marginTop: 2,
  },
  radioCircle: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: 'rgba(255, 255, 255, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: Spacing.md,
  },
  radioCircleSelected: {
    borderColor: P01Colors.cyan,
  },
  radioCircleInner: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: P01Colors.cyan,
  },

  /* Status Card */
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: Spacing.lg,
    paddingHorizontal: Spacing.lg,
  },
  statusDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginRight: Spacing.md,
  },
  statusLabel: {
    color: Colors.text,
    fontSize: 16,
    fontFamily: FontFamily.medium,
  },
  statusDescription: {
    color: Colors.textSecondary,
    fontSize: 14,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.lg,
  },

  /* Test Connection */
  testSection: {
    marginHorizontal: Spacing.lg,
    marginTop: Spacing.lg,
  },
  testButton: {
    borderRadius: BorderRadius.xl,
    overflow: 'hidden',
  },
  testButtonBlur: {
    backgroundColor: '#0f0f12',
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  testButtonContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  testButtonText: {
    color: P01Colors.cyan,
    fontSize: 15,
    fontFamily: FontFamily.semibold,
    marginLeft: Spacing.sm,
  },
  testResultContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: Spacing.md,
    padding: Spacing.md,
    borderRadius: BorderRadius.lg,
  },
  testResultSuccess: {
    backgroundColor: 'rgba(57, 197, 187, 0.08)',
  },
  testResultError: {
    backgroundColor: 'rgba(239, 68, 68, 0.08)',
  },
  testResultText: {
    fontSize: 14,
    fontFamily: FontFamily.medium,
    marginLeft: Spacing.sm,
  },

  /* Alert Cards */
  alertOuter: {
    marginHorizontal: Spacing.lg,
    marginTop: Spacing.lg,
    borderRadius: BorderRadius.xl,
    overflow: 'hidden',
  },
  alertContent: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: Spacing.lg,
  },
  alertTextYellow: {
    color: '#eab308',
    fontSize: 14,
    marginLeft: Spacing.md,
    flex: 1,
    lineHeight: 20,
  },
  alertTextMuted: {
    color: Colors.textSecondary,
    fontSize: 14,
    marginLeft: Spacing.md,
    flex: 1,
    lineHeight: 20,
  },
  alertTextBlue: {
    color: '#60a5fa',
    fontSize: 14,
    marginLeft: Spacing.md,
    flex: 1,
    lineHeight: 20,
  },

  /* Save Button */
  saveWrapper: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: Spacing.lg,
    paddingBottom: 140,
    paddingTop: Spacing.lg,
  },
  saveButton: {
    paddingVertical: 16,
    borderRadius: BorderRadius.xl,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: P01Colors.cyan,
    shadowColor: P01Colors.cyan,
    shadowOpacity: 0.3,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  saveButtonText: {
    color: '#09090b',
    fontFamily: FontFamily.semibold,
    fontSize: 16,
  },
});

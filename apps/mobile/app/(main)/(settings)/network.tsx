/**
 * Network — which cluster this wallet talks to.
 *
 * 🎯 REBUILT ON THE REALIGNED THEME AND THE SHARED KIT 2026-08-23.
 *
 * ⛔ THE THREE COLOURED DOTS ARE GONE. Each network row carried a dot in its
 * own hue — `#22c55e` green, `#eab308` yellow, `#3b82f6` blue — three colours
 * from outside the palette, in a system that has one accent and reserves amber
 * for caution. They also carried no information the radio to their right did
 * not already carry, and the green one was actively misleading: it read as
 * "safe" on the network where the money is real.
 *
 * 🚨 CAUTION IS NOW WHERE THE CAUTION IS. Amber marks Mainnet, because Mainnet
 * is the choice that spends real SOL. Devnet and Testnet are stated plainly.
 *
 * ⛔ THE STATUS CARD IS GONE. It restated the selected row's own label and
 * description directly underneath it — the same two sentences, twice, on a
 * screen with four rows.
 *
 * ⚠️ ONE PRIMARY ACTION: Save. "Test connection" is secondary and stays in the
 * scroll; the save bar is pinned above the tab bar with real insets rather than
 * the hardcoded `paddingBottom: 140` that used to guess at it.
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
import { Button } from '@/components/ui';
import { RadioOption, SettingsSection } from '../../../components/settings';
import { Colors, FontFamily, FontSize, BorderRadius, Spacing, Layout } from '@/constants/theme';
import { getCluster, getConnection, setCluster } from '../../../services/solana/connection';
import { useT } from '@/i18n';

type NetworkType = 'mainnet-beta' | 'devnet' | 'testnet';

const STORAGE_KEYS = {
  NETWORK: 'settings_network',
  CUSTOM_RPC: 'settings_custom_rpc',
};

export default function NetworkSettingsScreen() {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();

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

  return (
    <View style={styles.screen}>
      <Header title={t('settings.network')} showBack onBackPress={() => router.back()} />

      <ScrollView
        style={styles.flex}
        showsVerticalScrollIndicator={false}
        // Clears the pinned save bar: its own height plus the tab bar it sits above.
        contentContainerStyle={{
          paddingBottom: Layout.tabBarTotalHeight + insets.bottom + 96,
        }}
      >
        <SettingsSection style={styles.firstSection}>
          <RadioOption
            label={t('settings.mainnet')}
            description="Real funds. Every transaction spends real SOL."
            selected={selectedNetwork === 'mainnet-beta'}
            onSelect={() => handleNetworkSelect('mainnet-beta')}
          />
          <RadioOption
            label={t('settings.devnet')}
            description="Test tokens with no value. Free SOL from the faucet."
            selected={selectedNetwork === 'devnet'}
            onSelect={() => handleNetworkSelect('devnet')}
          />
          <RadioOption
            label="Testnet"
            description="Experimental. Resets and downtime are expected."
            selected={selectedNetwork === 'testnet'}
            onSelect={() => handleNetworkSelect('testnet')}
          />
        </SettingsSection>

        {/* Amber is caution, and this is the only choice here that can cost
            anything. Stated once, next to the choice that causes it. */}
        {selectedNetwork === 'mainnet-beta' ? (
          <View style={[styles.notice, styles.noticeWarn]}>
            <Ionicons name="warning-outline" size={18} color={Colors.yellow} />
            <Text style={[styles.noticeText, styles.noticeTextWarn]}>
              Switching to Mainnet puts real funds behind every action in this app.
            </Text>
          </View>
        ) : null}

        <View style={styles.testWrap}>
          <Button
            variant="secondary"
            fullWidth
            loading={isTesting}
            onPress={handleTestConnection}
            accessibilityLabel="Test network connection"
            icon={<Ionicons name="pulse-outline" size={18} color={Colors.text} />}
          >
            Test connection
          </Button>

          {testResult ? (
            <View style={styles.testResult} accessibilityRole="alert">
              <Ionicons
                name={testResult === 'success' ? 'checkmark-circle-outline' : 'close-circle-outline'}
                size={18}
                color={testResult === 'success' ? Colors.primary : Colors.error}
              />
              <Text
                style={[
                  styles.testResultText,
                  { color: testResult === 'success' ? Colors.primary : Colors.error },
                ]}
              >
                {testResult === 'success'
                  ? `Reached ${selectedNetwork === 'mainnet-beta' ? 'Mainnet' : selectedNetwork === 'devnet' ? 'Devnet' : 'Testnet'}.`
                  : t('common.failed')}
              </Text>
            </View>
          ) : null}
        </View>
      </ScrollView>

      {/* The one primary action, pinned so it never scrolls out of reach. */}
      <View
        style={[
          styles.saveBar,
          { paddingBottom: Layout.tabBarTotalHeight + insets.bottom + Spacing.md },
        ]}
      >
        <Button
          fullWidth
          size="lg"
          loading={isSaving}
          onPress={handleSaveNetwork}
          accessibilityLabel="Save network settings"
        >
          {t('common.save')}
        </Button>
      </View>
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

  notice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.md,
    marginTop: Spacing.lg,
    marginHorizontal: Spacing.xl,
    padding: Spacing.lg,
    borderRadius: BorderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  noticeWarn: {
    backgroundColor: Colors.warningDim,
    borderColor: Colors.yellow,
  },
  noticeText: {
    flex: 1,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    lineHeight: 19,
  },
  noticeTextWarn: {
    color: Colors.yellow,
  },

  testWrap: {
    marginTop: Spacing['2xl'],
    paddingHorizontal: Spacing.xl,
    gap: Spacing.md,
  },
  testResult: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  testResultText: {
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
  },

  saveBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.md,
    backgroundColor: Colors.background,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.borderSoft,
  },
});

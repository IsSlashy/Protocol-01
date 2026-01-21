import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { SettingsSection, SettingsRow, CurrencyModal } from '../../../components/settings';
import { useWalletStore } from '../../../stores/walletStore';
import { useSettingsStore, Currency, CURRENCY_SYMBOLS } from '../../../stores/settingsStore';
import { getCluster } from '../../../services/solana/connection';

export default function SettingsScreen() {
  const router = useRouter();
  const { publicKey, logout, hasWallet } = useWalletStore();
  const { currency, setCurrency, initialize: initSettings } = useSettingsStore();
  const [copied, setCopied] = useState(false);
  const [currencyModalVisible, setCurrencyModalVisible] = useState(false);

  useEffect(() => {
    initSettings();
  }, []);

  const walletAddress = publicKey || '';
  const truncatedAddress = walletAddress
    ? `${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}`
    : 'No wallet';

  const currentNetwork = getCluster();
  const networkDisplay = currentNetwork === 'mainnet-beta' ? 'Mainnet' :
                         currentNetwork === 'devnet' ? 'Devnet' : 'Testnet';

  const handleCopyAddress = async () => {
    if (!walletAddress) return;
    await Clipboard.setStringAsync(walletAddress);
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCurrencySelect = () => {
    setCurrencyModalVisible(true);
  };

  const handleNotifications = () => {
    Alert.alert(
      'Notifications',
      'Notification settings are not yet available.',
      [{ text: 'OK' }]
    );
  };

  const handleDeleteWallet = () => {
    Alert.alert(
      'Delete Wallet',
      'Are you sure you want to delete your wallet? This action cannot be undone. Make sure you have backed up your seed phrase!',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            Alert.alert(
              'Final Confirmation',
              'This will permanently delete your wallet from this device. You will need your seed phrase to recover it.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Delete Permanently',
                  style: 'destructive',
                  onPress: async () => {
                    try {
                      await logout();
                      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
                      router.replace('/');
                    } catch (error) {
                      Alert.alert('Error', 'Failed to delete wallet. Please try again.');
                    }
                  },
                },
              ]
            );
          },
        },
      ]
    );
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
        <Text className="text-white text-lg font-semibold">Settings</Text>
        <View className="w-10" />
      </View>

      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 40 }}
      >
        {/* WALLET */}
        <SettingsSection title="Wallet">
          <TouchableOpacity
            className="flex-row items-center justify-between py-4 px-4"
            onPress={handleCopyAddress}
            activeOpacity={0.7}
          >
            <View className="flex-row items-center flex-1">
              <View className="w-10 h-10 rounded-xl bg-p01-cyan/20 items-center justify-center mr-3">
                <Ionicons name="wallet-outline" size={20} color="#39c5bb" />
              </View>
              <View className="flex-1">
                <Text className="text-white text-base font-medium">Account</Text>
                <Text className="text-p01-gray text-sm mt-0.5">
                  {walletAddress ? truncatedAddress : 'No wallet connected'}
                </Text>
              </View>
            </View>
            <View className="flex-row items-center">
              {copied ? (
                <View className="flex-row items-center">
                  <Ionicons name="checkmark" size={16} color="#39c5bb" />
                  <Text className="text-p01-cyan text-xs ml-1">Copied!</Text>
                </View>
              ) : (
                <Ionicons name="copy-outline" size={18} color="#666" />
              )}
            </View>
          </TouchableOpacity>
        </SettingsSection>

        {/* SECURITY */}
        <SettingsSection title="Security">
          <SettingsRow
            label="Security Settings"
            leftIcon="shield-outline"
            onPress={() => router.push('/(main)/(settings)/security')}
          />
          <View className="h-px bg-p01-border mx-4" />
          <SettingsRow
            label="Backup & Recovery"
            leftIcon="key-outline"
            onPress={() => router.push('/(main)/(settings)/backup')}
          />
        </SettingsSection>

        {/* PRIVACY */}
        <SettingsSection title="Privacy">
          <SettingsRow
            label="Privacy Settings"
            leftIcon="eye-off-outline"
            onPress={() => router.push('/(main)/(settings)/privacy')}
          />
        </SettingsSection>

        {/* NETWORK */}
        <SettingsSection title="Network">
          <SettingsRow
            label="Network"
            value={networkDisplay}
            leftIcon="globe-outline"
            onPress={() => router.push('/(main)/(settings)/network')}
          />
          <View className="h-px bg-p01-border mx-4" />
          <SettingsRow
            label="RPC"
            value="Solana"
            leftIcon="server-outline"
            onPress={() => router.push('/(main)/(settings)/network')}
          />
        </SettingsSection>

        {/* PREFERENCES */}
        <SettingsSection title="Preferences">
          <SettingsRow
            label="Currency"
            value={currency}
            leftIcon="cash-outline"
            onPress={handleCurrencySelect}
          />
          <View className="h-px bg-p01-border mx-4" />
          <SettingsRow
            label="Notifications"
            leftIcon="notifications-outline"
            onPress={handleNotifications}
          />
        </SettingsSection>

        {/* ABOUT */}
        <SettingsSection title="About">
          <SettingsRow
            label="About P-01"
            value="v1.0.0"
            leftIcon="information-circle-outline"
            onPress={() => router.push('/(main)/(settings)/about')}
          />
        </SettingsSection>

        {/* DEVELOPER */}
        <SettingsSection title="Developer">
          <SettingsRow
            label="Privacy Tech Test"
            value="Devnet"
            leftIcon="flask-outline"
            onPress={() => router.push('/(main)/(settings)/privacy-test')}
          />
        </SettingsSection>

        {/* Danger Zone */}
        <View className="mt-4 mx-4">
          <TouchableOpacity
            className="py-4 items-center bg-red-500/10 rounded-xl border border-red-500/20"
            onPress={handleDeleteWallet}
            activeOpacity={0.7}
          >
            <View className="flex-row items-center">
              <Ionicons name="trash-outline" size={18} color="#ef4444" />
              <Text className="text-red-500 text-base font-medium ml-2">
                Delete Wallet
              </Text>
            </View>
          </TouchableOpacity>
        </View>

        {/* Version Footer */}
        <View className="items-center mt-8">
          <Text className="text-p01-gray/50 text-xs">
            Protocol 01 v1.0.0
          </Text>
          <Text className="text-p01-gray/30 text-xs mt-1">
            Built on Solana
          </Text>
        </View>
      </ScrollView>

      {/* Currency Selection Modal */}
      <CurrencyModal
        visible={currencyModalVisible}
        currentCurrency={currency}
        onSelect={setCurrency}
        onClose={() => setCurrencyModalVisible(false)}
      />
    </SafeAreaView>
  );
}

import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import * as LocalAuthentication from 'expo-local-authentication';
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
  const [showAdvanced, setShowAdvanced] = useState(false);

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

  const handleDisconnect = () => {
    Alert.alert(
      'Déconnexion',
      'Voulez-vous vous déconnecter ? Vous devrez vous authentifier pour accéder à votre wallet.',
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Déconnecter',
          onPress: async () => {
            await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            router.replace('/(auth)/lock');
          },
        },
      ]
    );
  };

  const handleDeleteWallet = async () => {
    // Require biometric authentication first
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const isEnrolled = await LocalAuthentication.isEnrolledAsync();

    if (hasHardware && isEnrolled) {
      const authResult = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Authentifiez-vous pour supprimer le wallet',
        cancelLabel: 'Annuler',
        disableDeviceFallback: false,
      });

      if (!authResult.success) {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }
    }

    Alert.alert(
      '⚠️ Supprimer le Wallet',
      'ATTENTION: Cette action est IRRÉVERSIBLE!\n\nVotre wallet sera définitivement supprimé de cet appareil. Assurez-vous d\'avoir sauvegardé votre phrase de récupération!',
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Je comprends, supprimer',
          style: 'destructive',
          onPress: () => {
            Alert.alert(
              '🔴 Confirmation Finale',
              'Tapez "SUPPRIMER" pour confirmer la suppression définitive de votre wallet.',
              [
                { text: 'Annuler', style: 'cancel' },
                {
                  text: 'Supprimer Définitivement',
                  style: 'destructive',
                  onPress: async () => {
                    try {
                      await logout();
                      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
                      router.replace('/');
                    } catch (error) {
                      Alert.alert('Erreur', 'Échec de la suppression. Veuillez réessayer.');
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

        {/* Session */}
        <View className="mt-4 mx-4">
          <TouchableOpacity
            className="py-4 items-center bg-p01-surface rounded-xl border border-p01-border"
            onPress={handleDisconnect}
            activeOpacity={0.7}
          >
            <View className="flex-row items-center">
              <Ionicons name="log-out-outline" size={18} color="#39c5bb" />
              <Text className="text-p01-cyan text-base font-medium ml-2">
                Déconnexion
              </Text>
            </View>
          </TouchableOpacity>
        </View>

        {/* Advanced Section - Hidden by default */}
        <View className="mt-6 mx-4">
          <TouchableOpacity
            className="flex-row items-center justify-center py-3"
            onPress={() => setShowAdvanced(!showAdvanced)}
            activeOpacity={0.7}
          >
            <Text className="text-p01-gray/50 text-xs mr-2">
              {showAdvanced ? 'Masquer les options avancées' : 'Options avancées'}
            </Text>
            <Ionicons
              name={showAdvanced ? 'chevron-up' : 'chevron-down'}
              size={14}
              color="#666"
            />
          </TouchableOpacity>
        </View>

        {/* Danger Zone - Only visible when advanced is shown */}
        {showAdvanced && (
          <View className="mt-2 mx-4">
            <View className="bg-red-500/5 rounded-xl p-4 border border-red-500/10">
              <Text className="text-red-400/70 text-xs text-center mb-3">
                ⚠️ Zone Dangereuse - Actions irréversibles
              </Text>
              <TouchableOpacity
                className="py-3 items-center bg-red-500/10 rounded-lg border border-red-500/20"
                onPress={handleDeleteWallet}
                activeOpacity={0.7}
              >
                <View className="flex-row items-center">
                  <Ionicons name="trash-outline" size={16} color="#ef4444" />
                  <Text className="text-red-500 text-sm font-medium ml-2">
                    Supprimer le Wallet
                  </Text>
                </View>
              </TouchableOpacity>
            </View>
          </View>
        )}

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

import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, TouchableOpacity, TextInput, ActivityIndicator, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import { SettingsSection, RadioOption } from '../../../components/settings';
import { getCluster, getConnection, resetConnection, setCluster } from '../../../services/solana/connection';

type NetworkType = 'mainnet-beta' | 'devnet' | 'testnet';

const STORAGE_KEYS = {
  NETWORK: 'settings_network',
  CUSTOM_RPC: 'settings_custom_rpc',
};

export default function NetworkSettingsScreen() {
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

      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      Alert.alert(
        'Network Updated',
        `Switched to ${selectedNetwork === 'mainnet-beta' ? 'Mainnet' :
                       selectedNetwork === 'devnet' ? 'Devnet' : 'Testnet'}. ` +
        'Please restart the app to fully apply the changes.',
        [
          {
            text: 'OK',
            onPress: () => router.back(),
          },
        ]
      );
    } catch (error) {
      console.error('Failed to save network:', error);
      Alert.alert('Error', 'Failed to save network settings. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const getNetworkColor = () => {
    switch (selectedNetwork) {
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
        <Text className="text-white text-lg font-semibold">Network Settings</Text>
        <View className="w-10" />
      </View>

      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 40 }}
      >
        {/* SELECT NETWORK */}
        <SettingsSection title="Select Network">
          <RadioOption
            label="Mainnet"
            description="Production network (real funds)"
            selected={selectedNetwork === 'mainnet-beta'}
            onSelect={() => handleNetworkSelect('mainnet-beta')}
          />
          <View className="h-px bg-p01-border mx-4" />
          <RadioOption
            label="Devnet"
            description="Development network (test tokens)"
            selected={selectedNetwork === 'devnet'}
            onSelect={() => handleNetworkSelect('devnet')}
          />
          <View className="h-px bg-p01-border mx-4" />
          <RadioOption
            label="Testnet"
            description="Test network (experimental)"
            selected={selectedNetwork === 'testnet'}
            onSelect={() => handleNetworkSelect('testnet')}
          />
        </SettingsSection>

        {/* Network Status */}
        <View className="mx-4 mb-6 p-4 bg-p01-surface rounded-2xl border border-p01-border">
          <View className="flex-row items-center">
            <View
              className="w-3 h-3 rounded-full mr-3"
              style={{ backgroundColor: getNetworkColor() }}
            />
            <Text className="text-white text-base font-medium">
              {selectedNetwork === 'mainnet-beta' ? 'Mainnet-Beta' :
               selectedNetwork === 'devnet' ? 'Devnet' : 'Testnet'}
            </Text>
          </View>
          <Text style={{ color: '#9ca3af', fontSize: 14, marginTop: 8 }}>
            {selectedNetwork === 'mainnet-beta'
              ? 'Production Solana network. All transactions use real SOL.'
              : selectedNetwork === 'devnet'
              ? 'Development network. Get free test SOL from the faucet.'
              : 'Testnet for experimental features. May be unstable.'}
          </Text>
        </View>

        {/* Test Connection */}
        <View className="mx-4 mb-6">
          <TouchableOpacity
            className="py-3 rounded-xl items-center flex-row justify-center"
            style={{ backgroundColor: 'rgba(255, 255, 255, 0.1)' }}
            onPress={handleTestConnection}
            disabled={isTesting}
            activeOpacity={0.7}
          >
            {isTesting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <>
                <Ionicons name="pulse-outline" size={20} color="#fff" />
                <Text className="text-white font-semibold ml-2">Test Connection</Text>
              </>
            )}
          </TouchableOpacity>

          {/* Test Result */}
          {testResult && (
            <View className={`flex-row items-center mt-3 p-3 rounded-xl ${
              testResult === 'success' ? 'bg-green-500/10' : 'bg-red-500/10'
            }`}>
              <Ionicons
                name={testResult === 'success' ? 'checkmark-circle' : 'close-circle'}
                size={20}
                color={testResult === 'success' ? '#22c55e' : '#ef4444'}
              />
              <Text className={`ml-2 text-sm ${
                testResult === 'success' ? 'text-green-500' : 'text-red-500'
              }`}>
                {testResult === 'success'
                  ? 'Connection successful!'
                  : 'Connection failed. Try again later.'}
              </Text>
            </View>
          )}
        </View>

        {/* Warning for Mainnet */}
        {selectedNetwork === 'mainnet-beta' && (
          <View className="mx-4 mt-2 p-4 bg-yellow-500/10 rounded-2xl border border-yellow-500/30">
            <View className="flex-row items-start">
              <Ionicons name="warning" size={20} color="#eab308" />
              <Text style={{ color: '#eab308', fontSize: 14, marginLeft: 12, flex: 1 }}>
                You are connecting to Mainnet. All transactions will use real SOL and tokens. Make sure you understand the risks.
              </Text>
            </View>
          </View>
        )}

        {/* Info for Devnet */}
        {selectedNetwork === 'devnet' && (
          <View className="mx-4 mt-2 p-4 bg-p01-surface rounded-2xl border border-p01-border">
            <View className="flex-row items-start">
              <Ionicons name="information-circle" size={20} color="#06b6d4" />
              <Text style={{ color: '#9ca3af', fontSize: 14, marginLeft: 12, flex: 1 }}>
                Devnet tokens have no real value. You can get free test SOL using the airdrop button on the wallet screen.
              </Text>
            </View>
          </View>
        )}

        {/* Info for Testnet */}
        {selectedNetwork === 'testnet' && (
          <View className="mx-4 mt-2 p-4 bg-blue-500/10 rounded-2xl border border-blue-500/30">
            <View className="flex-row items-start">
              <Ionicons name="flask-outline" size={20} color="#3b82f6" />
              <Text style={{ color: '#60a5fa', fontSize: 14, marginLeft: 12, flex: 1 }}>
                Testnet is used for experimental features and may experience downtime or resets. Not recommended for regular use.
              </Text>
            </View>
          </View>
        )}
      </ScrollView>

      {/* Save Button */}
      <View className="px-4 pb-4">
        <TouchableOpacity
          className="py-4 rounded-xl items-center flex-row justify-center"
          style={{
            backgroundColor: '#39c5bb',
            shadowColor: '#39c5bb',
            shadowOpacity: 0.3,
            shadowRadius: 10,
            shadowOffset: { width: 0, height: 4 },
          }}
          onPress={handleSaveNetwork}
          disabled={isSaving}
          activeOpacity={0.8}
        >
          {isSaving ? (
            <ActivityIndicator color="#0a0a0a" />
          ) : (
            <Text style={{ color: '#09090b', fontWeight: '600', fontSize: 16 }}>
              Save Network Settings
            </Text>
          )}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

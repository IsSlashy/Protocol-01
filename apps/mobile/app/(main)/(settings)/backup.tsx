import React, { useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Alert, Modal } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import * as LocalAuthentication from 'expo-local-authentication';
import { SettingsSection } from '../../../components/settings';
import { useWalletStore } from '../../../stores/walletStore';

export default function BackupRecoveryScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { getBackupMnemonic } = useWalletStore();

  const [isBackedUp, setIsBackedUp] = useState(false);
  const [showSeedModal, setShowSeedModal] = useState(false);
  const [seedPhrase, setSeedPhrase] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  const handleShowSeedPhrase = async () => {
    try {
      // Check if biometrics is available
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const isEnrolled = await LocalAuthentication.isEnrolledAsync();

      if (hasHardware && isEnrolled) {
        const result = await LocalAuthentication.authenticateAsync({
          promptMessage: 'Authenticate to view seed phrase',
          fallbackLabel: 'Use PIN',
        });

        if (!result.success) {
          return;
        }
      }

      // Get the mnemonic
      const mnemonic = await getBackupMnemonic();
      if (mnemonic) {
        setSeedPhrase(mnemonic.split(' '));
        setShowSeedModal(true);
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      } else {
        Alert.alert('Error', 'Could not retrieve seed phrase. Please try again.');
      }
    } catch (error) {
      console.error('Auth error:', error);
      Alert.alert('Authentication Failed', 'Please try again.');
    }
  };

  const handleCopySeed = async () => {
    if (seedPhrase.length === 0) return;
    await Clipboard.setStringAsync(seedPhrase.join(' '));
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleConfirmBackup = () => {
    setShowSeedModal(false);
    setIsBackedUp(true);
    setSeedPhrase([]);
    Alert.alert(
      'Backup Confirmed',
      'Great! Make sure you store your seed phrase in a secure location.',
      [{ text: 'OK' }]
    );
  };

  const handleExportBackup = () => {
    Alert.alert(
      'Export Encrypted Backup',
      'This feature is coming soon. For now, please use your seed phrase to back up your wallet.',
      [{ text: 'OK' }]
    );
  };

  const handleImportBackup = () => {
    Alert.alert(
      'Import Backup',
      'To restore your wallet, please use the "Import Wallet" option from the welcome screen.',
      [{ text: 'OK' }]
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
        <Text className="text-white text-lg font-semibold">Backup & Recovery</Text>
        <View className="w-10" />
      </View>

      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 40 }}
      >
        {/* Warning Card */}
        <View className="mx-4 mb-6 p-4 bg-red-500/10 rounded-2xl border border-red-500/30">
          <View className="flex-row items-start">
            <View className="w-10 h-10 rounded-full bg-red-500/20 items-center justify-center">
              <Ionicons name="warning" size={24} color="#ef4444" />
            </View>
            <View className="flex-1 ml-3">
              <Text className="text-red-400 text-base font-semibold mb-1">
                Important: Back Up Your Wallet
              </Text>
              <Text className="text-red-300/80 text-sm leading-5">
                If you lose access to your device and haven't backed up your seed phrase, you will permanently lose access to your funds. Make sure you have securely stored your backup.
              </Text>
            </View>
          </View>
        </View>

        {/* Backup Status */}
        <View className="mx-4 mb-6 p-4 bg-p01-surface rounded-2xl">
          <View className="flex-row items-center">
            <View className={`w-12 h-12 rounded-full items-center justify-center ${
              isBackedUp ? 'bg-green-500/20' : 'bg-yellow-500/20'
            }`}>
              <Ionicons
                name={isBackedUp ? 'shield-checkmark' : 'shield-outline'}
                size={24}
                color={isBackedUp ? '#22c55e' : '#eab308'}
              />
            </View>
            <View className="flex-1 ml-4">
              <Text className="text-white text-base font-semibold">
                {isBackedUp ? 'Wallet Backed Up' : 'Backup Recommended'}
              </Text>
              <Text className="text-p01-text-secondary text-sm mt-1">
                {isBackedUp
                  ? 'Your wallet is securely backed up'
                  : 'Create a backup to protect your funds'}
              </Text>
            </View>
          </View>
        </View>

        {/* SEED PHRASE */}
        <SettingsSection title="Seed Phrase">
          <TouchableOpacity
            className="flex-row items-center justify-between py-4 px-4"
            onPress={handleShowSeedPhrase}
            activeOpacity={0.7}
          >
            <View className="flex-row items-center flex-1">
              <View className="w-10 h-10 rounded-xl bg-p01-cyan/20 items-center justify-center mr-3">
                <Ionicons name="key" size={20} color="#39c5bb" />
              </View>
              <View className="flex-1">
                <Text className="text-white text-base font-medium">Show Seed Phrase</Text>
                <Text className="text-p01-text-secondary text-sm mt-0.5">
                  View your 12-word recovery phrase
                </Text>
              </View>
            </View>
            <Ionicons name="lock-closed" size={18} color="#666" />
          </TouchableOpacity>
        </SettingsSection>

        {/* Warning about seed phrase */}
        <View className="mx-4 mb-6 p-3 bg-yellow-500/10 rounded-xl border border-yellow-500/20">
          <View className="flex-row items-center">
            <Ionicons name="eye-off" size={16} color="#eab308" />
            <Text className="text-yellow-500 text-xs ml-2 flex-1">
              Never share your seed phrase. Anyone with it can access your funds.
            </Text>
          </View>
        </View>

        {/* BACKUP OPTIONS */}
        <SettingsSection title="Backup Options">
          <TouchableOpacity
            className="flex-row items-center justify-between py-4 px-4"
            onPress={handleExportBackup}
            activeOpacity={0.7}
          >
            <View className="flex-row items-center flex-1">
              <View className="w-10 h-10 rounded-xl bg-blue-500/20 items-center justify-center mr-3">
                <Ionicons name="download-outline" size={20} color="#3b82f6" />
              </View>
              <View className="flex-1">
                <Text className="text-white text-base font-medium">Export Encrypted Backup</Text>
                <Text className="text-p01-text-secondary text-sm mt-0.5">
                  Save password-protected backup file
                </Text>
              </View>
            </View>
            <Ionicons name="chevron-forward" size={20} color="#666" />
          </TouchableOpacity>
          <View className="h-px bg-p01-border mx-4" />
          <TouchableOpacity
            className="flex-row items-center justify-between py-4 px-4"
            onPress={handleImportBackup}
            activeOpacity={0.7}
          >
            <View className="flex-row items-center flex-1">
              <View className="w-10 h-10 rounded-xl bg-p01-pink/20 items-center justify-center mr-3">
                <Ionicons name="push-outline" size={20} color="#ff77a8" />
              </View>
              <View className="flex-1">
                <Text className="text-white text-base font-medium">Import Backup</Text>
                <Text className="text-p01-text-secondary text-sm mt-0.5">
                  Restore from encrypted backup file
                </Text>
              </View>
            </View>
            <Ionicons name="chevron-forward" size={20} color="#666" />
          </TouchableOpacity>
        </SettingsSection>

        {/* Info Card */}
        <View className="mx-4 mt-2 p-4 bg-p01-surface rounded-2xl border border-p01-border">
          <View className="flex-row items-start">
            <Ionicons name="information-circle" size={20} color="#39c5bb" />
            <Text className="text-p01-text-secondary text-sm ml-3 flex-1 leading-5">
              Your seed phrase is the only way to recover your wallet. Store it securely offline, never screenshot it, and never share it with anyone.
            </Text>
          </View>
        </View>
      </ScrollView>

      {/* Seed Phrase Modal */}
      <Modal
        visible={showSeedModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => {
          setShowSeedModal(false);
          setSeedPhrase([]);
        }}
      >
        <View className="flex-1 bg-p01-void" style={{ paddingTop: insets.top }}>
          {/* Modal Header */}
          <View className="flex-row items-center justify-between px-4 py-4">
            <TouchableOpacity
              onPress={() => {
                setShowSeedModal(false);
                setSeedPhrase([]);
              }}
              className="w-10 h-10 rounded-full bg-p01-surface items-center justify-center"
            >
              <Ionicons name="close" size={20} color="#fff" />
            </TouchableOpacity>
            <Text className="text-white text-lg font-semibold">Seed Phrase</Text>
            <View className="w-10" />
          </View>

          <ScrollView className="flex-1 px-4">
            {/* Warning */}
            <View className="mb-6 p-4 bg-red-500/10 rounded-2xl border border-red-500/30">
              <View className="flex-row items-center">
                <Ionicons name="warning" size={20} color="#ef4444" />
                <Text className="text-red-400 text-sm ml-2 flex-1">
                  Do not share this phrase with anyone. Anyone with access to it can steal your funds.
                </Text>
              </View>
            </View>

            {/* Seed Words Grid */}
            <View className="bg-p01-surface rounded-2xl p-4 mb-6">
              <View className="flex-row flex-wrap">
                {seedPhrase.map((word, index) => (
                  <View
                    key={index}
                    className="w-1/3 p-2"
                  >
                    <View className="bg-p01-void rounded-xl py-3 px-3 flex-row items-center">
                      <Text className="text-p01-text-secondary text-xs w-5">{index + 1}.</Text>
                      <Text className="text-white font-mono text-sm flex-1">{word}</Text>
                    </View>
                  </View>
                ))}
              </View>
            </View>

            {/* Copy Button */}
            <TouchableOpacity
              className="py-4 rounded-xl items-center mb-4"
              style={{ backgroundColor: 'rgba(255, 255, 255, 0.1)' }}
              onPress={handleCopySeed}
              activeOpacity={0.7}
            >
              <View className="flex-row items-center">
                <Ionicons
                  name={copied ? 'checkmark' : 'copy-outline'}
                  size={18}
                  color={copied ? '#39c5bb' : '#fff'}
                />
                <Text className={`font-semibold ml-2 ${copied ? 'text-p01-cyan' : 'text-white'}`}>
                  {copied ? 'Copied!' : 'Copy to Clipboard'}
                </Text>
              </View>
            </TouchableOpacity>

            {/* I've Backed Up Button */}
            <TouchableOpacity
              className="bg-p01-cyan py-4 rounded-xl items-center"
              onPress={handleConfirmBackup}
              activeOpacity={0.8}
              style={{
                shadowColor: '#39c5bb',
                shadowOpacity: 0.3,
                shadowRadius: 10,
                shadowOffset: { width: 0, height: 4 },
              }}
            >
              <Text className="text-p01-void font-semibold text-base">
                I've Saved My Seed Phrase
              </Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

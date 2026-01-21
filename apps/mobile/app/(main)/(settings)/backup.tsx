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

const COLORS = {
  background: '#09090b',
  surface: '#18181b',
  border: '#3f3f46',
  text: '#ffffff',
  textSecondary: '#9ca3af',
  textMuted: '#6b7280',
  cyan: '#06b6d4',
  red: '#ef4444',
  yellow: '#eab308',
  green: '#22c55e',
  blue: '#3b82f6',
  pink: '#ff77a8',
};

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
    <SafeAreaView style={{ flex: 1, backgroundColor: COLORS.background }}>
      {/* Header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 16 }}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: COLORS.surface, alignItems: 'center', justifyContent: 'center' }}
        >
          <Ionicons name="arrow-back" size={20} color={COLORS.text} />
        </TouchableOpacity>
        <Text style={{ color: COLORS.text, fontSize: 18, fontWeight: '600' }}>Backup & Recovery</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 40 }}
      >
        {/* Warning Card */}
        <View style={{ marginHorizontal: 16, marginBottom: 24, padding: 16, backgroundColor: 'rgba(239, 68, 68, 0.1)', borderRadius: 16, borderWidth: 1, borderColor: 'rgba(239, 68, 68, 0.3)' }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
            <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(239, 68, 68, 0.2)', alignItems: 'center', justifyContent: 'center' }}>
              <Ionicons name="warning" size={24} color={COLORS.red} />
            </View>
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={{ color: '#f87171', fontSize: 16, fontWeight: '600', marginBottom: 4 }}>
                Important: Back Up Your Wallet
              </Text>
              <Text style={{ color: 'rgba(252, 165, 165, 0.8)', fontSize: 14, lineHeight: 20 }}>
                If you lose access to your device and haven't backed up your seed phrase, you will permanently lose access to your funds.
              </Text>
            </View>
          </View>
        </View>

        {/* Backup Status */}
        <View style={{ marginHorizontal: 16, marginBottom: 24, padding: 16, backgroundColor: COLORS.surface, borderRadius: 16 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: isBackedUp ? 'rgba(34, 197, 94, 0.2)' : 'rgba(234, 179, 8, 0.2)' }}>
              <Ionicons
                name={isBackedUp ? 'shield-checkmark' : 'shield-outline'}
                size={24}
                color={isBackedUp ? COLORS.green : COLORS.yellow}
              />
            </View>
            <View style={{ flex: 1, marginLeft: 16 }}>
              <Text style={{ color: COLORS.text, fontSize: 16, fontWeight: '600' }}>
                {isBackedUp ? 'Wallet Backed Up' : 'Backup Recommended'}
              </Text>
              <Text style={{ color: COLORS.textSecondary, fontSize: 14, marginTop: 4 }}>
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
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 16, paddingHorizontal: 16 }}
            onPress={handleShowSeedPhrase}
            activeOpacity={0.7}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
              <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: 'rgba(6, 182, 212, 0.2)', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                <Ionicons name="key" size={20} color={COLORS.cyan} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: COLORS.text, fontSize: 16, fontWeight: '500' }}>Show Seed Phrase</Text>
                <Text style={{ color: COLORS.textSecondary, fontSize: 14, marginTop: 2 }}>
                  View your 12-word recovery phrase
                </Text>
              </View>
            </View>
            <Ionicons name="lock-closed" size={18} color={COLORS.textMuted} />
          </TouchableOpacity>
        </SettingsSection>

        {/* Warning about seed phrase */}
        <View style={{ marginHorizontal: 16, marginBottom: 24, padding: 12, backgroundColor: 'rgba(234, 179, 8, 0.1)', borderRadius: 12, borderWidth: 1, borderColor: 'rgba(234, 179, 8, 0.2)' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Ionicons name="eye-off" size={16} color={COLORS.yellow} />
            <Text style={{ color: COLORS.yellow, fontSize: 12, marginLeft: 8, flex: 1 }}>
              Never share your seed phrase. Anyone with it can access your funds.
            </Text>
          </View>
        </View>

        {/* BACKUP OPTIONS */}
        <SettingsSection title="Backup Options">
          <TouchableOpacity
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 16, paddingHorizontal: 16 }}
            onPress={handleExportBackup}
            activeOpacity={0.7}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
              <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: 'rgba(59, 130, 246, 0.2)', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                <Ionicons name="download-outline" size={20} color={COLORS.blue} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: COLORS.text, fontSize: 16, fontWeight: '500' }}>Export Encrypted Backup</Text>
                <Text style={{ color: COLORS.textSecondary, fontSize: 14, marginTop: 2 }}>
                  Save password-protected backup file
                </Text>
              </View>
            </View>
            <Ionicons name="chevron-forward" size={20} color={COLORS.textMuted} />
          </TouchableOpacity>
          <View style={{ height: 1, backgroundColor: COLORS.border, marginHorizontal: 16 }} />
          <TouchableOpacity
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 16, paddingHorizontal: 16 }}
            onPress={handleImportBackup}
            activeOpacity={0.7}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
              <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: 'rgba(255, 119, 168, 0.2)', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                <Ionicons name="push-outline" size={20} color={COLORS.pink} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: COLORS.text, fontSize: 16, fontWeight: '500' }}>Import Backup</Text>
                <Text style={{ color: COLORS.textSecondary, fontSize: 14, marginTop: 2 }}>
                  Restore from encrypted backup file
                </Text>
              </View>
            </View>
            <Ionicons name="chevron-forward" size={20} color={COLORS.textMuted} />
          </TouchableOpacity>
        </SettingsSection>

        {/* Info Card */}
        <View style={{ marginHorizontal: 16, marginTop: 8, padding: 16, backgroundColor: COLORS.surface, borderRadius: 16, borderWidth: 1, borderColor: COLORS.border }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
            <Ionicons name="information-circle" size={20} color={COLORS.cyan} />
            <Text style={{ color: COLORS.textSecondary, fontSize: 14, marginLeft: 12, flex: 1, lineHeight: 20 }}>
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
        <View style={{ flex: 1, backgroundColor: COLORS.background, paddingTop: insets.top }}>
          {/* Modal Header */}
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 16 }}>
            <TouchableOpacity
              onPress={() => {
                setShowSeedModal(false);
                setSeedPhrase([]);
              }}
              style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: COLORS.surface, alignItems: 'center', justifyContent: 'center' }}
            >
              <Ionicons name="close" size={20} color={COLORS.text} />
            </TouchableOpacity>
            <Text style={{ color: COLORS.text, fontSize: 18, fontWeight: '600' }}>Seed Phrase</Text>
            <View style={{ width: 40 }} />
          </View>

          <ScrollView style={{ flex: 1, paddingHorizontal: 16 }}>
            {/* Warning */}
            <View style={{ marginBottom: 24, padding: 16, backgroundColor: 'rgba(239, 68, 68, 0.1)', borderRadius: 16, borderWidth: 1, borderColor: 'rgba(239, 68, 68, 0.3)' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Ionicons name="warning" size={20} color={COLORS.red} />
                <Text style={{ color: '#f87171', fontSize: 14, marginLeft: 8, flex: 1 }}>
                  Do not share this phrase with anyone. Anyone with access to it can steal your funds.
                </Text>
              </View>
            </View>

            {/* Seed Words Grid */}
            <View style={{ backgroundColor: COLORS.surface, borderRadius: 16, padding: 16, marginBottom: 24 }}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                {seedPhrase.map((word, index) => (
                  <View key={index} style={{ width: '33.33%', padding: 8 }}>
                    <View style={{ backgroundColor: COLORS.background, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center' }}>
                      <Text style={{ color: COLORS.textSecondary, fontSize: 12, width: 20 }}>{index + 1}.</Text>
                      <Text style={{ color: COLORS.text, fontFamily: 'monospace', fontSize: 14, flex: 1 }}>{word}</Text>
                    </View>
                  </View>
                ))}
              </View>
            </View>

            {/* Copy Button */}
            <TouchableOpacity
              style={{ paddingVertical: 16, borderRadius: 12, alignItems: 'center', marginBottom: 16, backgroundColor: 'rgba(255, 255, 255, 0.1)' }}
              onPress={handleCopySeed}
              activeOpacity={0.7}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Ionicons
                  name={copied ? 'checkmark' : 'copy-outline'}
                  size={18}
                  color={copied ? COLORS.cyan : COLORS.text}
                />
                <Text style={{ fontWeight: '600', marginLeft: 8, color: copied ? COLORS.cyan : COLORS.text }}>
                  {copied ? 'Copied!' : 'Copy to Clipboard'}
                </Text>
              </View>
            </TouchableOpacity>

            {/* I've Backed Up Button */}
            <TouchableOpacity
              style={{
                backgroundColor: COLORS.cyan,
                paddingVertical: 16,
                borderRadius: 12,
                alignItems: 'center',
                shadowColor: COLORS.cyan,
                shadowOpacity: 0.3,
                shadowRadius: 10,
                shadowOffset: { width: 0, height: 4 },
              }}
              onPress={handleConfirmBackup}
              activeOpacity={0.8}
            >
              <Text style={{ color: COLORS.background, fontWeight: '600', fontSize: 16 }}>
                I've Saved My Seed Phrase
              </Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

import React, { useState } from 'react';
import { TouchableOpacity, ActivityIndicator, Alert, Platform, Linking, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import { P01Colors } from '@/constants/theme';
import { isDevnet } from '@/services/solana/connection';

interface DevnetAirdropFABProps {
  publicKey: string | null;
  requestAirdrop: (amount: number) => Promise<void>;
  refreshBalance: () => void;
}

export default function DevnetAirdropFAB({ publicKey, requestAirdrop, refreshBalance }: DevnetAirdropFABProps) {
  const [loading, setLoading] = useState(false);

  if (!isDevnet()) return null;

  const openFaucet = async () => {
    if (publicKey) {
      await Clipboard.setStringAsync(publicKey);
      if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    Linking.openURL('https://faucet.solana.com/');
  };

  const handlePress = async () => {
    if (loading) return;
    setLoading(true);
    try {
      if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await requestAirdrop(1);
      if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Airdrop Successful!', 'You received 1 SOL.', [{ text: 'OK', onPress: refreshBalance }]);
    } catch (err: any) {
      if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      const isRateLimited = err?.message === 'RATE_LIMITED' || err?.message?.includes('429') || err?.message?.includes('limit');
      if (isRateLimited) {
        Alert.alert('Faucet Rate Limited', 'Tap "Open Faucet" to get SOL from the official website.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Faucet', onPress: openFaucet },
        ]);
      } else {
        Alert.alert('Airdrop Failed', err?.message || 'Unknown error', [
          { text: 'OK' },
          { text: 'Try Faucet', onPress: openFaucet },
        ]);
      }
    } finally { setLoading(false); }
  };

  return (
    <TouchableOpacity style={[styles.fab, loading && { opacity: 0.7 }]} onPress={handlePress} disabled={loading}>
      {loading ? (
        <ActivityIndicator size="small" color="#000" />
      ) : (
        <Ionicons name="water" size={22} color="#000" />
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 150,
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: P01Colors.pink,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: P01Colors.pink,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 8,
  },
});

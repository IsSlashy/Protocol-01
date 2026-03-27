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
    <TouchableOpacity style={[styles.fab, loading && { opacity: 0.7 }]} onPress={handlePress} disabled={loading} accessibilityRole="button" accessibilityLabel="Request devnet airdrop" accessibilityHint="Requests 1 SOL from the devnet faucet" accessibilityState={{ disabled: loading, busy: loading }}>
      {loading ? (
        <ActivityIndicator size="small" color={P01Colors.pink} />
      ) : (
        <Ionicons name="water" size={14} color={P01Colors.pink} />
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  fab: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(255, 119, 168, 0.15)',
    justifyContent: 'center',
    alignItems: 'center',
  },
});

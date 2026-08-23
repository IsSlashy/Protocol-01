/**
 * DevnetAirdropFAB — top up a devnet wallet, on devnet only.
 *
 * 🎯 RESTYLED AND RENAMED IN THE INTERFACE, NOT IN THE CODE, 2026-08-23.
 *   - it was a 28pt pink disc with a water droplet in it and no visible label.
 *     28pt is under the 44pt floor, pink is retired, and an unlabelled droplet
 *     next to a balance is a guess. It is a labelled control now.
 *   - the label says "devnet" because that is the only place the control
 *     exists; a tester should not have to remember which network they are on to
 *     know what the button does.
 *
 * ⛔ The exported name and the props are unchanged: `index.tsx` imports this by
 * name, and the airdrop call, its retry behaviour and the faucet fallback are
 * business logic this pass does not touch.
 */

import React, { useState } from 'react';
import {
  TouchableOpacity,
  Text,
  ActivityIndicator,
  Alert,
  Platform,
  Linking,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';

import { Colors, FontFamily, FontSize, BorderRadius, Spacing } from '@/constants/theme';
import { isDevnet } from '@/services/solana/connection';

interface DevnetAirdropFABProps {
  publicKey: string | null;
  requestAirdrop: (amount: number) => Promise<void>;
  refreshBalance: () => void;
}

export default function DevnetAirdropFAB({
  publicKey,
  requestAirdrop,
  refreshBalance,
}: DevnetAirdropFABProps) {
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
    <TouchableOpacity
      style={[styles.button, loading && styles.busy]}
      onPress={handlePress}
      disabled={loading}
      accessibilityRole="button"
      accessibilityLabel="Request devnet airdrop"
      accessibilityHint="Requests 1 SOL from the devnet faucet"
      accessibilityState={{ disabled: loading, busy: loading }}
    >
      {loading ? (
        <ActivityIndicator size="small" color={Colors.textSecondary} />
      ) : (
        <Ionicons name="water-outline" size={15} color={Colors.textSecondary} />
      )}
      <Text style={styles.label}>Get devnet SOL</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    minHeight: 44,
    paddingHorizontal: Spacing.lg,
    borderRadius: BorderRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  busy: { opacity: 0.5 },
  label: {
    color: Colors.textSecondary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.medium,
  },
});

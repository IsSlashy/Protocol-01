import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { useSubscriptionVaultStore } from '@/stores/subscriptionVaultStore';
import { type VaultInfo } from '@/services/subscriptionVault';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';

export default function VaultDetailScreen() {
  const router = useRouter();
  const { vaultAddress } = useLocalSearchParams<{ vaultAddress: string }>();
  const { refreshVault, pauseNormalAction, resumeNormalAction, cancelNormalAction, isLoading } =
    useSubscriptionVaultStore();

  const [vaultInfo, setVaultInfo] = useState<VaultInfo | null>(null);

  useEffect(() => {
    const load = async () => {
      if (vaultAddress) {
        const info = await refreshVault(vaultAddress);
        setVaultInfo(info);
      }
    };
    load();
  }, [vaultAddress, refreshVault]);

  const handlePause = async () => {
    if (!vaultAddress) return;
    try {
      await pauseNormalAction(vaultAddress);
      Alert.alert('Success', 'Subscription paused');
      const info = await refreshVault(vaultAddress);
      setVaultInfo(info);
    } catch (err) {
      Alert.alert('Error', (err as Error).message);
    }
  };

  const handleResume = async () => {
    if (!vaultAddress) return;
    try {
      await resumeNormalAction(vaultAddress);
      Alert.alert('Success', 'Subscription resumed');
      const info = await refreshVault(vaultAddress);
      setVaultInfo(info);
    } catch (err) {
      Alert.alert('Error', (err as Error).message);
    }
  };

  const handleCancel = async () => {
    if (!vaultAddress || !vaultInfo) return;
    Alert.alert(
      'Cancel Subscription',
      'This will refund the remaining balance and close the vault.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Confirm',
          style: 'destructive',
          onPress: async () => {
            try {
              await cancelNormalAction(vaultAddress, vaultInfo.retailer);
              Alert.alert('Success', 'Subscription cancelled');
              router.back();
            } catch (err) {
              Alert.alert('Error', (err as Error).message);
            }
          },
        },
      ]
    );
  };

  if (!vaultInfo) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={22} color={Colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Vault Detail</Text>
          <View style={{ width: 40 }} />
        </View>
        <Text style={styles.loadingText}>Loading...</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={22} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Vault Detail</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        <View style={styles.detailCard}>
          <Text style={styles.detailLabel}>Status</Text>
          <Text style={styles.detailValue}>
            {!vaultInfo.isActive ? 'Cancelled' : vaultInfo.isPaused ? 'Paused' : 'Active'}
          </Text>
        </View>

        <View style={styles.detailCard}>
          <Text style={styles.detailLabel}>Retailer</Text>
          <Text style={styles.detailValue}>{vaultInfo.retailer}</Text>
        </View>

        <View style={styles.detailCard}>
          <Text style={styles.detailLabel}>Total Deposited</Text>
          <Text style={styles.detailValue}>
            {(Number(vaultInfo.totalDeposited) / 1e9).toFixed(3)} SOL
          </Text>
        </View>

        <View style={styles.detailCard}>
          <Text style={styles.detailLabel}>Rate</Text>
          <Text style={styles.detailValue}>
            {(Number(vaultInfo.rate) / 1e9).toFixed(3)} SOL per period
          </Text>
        </View>

        <View style={styles.detailCard}>
          <Text style={styles.detailLabel}>Claimed Periods</Text>
          <Text style={styles.detailValue}>{Number(vaultInfo.claimedPeriods)}</Text>
        </View>

        <View style={styles.actions}>
          {vaultInfo.isActive && !vaultInfo.isPaused && vaultInfo.isNormalMode && (
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: P01Colors.yellowDim }]}
              onPress={handlePause}
              disabled={isLoading}
            >
              <Text style={[styles.actionText, { color: P01Colors.yellow }]}>Pause</Text>
            </TouchableOpacity>
          )}

          {vaultInfo.isActive && vaultInfo.isPaused && vaultInfo.isNormalMode && (
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: P01Colors.cyanDim }]}
              onPress={handleResume}
              disabled={isLoading}
            >
              <Text style={[styles.actionText, { color: P01Colors.cyan }]}>Resume</Text>
            </TouchableOpacity>
          )}

          {vaultInfo.isActive && vaultInfo.isNormalMode && (
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: Colors.errorDim }]}
              onPress={handleCancel}
              disabled={isLoading}
            >
              <Text style={[styles.actionText, { color: Colors.error }]}>Cancel</Text>
            </TouchableOpacity>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
  },
  backBtn: {
    width: 40, height: 40, borderRadius: 9999,
    backgroundColor: Colors.surfaceSecondary,
    justifyContent: 'center', alignItems: 'center',
  },
  headerTitle: {
    color: Colors.text,
    fontSize: 20,
    fontFamily: FontFamily.bold,
  },
  scrollView: { flex: 1 },
  scrollContent: {
    paddingHorizontal: Spacing.xl,
    paddingBottom: 120,
  },
  loadingText: {
    fontSize: 14,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginTop: Spacing['3xl'],
  },
  detailCard: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    padding: Spacing.lg,
    marginBottom: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  detailLabel: {
    fontSize: 12,
    fontFamily: FontFamily.semibold,
    color: Colors.textTertiary,
    marginBottom: 4,
  },
  detailValue: {
    fontSize: 14,
    fontFamily: FontFamily.mono,
    color: Colors.text,
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginTop: Spacing.xl,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: Spacing.md,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
  },
  actionText: {
    fontSize: 14,
    fontFamily: FontFamily.bold,
  },
});

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';

import { useDenominatedPoolStore } from '@/stores/denominatedPoolStore';
import { useWalletStore } from '@/stores/walletStore';
import { useAuth } from '@/providers/PrivyProvider';
import {
  type PoolConfig,
  SOL_POOLS,
  USDC_POOLS,
} from '@/services/denominatedPool';
import { getConnection } from '@/services/solana/connection';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';

type TokenTab = 'SOL' | 'USDC';

export default function DenominatedShieldScreen() {
  const router = useRouter();
  const [tokenTab, setTokenTab] = useState<TokenTab>('SOL');
  const [walletBalance, setWalletBalance] = useState<number>(0);
  const [loadingBalance, setLoadingBalance] = useState(true);

  const {
    isLoading,
    error,
    progress,
    poolCache,
    shieldNote,
    refreshPoolInfo,
  } = useDenominatedPoolStore();

  const pools = tokenTab === 'SOL' ? SOL_POOLS : USDC_POOLS;
  const { publicKey: storePublicKey, initializeWithPrivy } = useWalletStore();
  const { walletAddress: privyWalletAddress } = useAuth();
  const walletPublicKey = privyWalletAddress || storePublicKey;

  // Ensure wallet store is synced with Privy address (same pattern as wallet screen)
  useEffect(() => {
    if (privyWalletAddress && !storePublicKey) {
      initializeWithPrivy(privyWalletAddress);
    }
  }, [privyWalletAddress, storePublicKey]);

  // Fetch wallet balance + pool info on mount
  const fetchBalance = useCallback(async () => {
    setLoadingBalance(true);
    try {
      if (walletPublicKey) {
        const connection = getConnection();
        const bal = await connection.getBalance(new PublicKey(walletPublicKey));
        console.log(`[DenomShield] Wallet balance: ${bal} lamports (${bal / LAMPORTS_PER_SOL} SOL)`);
        setWalletBalance(bal);
      } else {
        console.warn('[DenomShield] No wallet public key found');
      }
    } catch (err) {
      console.error('[DenomShield] Failed to fetch balance:', err);
    }
    setLoadingBalance(false);
  }, [walletPublicKey]);

  useEffect(() => {
    fetchBalance();
    refreshPoolInfo();
  }, [fetchBalance]);

  const handleShield = useCallback(async (pool: PoolConfig) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    // Refresh balance right before check (in case it's stale)
    let currentBalance = walletBalance;
    try {
      if (walletPublicKey) {
        const connection = getConnection();
        currentBalance = await connection.getBalance(new PublicKey(walletPublicKey));
        setWalletBalance(currentBalance);
      }
    } catch {}

    // Balance check
    const needed = Number(pool.denominationAtomic);
    console.log(`[DenomShield] Balance check: have=${currentBalance}, need=${needed + 50_000} (${pool.denomination} ${pool.token})`);
    if (pool.token === 'SOL' && currentBalance < needed + 50_000) {
      Alert.alert(
        'Insufficient SOL',
        `You need ${pool.denomination} SOL + fees. Current balance: ${(currentBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`,
      );
      return;
    }

    try {
      await shieldNote(pool);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert(
        'Shielded!',
        `${pool.denomination} ${pool.token} deposited into the privacy pool.\n\nYour note is saved locally. It will mature after ~1 epoch (~1 hour).`,
        [
          { text: 'View Notes', onPress: () => router.push('/(main)/(privacy)/denominated-notes' as any) },
          { text: 'OK' },
        ],
      );
      fetchBalance();
    } catch (err: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Shield Failed', err.message);
    }
  }, [walletBalance, walletPublicKey, shieldNote, router, fetchBalance]);

  const getPoolNoteCount = (pool: PoolConfig): number => {
    const cached = poolCache[pool.poolPDA.toBase58()];
    return cached?.info.noteCount ?? 0;
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={22} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Shield</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Wallet Balance */}
        <Animated.View entering={FadeInDown.delay(50)}>
          <View style={styles.balanceRow}>
            <Text style={styles.balanceLabel}>Wallet Balance</Text>
            <Text style={styles.balanceValue}>
              {loadingBalance ? '...' : `${(walletBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`}
            </Text>
          </View>
        </Animated.View>

        {/* Token Tabs */}
        <Animated.View entering={FadeInUp.delay(100)} style={styles.tabRow}>
          {(['SOL', 'USDC'] as TokenTab[]).map(tab => (
            <TouchableOpacity
              key={tab}
              style={[
                styles.tab,
                tokenTab === tab && styles.tabActive,
              ]}
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setTokenTab(tab);
              }}
            >
              <Text style={[
                styles.tabText,
                tokenTab === tab && styles.tabTextActive,
              ]}>
                {tab}
              </Text>
            </TouchableOpacity>
          ))}
        </Animated.View>

        {/* Explainer */}
        <Animated.View entering={FadeInUp.delay(150)}>
          <View style={styles.explainer}>
            <Ionicons name="shield-checkmark" size={16} color={P01Colors.cyan} />
            <Text style={styles.explainerText}>
              Select a denomination to deposit into the privacy pool. All deposits of the same size
              are indistinguishable — this is your anonymity set.
            </Text>
          </View>
        </Animated.View>

        {/* Pool Cards */}
        {pools.map((pool, i) => {
          const noteCount = getPoolNoteCount(pool);
          const anonymityLabel = noteCount === 0 ? 'Empty' :
            noteCount < 10 ? 'Low' :
            noteCount < 100 ? 'Medium' : 'High';
          const anonymityColor = noteCount === 0 ? Colors.textTertiary :
            noteCount < 10 ? P01Colors.yellow :
            noteCount < 100 ? P01Colors.cyan : P01Colors.green;

          return (
            <Animated.View key={pool.poolPDA.toBase58()} entering={FadeInUp.delay(200 + i * 80)}>
              <TouchableOpacity
                style={styles.poolCard}
                onPress={() => handleShield(pool)}
                disabled={isLoading}
                activeOpacity={0.7}
              >
                <LinearGradient
                  colors={[P01Colors.cyanDim, 'rgba(57, 197, 187, 0.02)']}
                  style={styles.poolCardGradient}
                >
                  <View style={styles.poolHeader}>
                    <View style={styles.poolDenomination}>
                      <Text style={styles.poolAmount}>{pool.denomination}</Text>
                      <Text style={styles.poolToken}>{pool.token}</Text>
                    </View>
                    <View style={styles.poolRight}>
                      <View style={[styles.anonymityBadge, { borderColor: anonymityColor }]}>
                        <View style={[styles.anonymityDot, { backgroundColor: anonymityColor }]} />
                        <Text style={[styles.anonymityText, { color: anonymityColor }]}>
                          {anonymityLabel}
                        </Text>
                      </View>
                      <Ionicons name="arrow-forward-circle" size={28} color={P01Colors.cyan} />
                    </View>
                  </View>

                  <View style={styles.poolStats}>
                    <View style={styles.poolStat}>
                      <Text style={styles.poolStatValue}>{noteCount}</Text>
                      <Text style={styles.poolStatLabel}>notes</Text>
                    </View>
                    <View style={styles.poolStatDivider} />
                    <View style={styles.poolStat}>
                      <Text style={styles.poolStatValue}>~1h</Text>
                      <Text style={styles.poolStatLabel}>delay</Text>
                    </View>
                    <View style={styles.poolStatDivider} />
                    <View style={styles.poolStat}>
                      <Text style={styles.poolStatValue}>Groth16</Text>
                      <Text style={styles.poolStatLabel}>proof</Text>
                    </View>
                  </View>
                </LinearGradient>
              </TouchableOpacity>
            </Animated.View>
          );
        })}

        {/* Loading overlay */}
        {isLoading && (
          <Animated.View entering={FadeInUp} style={styles.loadingOverlay}>
            <ActivityIndicator size="large" color={P01Colors.cyan} />
            <Text style={styles.loadingText}>{progress || 'Processing...'}</Text>
          </Animated.View>
        )}

        {/* Error */}
        {error && !isLoading && (
          <View style={styles.errorCard}>
            <Ionicons name="warning" size={18} color={Colors.error} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}
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
  balanceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    padding: Spacing.lg,
    marginBottom: Spacing.lg,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  balanceLabel: {
    fontSize: 14,
    fontFamily: FontFamily.medium,
    color: Colors.textSecondary,
  },
  balanceValue: {
    fontSize: 16,
    fontFamily: FontFamily.bold,
    color: Colors.text,
  },
  tabRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginBottom: Spacing.lg,
  },
  tab: {
    flex: 1,
    paddingVertical: Spacing.md,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
    backgroundColor: Colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  tabActive: {
    backgroundColor: P01Colors.cyanDim,
    borderColor: P01Colors.cyan,
  },
  tabText: {
    fontSize: 14,
    fontFamily: FontFamily.semibold,
    color: Colors.textSecondary,
  },
  tabTextActive: {
    color: P01Colors.cyan,
  },
  explainer: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.lg,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  explainerText: {
    flex: 1,
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    lineHeight: 18,
  },
  poolCard: {
    borderRadius: BorderRadius.lg,
    overflow: 'hidden',
    marginBottom: Spacing.md,
  },
  poolCardGradient: {
    borderRadius: BorderRadius.lg,
    padding: Spacing.lg,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  poolHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.md,
  },
  poolDenomination: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 6,
  },
  poolAmount: {
    fontSize: 28,
    fontFamily: FontFamily.bold,
    color: Colors.text,
  },
  poolToken: {
    fontSize: 16,
    fontFamily: FontFamily.medium,
    color: Colors.textSecondary,
  },
  poolRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  anonymityBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: BorderRadius.sm,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  anonymityDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  anonymityText: {
    fontSize: 11,
    fontFamily: FontFamily.mono,
  },
  poolStats: {
    flexDirection: 'row',
    backgroundColor: 'rgba(0,0,0,0.3)',
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
  },
  poolStat: {
    flex: 1,
    alignItems: 'center',
  },
  poolStatValue: {
    fontSize: 13,
    fontFamily: FontFamily.bold,
    color: Colors.text,
  },
  poolStatLabel: {
    fontSize: 11,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    marginTop: 2,
  },
  poolStatDivider: {
    width: 1,
    backgroundColor: Colors.border,
    marginHorizontal: 4,
  },
  loadingOverlay: {
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.xl,
  },
  loadingText: {
    fontSize: 14,
    fontFamily: FontFamily.medium,
    color: P01Colors.cyan,
  },
  errorCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: Colors.errorDim,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.error,
  },
  errorText: {
    flex: 1,
    fontSize: 13,
    fontFamily: FontFamily.regular,
    color: Colors.error,
  },
});

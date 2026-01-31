import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  StyleSheet,
  Platform,
  Alert,
  Linking,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import Animated, {
  FadeInDown,
  FadeInUp,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { useWalletStore } from '@/stores/walletStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useShieldedStore } from '@/stores/shieldedStore';
import { useSecuritySettings } from '@/hooks/useSecuritySettings';
import { useAuth } from '@/providers/PrivyProvider';
import { Colors, FontFamily, BorderRadius, Spacing, Shadows } from '@/constants/theme';

// P-01 Design System Colors - NO purple allowed
const P01 = {
  cyan: '#39c5bb',
  cyanDim: 'rgba(57, 197, 187, 0.15)',
  pink: '#ff77a8',
  pinkDim: 'rgba(255, 119, 168, 0.15)',
  blue: '#3b82f6',
  blueDim: 'rgba(59, 130, 246, 0.15)',
};
import { isDevnet } from '@/services/solana/connection';
import { formatTxDate } from '@/services/solana/transactions';
import { formatBalance } from '@/services/solana/balance';
import TokenIcon from '@/components/TokenIcon';

export default function WalletHomeScreen() {
  const router = useRouter();
  const { settings: securitySettings } = useSecuritySettings();
  const { formatAmount, initialize: initSettings } = useSettingsStore();
  const [balanceHidden, setBalanceHidden] = useState(false);

  // Get Privy auth state
  const { isAuthenticated, walletAddress: privyWalletAddress } = useAuth();

  const {
    initialized,
    loading,
    hasWallet: hasLocalWallet,
    publicKey: localPublicKey,
    balance,
    transactions,
    refreshing,
    error,
    formattedPublicKey: localFormattedPublicKey,
    refreshBalance,
    refreshTransactions,
    requestDevnetAirdrop,
    clearError,
    initializeWithPrivy,
  } = useWalletStore();

  // Use Privy wallet if available, otherwise local wallet
  const hasWallet = Boolean(privyWalletAddress || hasLocalWallet);
  const publicKey = privyWalletAddress || localPublicKey;
  const formattedPublicKey = publicKey
    ? `${publicKey.slice(0, 4)}...${publicKey.slice(-4)}`
    : localFormattedPublicKey;

  // Sync Privy wallet to store on mount
  useEffect(() => {
    if (privyWalletAddress && !hasLocalWallet) {
      initializeWithPrivy(privyWalletAddress);
    }
  }, [privyWalletAddress, hasLocalWallet, initializeWithPrivy]);

  // Compute formatted balance locally (Zustand getters don't trigger re-renders)
  const formattedSolBalance = balance ? formatBalance(balance.sol) : '0';

  const { shieldedBalance, isInitialized: shieldedInitialized } = useShieldedStore();

  // Initialize settings store
  useEffect(() => {
    initSettings();
  }, []);

  // Auto-refresh transactions when wallet screen is focused and empty
  // Wait for loading to complete to avoid race condition with cache loading
  useFocusEffect(
    useCallback(() => {
      if (initialized && !loading && hasWallet && transactions.length === 0) {
        // Only fetch if we're done loading AND still have no transactions
        // This gives the cache time to load first
        refreshTransactions();
      }
    }, [initialized, loading, hasWallet, transactions.length, refreshTransactions])
  );

  // Apply hide balance by default setting
  useEffect(() => {
    setBalanceHidden(securitySettings.hideBalanceByDefault);
  }, [securitySettings.hideBalanceByDefault]);

  // Format balance with selected currency
  const formattedBalance = formatAmount(balance?.totalUsd || 0);

  // Wallet is initialized in the main layout

  // Animations
  const balanceScale = useSharedValue(1);
  const balanceAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: balanceScale.value }],
  }));

  const onRefresh = useCallback(async () => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    await Promise.all([refreshBalance(), refreshTransactions()]);
  }, [refreshBalance, refreshTransactions]);

  const toggleBalanceVisibility = () => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    balanceScale.value = withSpring(0.95, {}, () => {
      balanceScale.value = withSpring(1);
    });
    setBalanceHidden(!balanceHidden);
  };

  const copyAddress = async () => {
    if (publicKey) {
      await Clipboard.setStringAsync(publicKey);
      if (Platform.OS !== 'web') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    }
  };

  const [airdropLoading, setAirdropLoading] = useState(false);

  const openFaucet = async () => {
    // Copy address to clipboard for quick paste
    if (publicKey) {
      await Clipboard.setStringAsync(publicKey);
      if (Platform.OS !== 'web') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    }
    // Open the faucet website
    Linking.openURL('https://faucet.solana.com/');
  };

  const handleAirdrop = async () => {
    if (airdropLoading) return;

    setAirdropLoading(true);
    try {
      if (Platform.OS !== 'web') {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      }

      await requestDevnetAirdrop(1);

      if (Platform.OS !== 'web') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }

      Alert.alert(
        'Airdrop Successful!',
        'You received 1 SOL. Pull down to refresh your balance.',
        [{ text: 'OK', onPress: () => refreshBalance() }]
      );
    } catch (err: any) {
      if (Platform.OS !== 'web') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }

      const isRateLimited = err?.message === 'RATE_LIMITED' ||
                            err?.message?.includes('429') ||
                            err?.message?.includes('limit');

      if (isRateLimited) {
        Alert.alert(
          'Faucet Rate Limited',
          'The Solana devnet faucet is temporarily unavailable (too many requests).\n\n' +
          'Tap "Open Faucet" to get SOL from the official website.\n\n' +
          'Your address will be copied automatically.',
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Open Faucet',
              onPress: openFaucet,
              style: 'default',
            },
          ]
        );
      } else {
        Alert.alert(
          'Airdrop Failed',
          err?.message || 'Unknown error occurred',
          [
            { text: 'OK' },
            { text: 'Try Faucet', onPress: openFaucet },
          ]
        );
      }
    } finally {
      setAirdropLoading(false);
    }
  };

  // No wallet - redirect to onboarding (this page should not be accessible without a wallet)
  useEffect(() => {
    if (initialized && !loading && !hasWallet) {
      router.replace('/(onboarding)');
    }
  }, [initialized, loading, hasWallet, router]);

  // Loading state
  if (!initialized || loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={Colors.primary} />
          <Text style={styles.loadingText}>Loading wallet...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!hasWallet) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <Animated.View entering={FadeInDown.delay(100)} style={styles.header}>
        <View style={styles.headerLeft}>
          <Image
            source={require('@/assets/images/01-miku.png')}
            style={styles.logoImage}
            resizeMode="contain"
          />
          <View>
            <Text style={styles.brandName}>PROTOCOL 01</Text>
            {isDevnet() && (
              <View style={[styles.devnetBadge, { backgroundColor: P01.pinkDim }]}>
                <Text style={[styles.devnetText, { color: P01.pink }]}>DEVNET</Text>
              </View>
            )}
          </View>
        </View>
        <View style={styles.headerRight}>
          <TouchableOpacity
            style={styles.headerButton}
            onPress={() => router.push('/(main)/(wallet)/scan')}
          >
            <Ionicons name="scan-outline" size={20} color={Colors.text} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.headerButton}
            onPress={() => router.push('/(main)/(settings)')}
          >
            <Ionicons name="settings-outline" size={20} color={Colors.text} />
          </TouchableOpacity>
        </View>
      </Animated.View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={Colors.primary}
            colors={[Colors.primary]}
          />
        }
      >
        {/* Balance Card */}
        <Animated.View entering={FadeInUp.delay(200)}>
          <LinearGradient
            colors={['#111111', '#0a0a0a']}
            style={styles.balanceCard}
          >
            {/* Address */}
            <TouchableOpacity style={styles.addressRow} onPress={copyAddress}>
              <Text style={styles.addressLabel}>Wallet Address</Text>
              <View style={styles.addressContainer}>
                <Text style={styles.addressText}>{formattedPublicKey}</Text>
                <Ionicons name="copy-outline" size={14} color={Colors.textSecondary} />
              </View>
            </TouchableOpacity>

            {/* Balance */}
            <TouchableOpacity onPress={toggleBalanceVisibility} activeOpacity={0.8}>
              <Animated.View style={[styles.balanceContainer, balanceAnimatedStyle]}>
                {balanceHidden ? (
                  <View style={styles.hiddenBalance}>
                    <Text style={styles.hiddenBalanceText}>••••••</Text>
                    <Ionicons name="eye-outline" size={24} color={Colors.textSecondary} />
                  </View>
                ) : (
                  <>
                    <Text style={styles.balanceAmount}>{formattedBalance}</Text>
                    <View style={styles.solBalanceRow}>
                      <Ionicons name="logo-bitcoin" size={16} color={Colors.primary} />
                      <Text style={styles.solBalance}>{formattedSolBalance} SOL</Text>
                    </View>
                  </>
                )}
              </Animated.View>
            </TouchableOpacity>

            {/* Action Buttons - Adapts based on network */}
            <View style={[styles.actionButtons, isDevnet() && styles.actionButtonsDevnet]}>
              <TouchableOpacity
                style={[styles.actionButton, isDevnet() && styles.actionButtonWide]}
                onPress={() => router.push('/(main)/(wallet)/send')}
              >
                <LinearGradient
                  colors={[P01.cyan, '#00ffe5']}
                  style={styles.actionIconGradient}
                >
                  <Ionicons name="arrow-up" size={18} color="#0a0a0c" />
                </LinearGradient>
                <Text style={styles.actionLabel}>Send</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.actionButton, isDevnet() && styles.actionButtonWide]}
                onPress={() => router.push('/(main)/(wallet)/receive')}
              >
                <View style={[styles.actionIcon, { backgroundColor: Colors.primaryDim }]}>
                  <Ionicons name="arrow-down" size={18} color={Colors.primary} />
                </View>
                <Text style={[styles.actionLabel, { color: Colors.primary }]}>Receive</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.actionButton, isDevnet() && styles.actionButtonWide]}
                onPress={() => router.push('/(main)/(wallet)/swap')}
              >
                <View style={[styles.actionIcon, { backgroundColor: P01.blueDim }]}>
                  <Ionicons name="swap-horizontal" size={18} color={P01.blue} />
                </View>
                <Text style={[styles.actionLabel, { color: P01.blue }]}>Swap</Text>
              </TouchableOpacity>

              {/* Buy button - Only visible on mainnet */}
              {!isDevnet() && (
                <TouchableOpacity
                  style={styles.actionButton}
                  onPress={() => router.push('/(main)/(wallet)/buy')}
                >
                  <View style={[styles.actionIcon, { backgroundColor: P01.pinkDim }]}>
                    <Ionicons name="card" size={18} color={P01.pink} />
                  </View>
                  <Text style={[styles.actionLabel, { color: P01.pink }]}>Buy</Text>
                </TouchableOpacity>
              )}
            </View>
          </LinearGradient>
        </Animated.View>

        {/* Devnet Airdrop */}
        {isDevnet() && (
          <Animated.View entering={FadeInUp.delay(300)}>
            <TouchableOpacity
              style={[styles.airdropCard, airdropLoading && { opacity: 0.7 }]}
              onPress={handleAirdrop}
              disabled={airdropLoading}
            >
              <LinearGradient
                colors={['rgba(255, 119, 168, 0.15)', 'rgba(255, 119, 168, 0.05)']}
                style={styles.airdropGradient}
              >
                <View style={[styles.airdropIconContainer, { backgroundColor: P01.pinkDim }]}>
                  {airdropLoading ? (
                    <ActivityIndicator size="small" color={P01.pink} />
                  ) : (
                    <Ionicons name="water" size={24} color={P01.pink} />
                  )}
                </View>
                <View style={styles.airdropContent}>
                  <Text style={styles.airdropTitle}>
                    {airdropLoading ? 'Requesting SOL...' : 'Get Test SOL'}
                  </Text>
                  <Text style={styles.airdropSubtitle}>
                    {airdropLoading
                      ? 'Please wait...'
                      : 'Tap to receive 1 SOL from the devnet faucet'}
                  </Text>
                </View>
                {!airdropLoading && (
                  <Ionicons name="chevron-forward" size={20} color={P01.pink} />
                )}
              </LinearGradient>
            </TouchableOpacity>
          </Animated.View>
        )}

        {/* Shielded Wallet Card */}
        <Animated.View entering={FadeInUp.delay(350)}>
          <TouchableOpacity
            style={styles.shieldedCard}
            onPress={() => router.push('/(main)/(wallet)/shielded')}
          >
            <LinearGradient
              colors={['rgba(57, 197, 187, 0.15)', 'rgba(57, 197, 187, 0.05)']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={styles.shieldedGradient}
            >
              <View style={styles.shieldedIconContainer}>
                <Ionicons name="shield-checkmark" size={24} color={P01.cyan} />
              </View>
              <View style={styles.shieldedContent}>
                <Text style={styles.shieldedTitle}>Shielded Wallet</Text>
                <Text style={styles.shieldedSubtitle}>
                  {shieldedInitialized
                    ? `${shieldedBalance.toFixed(4)} SOL shielded`
                    : 'ZK-protected privacy'}
                </Text>
              </View>
              <View style={styles.shieldedBadge}>
                <Text style={styles.shieldedBadgeText}>ZK</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={P01.cyan} />
            </LinearGradient>
          </TouchableOpacity>
        </Animated.View>

        {/* Assets Section */}
        <Animated.View entering={FadeInUp.delay(400)} style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>ASSETS</Text>
          </View>

          {/* SOL Asset */}
          <TouchableOpacity style={styles.assetRow} activeOpacity={0.7}>
            <View style={styles.assetLeft}>
              <TokenIcon symbol="SOL" size={44} />
              <View style={[styles.assetInfo, { marginLeft: Spacing.md }]}>
                <Text style={styles.assetName}>Solana</Text>
                <Text style={styles.assetSymbol}>SOL</Text>
              </View>
            </View>
            <View style={styles.assetRight}>
              <Text style={styles.assetBalance}>
                {balanceHidden ? '••••' : formattedSolBalance}
              </Text>
              <Text style={styles.assetUsd}>
                {balanceHidden ? '••••' : formattedBalance}
              </Text>
            </View>
          </TouchableOpacity>

          {/* Token Balances */}
          {balance?.tokens.map((token) => (
            <TouchableOpacity key={token.mint} style={styles.assetRow} activeOpacity={0.7}>
              <View style={styles.assetLeft}>
                <TokenIcon symbol={token.symbol} logoURI={token.logoURI} size={44} />
                <View style={[styles.assetInfo, { marginLeft: Spacing.md }]}>
                  <Text style={styles.assetName}>{token.name}</Text>
                  <Text style={styles.assetSymbol}>{token.symbol}</Text>
                </View>
              </View>
              <View style={styles.assetRight}>
                <Text style={styles.assetBalance}>
                  {balanceHidden ? '••••' : token.uiBalance}
                </Text>
                {token.usdValue && (
                  <Text style={styles.assetUsd}>
                    {balanceHidden ? '••••' : formatAmount(token.usdValue)}
                  </Text>
                )}
              </View>
            </TouchableOpacity>
          ))}
        </Animated.View>

        {/* Activity Section */}
        <Animated.View entering={FadeInUp.delay(500)} style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>RECENT ACTIVITY</Text>
            <TouchableOpacity onPress={() => router.push('/(main)/(wallet)/activity')}>
              <Text style={styles.seeAllText}>See All</Text>
            </TouchableOpacity>
          </View>

          {transactions.length === 0 ? (
            <View style={styles.emptyActivity}>
              <Ionicons name="time-outline" size={40} color={Colors.textTertiary} />
              <Text style={styles.emptyActivityText}>No transactions yet</Text>
              <Text style={styles.emptyActivitySubtext}>
                Your transaction history will appear here
              </Text>
            </View>
          ) : (
            transactions.slice(0, 5).map((tx, index) => (
              <TouchableOpacity key={tx.signature} style={styles.txRow} activeOpacity={0.7}>
                <View style={[
                  styles.txIcon,
                  {
                    backgroundColor:
                      tx.type === 'receive'
                        ? Colors.successDim
                        : tx.type === 'send'
                        ? Colors.errorDim
                        : Colors.blueDim,
                  },
                ]}>
                  <Ionicons
                    name={
                      tx.type === 'receive'
                        ? 'arrow-down'
                        : tx.type === 'send'
                        ? 'arrow-up'
                        : 'swap-horizontal'
                    }
                    size={18}
                    color={
                      tx.type === 'receive'
                        ? Colors.success
                        : tx.type === 'send'
                        ? Colors.error
                        : Colors.blue
                    }
                  />
                </View>
                <View style={styles.txInfo}>
                  <Text style={styles.txType}>
                    {tx.type.charAt(0).toUpperCase() + tx.type.slice(1)}
                  </Text>
                  <Text style={styles.txDate}>{formatTxDate(tx.timestamp)}</Text>
                </View>
                <View style={styles.txAmount}>
                  <Text style={[
                    styles.txAmountText,
                    { color: tx.type === 'receive' ? Colors.success : Colors.text },
                  ]}>
                    {tx.type === 'receive' ? '+' : '-'}
                    {tx.amount?.toFixed(4) || '0'} {tx.token || 'SOL'}
                  </Text>
                  <Text style={styles.txStatus}>
                    {tx.status === 'confirmed' ? 'Confirmed' : tx.status}
                  </Text>
                </View>
              </TouchableOpacity>
            ))
          )}
        </Animated.View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: Spacing.lg,
    color: Colors.textSecondary,
    fontFamily: FontFamily.medium,
    fontSize: 15,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: Spacing['3xl'],
  },
  emptyIconContainer: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: Colors.surfaceSecondary,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing['2xl'],
  },
  emptyTitle: {
    color: Colors.text,
    fontSize: 24,
    fontFamily: FontFamily.bold,
    marginBottom: Spacing.sm,
  },
  emptySubtitle: {
    color: Colors.textSecondary,
    fontSize: 15,
    fontFamily: FontFamily.regular,
    textAlign: 'center',
    marginBottom: Spacing['3xl'],
  },
  primaryButton: {
    backgroundColor: Colors.primary,
    paddingVertical: Spacing.lg,
    paddingHorizontal: Spacing['4xl'],
    borderRadius: BorderRadius.lg,
    ...Shadows.glow,
  },
  primaryButtonText: {
    color: Colors.background,
    fontSize: 16,
    fontFamily: FontFamily.semibold,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  logoImage: {
    width: 80,
    height: 32,
    marginRight: Spacing.md,
  },
  brandName: {
    color: Colors.text,
    fontSize: 18,
    fontFamily: FontFamily.bold,
    letterSpacing: 1,
  },
  devnetBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginTop: 2,
  },
  devnetText: {
    fontSize: 9,
    fontFamily: FontFamily.semibold,
    letterSpacing: 0.5,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  headerButton: {
    width: 40,
    height: 40,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.surfaceSecondary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: Spacing.xl,
    paddingBottom: 120,
  },
  balanceCard: {
    borderRadius: BorderRadius.xl,
    padding: Spacing.xl,
    marginBottom: Spacing.lg,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  addressRow: {
    marginBottom: Spacing.xl,
  },
  addressLabel: {
    color: Colors.textTertiary,
    fontSize: 12,
    fontFamily: FontFamily.medium,
    marginBottom: 4,
  },
  addressContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  addressText: {
    color: Colors.textSecondary,
    fontSize: 14,
    fontFamily: FontFamily.mono,
  },
  balanceContainer: {
    alignItems: 'center',
    marginBottom: Spacing['2xl'],
  },
  hiddenBalance: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  hiddenBalanceText: {
    color: Colors.text,
    fontSize: 40,
    fontFamily: FontFamily.bold,
    letterSpacing: 4,
  },
  balanceAmount: {
    color: Colors.text,
    fontSize: 40,
    fontFamily: FontFamily.bold,
  },
  solBalanceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: Spacing.sm,
    gap: Spacing.xs,
  },
  solBalance: {
    color: Colors.textSecondary,
    fontSize: 15,
    fontFamily: FontFamily.medium,
  },
  actionButtons: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.sm,
  },
  actionButtonsDevnet: {
    justifyContent: 'space-around',
  },
  actionButton: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.sm,
    minWidth: 60,
  },
  actionButtonWide: {
    minWidth: 80,
  },
  actionIconGradient: {
    width: 48,
    height: 48,
    borderRadius: BorderRadius.full,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.xs,
  },
  actionIcon: {
    width: 48,
    height: 48,
    borderRadius: BorderRadius.full,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.xs,
  },
  actionLabel: {
    color: Colors.text,
    fontSize: 12,
    fontFamily: FontFamily.medium,
  },
  airdropCard: {
    marginBottom: Spacing.lg,
    borderRadius: BorderRadius.lg,
    overflow: 'hidden',
  },
  airdropGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.lg,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: 'rgba(255, 119, 168, 0.3)',
  },
  airdropIconContainer: {
    width: 44,
    height: 44,
    borderRadius: BorderRadius.md,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.md,
  },
  airdropContent: {
    flex: 1,
  },
  airdropTitle: {
    color: Colors.text,
    fontSize: 15,
    fontFamily: FontFamily.semibold,
  },
  airdropSubtitle: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontFamily: FontFamily.regular,
    marginTop: 2,
  },
  shieldedCard: {
    marginBottom: Spacing.lg,
    borderRadius: BorderRadius.lg,
    overflow: 'hidden',
  },
  shieldedGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.lg,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.3)',
  },
  shieldedIconContainer: {
    width: 44,
    height: 44,
    borderRadius: BorderRadius.md,
    backgroundColor: 'rgba(57, 197, 187, 0.15)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.md,
  },
  shieldedContent: {
    flex: 1,
  },
  shieldedTitle: {
    color: '#ffffff',
    fontSize: 15,
    fontFamily: FontFamily.semibold,
  },
  shieldedSubtitle: {
    color: '#888892',
    fontSize: 13,
    fontFamily: FontFamily.regular,
    marginTop: 2,
  },
  shieldedBadge: {
    backgroundColor: 'rgba(57, 197, 187, 0.15)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    marginRight: Spacing.sm,
  },
  shieldedBadgeText: {
    color: '#39c5bb',
    fontSize: 10,
    fontFamily: FontFamily.mono,
    fontWeight: '600',
  },
  section: {
    marginBottom: Spacing['2xl'],
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.lg,
  },
  sectionTitle: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontFamily: FontFamily.semibold,
    letterSpacing: 1,
  },
  seeAllText: {
    color: Colors.primary,
    fontSize: 13,
    fontFamily: FontFamily.medium,
  },
  assetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Colors.surfaceSecondary,
    padding: Spacing.lg,
    borderRadius: BorderRadius.lg,
    marginBottom: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  assetLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  assetIcon: {
    width: 44,
    height: 44,
    borderRadius: BorderRadius.full,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.md,
  },
  assetIconText: {
    color: Colors.text,
    fontSize: 18,
    fontFamily: FontFamily.bold,
  },
  assetInfo: {},
  assetName: {
    color: Colors.text,
    fontSize: 15,
    fontFamily: FontFamily.semibold,
  },
  assetSymbol: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontFamily: FontFamily.regular,
    marginTop: 2,
  },
  assetRight: {
    alignItems: 'flex-end',
  },
  assetBalance: {
    color: Colors.text,
    fontSize: 15,
    fontFamily: FontFamily.semibold,
  },
  assetUsd: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontFamily: FontFamily.regular,
    marginTop: 2,
  },
  emptyActivity: {
    alignItems: 'center',
    paddingVertical: Spacing['3xl'],
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  emptyActivityText: {
    color: Colors.textSecondary,
    fontSize: 15,
    fontFamily: FontFamily.medium,
    marginTop: Spacing.md,
  },
  emptyActivitySubtext: {
    color: Colors.textTertiary,
    fontSize: 13,
    fontFamily: FontFamily.regular,
    marginTop: Spacing.xs,
  },
  txRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surfaceSecondary,
    padding: Spacing.lg,
    borderRadius: BorderRadius.lg,
    marginBottom: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  txIcon: {
    width: 40,
    height: 40,
    borderRadius: BorderRadius.full,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.md,
  },
  txInfo: {
    flex: 1,
  },
  txType: {
    color: Colors.text,
    fontSize: 15,
    fontFamily: FontFamily.medium,
  },
  txDate: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontFamily: FontFamily.regular,
    marginTop: 2,
  },
  txAmount: {
    alignItems: 'flex-end',
  },
  txAmountText: {
    fontSize: 15,
    fontFamily: FontFamily.semibold,
  },
  txStatus: {
    color: Colors.textTertiary,
    fontSize: 12,
    fontFamily: FontFamily.regular,
    marginTop: 2,
  },
});

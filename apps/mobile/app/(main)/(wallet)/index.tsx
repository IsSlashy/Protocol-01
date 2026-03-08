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
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import Animated, {
  FadeInUp,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { useWalletStore } from '@/stores/walletStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useShieldedStore } from '@/stores/shieldedStore';
import { useConfidentialStore } from '@/stores/confidentialStore';
import { useSecuritySettings } from '@/hooks/useSecuritySettings';
import { useAuth } from '@/providers/PrivyProvider';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import { isDevnet } from '@/services/solana/connection';
import { formatBalance } from '@/services/solana/balance';

import WalletHeader from '@/components/wallet/WalletHeader';
import PrivacySummaryPill from '@/components/wallet/PrivacySummaryPill';
import AssetsList from '@/components/wallet/AssetsList';
import RecentActivity from '@/components/wallet/RecentActivity';
import DevnetAirdropFAB from '@/components/wallet/DevnetAirdropFAB';

export default function WalletHomeScreen() {
  const router = useRouter();
  const { settings: securitySettings } = useSecuritySettings();
  const { formatAmount, initialize: initSettings } = useSettingsStore();
  const [balanceHidden, setBalanceHidden] = useState(false);

  const { isAuthenticated, walletAddress: privyWalletAddress } = useAuth();

  const {
    initialized,
    loading,
    hasWallet: hasLocalWallet,
    publicKey: localPublicKey,
    balance,
    transactions,
    refreshing,
    refreshBalance,
    refreshTransactions,
    requestDevnetAirdrop,
    initializeWithPrivy,
  } = useWalletStore();

  const hasWallet = Boolean(privyWalletAddress || hasLocalWallet);
  const publicKey = privyWalletAddress || localPublicKey;
  const formattedPublicKey = publicKey
    ? `${publicKey.slice(0, 4)}...${publicKey.slice(-4)}`
    : '';

  const lastSyncedRef = React.useRef<string | null>(null);
  useEffect(() => {
    if (privyWalletAddress && !hasLocalWallet && lastSyncedRef.current !== privyWalletAddress) {
      lastSyncedRef.current = privyWalletAddress;
      initializeWithPrivy(privyWalletAddress);
    }
  }, [privyWalletAddress, hasLocalWallet]);

  const formattedSolBalance = balance ? formatBalance(balance.sol) : '0';

  const { shieldedBalance } = useShieldedStore();
  const { balances: confidentialBalances } = useConfidentialStore();
  const confidentialSolBalance = (confidentialBalances['11111111111111111111111111111111'] || 0) / 1e9;

  useEffect(() => { initSettings(); }, []);

  useFocusEffect(
    useCallback(() => {
      if (initialized && !loading && hasWallet && transactions.length === 0) {
        refreshTransactions();
      }
    }, [initialized, loading, hasWallet, transactions.length, refreshTransactions])
  );

  useEffect(() => {
    setBalanceHidden(securitySettings.hideBalanceByDefault);
  }, [securitySettings.hideBalanceByDefault]);

  const formattedBalance = formatAmount(balance?.totalUsd || 0);

  const balanceScale = useSharedValue(1);
  const balanceAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: balanceScale.value }],
  }));

  const onRefresh = useCallback(async () => {
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await Promise.all([refreshBalance(), refreshTransactions()]);
  }, [refreshBalance, refreshTransactions]);

  const toggleBalanceVisibility = () => {
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    balanceScale.value = withSpring(0.95, {}, () => { balanceScale.value = withSpring(1); });
    setBalanceHidden(!balanceHidden);
  };

  const copyAddress = async () => {
    if (publicKey) {
      await Clipboard.setStringAsync(publicKey);
      if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  };

  // Timeout to prevent infinite loading — if wallet isn't ready after 8s, show fallback
  const [loadTimeout, setLoadTimeout] = useState(false);
  useEffect(() => {
    if (!initialized || !hasWallet) {
      const timer = setTimeout(() => setLoadTimeout(true), 8000);
      return () => clearTimeout(timer);
    }
    setLoadTimeout(false);
  }, [initialized, hasWallet]);

  if ((!initialized || (loading && !hasWallet)) && !loadTimeout) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={Colors.primary} accessibilityLabel="Loading wallet" />
          <Text style={styles.loadingText} accessibilityRole="text">Loading wallet...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!hasWallet) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.loadingContainer}>
          <Text style={{ color: '#ffffff', fontSize: 18, fontWeight: '600', marginBottom: 12 }} accessibilityRole="header">
            No Wallet Found
          </Text>
          <Text style={{ color: '#888', fontSize: 14, textAlign: 'center', marginBottom: 24, paddingHorizontal: 32 }}>
            Create a new wallet or import an existing one to get started.
          </Text>
          <TouchableOpacity
            onPress={() => router.replace('/(onboarding)')}
            style={{
              backgroundColor: Colors.primary,
              paddingHorizontal: 32,
              paddingVertical: 14,
              borderRadius: 12,
            }}
            accessibilityRole="button"
            accessibilityLabel="Set up wallet"
          >
            <Text style={{ color: '#0a0a0c', fontWeight: '700', fontSize: 16 }}>
              Set Up Wallet
            </Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <WalletHeader
        onScan={() => router.push('/(main)/(wallet)/scan')}
        onSettings={() => router.push('/(main)/(settings)')}
      />

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} colors={[Colors.primary]} />
        }
      >
        {/* Balance Card — Liquid Glass */}
        <Animated.View entering={FadeInUp.delay(200)} style={styles.balanceCardOuter}>
          <BlurView intensity={18} tint="dark" style={styles.balanceCard}>
            {/* Subtle gradient glow */}
            <LinearGradient
              colors={['rgba(57, 197, 187, 0.06)', 'rgba(255, 119, 168, 0.04)', 'transparent']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFill}
            />

            {/* Address chip */}
            <TouchableOpacity style={styles.addressChip} onPress={copyAddress} accessibilityRole="button" accessibilityLabel={`Copy wallet address ${formattedPublicKey}`} accessibilityHint="Copies full address to clipboard">
              <View style={styles.addressDot} />
              <Text style={styles.addressText}>{formattedPublicKey}</Text>
              <Ionicons name="copy-outline" size={12} color={Colors.textTertiary} />
            </TouchableOpacity>

            {/* Balance */}
            <TouchableOpacity onPress={toggleBalanceVisibility} activeOpacity={0.8} accessibilityRole="button" accessibilityLabel={balanceHidden ? 'Show balance' : 'Hide balance'} accessibilityHint="Toggles balance visibility">
              <Animated.View style={[styles.balanceContainer, balanceAnimatedStyle]}>
                {balanceHidden ? (
                  <View style={styles.hiddenBalance}>
                    <Text style={styles.hiddenBalanceText}>------</Text>
                    <Ionicons name="eye-outline" size={22} color={Colors.textTertiary} />
                  </View>
                ) : (
                  <>
                    <Text style={styles.balanceAmount}>{formattedBalance}</Text>
                    <View style={styles.solBalanceRow}>
                      <Text style={styles.solBalance}>{formattedSolBalance} SOL</Text>
                    </View>
                  </>
                )}
              </Animated.View>
            </TouchableOpacity>

            {/* Action buttons */}
            <View style={[styles.actionButtons, isDevnet() && styles.actionButtonsDevnet]}>
              <TouchableOpacity style={styles.actionButton} onPress={() => router.push('/(main)/(wallet)/send')} accessibilityLabel="Send tokens" accessibilityRole="button">
                <View style={[styles.actionIcon, { backgroundColor: 'rgba(57, 197, 187, 0.12)' }]}>
                  <Ionicons name="arrow-up" size={20} color={P01Colors.cyan} />
                </View>
                <Text style={[styles.actionLabel, { color: P01Colors.cyan }]}>Send</Text>
              </TouchableOpacity>

              <TouchableOpacity style={styles.actionButton} onPress={() => router.push('/(main)/(wallet)/receive')} accessibilityLabel="Receive tokens" accessibilityRole="button">
                <View style={[styles.actionIcon, { backgroundColor: 'rgba(57, 197, 187, 0.08)' }]}>
                  <Ionicons name="arrow-down" size={20} color={P01Colors.cyan} />
                </View>
                <Text style={[styles.actionLabel, { color: Colors.textSecondary }]}>Receive</Text>
              </TouchableOpacity>

              <TouchableOpacity style={styles.actionButton} onPress={() => router.push('/(main)/(wallet)/swap')} accessibilityLabel="Swap tokens" accessibilityRole="button">
                <View style={[styles.actionIcon, { backgroundColor: 'rgba(255, 119, 168, 0.08)' }]}>
                  <Ionicons name="swap-horizontal" size={20} color={P01Colors.pink} />
                </View>
                <Text style={[styles.actionLabel, { color: Colors.textSecondary }]}>Swap</Text>
              </TouchableOpacity>

              {!isDevnet() && (
                <TouchableOpacity style={styles.actionButton} onPress={() => router.push('/(main)/(wallet)/buy')} accessibilityLabel="Buy crypto" accessibilityRole="button">
                  <View style={[styles.actionIcon, { backgroundColor: 'rgba(255, 119, 168, 0.06)' }]}>
                    <Ionicons name="card" size={20} color={P01Colors.pink} />
                  </View>
                  <Text style={[styles.actionLabel, { color: Colors.textSecondary }]}>Buy</Text>
                </TouchableOpacity>
              )}
            </View>
          </BlurView>
        </Animated.View>

        {/* Privacy Summary Pill — taps to Privacy tab */}
        <PrivacySummaryPill
          shieldedBalance={shieldedBalance}
          confidentialBalance={confidentialSolBalance}
          onPress={() => router.push('/(main)/(privacy)')}
        />

        {/* Assets — owned tokens only */}
        <AssetsList
          solBalance={formattedSolBalance}
          formattedUsd={formattedBalance}
          tokens={balance?.tokens || []}
          balanceHidden={balanceHidden}
          formatAmount={formatAmount}
        />

        {/* Recent Activity — 3 items max + "See All" */}
        <RecentActivity
          transactions={transactions}
          onSeeAll={() => router.push('/(main)/(wallet)/activity')}
        />
      </ScrollView>

      {/* Devnet Airdrop FAB */}
      <DevnetAirdropFAB
        publicKey={publicKey}
        requestAirdrop={async (amount: number) => { await requestDevnetAirdrop(amount); }}
        refreshBalance={refreshBalance}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { marginTop: Spacing.lg, color: Colors.textSecondary, fontFamily: FontFamily.medium, fontSize: 15 },
  scrollView: { flex: 1 },
  scrollContent: { paddingHorizontal: Spacing.xl, paddingBottom: 120 },
  balanceCardOuter: {
    borderRadius: 24,
    overflow: 'hidden',
    marginBottom: Spacing.lg,
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.07)',
  },
  balanceCard: {
    padding: Spacing.xl,
    paddingTop: 20,
    backgroundColor: 'rgba(12, 12, 14, 0.7)',
  },
  addressChip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    marginBottom: 20,
  },
  addressDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: P01Colors.cyan,
  },
  addressText: { color: Colors.textTertiary, fontSize: 13, fontFamily: FontFamily.mono },
  balanceContainer: { alignItems: 'center', marginBottom: 28 },
  hiddenBalance: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  hiddenBalanceText: { color: Colors.text, fontSize: 38, fontFamily: FontFamily.bold, letterSpacing: 4 },
  balanceAmount: { color: Colors.text, fontSize: 42, fontFamily: FontFamily.bold, letterSpacing: -1 },
  solBalanceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
  },
  solBalance: { color: Colors.textTertiary, fontSize: 14, fontFamily: FontFamily.medium },
  actionButtons: { flexDirection: 'row', justifyContent: 'space-evenly' },
  actionButtonsDevnet: { justifyContent: 'space-evenly' },
  actionButton: { alignItems: 'center', justifyContent: 'center', paddingVertical: Spacing.xs, minWidth: 64 },
  actionIcon: { width: 50, height: 50, borderRadius: 16, justifyContent: 'center', alignItems: 'center', marginBottom: 6 },
  actionLabel: { color: Colors.textSecondary, fontSize: 12, fontFamily: FontFamily.medium },
});

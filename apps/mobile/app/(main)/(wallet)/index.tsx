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
          <Text style={{ color: '#ffffff', fontSize: 18, fontWeight: '600', marginBottom: 12 }}>
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
        {/* Balance Card */}
        <Animated.View entering={FadeInUp.delay(200)}>
          <LinearGradient colors={['#111111', '#0a0a0a']} style={styles.balanceCard}>
            <TouchableOpacity style={styles.addressRow} onPress={copyAddress}>
              <Text style={styles.addressLabel}>Wallet Address</Text>
              <View style={styles.addressContainer}>
                <Text style={styles.addressText}>{formattedPublicKey}</Text>
                <Ionicons name="copy-outline" size={14} color={Colors.textSecondary} />
              </View>
            </TouchableOpacity>

            <TouchableOpacity onPress={toggleBalanceVisibility} activeOpacity={0.8}>
              <Animated.View style={[styles.balanceContainer, balanceAnimatedStyle]}>
                {balanceHidden ? (
                  <View style={styles.hiddenBalance}>
                    <Text style={styles.hiddenBalanceText}>------</Text>
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

            <View style={[styles.actionButtons, isDevnet() && styles.actionButtonsDevnet]}>
              <TouchableOpacity style={[styles.actionButton, isDevnet() && styles.actionButtonWide]} onPress={() => router.push('/(main)/(wallet)/send')} accessibilityLabel="Send tokens" accessibilityRole="button">
                <LinearGradient colors={[P01Colors.cyan, P01Colors.cyanBright]} style={styles.actionIconGradient}>
                  <Ionicons name="arrow-up" size={18} color="#0a0a0c" />
                </LinearGradient>
                <Text style={styles.actionLabel}>Send</Text>
              </TouchableOpacity>

              <TouchableOpacity style={[styles.actionButton, isDevnet() && styles.actionButtonWide]} onPress={() => router.push('/(main)/(wallet)/receive')} accessibilityLabel="Receive tokens" accessibilityRole="button">
                <View style={[styles.actionIcon, { backgroundColor: Colors.primaryDim }]}>
                  <Ionicons name="arrow-down" size={18} color={Colors.primary} />
                </View>
                <Text style={[styles.actionLabel, { color: Colors.primary }]}>Receive</Text>
              </TouchableOpacity>

              <TouchableOpacity style={[styles.actionButton, isDevnet() && styles.actionButtonWide]} onPress={() => router.push('/(main)/(wallet)/swap')} accessibilityLabel="Swap tokens" accessibilityRole="button">
                <View style={[styles.actionIcon, { backgroundColor: P01Colors.blueDim }]}>
                  <Ionicons name="swap-horizontal" size={18} color={P01Colors.blue} />
                </View>
                <Text style={[styles.actionLabel, { color: P01Colors.blue }]}>Swap</Text>
              </TouchableOpacity>

              {!isDevnet() && (
                <TouchableOpacity style={styles.actionButton} onPress={() => router.push('/(main)/(wallet)/buy')} accessibilityLabel="Buy crypto" accessibilityRole="button">
                  <View style={[styles.actionIcon, { backgroundColor: P01Colors.pinkDim }]}>
                    <Ionicons name="card" size={18} color={P01Colors.pink} />
                  </View>
                  <Text style={[styles.actionLabel, { color: P01Colors.pink }]}>Buy</Text>
                </TouchableOpacity>
              )}
            </View>
          </LinearGradient>
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
  container: { flex: 1, backgroundColor: Colors.background },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { marginTop: Spacing.lg, color: Colors.textSecondary, fontFamily: FontFamily.medium, fontSize: 15 },
  scrollView: { flex: 1 },
  scrollContent: { paddingHorizontal: Spacing.xl, paddingBottom: 120 },
  balanceCard: {
    borderRadius: BorderRadius.xl,
    padding: Spacing.xl,
    marginBottom: Spacing.lg,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  addressRow: { marginBottom: Spacing.xl },
  addressLabel: { color: Colors.textTertiary, fontSize: 12, fontFamily: FontFamily.medium, marginBottom: 4 },
  addressContainer: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  addressText: { color: Colors.textSecondary, fontSize: 14, fontFamily: FontFamily.mono },
  balanceContainer: { alignItems: 'center', marginBottom: Spacing['2xl'] },
  hiddenBalance: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  hiddenBalanceText: { color: Colors.text, fontSize: 40, fontFamily: FontFamily.bold, letterSpacing: 4 },
  balanceAmount: { color: Colors.text, fontSize: 40, fontFamily: FontFamily.bold },
  solBalanceRow: { flexDirection: 'row', alignItems: 'center', marginTop: Spacing.sm, gap: Spacing.xs },
  solBalance: { color: Colors.textSecondary, fontSize: 15, fontFamily: FontFamily.medium },
  actionButtons: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: Spacing.sm },
  actionButtonsDevnet: { justifyContent: 'space-around' },
  actionButton: { alignItems: 'center', justifyContent: 'center', paddingVertical: Spacing.sm, minWidth: 60 },
  actionButtonWide: { minWidth: 80 },
  actionIconGradient: { width: 48, height: 48, borderRadius: 9999, justifyContent: 'center', alignItems: 'center', marginBottom: Spacing.xs },
  actionIcon: { width: 48, height: 48, borderRadius: 9999, justifyContent: 'center', alignItems: 'center', marginBottom: Spacing.xs },
  actionLabel: { color: Colors.text, fontSize: 12, fontFamily: FontFamily.medium },
});

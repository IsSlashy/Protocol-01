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
  InteractionManager,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
// BlurView + LinearGradient removed — flat surface for performance
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { useWalletStore } from '@/stores/walletStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useShieldedStore } from '@/stores/shieldedStore';
import { useConfidentialStore } from '@/stores/confidentialStore';
import { useDenominatedPoolStore } from '@/stores/denominatedPoolStore';
import { useSecuritySettings } from '@/hooks/useSecuritySettings';
import { useAuth } from '@/providers/PrivyProvider';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import { isDevnet } from '@/services/solana/connection';
import { formatBalance } from '@/services/solana/balance';

import { useT } from '@/i18n';
import WalletHeader from '@/components/wallet/WalletHeader';
import PrivacySummaryPill from '@/components/wallet/PrivacySummaryPill';
import AssetsList from '@/components/wallet/AssetsList';
import RecentActivity from '@/components/wallet/RecentActivity';
import DevnetAirdropFAB from '@/components/wallet/DevnetAirdropFAB';

export default function WalletHomeScreen() {
  const t = useT();
  const router = useRouter();
  const { settings: securitySettings, isLoading: securityLoading } = useSecuritySettings();
  const { formatAmount, initialize: initSettings } = useSettingsStore();
  // Start hidden until security settings load — prevents flash of visible balance
  const [balanceHidden, setBalanceHidden] = useState(true);

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
  const { getActiveNotes } = useDenominatedPoolStore();
  const denominatedSolBalance = getActiveNotes()
    .filter(n => n.token === 'SOL')
    .reduce((sum, n) => sum + n.denomination, 0);

  useEffect(() => { initSettings(); }, []);

  useFocusEffect(
    useCallback(() => {
      const task = InteractionManager.runAfterInteractions(() => {
        if (initialized && !loading && hasWallet && transactions.length === 0) {
          refreshTransactions();
        }
      });
      return () => task.cancel();
    }, [initialized, loading, hasWallet, transactions.length, refreshTransactions])
  );

  useEffect(() => {
    if (!securityLoading) {
      setBalanceHidden(securitySettings.hideBalanceByDefault);
    }
  }, [securitySettings.hideBalanceByDefault, securityLoading]);

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
          <ActivityIndicator size="large" color={Colors.primary} accessibilityLabel={t('wallet.loadingWallet')} />
          <Text style={styles.loadingText} accessibilityRole="text">{t('wallet.loadingWallet')}</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!hasWallet) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.loadingContainer}>
          <Text style={styles.noWalletTitle} accessibilityRole="header">{t('wallet.noWallet')}</Text>
          <Text style={styles.noWalletDesc}>{t('wallet.noWalletDesc')}</Text>
          <TouchableOpacity onPress={() => router.replace('/(onboarding)')} style={styles.setupBtn}
            accessibilityRole="button" accessibilityLabel={t('wallet.setupWallet')}>
            <Text style={styles.setupBtnText}>{t('wallet.setupWallet')}</Text>
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
        <Animated.View style={styles.balanceCardOuter}>
          <View style={styles.balanceCard}>

            {/* Address chip */}
            <TouchableOpacity style={styles.addressChip} onPress={copyAddress} accessibilityRole="button" accessibilityLabel={`${t('wallet.copyAddress')} ${formattedPublicKey}`} accessibilityHint={t('wallet.addressCopied')}>
              <View style={styles.addressDot} />
              <Text style={styles.addressText}>{formattedPublicKey}</Text>
              <Ionicons name="copy-outline" size={12} color={Colors.textTertiary} />
            </TouchableOpacity>

            {/* Balance */}
            <TouchableOpacity onPress={toggleBalanceVisibility} activeOpacity={0.8} accessibilityRole="button" accessibilityLabel={balanceHidden ? t('wallet.showBalance') : t('wallet.hideBalance')} accessibilityHint={balanceHidden ? t('wallet.showBalance') : t('wallet.hideBalance')}>
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
                      <DevnetAirdropFAB
                        publicKey={publicKey}
                        requestAirdrop={async (amount: number) => { await requestDevnetAirdrop(amount); }}
                        refreshBalance={refreshBalance}
                      />
                    </View>
                  </>
                )}
              </Animated.View>
            </TouchableOpacity>

            {/* Action buttons */}
            <View style={[styles.actionButtons, isDevnet() && styles.actionButtonsDevnet]}>
              <TouchableOpacity style={styles.actionButton} onPress={() => router.push('/(main)/(wallet)/send')} accessibilityLabel={t('wallet.send')} accessibilityRole="button">
                <View style={[styles.actionIcon, { backgroundColor: 'rgba(57, 197, 187, 0.12)' }]}>
                  <Ionicons name="arrow-up" size={20} color={P01Colors.cyan} />
                </View>
                <Text style={[styles.actionLabel, { color: P01Colors.cyan }]}>{t('wallet.send')}</Text>
              </TouchableOpacity>

              <TouchableOpacity style={styles.actionButton} onPress={() => router.push('/(main)/(wallet)/receive')} accessibilityLabel={t('wallet.receive')} accessibilityRole="button">
                <View style={[styles.actionIcon, { backgroundColor: 'rgba(57, 197, 187, 0.08)' }]}>
                  <Ionicons name="arrow-down" size={20} color={P01Colors.cyan} />
                </View>
                <Text style={[styles.actionLabel, { color: Colors.textSecondary }]}>{t('wallet.receive')}</Text>
              </TouchableOpacity>

              <TouchableOpacity style={styles.actionButton} onPress={() => router.push('/(main)/(wallet)/swap')} accessibilityLabel={t('wallet.swap')} accessibilityRole="button">
                <View style={[styles.actionIcon, { backgroundColor: 'rgba(255, 119, 168, 0.08)' }]}>
                  <Ionicons name="swap-horizontal" size={20} color={P01Colors.pink} />
                </View>
                <Text style={[styles.actionLabel, { color: Colors.textSecondary }]}>{t('wallet.swap')}</Text>
              </TouchableOpacity>

              {!isDevnet() && (
                <TouchableOpacity style={styles.actionButton} onPress={() => router.push('/(main)/(wallet)/buy')} accessibilityLabel={t('wallet.buy')} accessibilityRole="button">
                  <View style={[styles.actionIcon, { backgroundColor: 'rgba(255, 119, 168, 0.06)' }]}>
                    <Ionicons name="card" size={20} color={P01Colors.pink} />
                  </View>
                  <Text style={[styles.actionLabel, { color: Colors.textSecondary }]}>{t('wallet.buy')}</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </Animated.View>

        {/* Privacy Summary Pill — taps to Privacy tab */}
        <PrivacySummaryPill
          shieldedBalance={shieldedBalance}
          confidentialBalance={confidentialSolBalance}
          denominatedBalance={denominatedSolBalance}
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

    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { marginTop: Spacing.lg, color: Colors.textSecondary, fontFamily: FontFamily.medium, fontSize: 15 },
  scrollView: { flex: 1 },
  scrollContent: { paddingHorizontal: Spacing.xl, paddingBottom: 160 },
  balanceCardOuter: {
    borderRadius: BorderRadius.xl,
    overflow: 'hidden',
    marginBottom: Spacing.lg,
  },
  balanceCard: {
    padding: Spacing.xl,
    paddingTop: 20,
    backgroundColor: Colors.surfaceSecondary,
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
    gap: 6,
    marginTop: 6,
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
  },
  solBalance: { color: Colors.textTertiary, fontSize: 14, fontFamily: FontFamily.medium },
  actionButtons: { flexDirection: 'row', justifyContent: 'space-evenly' },
  actionButtonsDevnet: { justifyContent: 'space-evenly' },
  actionButton: { alignItems: 'center', justifyContent: 'center', paddingVertical: Spacing.xs, minWidth: 56 },
  actionIcon: { width: 44, height: 44, borderRadius: 14, justifyContent: 'center', alignItems: 'center', marginBottom: 5 },
  actionLabel: { color: Colors.textSecondary, fontSize: 11, fontFamily: FontFamily.medium },

  // No wallet
  noWalletTitle: { color: Colors.text, fontSize: 18, fontFamily: FontFamily.semibold, marginBottom: 8 },
  noWalletDesc: { color: Colors.textSecondary, fontSize: 14, fontFamily: FontFamily.regular, textAlign: 'center', marginBottom: 24, paddingHorizontal: 32 },
  setupBtn: { backgroundColor: P01Colors.cyan, paddingHorizontal: 28, paddingVertical: 14, borderRadius: BorderRadius.md },
  setupBtnText: { color: '#000', fontFamily: FontFamily.bold, fontSize: 15 },
});

/**
 * The wallet home screen — the front door.
 *
 * 🎯 REWORKED 2026-08-23, on the realigned theme and the founder's product
 * ruling. What it used to be, and why each piece went:
 *
 *  - THE FIAT NUMBER WAS THE HERO AND IT WAS NOT ALWAYS REAL. A 42pt
 *    `formatAmount(balance?.totalUsd || 0)` sat at the top of the screen. The
 *    price feed returns 0 when CoinGecko fails (services/solana/balance.ts:117),
 *    so a wallet holding 2 SOL rendered "$0.00" in the largest type on the app
 *    whenever the network hiccuped. SOL is the hero now — it is the number the
 *    wallet actually knows — and the fiat line appears only when a price was
 *    looked up.
 *
 *  - THE ACTIONS WERE SEND, RECEIVE AND SWAP. Two of those are the parked
 *    personal-payments product and the third is a token swap; none of them is
 *    what Styx is for. The row is Send, Receive, Shield, Subscribe, so the
 *    product is reachable from the front door instead of hiding behind a tab.
 *
 *  - THERE WAS NO SIGN OF A SUBSCRIPTION ANYWHERE. Merchant subscriptions are
 *    the product. There is a strip for them now, beside the private balance.
 *
 *  - ⛔ THE COMMENTED-OUT QUANTUM CTA IS DELETED. Forty lines of inline styles
 *    behind a `{/* ... *\/}`, dead since the Dublin scope lock in May. Dead code
 *    in a comment is still dead code, and this one carried its own copy of the
 *    old palette.
 *
 * ⚠️ ONE COPY CONTROL FOR THE ADDRESS. There was a chip under the header and
 * the Receive screen has its own; two silent copy affordances for the same
 * string is one too many. This one is 44pt, named, and says so when it fires.
 *
 * 🚨 NOTHING HERE FETCHES ANYTHING NEW. The subscriptions strip reads the
 * stream store as it stands and says "None yet" until the Subs tab has
 * hydrated it. Adding a fetch to the home screen would be a behaviour change,
 * and this is a UI pass.
 */

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
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';

import { useWalletStore } from '@/stores/walletStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useShieldedStore } from '@/stores/shieldedStore';
import { useConfidentialStore } from '@/stores/confidentialStore';
import { useDenominatedPoolStore } from '@/stores/denominatedPoolStore';
import { useStreamStore } from '@/stores/streamStore';
import { useSecuritySettings } from '@/hooks/useSecuritySettings';
import {
  Colors,
  FontFamily,
  FontSize,
  BorderRadius,
  Spacing,
  Layout,
} from '@/constants/theme';
import { formatBalance } from '@/services/solana/balance';
import { Button } from '@/components/ui/Button';

import { useT } from '@/i18n';
import WalletHeader from '@/components/wallet/WalletHeader';
import PrivacySummaryPill from '@/components/wallet/PrivacySummaryPill';
import SubscriptionsStrip from '@/components/wallet/SubscriptionsStrip';
import AssetsList from '@/components/wallet/AssetsList';
import RecentActivity from '@/components/wallet/RecentActivity';
import DevnetAirdropFAB from '@/components/wallet/DevnetAirdropFAB';

export default function WalletHomeScreen() {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { settings: securitySettings, isLoading: securityLoading } = useSecuritySettings();
  const { formatAmount, initialize: initSettings } = useSettingsStore();
  // Start hidden until security settings load — prevents flash of visible balance
  const [balanceHidden, setBalanceHidden] = useState(true);
  const [addressCopied, setAddressCopied] = useState(false);

  // Local wallet only (Privy removed — spec §3 Phase 1).
  const {
    initialized,
    loading,
    hasWallet,
    publicKey,
    balance,
    transactions,
    refreshing,
    refreshBalance,
    refreshTransactions,
    requestDevnetAirdrop,
  } = useWalletStore();

  const formattedPublicKey = publicKey
    ? `${publicKey.slice(0, 4)}…${publicKey.slice(-4)}`
    : '';

  const formattedSolBalance = balance ? formatBalance(balance.sol) : '0';

  /**
   * ⚠️ THE HALF OF THE BALANCE THAT CAN BE UNKNOWN. `getSolPrice` returns 0 on
   * a failed fetch, so `totalUsd` is 0 both when the wallet is empty and when
   * the price lookup fell over. Only the first of those is worth printing.
   */
  const fiatKnown = !!balance && ((balance.solUsd ?? 0) > 0 || balance.sol === 0);
  const formattedFiat = fiatKnown ? formatAmount(balance?.totalUsd || 0) : undefined;

  const { shieldedBalance } = useShieldedStore();
  const { balances: confidentialBalances } = useConfidentialStore();
  const confidentialSolBalance = (confidentialBalances['11111111111111111111111111111111'] || 0) / 1e9;
  const { getActiveNotes } = useDenominatedPoolStore();
  const denominatedSolBalance = getActiveNotes()
    .filter(n => n.token === 'SOL')
    .reduce((sum, n) => sum + n.denomination, 0);

  // Read-only. See the header note: the Subs tab owns hydration.
  const streams = useStreamStore((s) => s.streams);
  const activeStreams = streams.filter((s) => s.status === 'active');
  const nextPaymentAt = activeStreams.length
    ? Math.min(...activeStreams.map((s) => s.nextPaymentDate))
    : undefined;

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

  const onRefresh = useCallback(async () => {
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await Promise.all([refreshBalance(), refreshTransactions()]);
  }, [refreshBalance, refreshTransactions]);

  const toggleBalanceVisibility = () => {
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setBalanceHidden(!balanceHidden);
  };

  const copyAddress = async () => {
    if (publicKey) {
      await Clipboard.setStringAsync(publicKey);
      setAddressCopied(true);
      setTimeout(() => setAddressCopied(false), 2000);
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

  // No wallet after init (e.g. just after Disconnect / Delete Wallet) → return to
  // the welcome menu automatically instead of stranding the user on a manual
  // "set up" button. Guarded by !loading so a transient boot frame can't fire it
  // (at boot, reaching the wallet tab always means hasWallet is true).
  useEffect(() => {
    if (initialized && !loading && !hasWallet) {
      router.replace('/(onboarding)');
    }
  }, [initialized, loading, hasWallet, router]);

  if ((!initialized || (loading && !hasWallet)) && !loadTimeout) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centred}>
          <ActivityIndicator size="large" color={Colors.primary} accessibilityLabel={t('wallet.loadingWallet')} />
          <Text style={styles.loadingText} accessibilityRole="text">{t('wallet.loadingWallet')}</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!hasWallet) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centred}>
          <Text style={styles.noWalletTitle} accessibilityRole="header">{t('wallet.noWallet')}</Text>
          <Text style={styles.noWalletDesc}>{t('wallet.noWalletDesc')}</Text>
          <Button
            variant="primary"
            size="lg"
            onPress={() => router.replace('/(onboarding)')}
            accessibilityLabel={t('wallet.setupWallet')}
            style={styles.setupButton}
          >
            {t('wallet.setupWallet')}
          </Button>
        </View>
      </SafeAreaView>
    );
  }

  const ACTIONS: {
    key: string;
    label: string;
    icon: keyof typeof Ionicons.glyphMap;
    onPress: () => void;
  }[] = [
    {
      key: 'send',
      label: t('wallet.send'),
      icon: 'arrow-up',
      onPress: () => router.push('/(main)/(wallet)/send'),
    },
    {
      key: 'receive',
      label: t('wallet.receive'),
      icon: 'arrow-down',
      onPress: () => router.push('/(main)/(wallet)/receive'),
    },
    {
      key: 'shield',
      label: t('wallet.shield'),
      icon: 'shield-half-outline',
      onPress: () => router.push('/(main)/(privacy)'),
    },
    {
      // Subscribing starts by choosing a merchant, and the registry lives on
      // Discover. Sending someone straight to a subscribe form with no service
      // selected is the dead end the extension removed.
      key: 'subscribe',
      label: t('wallet.subscribe'),
      icon: 'repeat',
      onPress: () => router.push('/(main)/(discover)'),
    },
  ];

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <WalletHeader
        onScan={() => router.push('/(main)/(wallet)/scan')}
        onSettings={() => router.push('/(main)/(settings)')}
      />

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: Layout.tabBarTotalHeight + insets.bottom + Spacing['2xl'] },
        ]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} colors={[Colors.primary]} />
        }
      >
        {/* ── The balance ─────────────────────────────────────────────── */}
        <View style={styles.balanceBlock}>
          <View style={styles.balanceLabelRow}>
            <Text style={styles.balanceLabel}>{t('wallet.totalBalance')}</Text>
            <TouchableOpacity
              onPress={toggleBalanceVisibility}
              style={styles.eyeButton}
              accessibilityRole="button"
              accessibilityLabel={balanceHidden ? t('wallet.showBalance') : t('wallet.hideBalance')}
            >
              <Ionicons
                name={balanceHidden ? 'eye-outline' : 'eye-off-outline'}
                size={18}
                color={Colors.textTertiary}
              />
            </TouchableOpacity>
          </View>

          {balanceHidden ? (
            <Text style={styles.balanceAmount}>••••</Text>
          ) : (
            <>
              <View style={styles.balanceRow}>
                <Text style={styles.balanceAmount}>{formattedSolBalance}</Text>
                <Text style={styles.balanceUnit}>SOL</Text>
              </View>
              {formattedFiat ? <Text style={styles.balanceFiat}>{formattedFiat}</Text> : null}
            </>
          )}
        </View>

        {/* ── The one copy control for this wallet's address ───────────── */}
        <TouchableOpacity
          style={styles.addressRow}
          onPress={copyAddress}
          accessibilityRole="button"
          accessibilityLabel={`${t('wallet.copyAddress')}, ${formattedPublicKey}`}
          accessibilityHint={t('wallet.addressCopied')}
        >
          <Text style={styles.addressText}>{formattedPublicKey}</Text>
          <Ionicons
            name={addressCopied ? 'checkmark' : 'copy-outline'}
            size={15}
            color={addressCopied ? Colors.primary : Colors.textTertiary}
          />
          {addressCopied ? <Text style={styles.copiedText}>{t('common.copied')}</Text> : null}
        </TouchableOpacity>

        {/* ── The four things this wallet does ─────────────────────────── */}
        <View style={styles.actions}>
          {ACTIONS.map((action) => (
            <TouchableOpacity
              key={action.key}
              style={styles.action}
              onPress={action.onPress}
              accessibilityRole="button"
              accessibilityLabel={action.label}
            >
              <View style={styles.actionIcon}>
                <Ionicons name={action.icon} size={20} color={Colors.primary} />
              </View>
              <Text style={styles.actionLabel}>{action.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Devnet only, and it returns null everywhere else. */}
        <View style={styles.airdropRow}>
          <DevnetAirdropFAB
            publicKey={publicKey}
            requestAirdrop={async (amount: number) => { await requestDevnetAirdrop(amount); }}
            refreshBalance={refreshBalance}
          />
        </View>

        {/* ── The two strips: what is private, and what is recurring ───── */}
        <View style={styles.strips}>
          <PrivacySummaryPill
            shieldedBalance={shieldedBalance}
            confidentialBalance={confidentialSolBalance}
            denominatedBalance={denominatedSolBalance}
            onPress={() => router.push('/(main)/(privacy)')}
          />
          <SubscriptionsStrip
            activeCount={activeStreams.length}
            nextPaymentAt={nextPaymentAt}
            onPress={() => router.push('/(main)/(streams)')}
          />
        </View>

        <AssetsList
          solBalance={formattedSolBalance}
          formattedUsd={formattedFiat}
          tokens={balance?.tokens || []}
          balanceHidden={balanceHidden}
          formatAmount={formatAmount}
        />

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
  centred: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: Spacing['3xl'],
  },
  loadingText: {
    marginTop: Spacing.lg,
    color: Colors.textSecondary,
    fontFamily: FontFamily.regular,
    fontSize: FontSize.md,
  },
  scrollView: { flex: 1 },
  scrollContent: { paddingHorizontal: Spacing.xl },

  // Balance
  balanceBlock: {
    paddingTop: Spacing['3xl'],
    paddingBottom: Spacing['2xl'],
  },
  balanceLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
  },
  balanceLabel: {
    color: Colors.textSecondary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
  },
  eyeButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  balanceRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: Spacing.sm,
  },
  balanceAmount: {
    color: Colors.text,
    fontSize: FontSize['4xl'],
    fontFamily: FontFamily.display,
    letterSpacing: -1,
  },
  balanceUnit: {
    color: Colors.textSecondary,
    fontSize: FontSize.xl,
    fontFamily: FontFamily.display,
  },
  balanceFiat: {
    color: Colors.textSecondary,
    fontSize: FontSize.md,
    fontFamily: FontFamily.mono,
    marginTop: Spacing.xs,
  },

  // Address
  addressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: Spacing.sm,
    minHeight: 44,
    paddingRight: Spacing.md,
  },
  addressText: {
    color: Colors.textSecondary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.mono,
  },
  copiedText: {
    color: Colors.primary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
  },

  // Actions
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: Spacing.lg,
    marginBottom: Spacing['2xl'],
  },
  action: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    minHeight: 76,
  },
  actionIcon: {
    width: 48,
    height: 48,
    borderRadius: BorderRadius.md,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: Colors.primaryDim,
  },
  actionLabel: {
    color: Colors.textSecondary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
  },

  airdropRow: {
    alignSelf: 'flex-start',
    marginBottom: Spacing['2xl'],
  },

  strips: {
    gap: Spacing.md,
    marginBottom: Spacing['2xl'],
  },

  // No wallet
  noWalletTitle: {
    color: Colors.text,
    fontSize: FontSize['2xl'],
    fontFamily: FontFamily.display,
    marginBottom: Spacing.sm,
    textAlign: 'center',
  },
  noWalletDesc: {
    color: Colors.textSecondary,
    fontSize: FontSize.md,
    fontFamily: FontFamily.regular,
    textAlign: 'center',
    marginBottom: Spacing['3xl'],
    lineHeight: 22,
  },
  setupButton: { alignSelf: 'stretch' },
});

/**
 * Settings — the index.
 *
 * 🎯 REBUILT ON THE REALIGNED THEME AND THE SHARED KIT 2026-08-23.
 *
 * WHAT WAS HERE. A local `GlassCard`, a local `SectionTitle` and a local
 * `GlassDivider`, none of which were glass and all three of which existed
 * identically in five sibling files. Their fills were hex literals
 * (`#0d0d10`, `rgba(255,255,255,0.06)`) written inline, so the token sweep over
 * `constants/theme.ts` could not reach this screen at all. Every section header
 * was `.toUpperCase()`, and eight elements faded in on a staggered 50→540ms
 * ladder — half a second of choreography to show a list of links.
 *
 * All three components are now `components/settings/`, which existed and which
 * nothing imported.
 *
 * ⛔ TWO ROWS DELETED, NOT RESTYLED.
 *   - "RPC Endpoint · Solana" pushed to `/network`, the same route as the
 *     Network row directly above it, and its value was the word "Solana" —
 *     a constant, on a Solana wallet. Two rows, one destination, no decision.
 *   - The version footer restated `v… · CODENAME`, which the About row two
 *     lines above already shows as its value.
 *
 * ⚠️ THE DANGER ZONE STAYS BEHIND A DISCLOSURE and stays last. Deleting the
 * wallet is the one irreversible action in the app; it should be reachable and
 * never adjacent to something ordinary.
 *
 * 🚨 `app/_layout.tsx` sets `Text.defaultProps.allowFontScaling = false` for
 * the whole app, so Dynamic Type does nothing here. Left alone deliberately —
 * see the report; turning it on needs a layout pass over every screen, not one.
 */

import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { p01Alert } from '@/stores/alertStore';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import * as Linking from 'expo-linking';
import Constants from 'expo-constants';

import { Header } from '@/components/common';
import { Button } from '@/components/ui';
import { SettingsRow, SettingsSection, ToggleRow, CurrencyModal } from '../../../components/settings';
import { useWalletStore } from '../../../stores/walletStore';
import { useSettingsStore, Currency, CURRENCY_SYMBOLS } from '../../../stores/settingsStore';
import { useShieldedStore } from '../../../stores/shieldedStore';
import { useConfidentialStore } from '../../../stores/confidentialStore';
import { useDenominatedPoolStore } from '../../../stores/denominatedPoolStore';
import { useSubscriptionVaultStore } from '../../../stores/subscriptionVaultStore';
import { useStreamStore } from '../../../stores/streamStore';
import { lockVault } from '../../../utils/crypto/noteVault';
import { getCluster } from '../../../services/solana/connection';
import { Colors, FontFamily, FontSize, BorderRadius, Spacing, Layout } from '@/constants/theme';
import { RELEASE_CODENAME } from '@/constants/release';
import { useT, LANGUAGES, useLangStore } from '@/i18n';

export default function SettingsScreen() {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // Local wallet only (Privy removed — spec §3 Phase 1).
  const { publicKey, logout: walletLogout, hasWallet: hasLocalWallet, balance } = useWalletStore();
  const {
    currency,
    setCurrency,
    initialize: initSettings,
    shieldedWalletEnabled,
    confidentialBalanceEnabled,
    setShieldedWalletEnabled,
    setConfidentialBalanceEnabled,
  } = useSettingsStore();
  const { shieldedBalance, notes: shieldedNotes } = useShieldedStore();
  const { balances: confidentialBalances, pendingCredits } = useConfidentialStore();

  const { getActiveNotes } = useDenominatedPoolStore();
  const denominatedNotes = getActiveNotes();
  const hasDenominatedFunds = denominatedNotes.length > 0;
  const hasShieldedFunds = shieldedBalance > 0 || shieldedNotes.filter(n => Number(n.amount) > 0).length > 0;
  const confidentialSolBalance = (confidentialBalances['11111111111111111111111111111111'] || 0) / 1e9;
  const hasConfidentialFunds = confidentialSolBalance > 0 || (pendingCredits['11111111111111111111111111111111'] || 0) > 0;
  const hasLegacyFunds = hasShieldedFunds || hasConfidentialFunds;
  const solBalance = balance?.sol ?? 0;
  const hasAnyFunds = solBalance > 0.01 || hasLegacyFunds || hasDenominatedFunds;
  const [copied, setCopied] = useState(false);
  const [currencyModalVisible, setCurrencyModalVisible] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    initSettings();
  }, []);

  const walletAddress = publicKey || '';
  const truncatedAddress = walletAddress
    ? `${walletAddress.slice(0, 4)}…${walletAddress.slice(-4)}`
    : 'No wallet';

  const currentNetwork = getCluster();
  const networkDisplay = currentNetwork === 'mainnet-beta' ? 'Mainnet' :
                         currentNetwork === 'devnet' ? 'Devnet' : 'Testnet';

  const handleCopyAddress = async () => {
    if (!walletAddress) return;
    await Clipboard.setStringAsync(walletAddress);
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCurrencySelect = () => {
    setCurrencyModalVisible(true);
  };

  const handleNotifications = () => {
    Linking.openSettings();
  };

  const handleDisconnect = () => {
    // Disconnect = full sign-out. It ERASES this wallet's keypair from the device
    // (walletLogout -> deleteWallet) so hasWallet becomes false; router.replace('/')
    // then hits the boot router which lands the user on /(onboarding) — the welcome
    // menu (create / import seed). This is destructive, but it is reversible with the
    // recovery phrase: re-importing the same seed re-derives the same address (SOL is
    // on-chain) and the seed-derived notes (re-import on this device restores the local
    // archive; otherwise an on-chain rescan recovers them). So we do NOT hard-block on
    // funds the way Delete Wallet does — that would stop a normal (fee-funded) wallet
    // from ever reaching the welcome menu, which is exactly what the user asked for.
    // Instead: informed consent — list what is at stake, name the seed-only recovery,
    // and offer a one-tap backup escape before the irreversible delete.
    const activeVaults = useSubscriptionVaultStore.getState().vaults.length;
    const activeStreams = useStreamStore.getState().streams.filter((s) => s.status === 'active').length;

    const stakes: string[] = [];
    if (solBalance > 0) stakes.push(`${solBalance.toFixed(4)} SOL`);
    if (hasDenominatedFunds) stakes.push(`${denominatedNotes.length} shielded note${denominatedNotes.length !== 1 ? 's' : ''}`);
    if (hasShieldedFunds) stakes.push('shielded balance');
    if (hasConfidentialFunds) stakes.push('confidential balance');
    if (activeVaults > 0) stakes.push(`${activeVaults} subscription${activeVaults !== 1 ? 's' : ''}`);
    if (activeStreams > 0) stakes.push(`${activeStreams} payment stream${activeStreams !== 1 ? 's' : ''}`);

    // Subscriptions can hold a device-local subscriber secret that is NOT seed-derived,
    // so if any exist, steer the user to cancel/move first rather than risk stranding them.
    const message = stakes.length > 0
      ? `${t('settings.disconnectConfirm')}\n\n${t('settings.disconnectStillHolds')}\n${stakes.join('\n')}`
      : t('settings.disconnectConfirm');

    p01Alert(
      t('settings.disconnect'),
      message,
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('settings.backupPhraseFirst'), onPress: () => router.push('/(main)/(settings)/backup') },
        {
          text: t('settings.disconnect'),
          style: 'destructive',
          onPress: async () => {
            try {
              lockVault(); // wipe vault key from memory
              await SecureStore.deleteItemAsync('p01_session_unlocked');
              // walletLogout() deletes the keypair, archives notes by pubkey, and
              // sets hasWallet=false. Navigate to the welcome menu with the EXPLICIT
              // group path: this handler is 3 navigators deep (root Stack > (main)
              // Tabs > (settings) Stack), and a bare router.replace('/') does not
              // escape that nesting — it gets applied inside the (settings) stack and
              // leaves the user stuck on Settings. '/(onboarding)' resolves to the
              // root sibling and unwinds cleanly (same call the wallet fallback uses).
              await walletLogout();
              await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              router.replace('/(onboarding)');
            } catch (error) {
              await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
              p01Alert(t('common.error'), t('alerts.errorGeneric'));
            }
          },
        },
      ],
      'warning',
    );
  };

  const handleDeleteWallet = async () => {
    // Block deletion if wallet still has funds
    if (hasAnyFunds) {
      const parts: string[] = [];
      if (solBalance > 0.01) parts.push(`${solBalance.toFixed(4)} SOL`);
      if (hasDenominatedFunds) parts.push(`${denominatedNotes.length} shielded note${denominatedNotes.length !== 1 ? 's' : ''}`);
      if (hasShieldedFunds) parts.push('shielded balance');
      if (hasConfidentialFunds) parts.push('confidential balance');

      p01Alert(
        t('common.warning'),
        `You still have funds in this wallet:\n\n${parts.join('\n')}\n\nTransfer all funds to another wallet before deleting. This protects you from losing assets.`,
        [
          { text: t('common.send'), onPress: () => router.push('/(main)/(wallet)/send') },
          { text: t('common.cancel'), style: 'cancel' },
        ],
        'warning',
      );
      return;
    }

    // Require biometric authentication first
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const isEnrolled = await LocalAuthentication.isEnrolledAsync();

    if (hasHardware && isEnrolled) {
      const authResult = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Authenticate to delete the wallet',
        cancelLabel: t('common.cancel'),
        disableDeviceFallback: false,
      });

      if (!authResult.success) {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }
    }

    p01Alert(
      t('settings.resetWallet'),
      t('settings.resetConfirm'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.confirm'),
          style: 'destructive',
          onPress: () => {
            p01Alert(
              t('common.confirm'),
              t('settings.resetConfirm'),
              [
                { text: t('common.cancel'), style: 'cancel' },
                {
                  text: t('common.delete'),
                  style: 'destructive',
                  onPress: async () => {
                    try {
                      await walletLogout();
                      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
                      // Explicit group path — '/' does not escape the nested
                      // root Stack > (main) Tabs > (settings) Stack (see handleDisconnect).
                      router.replace('/(onboarding)');
                    } catch (error) {
                      p01Alert(t('common.error'), t('alerts.errorGeneric'));
                    }
                  },
                },
              ]
            );
          },
        },
      ]
    );
  };

  return (
    <View style={styles.screen}>
      <Header title={t('settings.title')} showBack onBackPress={() => router.back()} />

      <ScrollView
        style={styles.flex}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingBottom: Layout.tabBarTotalHeight + insets.bottom + Spacing['3xl'],
        }}
      >
        {/* ── The wallet this is. One row, and the only thing it does is copy. ── */}
        <SettingsSection style={styles.firstSection}>
          <TouchableOpacity
            style={styles.walletRow}
            onPress={handleCopyAddress}
            disabled={!walletAddress}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={
              walletAddress ? `Copy wallet address ${truncatedAddress}` : t('wallet.noWallet')
            }
          >
            <View style={styles.walletText}>
              <Text style={styles.walletLabel}>{t('wallet.title')}</Text>
              <Text style={styles.walletAddress} numberOfLines={1}>
                {walletAddress ? truncatedAddress : t('wallet.noWallet')}
              </Text>
            </View>
            {copied ? (
              <View style={styles.copiedRow}>
                <Ionicons name="checkmark" size={16} color={Colors.primary} />
                <Text style={styles.copiedText}>{t('common.copied')}</Text>
              </View>
            ) : walletAddress ? (
              <Ionicons name="copy-outline" size={18} color={Colors.textTertiary} />
            ) : null}
          </TouchableOpacity>
        </SettingsSection>

        {/* ── Security ── */}
        <SettingsSection title={t('settings.security')}>
          <SettingsRow
            label={t('settings.security')}
            leftIcon="shield-outline"
            onPress={() => router.push('/(main)/(settings)/security')}
          />
          <SettingsRow
            label={t('settings.backup')}
            leftIcon="key-outline"
            onPress={() => router.push('/(main)/(settings)/backup')}
          />
          <SettingsRow
            label="Connect to extension"
            description="Send this wallet to the browser extension"
            leftIcon="desktop-outline"
            onPress={() => router.push('/(main)/(settings)/connect-extension')}
          />
        </SettingsSection>

        {/* ── Privacy ── */}
        <SettingsSection title={t('settings.privacy')}>
          <SettingsRow
            label={t('settings.privacy')}
            description="Decoys, stealth addresses and relay routing"
            leftIcon="eye-off-outline"
            onPress={() => router.push('/(main)/(settings)/privacy')}
          />
        </SettingsSection>

        {/* ⚠️ Two retired modules, kept switchable because money can still be
            sitting in them. The balance is stated on the row itself when there
            is one — a toggle that quietly holds funds is how they get lost. */}
        <SettingsSection
          title={t('settings.privacyFeatures')}
          footer="Both are superseded by the denominated privacy pool. Turn one on only to move money out of it."
        >
          <ToggleRow
            label="Shielded wallet"
            description={hasShieldedFunds
              ? `Retired. ${shieldedBalance.toFixed(4)} SOL still in the pool — withdraw it.`
              : 'Retired. Variable amounts, so a deposit and its withdrawal match on size.'}
            value={shieldedWalletEnabled}
            onValueChange={setShieldedWalletEnabled}
          />
          <ToggleRow
            label="Confidential balance"
            description={hasConfidentialFunds
              ? `Retired. ${confidentialSolBalance.toFixed(4)} SOL still confidential — withdraw it.`
              : 'Retired. Hides token amounts on chain; sender and recipient stay visible.'}
            value={confidentialBalanceEnabled}
            onValueChange={setConfidentialBalanceEnabled}
          />
        </SettingsSection>

        {/* ── Network ── */}
        <SettingsSection title={t('settings.network')}>
          <SettingsRow
            label={t('settings.network')}
            value={networkDisplay}
            leftIcon="globe-outline"
            onPress={() => router.push('/(main)/(settings)/network')}
          />
        </SettingsSection>

        {/* ── Preferences ── */}
        <SettingsSection title={t('settings.general')}>
          <SettingsRow
            label="Currency"
            value={`${currency} ${CURRENCY_SYMBOLS[currency]}`}
            leftIcon="cash-outline"
            onPress={handleCurrencySelect}
          />
          <SettingsRow
            label={t('settings.notifications')}
            description="Opens this app's page in system settings"
            leftIcon="notifications-outline"
            onPress={handleNotifications}
          />

          <View style={styles.languageBlock}>
            <Text style={styles.languageLabel}>{t('settings.language')}</Text>
            <View style={styles.languageChoices} accessibilityRole="radiogroup">
              {LANGUAGES.map((lang) => {
                const isActive = useLangStore.getState().locale === lang.id;
                return (
                  <TouchableOpacity
                    key={lang.id}
                    onPress={() => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      useLangStore.getState().setLocale(lang.id);
                    }}
                    activeOpacity={0.7}
                    accessibilityRole="radio"
                    accessibilityLabel={lang.label}
                    accessibilityState={{ checked: isActive }}
                    style={[styles.languageChoice, isActive && styles.languageChoiceActive]}
                  >
                    <Text style={[styles.languageNative, isActive && styles.languageNativeActive]}>
                      {lang.native}
                    </Text>
                    <Text style={[styles.languageSub, isActive && styles.languageSubActive]}>
                      {lang.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        </SettingsSection>

        {/* ── About ── */}
        <SettingsSection title={t('settings.about')}>
          <SettingsRow
            label={t('settings.about')}
            value={`v${Constants.expoConfig?.version ?? '0.0.0'} · ${RELEASE_CODENAME}`}
            leftIcon="information-circle-outline"
            onPress={() => router.push('/(main)/(settings)/about')}
          />
        </SettingsSection>

        {/* ── Leaving. Not styled as a primary action: it is not one. ── */}
        <View style={styles.disconnectWrap}>
          <Button
            variant="secondary"
            fullWidth
            onPress={handleDisconnect}
            accessibilityLabel="Disconnect this wallet from the device"
            icon={<Ionicons name="log-out-outline" size={18} color={Colors.text} />}
          >
            {t('settings.disconnect')}
          </Button>
        </View>

        {/* ── The one irreversible thing in the app, behind a disclosure. ── */}
        <View style={styles.dangerWrap}>
          <TouchableOpacity
            onPress={() => setShowAdvanced(!showAdvanced)}
            activeOpacity={0.7}
            style={styles.dangerToggle}
            accessibilityRole="button"
            accessibilityLabel={showAdvanced ? 'Hide advanced options' : 'Show advanced options'}
            accessibilityState={{ expanded: showAdvanced }}
          >
            <Text style={styles.dangerToggleText}>{t('settings.dangerZone')}</Text>
            <Ionicons
              name={showAdvanced ? 'chevron-up' : 'chevron-down'}
              size={14}
              color={Colors.textTertiary}
            />
          </TouchableOpacity>

          {showAdvanced ? (
            <View style={styles.dangerBody}>
              <Text style={styles.dangerNote}>
                Deleting removes the keypair from this device. Only your recovery phrase
                brings it back.
              </Text>
              <Button
                variant="danger"
                fullWidth
                onPress={handleDeleteWallet}
                accessibilityLabel="Delete wallet permanently"
                icon={<Ionicons name="trash-outline" size={16} color={Colors.error} />}
              >
                {t('settings.resetWallet')}
              </Button>
            </View>
          ) : null}
        </View>
      </ScrollView>

      <CurrencyModal
        visible={currencyModalVisible}
        currentCurrency={currency}
        onSelect={setCurrency}
        onClose={() => setCurrencyModalVisible(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  flex: {
    flex: 1,
  },
  firstSection: {
    marginTop: Spacing.lg,
  },

  /* Wallet */
  walletRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    minHeight: 60,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.lg,
  },
  walletText: {
    flex: 1,
    minWidth: 0,
  },
  walletLabel: {
    color: Colors.textTertiary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
  },
  walletAddress: {
    color: Colors.text,
    fontSize: FontSize.md,
    fontFamily: FontFamily.mono,
    marginTop: 3,
  },
  copiedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
  },
  copiedText: {
    color: Colors.primary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
  },

  /* Language */
  languageBlock: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.lg,
  },
  languageLabel: {
    color: Colors.text,
    fontSize: FontSize.md,
    fontFamily: FontFamily.regular,
    marginBottom: Spacing.md,
  },
  languageChoices: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  languageChoice: {
    flex: 1,
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: BorderRadius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: 'transparent',
  },
  languageChoiceActive: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primaryDim,
  },
  languageNative: {
    fontSize: FontSize.sm,
    fontFamily: FontFamily.medium,
    color: Colors.textSecondary,
  },
  languageNativeActive: {
    color: Colors.primary,
  },
  languageSub: {
    fontSize: FontSize.xs,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    marginTop: 2,
  },
  languageSubActive: {
    color: Colors.primaryMuted,
  },

  /* Disconnect */
  disconnectWrap: {
    marginTop: Spacing['3xl'],
    paddingHorizontal: Spacing.xl,
  },

  /* Danger zone */
  dangerWrap: {
    marginTop: Spacing['2xl'],
    paddingHorizontal: Spacing.xl,
  },
  dangerToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    minHeight: 44,
  },
  dangerToggleText: {
    color: Colors.textTertiary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
  },
  dangerBody: {
    marginTop: Spacing.md,
    gap: Spacing.md,
  },
  dangerNote: {
    color: Colors.textTertiary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    lineHeight: 19,
    textAlign: 'center',
  },
});

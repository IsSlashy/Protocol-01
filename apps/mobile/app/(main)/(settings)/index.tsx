import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { useRouter } from 'expo-router';
import { p01Alert } from '@/stores/alertStore';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import * as LocalAuthentication from 'expo-local-authentication';
import * as Linking from 'expo-linking';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { SettingsRow, ToggleRow, CurrencyModal } from '../../../components/settings';
import { useWalletStore } from '../../../stores/walletStore';
import { useSettingsStore, Currency, CURRENCY_SYMBOLS } from '../../../stores/settingsStore';
import { useShieldedStore } from '../../../stores/shieldedStore';
import { useConfidentialStore } from '../../../stores/confidentialStore';
import { useDenominatedPoolStore } from '../../../stores/denominatedPoolStore';
import { resetAllPrivacyStores } from '../../../stores/resetStores';
import { lockVault } from '../../../utils/crypto/noteVault';
import { getCluster } from '../../../services/solana/connection';
import { useAuth } from '../../../providers/PrivyProvider';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';

/* ──────────────────────── Glass Card ──────────────────────── */

interface GlassCardProps {
  children: React.ReactNode;
  delay?: number;
  style?: object;
}

const GlassCard: React.FC<GlassCardProps> = ({ children, delay = 0, style }) => (
  <Animated.View entering={FadeInDown.delay(delay).duration(350)} style={[styles.glassOuter, style]}>
    <BlurView intensity={14} tint="dark" style={styles.glassBlur}>
      <LinearGradient
        colors={['rgba(57, 197, 187, 0.06)', 'rgba(255, 119, 168, 0.03)', 'transparent']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      {children}
    </BlurView>
  </Animated.View>
);

/* ──────────────────────── Section Title ──────────────────────── */

const SectionTitle: React.FC<{ title: string; delay?: number }> = ({ title, delay = 0 }) => (
  <Animated.Text
    entering={FadeInDown.delay(delay).duration(300)}
    style={styles.sectionTitle}
  >
    {title}
  </Animated.Text>
);

/* ──────────────────────── Divider ──────────────────────── */

const GlassDivider: React.FC = () => (
  <View style={styles.divider} />
);

/* ──────────────────────── Screen ──────────────────────── */

export default function SettingsScreen() {
  const router = useRouter();
  const { publicKey: localPublicKey, logout: walletLogout, hasWallet: hasLocalWallet, balance } = useWalletStore();
  const { logout: privyLogout, walletAddress: privyWalletAddress } = useAuth();
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

  // Use Privy wallet if available, fallback to local
  const publicKey = privyWalletAddress || localPublicKey;
  const walletAddress = publicKey || '';
  const truncatedAddress = walletAddress
    ? `${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}`
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
    p01Alert(
      'Disconnect',
      'Do you want to disconnect? You will need to authenticate to access your wallet.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          onPress: async () => {
            // Archive notes before disconnecting so they persist across sessions
            const currentAddress = privyWalletAddress || localPublicKey;
            if (currentAddress) {
              await resetAllPrivacyStores(currentAddress);
            }
            try {
              await privyLogout();
            } catch (e) {
              console.warn('[Settings] Privy logout error:', e);
            }
            lockVault(); // Wipe vault key from memory
            await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            router.replace('/(auth)/login');
          },
        },
      ]
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
        'Wallet Not Empty',
        `You still have funds in this wallet:\n\n${parts.join('\n')}\n\nTransfer all funds to another wallet before deleting. This protects you from losing assets.`,
        [
          { text: 'Go to Send', onPress: () => router.push('/(main)/(wallet)/send') },
          { text: 'Cancel', style: 'cancel' },
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
        cancelLabel: 'Cancel',
        disableDeviceFallback: false,
      });

      if (!authResult.success) {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }
    }

    p01Alert(
      'Delete Wallet',
      'WARNING: This action is IRREVERSIBLE!\n\nYour wallet will be permanently deleted from this device. Make sure you have backed up your recovery phrase!',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'I understand, delete',
          style: 'destructive',
          onPress: () => {
            p01Alert(
              'Final Confirmation',
              'This action is IRREVERSIBLE. Your wallet and all associated data will be permanently deleted.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Delete Permanently',
                  style: 'destructive',
                  onPress: async () => {
                    try {
                      await privyLogout();
                      await walletLogout();
                      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
                      router.replace('/');
                    } catch (error) {
                      p01Alert('Error', 'Deletion failed. Please try again.');
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
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <Animated.View entering={FadeInDown.delay(50).duration(300)} style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="arrow-back" size={20} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Settings</Text>
        <View style={{ width: 40 }} />
      </Animated.View>

      <ScrollView
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 120 }}
      >
        {/* WALLET */}
        <SectionTitle title="WALLET" delay={80} />
        <GlassCard delay={100}>
          <TouchableOpacity
            style={styles.walletRow}
            onPress={handleCopyAddress}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={`Copy wallet address ${truncatedAddress}`}
          >
            <View style={styles.walletRowLeft}>
              <View style={styles.walletIcon}>
                <Ionicons name="wallet-outline" size={20} color={P01Colors.cyan} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowLabel}>Account</Text>
                <Text style={styles.rowSublabel}>
                  {walletAddress ? truncatedAddress : 'No wallet connected'}
                </Text>
              </View>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              {copied ? (
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Ionicons name="checkmark" size={16} color={P01Colors.cyan} />
                  <Text style={styles.copiedText}>Copied!</Text>
                </View>
              ) : (
                <Ionicons name="copy-outline" size={18} color="#666" />
              )}
            </View>
          </TouchableOpacity>
        </GlassCard>

        {/* SECURITY */}
        <SectionTitle title="SECURITY" delay={130} />
        <GlassCard delay={150}>
          <SettingsRow
            label="Security Settings"
            leftIcon="shield-outline"
            onPress={() => router.push('/(main)/(settings)/security')}
          />
          <GlassDivider />
          <SettingsRow
            label="Backup & Recovery"
            leftIcon="key-outline"
            onPress={() => router.push('/(main)/(settings)/backup')}
          />
        </GlassCard>

        {/* PRIVACY */}
        <SectionTitle title="PRIVACY" delay={180} />
        <GlassCard delay={200}>
          <SettingsRow
            label="Privacy Settings"
            leftIcon="eye-off-outline"
            onPress={() => router.push('/(main)/(settings)/privacy')}
          />
        </GlassCard>

        {/* PRIVACY FEATURES */}
        <SectionTitle title="PRIVACY FEATURES" delay={230} />
        <GlassCard delay={250}>
          <ToggleRow
            label="Shielded Wallet (Legacy)"
            description={hasShieldedFunds
              ? `${shieldedBalance.toFixed(4)} SOL in pool — withdraw recommended`
              : 'Variable-amount privacy pool. Use Privacy Pool instead for stronger anonymity.'}
            value={shieldedWalletEnabled}
            onValueChange={setShieldedWalletEnabled}
          />
          <GlassDivider />
          <ToggleRow
            label="Confidential Balance"
            description={hasConfidentialFunds
              ? `${confidentialSolBalance.toFixed(4)} SOL confidential — withdraw recommended`
              : 'Hide token amounts on-chain. Sender and recipient remain visible.'}
            value={confidentialBalanceEnabled}
            onValueChange={setConfidentialBalanceEnabled}
          />
        </GlassCard>

        {/* NETWORK */}
        <SectionTitle title="NETWORK" delay={280} />
        <GlassCard delay={300}>
          <SettingsRow
            label="Network"
            value={networkDisplay}
            leftIcon="globe-outline"
            onPress={() => router.push('/(main)/(settings)/network')}
          />
          <GlassDivider />
          <SettingsRow
            label="RPC"
            value="Solana"
            leftIcon="server-outline"
            onPress={() => router.push('/(main)/(settings)/network')}
          />
        </GlassCard>

        {/* PREFERENCES */}
        <SectionTitle title="PREFERENCES" delay={330} />
        <GlassCard delay={350}>
          <SettingsRow
            label="Currency"
            value={currency}
            leftIcon="cash-outline"
            onPress={handleCurrencySelect}
          />
          <GlassDivider />
          <SettingsRow
            label="Notifications"
            leftIcon="notifications-outline"
            onPress={handleNotifications}
          />
        </GlassCard>

        {/* ABOUT */}
        <SectionTitle title="ABOUT" delay={380} />
        <GlassCard delay={400}>
          <SettingsRow
            label="About P-01"
            value="v1.0.0"
            leftIcon="information-circle-outline"
            onPress={() => router.push('/(main)/(settings)/about')}
          />
        </GlassCard>

        {/* Disconnect Button */}
        <Animated.View entering={FadeInDown.delay(450).duration(350)} style={styles.disconnectOuter}>
          <BlurView intensity={12} tint="dark" style={styles.disconnectBlur}>
            <LinearGradient
              colors={['rgba(57, 197, 187, 0.06)', 'rgba(255, 119, 168, 0.03)', 'transparent']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />
            <TouchableOpacity
              style={styles.disconnectTouch}
              onPress={handleDisconnect}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Disconnect wallet"
            >
              <Ionicons name="log-out-outline" size={18} color={P01Colors.cyan} />
              <Text style={styles.disconnectText}>Disconnect</Text>
            </TouchableOpacity>
          </BlurView>
        </Animated.View>

        {/* Advanced Section Toggle */}
        <Animated.View entering={FadeInDown.delay(510).duration(300)} style={styles.advancedToggle}>
          <TouchableOpacity
            style={styles.advancedToggleTouch}
            onPress={() => setShowAdvanced(!showAdvanced)}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={showAdvanced ? 'Hide advanced options' : 'Show advanced options'}
          >
            <Text style={styles.advancedToggleText}>
              {showAdvanced ? 'Hide advanced options' : 'Advanced options'}
            </Text>
            <Ionicons
              name={showAdvanced ? 'chevron-up' : 'chevron-down'}
              size={14}
              color="#666"
            />
          </TouchableOpacity>
        </Animated.View>

        {/* Danger Zone */}
        {showAdvanced && (
          <Animated.View entering={FadeInDown.duration(250)} style={styles.dangerOuter}>
            <BlurView intensity={12} tint="dark" style={styles.dangerBlur}>
              <LinearGradient
                colors={['rgba(255, 51, 102, 0.06)', 'rgba(255, 51, 102, 0.02)', 'transparent']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={StyleSheet.absoluteFill}
                pointerEvents="none"
              />
              <Text style={styles.dangerLabel}>
                Danger Zone - Irreversible actions
              </Text>
              <TouchableOpacity
                style={styles.deleteButton}
                onPress={handleDeleteWallet}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Delete wallet permanently"
              >
                <Ionicons name="trash-outline" size={16} color="#ef4444" />
                <Text style={styles.deleteButtonText}>Delete Wallet</Text>
              </TouchableOpacity>
            </BlurView>
          </Animated.View>
        )}

        {/* Version Footer */}
        <Animated.View entering={FadeInDown.delay(540).duration(300)} style={styles.footer}>
          <Text style={styles.footerVersion}>Protocol 01 v1.0.0</Text>
          <Text style={styles.footerBuilt}>Built on Solana</Text>
        </Animated.View>
      </ScrollView>

      {/* Currency Selection Modal */}
      <CurrencyModal
        visible={currencyModalVisible}
        currentCurrency={currency}
        onSelect={setCurrency}
        onClose={() => setCurrencyModalVisible(false)}
      />
    </SafeAreaView>
  );
}

/* ──────────────────────── Styles ──────────────────────── */

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'transparent',
  },

  /* Header */
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.lg,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: BorderRadius.full,
    backgroundColor: 'rgba(12, 12, 14, 0.65)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.07)',
  },
  headerTitle: {
    color: Colors.text,
    fontSize: 18,
    fontFamily: FontFamily.semibold,
  },

  /* Section Title */
  sectionTitle: {
    color: Colors.textSecondary,
    fontSize: 12,
    fontFamily: FontFamily.semibold,
    letterSpacing: 1,
    paddingHorizontal: Spacing.lg,
    marginBottom: Spacing.sm,
    marginTop: Spacing.lg,
  },

  /* Glass Card */
  glassOuter: {
    marginHorizontal: Spacing.lg,
    borderRadius: BorderRadius.xl,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.07)',
  },
  glassBlur: {
    backgroundColor: 'rgba(12, 12, 14, 0.65)',
  },

  /* Divider */
  divider: {
    height: 1,
    backgroundColor: 'rgba(57, 197, 187, 0.07)',
    marginHorizontal: Spacing.lg,
  },

  /* Wallet Row */
  walletRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.lg,
    paddingHorizontal: Spacing.lg,
  },
  walletRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  walletIcon: {
    width: 40,
    height: 40,
    borderRadius: BorderRadius.md,
    backgroundColor: 'rgba(57, 197, 187, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: Spacing.md,
  },
  rowLabel: {
    color: Colors.text,
    fontSize: 16,
    fontFamily: FontFamily.medium,
  },
  rowSublabel: {
    color: Colors.textSecondary,
    fontSize: 14,
    marginTop: 2,
  },
  copiedText: {
    color: P01Colors.cyan,
    fontSize: 12,
    marginLeft: 4,
  },

  /* Disconnect */
  disconnectOuter: {
    marginTop: Spacing.lg,
    marginHorizontal: Spacing.lg,
    borderRadius: BorderRadius.xl,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.07)',
  },
  disconnectBlur: {
    backgroundColor: 'rgba(12, 12, 14, 0.65)',
  },
  disconnectTouch: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.lg,
  },
  disconnectText: {
    color: P01Colors.cyan,
    fontSize: 16,
    fontFamily: FontFamily.medium,
    marginLeft: Spacing.sm,
  },

  /* Advanced Toggle */
  advancedToggle: {
    marginTop: Spacing['2xl'],
    marginHorizontal: Spacing.lg,
  },
  advancedToggleTouch: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.md,
  },
  advancedToggleText: {
    color: 'rgba(136, 136, 146, 0.5)',
    fontSize: 12,
    marginRight: Spacing.sm,
  },

  /* Danger Zone */
  dangerOuter: {
    marginTop: Spacing.sm,
    marginHorizontal: Spacing.lg,
    borderRadius: BorderRadius.xl,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255, 51, 102, 0.12)',
  },
  dangerBlur: {
    backgroundColor: 'rgba(12, 12, 14, 0.65)',
    padding: Spacing.lg,
  },
  dangerLabel: {
    color: 'rgba(239, 68, 68, 0.7)',
    fontSize: 12,
    textAlign: 'center',
    marginBottom: Spacing.md,
  },
  deleteButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.md,
    backgroundColor: 'rgba(239, 68, 68, 0.08)',
    borderRadius: BorderRadius.md,
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.15)',
  },
  deleteButtonText: {
    color: '#ef4444',
    fontSize: 14,
    fontFamily: FontFamily.medium,
    marginLeft: Spacing.sm,
  },

  /* Footer */
  footer: {
    alignItems: 'center',
    marginTop: Spacing['3xl'],
  },
  footerVersion: {
    color: 'rgba(136, 136, 146, 0.5)',
    fontSize: 12,
  },
  footerBuilt: {
    color: 'rgba(136, 136, 146, 0.3)',
    fontSize: 12,
    marginTop: 4,
  },
});

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Linking,
  Alert,
  Platform,
  Modal,
  FlatList,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';

import { useWalletStore } from '@/stores/walletStore';
import { Colors, FontFamily, BorderRadius, Spacing } from '@/constants/theme';

// P-01 Design System Colors
const P01 = {
  cyan: '#39c5bb',
  cyanDim: 'rgba(57, 197, 187, 0.15)',
  pink: '#ff77a8',
  pinkDim: 'rgba(255, 119, 168, 0.15)',
  blue: '#3b82f6',
  blueDim: 'rgba(59, 130, 246, 0.15)',
  green: '#22c55e',
  greenDim: 'rgba(34, 197, 94, 0.15)',
};

// On-ramp providers
interface OnRampProvider {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  fees: string;
  paymentMethods: string[];
  getUrl: (walletAddress: string, currency?: string) => string;
}

const ON_RAMP_PROVIDERS: OnRampProvider[] = [
  {
    id: 'moonpay',
    name: 'MoonPay',
    description: 'Buy crypto with card or bank transfer',
    icon: '🌙',
    color: '#7C3AED',
    fees: '1-4.5%',
    paymentMethods: ['Credit Card', 'Debit Card', 'Bank Transfer', 'Apple Pay', 'Google Pay'],
    getUrl: (walletAddress, currency = 'sol') =>
      `https://www.moonpay.com/buy/${currency}?walletAddress=${walletAddress}`,
  },
  {
    id: 'transak',
    name: 'Transak',
    description: 'Global fiat-to-crypto gateway',
    icon: '⚡',
    color: '#0052FF',
    fees: '0.99-5.5%',
    paymentMethods: ['Credit Card', 'Debit Card', 'Bank Transfer', 'Apple Pay'],
    getUrl: (walletAddress, currency = 'SOL') =>
      `https://global.transak.com/?cryptoCurrencyCode=${currency}&walletAddress=${walletAddress}&network=solana`,
  },
  {
    id: 'ramp',
    name: 'Ramp Network',
    description: 'Low fees, instant purchases',
    icon: '🚀',
    color: '#21BF73',
    fees: '0.49-2.9%',
    paymentMethods: ['Credit Card', 'Debit Card', 'Bank Transfer', 'Apple Pay'],
    getUrl: (walletAddress, currency = 'SOLANA_SOL') =>
      `https://ramp.network/buy/?swapAsset=${currency}&userAddress=${walletAddress}`,
  },
];

// Crypto assets available to buy
interface CryptoAsset {
  symbol: string;
  name: string;
  color: string;
  moonpayCode: string;
  transakCode: string;
  rampCode: string;
}

const CRYPTO_ASSETS: CryptoAsset[] = [
  {
    symbol: 'SOL',
    name: 'Solana',
    color: P01.cyan,
    moonpayCode: 'sol',
    transakCode: 'SOL',
    rampCode: 'SOLANA_SOL',
  },
  {
    symbol: 'USDC',
    name: 'USD Coin',
    color: '#2775CA',
    moonpayCode: 'usdc_sol',
    transakCode: 'USDC',
    rampCode: 'SOLANA_USDC',
  },
  {
    symbol: 'USDT',
    name: 'Tether',
    color: '#26A17B',
    moonpayCode: 'usdt_sol',
    transakCode: 'USDT',
    rampCode: 'SOLANA_USDT',
  },
];

export default function BuyScreen() {
  const router = useRouter();
  const { publicKey } = useWalletStore();

  const [selectedAsset, setSelectedAsset] = useState<CryptoAsset>(CRYPTO_ASSETS[0]);
  const [selectedProvider, setSelectedProvider] = useState<OnRampProvider>(ON_RAMP_PROVIDERS[0]);
  const [showAssetModal, setShowAssetModal] = useState(false);
  const [showProviderModal, setShowProviderModal] = useState(false);

  const getCurrencyCode = useCallback((provider: OnRampProvider, asset: CryptoAsset) => {
    switch (provider.id) {
      case 'moonpay':
        return asset.moonpayCode;
      case 'transak':
        return asset.transakCode;
      case 'ramp':
        return asset.rampCode;
      default:
        return asset.symbol;
    }
  }, []);

  const handleBuy = async () => {
    if (!publicKey) {
      Alert.alert('No Wallet', 'Please create or import a wallet first');
      return;
    }

    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }

    const currencyCode = getCurrencyCode(selectedProvider, selectedAsset);
    const url = selectedProvider.getUrl(publicKey, currencyCode);

    try {
      const canOpen = await Linking.canOpenURL(url);
      if (canOpen) {
        await Linking.openURL(url);
      } else {
        Alert.alert('Error', 'Cannot open the payment provider. Please try again later.');
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to open payment provider');
    }
  };

  const copyAddress = async () => {
    if (publicKey) {
      await Clipboard.setStringAsync(publicKey);
      if (Platform.OS !== 'web') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      Alert.alert('Copied!', 'Your wallet address has been copied to clipboard');
    }
  };

  const renderAssetModal = () => (
    <Modal
      visible={showAssetModal}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={() => setShowAssetModal(false)}
    >
      <View style={styles.modalContainer}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>Select Asset</Text>
          <TouchableOpacity
            onPress={() => setShowAssetModal(false)}
            style={styles.modalCloseButton}
          >
            <Ionicons name="close" size={24} color={Colors.text} />
          </TouchableOpacity>
        </View>

        <FlatList
          data={CRYPTO_ASSETS}
          keyExtractor={item => item.symbol}
          contentContainerStyle={styles.assetList}
          renderItem={({ item }) => {
            const isSelected = item.symbol === selectedAsset.symbol;
            return (
              <TouchableOpacity
                style={[styles.assetItem, isSelected && styles.assetItemSelected]}
                onPress={() => {
                  setSelectedAsset(item);
                  setShowAssetModal(false);
                  if (Platform.OS !== 'web') {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  }
                }}
              >
                <View style={[styles.assetLogo, { backgroundColor: item.color + '20' }]}>
                  <Text style={[styles.assetLogoText, { color: item.color }]}>
                    {item.symbol.charAt(0)}
                  </Text>
                </View>
                <View style={styles.assetInfo}>
                  <Text style={styles.assetSymbol}>{item.symbol}</Text>
                  <Text style={styles.assetName}>{item.name}</Text>
                </View>
                {isSelected && (
                  <Ionicons name="checkmark-circle" size={24} color={Colors.primary} />
                )}
              </TouchableOpacity>
            );
          }}
        />
      </View>
    </Modal>
  );

  const renderProviderModal = () => (
    <Modal
      visible={showProviderModal}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={() => setShowProviderModal(false)}
    >
      <View style={styles.modalContainer}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>Select Provider</Text>
          <TouchableOpacity
            onPress={() => setShowProviderModal(false)}
            style={styles.modalCloseButton}
          >
            <Ionicons name="close" size={24} color={Colors.text} />
          </TouchableOpacity>
        </View>

        <FlatList
          data={ON_RAMP_PROVIDERS}
          keyExtractor={item => item.id}
          contentContainerStyle={styles.providerList}
          renderItem={({ item }) => {
            const isSelected = item.id === selectedProvider.id;
            return (
              <TouchableOpacity
                style={[styles.providerItem, isSelected && styles.providerItemSelected]}
                onPress={() => {
                  setSelectedProvider(item);
                  setShowProviderModal(false);
                  if (Platform.OS !== 'web') {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  }
                }}
              >
                <View style={[styles.providerLogo, { backgroundColor: item.color + '20' }]}>
                  <Text style={styles.providerIcon}>{item.icon}</Text>
                </View>
                <View style={styles.providerInfo}>
                  <Text style={styles.providerName}>{item.name}</Text>
                  <Text style={styles.providerDescription}>{item.description}</Text>
                  <Text style={styles.providerFees}>Fees: {item.fees}</Text>
                </View>
                {isSelected && (
                  <Ionicons name="checkmark-circle" size={24} color={Colors.primary} />
                )}
              </TouchableOpacity>
            );
          }}
        />
      </View>
    </Modal>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <Animated.View entering={FadeInDown.delay(100)} style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
        >
          <Ionicons name="arrow-back" size={24} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Buy Crypto</Text>
        <View style={styles.headerSpacer} />
      </Animated.View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Info Card */}
        <Animated.View entering={FadeInUp.delay(200)}>
          <LinearGradient
            colors={[P01.pinkDim, 'rgba(255, 119, 168, 0.05)']}
            style={styles.infoCard}
          >
            <Ionicons name="information-circle" size={24} color={P01.pink} />
            <Text style={styles.infoText}>
              Buy crypto directly to your wallet using a credit card, debit card, or bank transfer through our trusted partners.
            </Text>
          </LinearGradient>
        </Animated.View>

        {/* Asset Selection */}
        <Animated.View entering={FadeInUp.delay(300)} style={styles.section}>
          <Text style={styles.sectionLabel}>ASSET TO BUY</Text>
          <TouchableOpacity
            style={styles.selectorCard}
            onPress={() => setShowAssetModal(true)}
          >
            <View style={styles.selectorLeft}>
              <View style={[styles.assetLogo, { backgroundColor: selectedAsset.color + '20' }]}>
                <Text style={[styles.assetLogoText, { color: selectedAsset.color }]}>
                  {selectedAsset.symbol.charAt(0)}
                </Text>
              </View>
              <View>
                <Text style={styles.selectorTitle}>{selectedAsset.symbol}</Text>
                <Text style={styles.selectorSubtitle}>{selectedAsset.name}</Text>
              </View>
            </View>
            <Ionicons name="chevron-forward" size={20} color={Colors.textSecondary} />
          </TouchableOpacity>
        </Animated.View>

        {/* Provider Selection */}
        <Animated.View entering={FadeInUp.delay(400)} style={styles.section}>
          <Text style={styles.sectionLabel}>PAYMENT PROVIDER</Text>
          <TouchableOpacity
            style={styles.selectorCard}
            onPress={() => setShowProviderModal(true)}
          >
            <View style={styles.selectorLeft}>
              <View style={[styles.providerLogo, { backgroundColor: selectedProvider.color + '20' }]}>
                <Text style={styles.providerIcon}>{selectedProvider.icon}</Text>
              </View>
              <View>
                <Text style={styles.selectorTitle}>{selectedProvider.name}</Text>
                <Text style={styles.selectorSubtitle}>Fees: {selectedProvider.fees}</Text>
              </View>
            </View>
            <Ionicons name="chevron-forward" size={20} color={Colors.textSecondary} />
          </TouchableOpacity>
        </Animated.View>

        {/* Payment Methods */}
        <Animated.View entering={FadeInUp.delay(500)} style={styles.section}>
          <Text style={styles.sectionLabel}>ACCEPTED PAYMENT METHODS</Text>
          <View style={styles.paymentMethods}>
            {selectedProvider.paymentMethods.map((method, index) => (
              <View key={index} style={styles.paymentBadge}>
                <Ionicons
                  name={
                    method.includes('Card') ? 'card' :
                    method.includes('Bank') ? 'business' :
                    method.includes('Apple') ? 'logo-apple' :
                    method.includes('Google') ? 'logo-google' : 'cash'
                  }
                  size={14}
                  color={Colors.primary}
                />
                <Text style={styles.paymentText}>{method}</Text>
              </View>
            ))}
          </View>
        </Animated.View>

        {/* Receiving Address */}
        <Animated.View entering={FadeInUp.delay(600)} style={styles.section}>
          <Text style={styles.sectionLabel}>RECEIVING ADDRESS</Text>
          <TouchableOpacity style={styles.addressCard} onPress={copyAddress}>
            <View style={styles.addressContent}>
              <Ionicons name="wallet" size={20} color={P01.cyan} />
              <Text style={styles.addressText} numberOfLines={1}>
                {publicKey ? `${publicKey.slice(0, 12)}...${publicKey.slice(-12)}` : 'No wallet'}
              </Text>
            </View>
            <Ionicons name="copy-outline" size={20} color={Colors.textSecondary} />
          </TouchableOpacity>
          <Text style={styles.addressHint}>
            Your purchased crypto will be sent to this address
          </Text>
        </Animated.View>

        {/* Features */}
        <Animated.View entering={FadeInUp.delay(700)} style={styles.featuresCard}>
          <View style={styles.featureRow}>
            <Ionicons name="shield-checkmark" size={20} color={P01.green} />
            <Text style={styles.featureText}>Secure & regulated providers</Text>
          </View>
          <View style={styles.featureRow}>
            <Ionicons name="flash" size={20} color={P01.cyan} />
            <Text style={styles.featureText}>Instant delivery to your wallet</Text>
          </View>
          <View style={styles.featureRow}>
            <Ionicons name="globe" size={20} color={P01.blue} />
            <Text style={styles.featureText}>Available in 150+ countries</Text>
          </View>
        </Animated.View>
      </ScrollView>

      {/* Buy Button */}
      <Animated.View entering={FadeInUp.delay(800)} style={styles.bottomSection}>
        <TouchableOpacity
          onPress={handleBuy}
          disabled={!publicKey}
          style={[styles.buyButton, !publicKey && styles.buyButtonDisabled]}
        >
          <LinearGradient
            colors={[P01.pink, '#ff5588']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.buyButtonGradient}
          >
            <Ionicons name="card" size={20} color="#fff" />
            <Text style={styles.buyButtonText}>
              Buy {selectedAsset.symbol} with {selectedProvider.name}
            </Text>
          </LinearGradient>
        </TouchableOpacity>
        <Text style={styles.disclaimerText}>
          You will be redirected to {selectedProvider.name} to complete your purchase
        </Text>
      </Animated.View>

      {renderAssetModal()}
      {renderProviderModal()}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.surfaceSecondary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    color: Colors.text,
    fontSize: 18,
    fontFamily: FontFamily.semibold,
  },
  headerSpacer: {
    width: 40,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: Spacing.xl,
    paddingBottom: Spacing.xl,
  },
  infoCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: Spacing.lg,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: 'rgba(255, 119, 168, 0.3)',
    marginBottom: Spacing.xl,
    gap: Spacing.md,
  },
  infoText: {
    flex: 1,
    color: Colors.textSecondary,
    fontSize: 14,
    fontFamily: FontFamily.regular,
    lineHeight: 20,
  },
  section: {
    marginBottom: Spacing.xl,
  },
  sectionLabel: {
    color: Colors.textTertiary,
    fontSize: 12,
    fontFamily: FontFamily.semibold,
    letterSpacing: 1,
    marginBottom: Spacing.sm,
  },
  selectorCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.lg,
  },
  selectorLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  selectorTitle: {
    color: Colors.text,
    fontSize: 16,
    fontFamily: FontFamily.semibold,
  },
  selectorSubtitle: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontFamily: FontFamily.regular,
    marginTop: 2,
  },
  assetLogo: {
    width: 44,
    height: 44,
    borderRadius: BorderRadius.full,
    justifyContent: 'center',
    alignItems: 'center',
  },
  assetLogoText: {
    fontSize: 18,
    fontFamily: FontFamily.bold,
  },
  providerLogo: {
    width: 44,
    height: 44,
    borderRadius: BorderRadius.lg,
    justifyContent: 'center',
    alignItems: 'center',
  },
  providerIcon: {
    fontSize: 24,
  },
  paymentMethods: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
  },
  paymentBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.primaryDim,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md,
    gap: Spacing.xs,
  },
  paymentText: {
    color: Colors.primary,
    fontSize: 12,
    fontFamily: FontFamily.medium,
  },
  addressCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.lg,
  },
  addressContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    flex: 1,
  },
  addressText: {
    color: Colors.text,
    fontSize: 14,
    fontFamily: FontFamily.mono,
    flex: 1,
  },
  addressHint: {
    color: Colors.textTertiary,
    fontSize: 12,
    fontFamily: FontFamily.regular,
    marginTop: Spacing.sm,
  },
  featuresCard: {
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.lg,
    gap: Spacing.md,
  },
  featureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  featureText: {
    color: Colors.textSecondary,
    fontSize: 14,
    fontFamily: FontFamily.regular,
  },
  bottomSection: {
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
    paddingBottom: Spacing['3xl'],
  },
  buyButton: {
    borderRadius: BorderRadius.lg,
    overflow: 'hidden',
  },
  buyButtonDisabled: {
    opacity: 0.5,
  },
  buyButtonGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.lg,
    gap: Spacing.sm,
  },
  buyButtonText: {
    color: '#fff',
    fontSize: 16,
    fontFamily: FontFamily.semibold,
  },
  disclaimerText: {
    color: Colors.textTertiary,
    fontSize: 12,
    fontFamily: FontFamily.regular,
    textAlign: 'center',
    marginTop: Spacing.md,
  },
  // Modal styles
  modalContainer: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  modalTitle: {
    color: Colors.text,
    fontSize: 18,
    fontFamily: FontFamily.semibold,
  },
  modalCloseButton: {
    width: 40,
    height: 40,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.surfaceSecondary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  assetList: {
    padding: Spacing.lg,
  },
  assetItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.lg,
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.lg,
    marginBottom: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  assetItemSelected: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primaryDim,
  },
  assetInfo: {
    flex: 1,
    marginLeft: Spacing.md,
  },
  assetSymbol: {
    color: Colors.text,
    fontSize: 16,
    fontFamily: FontFamily.semibold,
  },
  assetName: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontFamily: FontFamily.regular,
    marginTop: 2,
  },
  providerList: {
    padding: Spacing.lg,
  },
  providerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.lg,
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.lg,
    marginBottom: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  providerItemSelected: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primaryDim,
  },
  providerInfo: {
    flex: 1,
    marginLeft: Spacing.md,
  },
  providerName: {
    color: Colors.text,
    fontSize: 16,
    fontFamily: FontFamily.semibold,
  },
  providerDescription: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontFamily: FontFamily.regular,
    marginTop: 2,
  },
  providerFees: {
    color: Colors.textTertiary,
    fontSize: 12,
    fontFamily: FontFamily.regular,
    marginTop: 4,
  },
});

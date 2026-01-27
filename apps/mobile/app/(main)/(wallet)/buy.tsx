import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  TextInput,
  Alert,
  Platform,
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Share,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import { WebView } from 'react-native-webview';
import QRCode from 'react-native-qrcode-svg';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';

import { useWalletStore } from '@/stores/walletStore';
import { Colors, FontFamily, BorderRadius, Spacing } from '@/constants/theme';
import { isMainnet } from '@/services/solana/connection';
import {
  getCryptoPrices,
  getPaymentQuote,
  createPaymentSession,
  SUPPORTED_ASSETS,
  SUPPORTED_FIAT,
  PAYMENT_METHODS,
  P01_NETWORK_FEE_BPS,
  type PaymentQuote,
} from '@/services/payments/p01-payments';

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

// Asset display config
const ASSET_CONFIG: Record<string, { color: string; icon: string }> = {
  SOL: { color: P01.cyan, icon: '◎' },
  USDC: { color: '#2775CA', icon: '$' },
  USDT: { color: '#26A17B', icon: '₮' },
};

export default function BuyScreen() {
  const router = useRouter();
  const { publicKey } = useWalletStore();

  const [selectedAsset, setSelectedAsset] = useState(SUPPORTED_ASSETS[0]);
  const [selectedFiat, setSelectedFiat] = useState(SUPPORTED_FIAT[0]);
  const [selectedPayment, setSelectedPayment] = useState(PAYMENT_METHODS[0]);
  const [amount, setAmount] = useState('100');
  const [isLoading, setIsLoading] = useState(false);
  const [quote, setQuote] = useState<PaymentQuote | null>(null);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [priceLoading, setPriceLoading] = useState(true);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [paymentUrl, setPaymentUrl] = useState('');
  const [showDepositModal, setShowDepositModal] = useState(false);
  const webViewRef = useRef<WebView>(null);

  // Only allow buying on mainnet
  const isOnMainnet = isMainnet();

  // Redirect to wallet if not on mainnet
  useEffect(() => {
    if (!isOnMainnet) {
      Alert.alert(
        'Mainnet Only',
        'Buying crypto is only available on mainnet. Switch to mainnet in settings to access this feature.',
        [{ text: 'OK', onPress: () => router.back() }]
      );
    }
  }, [isOnMainnet]);

  // Fetch prices on mount and periodically
  useEffect(() => {
    const fetchPrices = async () => {
      try {
        const newPrices = await getCryptoPrices();
        setPrices(newPrices);
      } catch (error) {
        console.error('Failed to fetch prices:', error);
      } finally {
        setPriceLoading(false);
      }
    };

    fetchPrices();
    const interval = setInterval(fetchPrices, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, []);

  // Update quote when inputs change
  useEffect(() => {
    const updateQuote = async () => {
      const numAmount = parseFloat(amount) || 0;
      if (numAmount > 0 && prices[selectedAsset.symbol]) {
        try {
          const newQuote = await getPaymentQuote({
            fiatAmount: numAmount,
            fiatCurrency: selectedFiat.code,
            cryptoSymbol: selectedAsset.symbol,
            paymentMethodId: selectedPayment.id,
          });
          setQuote(newQuote);
        } catch (error) {
          console.error('Failed to get quote:', error);
        }
      } else {
        setQuote(null);
      }
    };

    updateQuote();
  }, [amount, selectedAsset, selectedFiat, selectedPayment, prices]);

  const handleAmountChange = (text: string) => {
    // Only allow numbers and decimal point
    const cleaned = text.replace(/[^0-9.]/g, '');
    // Prevent multiple decimal points
    const parts = cleaned.split('.');
    if (parts.length > 2) return;
    if (parts[1]?.length > 2) return;
    setAmount(cleaned);
  };

  const handleQuickAmount = (value: number) => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    setAmount(value.toString());
  };

  const handleBuy = async () => {
    if (!publicKey) {
      Alert.alert('No Wallet', 'Please create or import a wallet first');
      return;
    }

    if (!quote) {
      Alert.alert('Error', 'Unable to get quote. Please try again.');
      return;
    }

    const numAmount = parseFloat(amount) || 0;
    if (numAmount < selectedPayment.minAmount) {
      Alert.alert('Minimum Amount', `Minimum purchase is ${selectedFiat.symbol}${selectedPayment.minAmount}`);
      return;
    }

    if (numAmount > selectedPayment.maxAmount) {
      Alert.alert('Maximum Amount', `Maximum purchase is ${selectedFiat.symbol}${selectedPayment.maxAmount.toLocaleString()}`);
      return;
    }

    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }

    setIsLoading(true);

    try {
      // Create payment session
      const session = await createPaymentSession({
        quote,
        walletAddress: publicKey,
        paymentMethodId: selectedPayment.id,
      });

      // Open in-app WebView modal for native experience
      setPaymentUrl(session.paymentUrl);
      setShowPaymentModal(true);
    } catch (error) {
      console.error('Payment error:', error);
      Alert.alert('Error', 'Failed to initiate payment. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  // Handle direct deposit
  const handleDirectDeposit = () => {
    if (!publicKey) {
      Alert.alert('No Wallet', 'Please create or import a wallet first');
      return;
    }
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    setShowDepositModal(true);
  };

  // Copy address to clipboard
  const copyAddress = async () => {
    if (publicKey) {
      await Clipboard.setStringAsync(publicKey);
      if (Platform.OS !== 'web') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      Alert.alert('Copied', 'Wallet address copied to clipboard');
    }
  };

  // Share address
  const shareAddress = async () => {
    if (publicKey) {
      await Share.share({
        message: `My Solana wallet address: ${publicKey}`,
        title: 'My P-01 Wallet Address',
      });
    }
  };

  // Handle WebView navigation state change
  const handleWebViewStateChange = (navState: any) => {
    // Check for success URLs to close the modal
    if (navState.url?.includes('success') || navState.url?.includes('complete')) {
      setShowPaymentModal(false);
      Alert.alert(
        'Payment Initiated',
        `Your purchase of ${quote?.cryptoAmount.toFixed(4)} ${quote?.cryptoSymbol} is being processed. You will receive your crypto once the payment is confirmed.`,
        [{ text: 'OK' }]
      );
    }
  };

  // Get asset display config
  const assetConfig = ASSET_CONFIG[selectedAsset.symbol] || { color: P01.cyan, icon: '?' };
  const p01FeePercent = P01_NETWORK_FEE_BPS / 100;
  const paymentFeePercent = selectedPayment.feeBps / 100;

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
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Buy Crypto</Text>
          <View style={styles.poweredBy}>
            <Text style={styles.poweredByText}>P-01 Network</Text>
          </View>
        </View>
        <View style={styles.headerSpacer} />
      </Animated.View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardView}
      >
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Devnet Warning */}
          {!isOnMainnet && (
            <Animated.View entering={FadeInUp.delay(150)}>
              <LinearGradient
                colors={['rgba(251, 146, 60, 0.2)', 'rgba(251, 146, 60, 0.05)']}
                style={[styles.warningCard, { borderColor: 'rgba(251, 146, 60, 0.5)' }]}
              >
                <Ionicons name="warning" size={24} color="#fb923c" />
                <Text style={[styles.warningText, { color: '#fb923c' }]}>
                  Switch to mainnet to buy real crypto.
                </Text>
              </LinearGradient>
            </Animated.View>
          )}

          {/* Amount Input */}
          <Animated.View entering={FadeInUp.delay(200)} style={styles.section}>
            <Text style={styles.sectionLabel}>YOU PAY</Text>
            <View style={styles.amountCard}>
              <View style={styles.amountRow}>
                <Text style={styles.currencySymbol}>{selectedFiat.symbol}</Text>
                <TextInput
                  style={styles.amountInput}
                  value={amount}
                  onChangeText={handleAmountChange}
                  keyboardType="decimal-pad"
                  placeholder="0.00"
                  placeholderTextColor={Colors.textTertiary}
                />
                <TouchableOpacity style={styles.currencySelector}>
                  <Text style={styles.currencyCode}>{selectedFiat.code}</Text>
                  <Ionicons name="chevron-down" size={16} color={Colors.textSecondary} />
                </TouchableOpacity>
              </View>

              {/* Quick amounts */}
              <View style={styles.quickAmounts}>
                {[50, 100, 250, 500].map((value) => (
                  <TouchableOpacity
                    key={value}
                    style={[
                      styles.quickAmountButton,
                      amount === value.toString() && styles.quickAmountButtonActive,
                    ]}
                    onPress={() => handleQuickAmount(value)}
                  >
                    <Text
                      style={[
                        styles.quickAmountText,
                        amount === value.toString() && styles.quickAmountTextActive,
                      ]}
                    >
                      {selectedFiat.symbol}{value}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          </Animated.View>

          {/* You Receive */}
          <Animated.View entering={FadeInUp.delay(300)} style={styles.section}>
            <Text style={styles.sectionLabel}>YOU RECEIVE</Text>
            <View style={styles.receiveCard}>
              <View style={styles.receiveRow}>
                <View style={[styles.assetIcon, { backgroundColor: assetConfig.color + '20' }]}>
                  <Text style={[styles.assetIconText, { color: assetConfig.color }]}>
                    {assetConfig.icon}
                  </Text>
                </View>
                <View style={styles.receiveInfo}>
                  <Text style={styles.receiveAmount}>
                    {quote ? quote.cryptoAmount.toFixed(selectedAsset.symbol === 'SOL' ? 4 : 2) : '0.00'} {selectedAsset.symbol}
                  </Text>
                  <Text style={styles.receiveName}>
                    {selectedAsset.name}
                    {prices[selectedAsset.symbol] && (
                      <Text style={styles.priceText}> @ ${prices[selectedAsset.symbol].toLocaleString()}</Text>
                    )}
                  </Text>
                </View>
                <TouchableOpacity style={styles.assetSelector}>
                  <Ionicons name="chevron-down" size={20} color={Colors.textSecondary} />
                </TouchableOpacity>
              </View>

              {/* Asset options */}
              <View style={styles.assetOptions}>
                {SUPPORTED_ASSETS.map((asset) => {
                  const config = ASSET_CONFIG[asset.symbol] || { color: P01.cyan };
                  return (
                    <TouchableOpacity
                      key={asset.symbol}
                      style={[
                        styles.assetOption,
                        selectedAsset.symbol === asset.symbol && styles.assetOptionActive,
                      ]}
                      onPress={() => {
                        setSelectedAsset(asset);
                        if (Platform.OS !== 'web') {
                          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        }
                      }}
                    >
                      <Text
                        style={[
                          styles.assetOptionText,
                          selectedAsset.symbol === asset.symbol && { color: config.color },
                        ]}
                      >
                        {asset.symbol}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          </Animated.View>

          {/* Payment Method */}
          <Animated.View entering={FadeInUp.delay(400)} style={styles.section}>
            <Text style={styles.sectionLabel}>PAYMENT METHOD</Text>
            <View style={styles.paymentMethods}>
              {PAYMENT_METHODS.map((method) => (
                <TouchableOpacity
                  key={method.id}
                  style={[
                    styles.paymentMethod,
                    selectedPayment.id === method.id && styles.paymentMethodActive,
                  ]}
                  onPress={() => {
                    setSelectedPayment(method);
                    if (Platform.OS !== 'web') {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    }
                  }}
                >
                  <Ionicons
                    name={method.icon as any}
                    size={24}
                    color={selectedPayment.id === method.id ? P01.cyan : Colors.textSecondary}
                  />
                  <View style={styles.paymentMethodInfo}>
                    <Text style={styles.paymentMethodName}>{method.name}</Text>
                    <Text style={styles.paymentMethodDetails}>
                      {method.processingTime} • {(method.feeBps / 100).toFixed(1)}% fee
                    </Text>
                  </View>
                  {selectedPayment.id === method.id && (
                    <Ionicons name="checkmark-circle" size={20} color={P01.cyan} />
                  )}
                </TouchableOpacity>
              ))}
            </View>
          </Animated.View>

          {/* Fee Breakdown */}
          <Animated.View entering={FadeInUp.delay(500)} style={styles.section}>
            <Text style={styles.sectionLabel}>FEE BREAKDOWN</Text>
            <View style={styles.feeCard}>
              <View style={styles.feeRow}>
                <Text style={styles.feeLabel}>Subtotal</Text>
                <Text style={styles.feeValue}>
                  {selectedFiat.symbol}{quote?.fiatAmount.toFixed(2) || '0.00'}
                </Text>
              </View>
              <View style={styles.feeRow}>
                <Text style={styles.feeLabel}>Payment Fee ({paymentFeePercent.toFixed(1)}%)</Text>
                <Text style={styles.feeValue}>
                  -{selectedFiat.symbol}{quote?.paymentMethodFee.toFixed(2) || '0.00'}
                </Text>
              </View>
              <View style={styles.feeRow}>
                <View style={styles.feeLabelRow}>
                  <Text style={styles.feeLabel}>P-01 Network ({p01FeePercent.toFixed(1)}%)</Text>
                  <View style={styles.p01Badge}>
                    <Text style={styles.p01BadgeText}>P-01</Text>
                  </View>
                </View>
                <Text style={styles.feeValue}>
                  -{selectedFiat.symbol}{quote?.p01NetworkFee.toFixed(2) || '0.00'}
                </Text>
              </View>
              <View style={[styles.feeRow, styles.feeRowTotal]}>
                <Text style={styles.feeLabelTotal}>Net Amount</Text>
                <Text style={styles.feeValueTotal}>
                  {selectedFiat.symbol}{quote?.netAmount.toFixed(2) || '0.00'}
                </Text>
              </View>
            </View>
          </Animated.View>

          {/* Security Info */}
          <Animated.View entering={FadeInUp.delay(600)} style={styles.securityCard}>
            <View style={styles.securityRow}>
              <Ionicons name="shield-checkmark" size={18} color={P01.green} />
              <Text style={styles.securityText}>Secure payment processing</Text>
            </View>
            <View style={styles.securityRow}>
              <Ionicons name="lock-closed" size={18} color={P01.cyan} />
              <Text style={styles.securityText}>End-to-end encrypted</Text>
            </View>
            <View style={styles.securityRow}>
              <Ionicons name="flash" size={18} color={P01.pink} />
              <Text style={styles.securityText}>Instant delivery to your wallet</Text>
            </View>
          </Animated.View>

          {/* Direct Deposit Option */}
          <Animated.View entering={FadeInUp.delay(650)} style={styles.section}>
            <TouchableOpacity
              onPress={handleDirectDeposit}
              style={styles.directDepositButton}
            >
              <View style={styles.directDepositIcon}>
                <Ionicons name="qr-code" size={24} color={P01.cyan} />
              </View>
              <View style={styles.directDepositInfo}>
                <Text style={styles.directDepositTitle}>Direct Deposit</Text>
                <Text style={styles.directDepositDesc}>Already have crypto? Send directly to your wallet</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={Colors.textSecondary} />
            </TouchableOpacity>
          </Animated.View>
        </ScrollView>

        {/* Buy Button */}
        <Animated.View entering={FadeInUp.delay(700)} style={styles.bottomSection}>
          <TouchableOpacity
            onPress={handleBuy}
            disabled={!publicKey || !isOnMainnet || isLoading || !quote}
            style={[
              styles.buyButton,
              (!publicKey || !isOnMainnet || isLoading || !quote) && styles.buyButtonDisabled,
            ]}
          >
            <LinearGradient
              colors={isOnMainnet && quote ? [P01.cyan, '#00ffe5'] : ['#444', '#333']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={styles.buyButtonGradient}
            >
              {isLoading ? (
                <ActivityIndicator color="#0a0a0c" />
              ) : priceLoading ? (
                <ActivityIndicator color="#0a0a0c" size="small" />
              ) : (
                <>
                  <Ionicons name="flash" size={20} color="#0a0a0c" />
                  <Text style={styles.buyButtonText}>
                    Buy {quote ? `${quote.cryptoAmount.toFixed(4)} ${selectedAsset.symbol}` : selectedAsset.symbol}
                  </Text>
                </>
              )}
            </LinearGradient>
          </TouchableOpacity>
          <Text style={styles.disclaimerText}>
            Powered by P-01 Network • Secure fiat-to-crypto
          </Text>
        </Animated.View>
      </KeyboardAvoidingView>

      {/* Payment WebView Modal */}
      <Modal
        visible={showPaymentModal}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setShowPaymentModal(false)}
      >
        <SafeAreaView style={styles.modalContainer} edges={['top']}>
          <View style={styles.modalHeader}>
            <TouchableOpacity
              onPress={() => setShowPaymentModal(false)}
              style={styles.modalCloseButton}
            >
              <Ionicons name="close" size={24} color={Colors.text} />
            </TouchableOpacity>
            <Text style={styles.modalTitle}>Complete Payment</Text>
            <View style={styles.modalCloseButton} />
          </View>
          <WebView
            ref={webViewRef}
            source={{ uri: paymentUrl }}
            style={styles.webView}
            onNavigationStateChange={handleWebViewStateChange}
            startInLoadingState={true}
            renderLoading={() => (
              <View style={styles.webViewLoading}>
                <ActivityIndicator size="large" color={P01.cyan} />
                <Text style={styles.webViewLoadingText}>Loading payment provider...</Text>
              </View>
            )}
            javaScriptEnabled={true}
            domStorageEnabled={true}
            sharedCookiesEnabled={true}
            thirdPartyCookiesEnabled={true}
          />
        </SafeAreaView>
      </Modal>

      {/* Direct Deposit Modal */}
      <Modal
        visible={showDepositModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowDepositModal(false)}
      >
        <View style={styles.depositModalContainer}>
          <View style={styles.depositModalHeader}>
            <Text style={styles.depositModalTitle}>Receive {selectedAsset.symbol}</Text>
            <TouchableOpacity
              onPress={() => setShowDepositModal(false)}
              style={styles.depositCloseButton}
            >
              <Ionicons name="close-circle" size={28} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <View style={styles.depositContent}>
            {/* QR Code */}
            <View style={styles.qrCodeContainer}>
              <View style={styles.qrCodeWrapper}>
                {publicKey && (
                  <QRCode
                    value={publicKey}
                    size={180}
                    color="#000000"
                    backgroundColor="#FFFFFF"
                  />
                )}
              </View>
              <Text style={styles.qrCodeLabel}>Scan to deposit {selectedAsset.symbol}</Text>
            </View>

            {/* Address display */}
            <View style={styles.addressCard}>
              <Text style={styles.addressLabel}>Your {selectedAsset.name} Address</Text>
              <Text style={styles.addressText} numberOfLines={2}>
                {publicKey}
              </Text>
            </View>

            {/* Action buttons */}
            <View style={styles.depositActions}>
              <TouchableOpacity onPress={copyAddress} style={styles.depositActionButton}>
                <LinearGradient
                  colors={[P01.cyan, '#00ffe5']}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 0 }}
                  style={styles.depositActionGradient}
                >
                  <Ionicons name="copy" size={20} color="#0a0a0c" />
                  <Text style={styles.depositActionText}>Copy Address</Text>
                </LinearGradient>
              </TouchableOpacity>

              <TouchableOpacity onPress={shareAddress} style={styles.depositActionButtonSecondary}>
                <Ionicons name="share-outline" size={20} color={P01.cyan} />
                <Text style={styles.depositActionTextSecondary}>Share</Text>
              </TouchableOpacity>
            </View>

            {/* Warning */}
            <View style={styles.depositWarning}>
              <Ionicons name="warning" size={18} color="#fb923c" />
              <Text style={styles.depositWarningText}>
                Only send {selectedAsset.symbol} on the Solana network to this address.
                Sending other tokens may result in permanent loss.
              </Text>
            </View>
          </View>
        </View>
      </Modal>
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
  headerCenter: {
    alignItems: 'center',
  },
  headerTitle: {
    color: Colors.text,
    fontSize: 18,
    fontFamily: FontFamily.semibold,
  },
  poweredBy: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2,
  },
  poweredByText: {
    color: P01.cyan,
    fontSize: 11,
    fontFamily: FontFamily.medium,
    letterSpacing: 0.5,
  },
  headerSpacer: {
    width: 40,
  },
  keyboardView: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: Spacing.xl,
    paddingBottom: Spacing.xl,
  },
  warningCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.lg,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    marginBottom: Spacing.lg,
    gap: Spacing.md,
  },
  warningText: {
    flex: 1,
    fontSize: 14,
    fontFamily: FontFamily.medium,
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
  amountCard: {
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.lg,
  },
  amountRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  currencySymbol: {
    color: Colors.text,
    fontSize: 32,
    fontFamily: FontFamily.bold,
    marginRight: Spacing.xs,
  },
  amountInput: {
    flex: 1,
    color: Colors.text,
    fontSize: 32,
    fontFamily: FontFamily.bold,
    padding: 0,
  },
  currencySelector: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surfaceTertiary,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md,
    gap: Spacing.xs,
  },
  currencyCode: {
    color: Colors.text,
    fontSize: 14,
    fontFamily: FontFamily.semibold,
  },
  quickAmounts: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginTop: Spacing.lg,
  },
  quickAmountButton: {
    flex: 1,
    paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.surfaceTertiary,
    alignItems: 'center',
  },
  quickAmountButtonActive: {
    backgroundColor: P01.cyanDim,
    borderWidth: 1,
    borderColor: P01.cyan,
  },
  quickAmountText: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontFamily: FontFamily.medium,
  },
  quickAmountTextActive: {
    color: P01.cyan,
  },
  receiveCard: {
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.lg,
  },
  receiveRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  assetIcon: {
    width: 48,
    height: 48,
    borderRadius: BorderRadius.full,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.md,
  },
  assetIconText: {
    fontSize: 20,
    fontFamily: FontFamily.bold,
  },
  receiveInfo: {
    flex: 1,
  },
  receiveAmount: {
    color: Colors.text,
    fontSize: 24,
    fontFamily: FontFamily.bold,
  },
  receiveName: {
    color: Colors.textSecondary,
    fontSize: 14,
    fontFamily: FontFamily.regular,
    marginTop: 2,
  },
  priceText: {
    color: Colors.textTertiary,
    fontSize: 12,
  },
  assetSelector: {
    padding: Spacing.sm,
  },
  assetOptions: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginTop: Spacing.lg,
  },
  assetOption: {
    flex: 1,
    paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.surfaceTertiary,
    alignItems: 'center',
  },
  assetOptionActive: {
    backgroundColor: 'rgba(57, 197, 187, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.3)',
  },
  assetOptionText: {
    color: Colors.textSecondary,
    fontSize: 14,
    fontFamily: FontFamily.semibold,
  },
  paymentMethods: {
    gap: Spacing.sm,
  },
  paymentMethod: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.lg,
    gap: Spacing.md,
  },
  paymentMethodActive: {
    borderColor: P01.cyan,
    backgroundColor: P01.cyanDim,
  },
  paymentMethodInfo: {
    flex: 1,
  },
  paymentMethodName: {
    color: Colors.text,
    fontSize: 15,
    fontFamily: FontFamily.semibold,
  },
  paymentMethodDetails: {
    color: Colors.textSecondary,
    fontSize: 12,
    fontFamily: FontFamily.regular,
    marginTop: 2,
  },
  feeCard: {
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.lg,
  },
  feeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: Spacing.sm,
  },
  feeRowTotal: {
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    marginTop: Spacing.sm,
    paddingTop: Spacing.md,
  },
  feeLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  feeLabel: {
    color: Colors.textSecondary,
    fontSize: 14,
    fontFamily: FontFamily.regular,
  },
  feeValue: {
    color: Colors.text,
    fontSize: 14,
    fontFamily: FontFamily.medium,
  },
  feeLabelTotal: {
    color: Colors.text,
    fontSize: 15,
    fontFamily: FontFamily.semibold,
  },
  feeValueTotal: {
    color: P01.cyan,
    fontSize: 16,
    fontFamily: FontFamily.bold,
  },
  p01Badge: {
    backgroundColor: P01.cyanDim,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  p01BadgeText: {
    color: P01.cyan,
    fontSize: 10,
    fontFamily: FontFamily.semibold,
  },
  securityCard: {
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.lg,
    gap: Spacing.md,
  },
  securityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  securityText: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontFamily: FontFamily.regular,
  },
  bottomSection: {
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
    paddingBottom: Spacing['3xl'],
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    backgroundColor: Colors.background,
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
    color: '#0a0a0c',
    fontSize: 16,
    fontFamily: FontFamily.bold,
  },
  disclaimerText: {
    color: Colors.textTertiary,
    fontSize: 11,
    fontFamily: FontFamily.regular,
    textAlign: 'center',
    marginTop: Spacing.md,
  },
  // Direct deposit button
  directDepositButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.lg,
    gap: Spacing.md,
  },
  directDepositIcon: {
    width: 48,
    height: 48,
    borderRadius: BorderRadius.full,
    backgroundColor: P01.cyanDim,
    justifyContent: 'center',
    alignItems: 'center',
  },
  directDepositInfo: {
    flex: 1,
  },
  directDepositTitle: {
    color: Colors.text,
    fontSize: 16,
    fontFamily: FontFamily.semibold,
  },
  directDepositDesc: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontFamily: FontFamily.regular,
    marginTop: 2,
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
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  modalCloseButton: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalTitle: {
    color: Colors.text,
    fontSize: 16,
    fontFamily: FontFamily.semibold,
  },
  webView: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  webViewLoading: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: Colors.background,
  },
  webViewLoadingText: {
    color: Colors.textSecondary,
    fontSize: 14,
    fontFamily: FontFamily.regular,
    marginTop: Spacing.md,
  },
  // Deposit modal styles
  depositModalContainer: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  depositModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.xl,
    paddingBottom: Spacing.lg,
  },
  depositModalTitle: {
    color: Colors.text,
    fontSize: 20,
    fontFamily: FontFamily.bold,
  },
  depositCloseButton: {
    padding: Spacing.xs,
  },
  depositContent: {
    flex: 1,
    paddingHorizontal: Spacing.xl,
  },
  qrCodeContainer: {
    alignItems: 'center',
    paddingVertical: Spacing['2xl'],
  },
  qrCodeWrapper: {
    width: 200,
    height: 200,
    borderRadius: BorderRadius.xl,
    backgroundColor: '#FFFFFF',
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.sm,
    borderWidth: 2,
    borderColor: P01.cyan,
  },
  qrCodeLabel: {
    color: Colors.textSecondary,
    fontSize: 14,
    fontFamily: FontFamily.regular,
    marginTop: Spacing.lg,
  },
  addressCard: {
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.lg,
    padding: Spacing.lg,
    marginBottom: Spacing.xl,
  },
  addressLabel: {
    color: Colors.textSecondary,
    fontSize: 12,
    fontFamily: FontFamily.medium,
    marginBottom: Spacing.sm,
  },
  addressText: {
    color: Colors.text,
    fontSize: 14,
    fontFamily: FontFamily.mono || FontFamily.regular,
    lineHeight: 22,
  },
  depositActions: {
    flexDirection: 'row',
    gap: Spacing.md,
    marginBottom: Spacing.xl,
  },
  depositActionButton: {
    flex: 2,
    borderRadius: BorderRadius.lg,
    overflow: 'hidden',
  },
  depositActionGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.lg,
    gap: Spacing.sm,
  },
  depositActionText: {
    color: '#0a0a0c',
    fontSize: 15,
    fontFamily: FontFamily.semibold,
  },
  depositActionButtonSecondary: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.lg,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: P01.cyan,
    gap: Spacing.sm,
  },
  depositActionTextSecondary: {
    color: P01.cyan,
    fontSize: 15,
    fontFamily: FontFamily.semibold,
  },
  depositWarning: {
    flexDirection: 'row',
    backgroundColor: 'rgba(251, 146, 60, 0.1)',
    borderRadius: BorderRadius.lg,
    padding: Spacing.lg,
    gap: Spacing.md,
  },
  depositWarningText: {
    flex: 1,
    color: '#fb923c',
    fontSize: 13,
    fontFamily: FontFamily.regular,
    lineHeight: 20,
  },
});

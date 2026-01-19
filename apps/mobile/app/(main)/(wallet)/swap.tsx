import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Alert,
  Modal,
  FlatList,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown, FadeInUp, FadeIn } from 'react-native-reanimated';

import { useWalletStore } from '@/stores/walletStore';
import { Colors, FontFamily, BorderRadius, Spacing } from '@/constants/theme';

// P-01 Design System Colors - NO purple allowed
const P01 = {
  cyan: '#39c5bb',
  cyanDim: 'rgba(57, 197, 187, 0.15)',
  pink: '#ff77a8',
  pinkDim: 'rgba(255, 119, 168, 0.15)',
  blue: '#3b82f6',
  blueDim: 'rgba(59, 130, 246, 0.15)',
};

// Token definitions
interface Token {
  symbol: string;
  name: string;
  mint: string;
  decimals: number;
  logoColor: string;
  balance?: number;
}

const TOKENS: Token[] = [
  {
    symbol: 'SOL',
    name: 'Solana',
    mint: 'So11111111111111111111111111111111111111112',
    decimals: 9,
    logoColor: '#39c5bb',
  },
  {
    symbol: 'USDC',
    name: 'USD Coin',
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    decimals: 6,
    logoColor: '#2775CA',
  },
  {
    symbol: 'USDT',
    name: 'Tether USD',
    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    decimals: 6,
    logoColor: '#26A17B',
  },
  {
    symbol: 'BONK',
    name: 'Bonk',
    mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    decimals: 5,
    logoColor: '#F7931A',
  },
  {
    symbol: 'JUP',
    name: 'Jupiter',
    mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    decimals: 6,
    logoColor: '#00D18C',
  },
  {
    symbol: 'RAY',
    name: 'Raydium',
    mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
    decimals: 6,
    logoColor: '#5AC4BE',
  },
  {
    symbol: 'PYTH',
    name: 'Pyth Network',
    mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
    decimals: 6,
    logoColor: '#ff77a8',
  },
  {
    symbol: 'WIF',
    name: 'dogwifhat',
    mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    decimals: 6,
    logoColor: '#A5682A',
  },
];

export default function SwapScreen() {
  const router = useRouter();
  const { balance, refreshBalance } = useWalletStore();

  // Form state
  const [fromToken, setFromToken] = useState<Token>(TOKENS[0]); // SOL
  const [toToken, setToToken] = useState<Token>(TOKENS[1]); // USDC
  const [fromAmount, setFromAmount] = useState('');
  const [toAmount, setToAmount] = useState('');
  const [slippage, setSlippage] = useState(0.5);
  const [loading, setLoading] = useState(false);
  const [showFromModal, setShowFromModal] = useState(false);
  const [showToModal, setShowToModal] = useState(false);
  const [showSlippageModal, setShowSlippageModal] = useState(false);
  const [quoteLoading, setQuoteLoading] = useState(false);

  // Mock exchange rates (in production, fetch from Jupiter API)
  const [exchangeRate, setExchangeRate] = useState<number | null>(null);

  // Get token balance
  const getTokenBalance = (token: Token): number => {
    if (token.symbol === 'SOL') {
      return balance?.sol || 0;
    }
    const tokenBalance = balance?.tokens?.find(t => t.mint === token.mint);
    return tokenBalance?.balance || 0;
  };

  // Mock quote fetch
  const fetchQuote = useCallback(async (amount: string) => {
    if (!amount || parseFloat(amount) <= 0) {
      setToAmount('');
      setExchangeRate(null);
      return;
    }

    setQuoteLoading(true);

    // Simulate API delay
    await new Promise(resolve => setTimeout(resolve, 500));

    // TODO: Replace with real Jupiter API integration
    // These are placeholder rates for development/testing only
    // Real rates should be fetched from: https://quote-api.jup.ag/v6/quote
    const placeholderRates: Record<string, Record<string, number>> = {
      SOL: { USDC: 185.50, USDT: 185.30, BONK: 2500000, JUP: 220, RAY: 105, PYTH: 580, WIF: 75 },
      USDC: { SOL: 0.0054, USDT: 0.9998, BONK: 13500, JUP: 1.19, RAY: 0.57, PYTH: 3.13, WIF: 0.40 },
      USDT: { SOL: 0.0054, USDC: 1.0002, BONK: 13520, JUP: 1.19, RAY: 0.57, PYTH: 3.14, WIF: 0.40 },
    };

    let rate = 1;
    if (fromToken.symbol === toToken.symbol) {
      rate = 1;
    } else if (placeholderRates[fromToken.symbol]?.[toToken.symbol]) {
      rate = placeholderRates[fromToken.symbol][toToken.symbol];
    } else if (placeholderRates[toToken.symbol]?.[fromToken.symbol]) {
      rate = 1 / placeholderRates[toToken.symbol][fromToken.symbol];
    } else {
      // Default fallback rate
      rate = 1;
    }

    const outputAmount = parseFloat(amount) * rate;
    setToAmount(outputAmount.toFixed(6));
    setExchangeRate(rate);
    setQuoteLoading(false);
  }, [fromToken, toToken]);

  // Debounce quote fetch
  useEffect(() => {
    const timer = setTimeout(() => {
      fetchQuote(fromAmount);
    }, 300);
    return () => clearTimeout(timer);
  }, [fromAmount, fromToken, toToken, fetchQuote]);

  const handleFromAmountChange = (value: string) => {
    const sanitized = value.replace(/[^0-9.]/g, '');
    const parts = sanitized.split('.');
    const formatted = parts.length > 2 ? `${parts[0]}.${parts.slice(1).join('')}` : sanitized;
    setFromAmount(formatted);
  };

  const handlePercentage = (percent: number) => {
    const tokenBalance = getTokenBalance(fromToken);
    const maxAmount = fromToken.symbol === 'SOL'
      ? Math.max(0, tokenBalance - 0.01) // Reserve for fees
      : tokenBalance;
    const value = (maxAmount * percent).toFixed(6);
    setFromAmount(value);
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  const handleSwapTokens = () => {
    const temp = fromToken;
    setFromToken(toToken);
    setToToken(temp);
    setFromAmount(toAmount);
    setToAmount(fromAmount);
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
  };

  const handleSwap = async () => {
    if (!fromAmount || parseFloat(fromAmount) <= 0) {
      Alert.alert('Invalid Amount', 'Please enter a valid amount to swap');
      return;
    }

    const tokenBalance = getTokenBalance(fromToken);
    if (parseFloat(fromAmount) > tokenBalance) {
      Alert.alert('Insufficient Balance', `You don't have enough ${fromToken.symbol}`);
      return;
    }

    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }

    Alert.alert(
      'Confirm Swap',
      `Swap ${fromAmount} ${fromToken.symbol} for ~${toAmount} ${toToken.symbol}?\n\nSlippage: ${slippage}%`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Swap',
          style: 'default',
          onPress: async () => {
            setLoading(true);
            try {
              // Simulate swap (in production, call Jupiter API)
              await new Promise(resolve => setTimeout(resolve, 2000));

              if (Platform.OS !== 'web') {
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              }

              Alert.alert(
                'Swap Successful',
                `Successfully swapped ${fromAmount} ${fromToken.symbol} for ${toAmount} ${toToken.symbol}`,
                [
                  {
                    text: 'Done',
                    onPress: () => {
                      refreshBalance();
                      router.back();
                    },
                  },
                ]
              );
            } catch (error: any) {
              if (Platform.OS !== 'web') {
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
              }
              Alert.alert('Swap Failed', error.message || 'Transaction failed');
            } finally {
              setLoading(false);
            }
          },
        },
      ]
    );
  };

  const selectToken = (token: Token, isFrom: boolean) => {
    if (isFrom) {
      if (token.symbol === toToken.symbol) {
        handleSwapTokens();
      } else {
        setFromToken(token);
      }
      setShowFromModal(false);
    } else {
      if (token.symbol === fromToken.symbol) {
        handleSwapTokens();
      } else {
        setToToken(token);
      }
      setShowToModal(false);
    }
  };

  const isFormValid = fromAmount && parseFloat(fromAmount) > 0 && toAmount && !loading;

  const renderTokenModal = (isFrom: boolean) => (
    <Modal
      visible={isFrom ? showFromModal : showToModal}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={() => isFrom ? setShowFromModal(false) : setShowToModal(false)}
    >
      <View style={styles.modalContainer}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>Select Token</Text>
          <TouchableOpacity
            onPress={() => isFrom ? setShowFromModal(false) : setShowToModal(false)}
            style={styles.modalCloseButton}
          >
            <Ionicons name="close" size={24} color={Colors.text} />
          </TouchableOpacity>
        </View>

        <FlatList
          data={TOKENS}
          keyExtractor={item => item.mint}
          contentContainerStyle={styles.tokenList}
          renderItem={({ item }) => {
            const tokenBalance = getTokenBalance(item);
            const isSelected = isFrom
              ? item.symbol === fromToken.symbol
              : item.symbol === toToken.symbol;

            return (
              <TouchableOpacity
                style={[styles.tokenItem, isSelected && styles.tokenItemSelected]}
                onPress={() => selectToken(item, isFrom)}
              >
                <View style={[styles.tokenLogo, { backgroundColor: item.logoColor + '20' }]}>
                  <Text style={[styles.tokenLogoText, { color: item.logoColor }]}>
                    {item.symbol.charAt(0)}
                  </Text>
                </View>
                <View style={styles.tokenInfo}>
                  <Text style={styles.tokenSymbol}>{item.symbol}</Text>
                  <Text style={styles.tokenName}>{item.name}</Text>
                </View>
                <View style={styles.tokenBalanceContainer}>
                  <Text style={styles.tokenBalanceValue}>
                    {tokenBalance > 0 ? tokenBalance.toFixed(4) : '0'}
                  </Text>
                  {isSelected && (
                    <Ionicons name="checkmark-circle" size={20} color={Colors.primary} />
                  )}
                </View>
              </TouchableOpacity>
            );
          }}
        />
      </View>
    </Modal>
  );

  const renderSlippageModal = () => (
    <Modal
      visible={showSlippageModal}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={() => setShowSlippageModal(false)}
    >
      <View style={styles.modalContainer}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>Slippage Tolerance</Text>
          <TouchableOpacity
            onPress={() => setShowSlippageModal(false)}
            style={styles.modalCloseButton}
          >
            <Ionicons name="close" size={24} color={Colors.text} />
          </TouchableOpacity>
        </View>

        <View style={styles.slippageContent}>
          <Text style={styles.slippageDescription}>
            Your transaction will revert if the price changes unfavorably by more than this percentage.
          </Text>

          <View style={styles.slippageOptions}>
            {[0.1, 0.5, 1, 3].map(value => (
              <TouchableOpacity
                key={value}
                style={[
                  styles.slippageOption,
                  slippage === value && styles.slippageOptionSelected,
                ]}
                onPress={() => {
                  setSlippage(value);
                  if (Platform.OS !== 'web') {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  }
                }}
              >
                <Text style={[
                  styles.slippageOptionText,
                  slippage === value && styles.slippageOptionTextSelected,
                ]}>
                  {value}%
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <TouchableOpacity
            style={styles.slippageDoneButton}
            onPress={() => setShowSlippageModal(false)}
          >
            <Text style={styles.slippageDoneButtonText}>Done</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        {/* Header */}
        <Animated.View entering={FadeInDown.delay(100)} style={styles.header}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={styles.backButton}
          >
            <Ionicons name="arrow-back" size={24} color={Colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Swap</Text>
          <TouchableOpacity
            onPress={() => setShowSlippageModal(true)}
            style={styles.settingsButton}
          >
            <Ionicons name="settings-outline" size={22} color={Colors.textSecondary} />
          </TouchableOpacity>
        </Animated.View>

        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* From Token */}
          <Animated.View entering={FadeInUp.delay(200)} style={styles.tokenSection}>
            <Text style={styles.sectionLabel}>FROM</Text>
            <View style={styles.tokenCard}>
              <TouchableOpacity
                style={styles.tokenSelector}
                onPress={() => setShowFromModal(true)}
              >
                <View style={[styles.tokenLogo, { backgroundColor: fromToken.logoColor + '20' }]}>
                  <Text style={[styles.tokenLogoText, { color: fromToken.logoColor }]}>
                    {fromToken.symbol.charAt(0)}
                  </Text>
                </View>
                <Text style={styles.selectedTokenSymbol}>{fromToken.symbol}</Text>
                <Ionicons name="chevron-down" size={18} color={Colors.textSecondary} />
              </TouchableOpacity>

              <View style={styles.amountContainer}>
                <TextInput
                  style={styles.amountInput}
                  placeholder="0"
                  placeholderTextColor={Colors.textTertiary}
                  value={fromAmount}
                  onChangeText={handleFromAmountChange}
                  keyboardType="decimal-pad"
                />
              </View>

              <View style={styles.tokenCardFooter}>
                <Text style={styles.balanceText}>
                  Balance: {getTokenBalance(fromToken).toFixed(4)} {fromToken.symbol}
                </Text>
                <View style={styles.percentButtons}>
                  {[0.25, 0.5, 1].map(percent => (
                    <TouchableOpacity
                      key={percent}
                      style={styles.percentButton}
                      onPress={() => handlePercentage(percent)}
                    >
                      <Text style={styles.percentButtonText}>
                        {percent === 1 ? 'MAX' : `${percent * 100}%`}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            </View>
          </Animated.View>

          {/* Swap Button */}
          <Animated.View entering={FadeIn.delay(300)} style={styles.swapArrowContainer}>
            <TouchableOpacity
              style={styles.swapArrowButton}
              onPress={handleSwapTokens}
            >
              <Ionicons name="swap-vertical" size={24} color={P01.blue} />
            </TouchableOpacity>
          </Animated.View>

          {/* To Token */}
          <Animated.View entering={FadeInUp.delay(400)} style={styles.tokenSection}>
            <Text style={styles.sectionLabel}>TO</Text>
            <View style={styles.tokenCard}>
              <TouchableOpacity
                style={styles.tokenSelector}
                onPress={() => setShowToModal(true)}
              >
                <View style={[styles.tokenLogo, { backgroundColor: toToken.logoColor + '20' }]}>
                  <Text style={[styles.tokenLogoText, { color: toToken.logoColor }]}>
                    {toToken.symbol.charAt(0)}
                  </Text>
                </View>
                <Text style={styles.selectedTokenSymbol}>{toToken.symbol}</Text>
                <Ionicons name="chevron-down" size={18} color={Colors.textSecondary} />
              </TouchableOpacity>

              <View style={styles.amountContainer}>
                {quoteLoading ? (
                  <Text style={styles.loadingText}>Loading...</Text>
                ) : (
                  <Text style={[styles.amountOutput, !toAmount && styles.amountOutputPlaceholder]}>
                    {toAmount || '0'}
                  </Text>
                )}
              </View>

              <View style={styles.tokenCardFooter}>
                <Text style={styles.balanceText}>
                  Balance: {getTokenBalance(toToken).toFixed(4)} {toToken.symbol}
                </Text>
              </View>
            </View>
          </Animated.View>

          {/* Exchange Rate Info */}
          {exchangeRate && fromAmount && (
            <Animated.View entering={FadeInUp.delay(500)} style={styles.rateCard}>
              <View style={styles.rateRow}>
                <Text style={styles.rateLabel}>Rate</Text>
                <Text style={styles.rateValue}>
                  1 {fromToken.symbol} = {exchangeRate.toFixed(6)} {toToken.symbol}
                </Text>
              </View>
              <View style={styles.rateDivider} />
              <View style={styles.rateRow}>
                <Text style={styles.rateLabel}>Slippage</Text>
                <TouchableOpacity
                  onPress={() => setShowSlippageModal(true)}
                  style={styles.slippageButton}
                >
                  <Text style={styles.slippageValue}>{slippage}%</Text>
                  <Ionicons name="pencil" size={14} color={P01.blue} />
                </TouchableOpacity>
              </View>
              <View style={styles.rateDivider} />
              <View style={styles.rateRow}>
                <Text style={styles.rateLabel}>Network Fee</Text>
                <Text style={styles.rateValue}>~0.00005 SOL</Text>
              </View>
              <View style={styles.rateDivider} />
              <View style={styles.rateRow}>
                <Text style={styles.rateLabel}>Route</Text>
                <View style={styles.routeBadge}>
                  <Text style={styles.routeText}>Jupiter</Text>
                </View>
              </View>
            </Animated.View>
          )}
        </ScrollView>

        {/* Swap Button */}
        <Animated.View entering={FadeInUp.delay(600)} style={styles.bottomSection}>
          <TouchableOpacity
            onPress={handleSwap}
            disabled={!isFormValid}
            style={[
              styles.swapButton,
              !isFormValid && styles.swapButtonDisabled,
            ]}
          >
            {loading ? (
              <Text style={styles.swapButtonText}>Swapping...</Text>
            ) : (
              <>
                <Ionicons name="swap-horizontal" size={20} color={Colors.background} />
                <Text style={styles.swapButtonText}>Swap</Text>
              </>
            )}
          </TouchableOpacity>
        </Animated.View>
      </KeyboardAvoidingView>

      {renderTokenModal(true)}
      {renderTokenModal(false)}
      {renderSlippageModal()}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  keyboardView: {
    flex: 1,
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
  settingsButton: {
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
    paddingBottom: Spacing['3xl'],
  },
  tokenSection: {
    marginBottom: Spacing.sm,
  },
  sectionLabel: {
    color: Colors.textTertiary,
    fontSize: 12,
    fontFamily: FontFamily.semibold,
    letterSpacing: 1,
    marginBottom: Spacing.sm,
  },
  tokenCard: {
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.lg,
  },
  tokenSelector: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surfaceTertiary,
    borderRadius: BorderRadius.lg,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    alignSelf: 'flex-start',
    gap: Spacing.sm,
  },
  tokenLogo: {
    width: 28,
    height: 28,
    borderRadius: BorderRadius.full,
    justifyContent: 'center',
    alignItems: 'center',
  },
  tokenLogoText: {
    fontSize: 14,
    fontFamily: FontFamily.bold,
  },
  selectedTokenSymbol: {
    color: Colors.text,
    fontSize: 16,
    fontFamily: FontFamily.semibold,
  },
  amountContainer: {
    marginTop: Spacing.lg,
    marginBottom: Spacing.md,
  },
  amountInput: {
    color: Colors.text,
    fontSize: 36,
    fontFamily: FontFamily.bold,
  },
  amountOutput: {
    color: Colors.text,
    fontSize: 36,
    fontFamily: FontFamily.bold,
  },
  amountOutputPlaceholder: {
    color: Colors.textTertiary,
  },
  loadingText: {
    color: Colors.textTertiary,
    fontSize: 24,
    fontFamily: FontFamily.medium,
  },
  tokenCardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  balanceText: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontFamily: FontFamily.regular,
  },
  percentButtons: {
    flexDirection: 'row',
    gap: Spacing.xs,
  },
  percentButton: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderRadius: BorderRadius.md,
    backgroundColor: P01.blueDim,
  },
  percentButtonText: {
    color: P01.blue,
    fontSize: 12,
    fontFamily: FontFamily.semibold,
  },
  swapArrowContainer: {
    alignItems: 'center',
    marginVertical: -Spacing.md,
    zIndex: 1,
  },
  swapArrowButton: {
    width: 44,
    height: 44,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.surfaceSecondary,
    borderWidth: 3,
    borderColor: Colors.background,
    justifyContent: 'center',
    alignItems: 'center',
  },
  rateCard: {
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.lg,
    marginTop: Spacing.lg,
  },
  rateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.sm,
  },
  rateLabel: {
    color: Colors.textSecondary,
    fontSize: 14,
    fontFamily: FontFamily.regular,
  },
  rateValue: {
    color: Colors.text,
    fontSize: 14,
    fontFamily: FontFamily.medium,
  },
  rateDivider: {
    height: 1,
    backgroundColor: Colors.border,
  },
  slippageButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
  },
  slippageValue: {
    color: P01.blue,
    fontSize: 14,
    fontFamily: FontFamily.semibold,
  },
  routeBadge: {
    backgroundColor: Colors.primaryDim,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderRadius: BorderRadius.md,
  },
  routeText: {
    color: Colors.primary,
    fontSize: 12,
    fontFamily: FontFamily.semibold,
  },
  bottomSection: {
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
    paddingBottom: Spacing['3xl'],
  },
  swapButton: {
    backgroundColor: P01.blue,
    borderRadius: BorderRadius.lg,
    paddingVertical: Spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
  },
  swapButtonDisabled: {
    backgroundColor: Colors.textTertiary,
    opacity: 0.5,
  },
  swapButtonText: {
    color: Colors.background,
    fontSize: 16,
    fontFamily: FontFamily.semibold,
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
  tokenList: {
    padding: Spacing.lg,
  },
  tokenItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.lg,
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.lg,
    marginBottom: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  tokenItemSelected: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primaryDim,
  },
  tokenInfo: {
    flex: 1,
    marginLeft: Spacing.md,
  },
  tokenSymbol: {
    color: Colors.text,
    fontSize: 16,
    fontFamily: FontFamily.semibold,
  },
  tokenName: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontFamily: FontFamily.regular,
    marginTop: 2,
  },
  tokenBalanceContainer: {
    alignItems: 'flex-end',
    gap: Spacing.xs,
  },
  tokenBalanceValue: {
    color: Colors.textSecondary,
    fontSize: 14,
    fontFamily: FontFamily.medium,
  },
  // Slippage modal
  slippageContent: {
    padding: Spacing.xl,
  },
  slippageDescription: {
    color: Colors.textSecondary,
    fontSize: 14,
    fontFamily: FontFamily.regular,
    lineHeight: 20,
    marginBottom: Spacing.xl,
  },
  slippageOptions: {
    flexDirection: 'row',
    gap: Spacing.md,
    marginBottom: Spacing['3xl'],
  },
  slippageOption: {
    flex: 1,
    paddingVertical: Spacing.lg,
    borderRadius: BorderRadius.lg,
    backgroundColor: Colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
  },
  slippageOptionSelected: {
    borderColor: P01.blue,
    backgroundColor: P01.blueDim,
  },
  slippageOptionText: {
    color: Colors.textSecondary,
    fontSize: 16,
    fontFamily: FontFamily.semibold,
  },
  slippageOptionTextSelected: {
    color: P01.blue,
  },
  slippageDoneButton: {
    backgroundColor: P01.blue,
    borderRadius: BorderRadius.lg,
    paddingVertical: Spacing.lg,
    alignItems: 'center',
  },
  slippageDoneButtonText: {
    color: Colors.background,
    fontSize: 16,
    fontFamily: FontFamily.semibold,
  },
});

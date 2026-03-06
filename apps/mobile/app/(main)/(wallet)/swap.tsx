import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Image,
  StyleSheet,
  Keyboard,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { VersionedTransaction } from '@solana/web3.js';

import { Colors, FontFamily, BorderRadius, Spacing } from '@/constants/theme';
import { useWalletStore } from '@/stores/walletStore';
import { useAuth } from '@/providers/PrivyProvider';
import { getConnection, isDevnet } from '@/services/solana/connection';
import { getKeypair } from '@/services/solana/wallet';
import {
  JupiterToken,
  TOKEN_MINTS,
  getQuote,
  getSwapTransaction,
  executeSwap,
  formatTokenAmount,
  parseTokenAmount,
  calculateExchangeRate,
  getPriceImpactSeverity,
  QuoteResponse,
  getPopularTokens,
} from '@/services/jupiter';

type SwapStatus = 'idle' | 'quoting' | 'signing' | 'swapping' | 'confirming' | 'success' | 'error';

// Default tokens
const DEFAULT_INPUT: JupiterToken = {
  address: TOKEN_MINTS.SOL,
  chainId: 101,
  decimals: 9,
  name: 'Solana',
  symbol: 'SOL',
  logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
};

const DEFAULT_OUTPUT: JupiterToken = {
  address: TOKEN_MINTS.USDC,
  chainId: 101,
  decimals: 6,
  name: 'USD Coin',
  symbol: 'USDC',
  logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png',
};

// Token selector modal (inline for simplicity)
import TokenSelector from '@/components/ui/TokenSelector';

export default function SwapScreen() {
  const router = useRouter();
  const { publicKey, balance } = useWalletStore();
  const { walletAddress, signTransaction: privySignTransaction } = useAuth();

  // Token state
  const [inputToken, setInputToken] = useState<JupiterToken>(DEFAULT_INPUT);
  const [outputToken, setOutputToken] = useState<JupiterToken>(DEFAULT_OUTPUT);
  const [inputAmount, setInputAmount] = useState('');
  const [outputAmount, setOutputAmount] = useState('');

  // Quote state
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [exchangeRate, setExchangeRate] = useState<number | null>(null);
  const [priceImpact, setPriceImpact] = useState<string>('0');

  // UI state
  const [status, setStatus] = useState<SwapStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [txSignature, setTxSignature] = useState<string | null>(null);
  const [selectorVisible, setSelectorVisible] = useState(false);
  const [selectorTarget, setSelectorTarget] = useState<'input' | 'output'>('input');
  const [slippage, setSlippage] = useState(50); // 0.5% default

  // Quote debounce
  const quoteTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Get SOL balance for display
  const solBalance = balance?.sol ? balance.sol / 1e9 : 0;

  // Fetch quote when input changes
  useEffect(() => {
    if (quoteTimeout.current) clearTimeout(quoteTimeout.current);

    if (!inputAmount || parseFloat(inputAmount) <= 0) {
      setQuote(null);
      setOutputAmount('');
      setExchangeRate(null);
      setPriceImpact('0');
      return;
    }

    setStatus('quoting');
    setError(null);

    quoteTimeout.current = setTimeout(async () => {
      try {
        const amountIn = parseTokenAmount(inputAmount, inputToken.decimals);
        const q = await getQuote({
          inputMint: inputToken.address,
          outputMint: outputToken.address,
          amount: amountIn.toString(),
          slippageBps: slippage,
        });

        setQuote(q);
        setOutputAmount(formatTokenAmount(q.outAmount, outputToken.decimals));
        setExchangeRate(
          calculateExchangeRate(q.inAmount, q.outAmount, inputToken.decimals, outputToken.decimals)
        );
        setPriceImpact(q.priceImpactPct);
        setStatus('idle');
      } catch (err: any) {
        console.error('[Swap] Quote error:', err);
        setError(err.message?.includes('Could not find') ? 'No route found for this pair' : 'Failed to get quote');
        setQuote(null);
        setOutputAmount('');
        setStatus('idle');
      }
    }, 500);

    return () => {
      if (quoteTimeout.current) clearTimeout(quoteTimeout.current);
    };
  }, [inputAmount, inputToken.address, outputToken.address, slippage]);

  // Swap tokens (flip)
  const handleFlip = useCallback(() => {
    const prevInput = inputToken;
    const prevOutput = outputToken;
    setInputToken(prevOutput);
    setOutputToken(prevInput);
    setInputAmount(outputAmount);
    setOutputAmount('');
    setQuote(null);
  }, [inputToken, outputToken, outputAmount]);

  // Open token selector
  const openSelector = (target: 'input' | 'output') => {
    setSelectorTarget(target);
    setSelectorVisible(true);
  };

  const handleTokenSelect = (token: JupiterToken) => {
    if (selectorTarget === 'input') {
      if (token.address === outputToken.address) {
        handleFlip();
      } else {
        setInputToken(token);
      }
    } else {
      if (token.address === inputToken.address) {
        handleFlip();
      } else {
        setOutputToken(token);
      }
    }
    setQuote(null);
    setOutputAmount('');
  };

  // Set max input amount
  const handleMax = () => {
    if (inputToken.address === TOKEN_MINTS.SOL) {
      // Keep some SOL for fees
      const max = Math.max(0, solBalance - 0.01);
      setInputAmount(max > 0 ? max.toFixed(6) : '0');
    } else {
      // For SPL tokens, find balance from wallet
      const tokenBalance = balance?.tokens?.find(
        (t: any) => t.mint === inputToken.address
      );
      if (tokenBalance) {
        setInputAmount((tokenBalance.balance / Math.pow(10, inputToken.decimals)).toString());
      }
    }
  };

  // Execute swap
  const handleSwap = async () => {
    if (!quote || !publicKey) return;

    Keyboard.dismiss();
    setError(null);
    setStatus('signing');

    try {
      const connection = getConnection();

      // Get swap transaction from Jupiter
      const swapResponse = await getSwapTransaction({
        quoteResponse: quote,
        userPublicKey: walletAddress || publicKey,
      });

      if (swapResponse.simulationError) {
        throw new Error(`Simulation failed: ${swapResponse.simulationError}`);
      }

      setStatus('swapping');

      // Sign and send
      let signFn: (tx: VersionedTransaction) => Promise<VersionedTransaction>;

      if (privySignTransaction) {
        signFn = privySignTransaction as any;
      } else {
        const keypair = await getKeypair();
        if (!keypair) throw new Error('No wallet keypair found');
        signFn = async (tx: VersionedTransaction) => {
          tx.sign([keypair]);
          return tx;
        };
      }

      const signature = await executeSwap({
        connection,
        swapTransaction: swapResponse.swapTransaction,
        signTransaction: signFn,
      });

      setTxSignature(signature);
      setStatus('success');

      // Refresh balance after swap
      setTimeout(() => {
        useWalletStore.getState().refreshBalance();
      }, 2000);
    } catch (err: any) {
      console.error('[Swap] Error:', err);
      setError(err.message || 'Swap failed');
      setStatus('error');
    }
  };

  // Reset after success/error
  const handleReset = () => {
    setInputAmount('');
    setOutputAmount('');
    setQuote(null);
    setError(null);
    setTxSignature(null);
    setStatus('idle');
  };

  const isProcessing = ['signing', 'swapping', 'confirming'].includes(status);
  const onDevnet = isDevnet();
  const canSwap = quote && !isProcessing && status !== 'quoting' && parseFloat(inputAmount) > 0 && !onDevnet;
  const impactSeverity = getPriceImpactSeverity(priceImpact);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => router.back()}
          disabled={isProcessing}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="arrow-back" size={24} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Swap</Text>
        <TouchableOpacity
          style={styles.settingsButton}
          onPress={() => {
            // Cycle slippage: 0.5% → 1% → 2% → 0.5%
            setSlippage(prev => prev === 50 ? 100 : prev === 100 ? 200 : 50);
          }}
          accessibilityRole="button"
          accessibilityLabel={`Slippage tolerance ${(slippage / 100).toFixed(1)} percent, tap to change`}
        >
          <Ionicons name="settings-outline" size={20} color={Colors.textSecondary} />
          <Text style={styles.slippageText}>{(slippage / 100).toFixed(1)}%</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Devnet Warning */}
        {isDevnet() && (
          <View style={styles.devnetBanner}>
            <Ionicons name="information-circle" size={22} color={Colors.warning} />
            <View style={{ flex: 1, marginLeft: Spacing.sm }}>
              <Text style={styles.devnetTitle}>Devnet Mode</Text>
              <Text style={styles.devnetText}>
                Swap is only available on mainnet. Switch to mainnet in Settings to use this feature.
              </Text>
            </View>
          </View>
        )}

        {/* Success State */}
        {status === 'success' && (
          <Animated.View entering={FadeInDown.duration(300)} style={styles.successCard}>
            <Ionicons name="checkmark-circle" size={48} color={Colors.primary} />
            <Text style={styles.successTitle}>Swap Complete!</Text>
            <Text style={styles.successAmount}>
              {inputAmount} {inputToken.symbol} → {outputAmount} {outputToken.symbol}
            </Text>
            {txSignature && (
              <Text style={styles.successSig} numberOfLines={1}>
                Tx: {txSignature.slice(0, 20)}...
              </Text>
            )}
            <TouchableOpacity style={styles.successButton} onPress={handleReset} accessibilityRole="button" accessibilityLabel="Start a new swap">
              <Text style={styles.successButtonText}>New Swap</Text>
            </TouchableOpacity>
          </Animated.View>
        )}

        {/* Swap Form */}
        {status !== 'success' && (
          <>
            {/* Input Token Card */}
            <Animated.View entering={FadeInDown.delay(50)} style={styles.tokenCard}>
              <View style={styles.tokenCardHeader}>
                <Text style={styles.tokenCardLabel}>You Pay</Text>
                {inputToken.address === TOKEN_MINTS.SOL && (
                  <TouchableOpacity onPress={handleMax} accessibilityRole="button" accessibilityLabel={`Use maximum balance, ${solBalance.toFixed(4)} SOL`}>
                    <Text style={styles.maxButton}>
                      Balance: {solBalance.toFixed(4)} SOL
                    </Text>
                  </TouchableOpacity>
                )}
              </View>

              <View style={styles.tokenInputRow}>
                <TextInput
                  style={styles.amountInput}
                  placeholder="0.00"
                  placeholderTextColor={Colors.textTertiary}
                  value={inputAmount}
                  onChangeText={text => {
                    // Allow only valid decimal numbers
                    if (/^\d*\.?\d*$/.test(text)) {
                      setInputAmount(text);
                    }
                  }}
                  keyboardType="decimal-pad"
                  editable={!isProcessing}
                  accessibilityLabel={`Amount of ${inputToken.symbol} to swap`}
                  accessibilityHint="Enter the amount you want to swap"
                />

                <TouchableOpacity
                  style={styles.tokenSelector}
                  onPress={() => openSelector('input')}
                  disabled={isProcessing}
                  accessibilityRole="button"
                  accessibilityLabel={`Select input token, currently ${inputToken.symbol}`}
                >
                  {inputToken.logoURI ? (
                    <Image source={{ uri: inputToken.logoURI }} style={styles.tokenSelectorLogo} />
                  ) : (
                    <View style={[styles.tokenSelectorLogo, styles.tokenSelectorLogoPlaceholder]}>
                      <Text style={styles.tokenSelectorLogoLetter}>{inputToken.symbol[0]}</Text>
                    </View>
                  )}
                  <Text style={styles.tokenSelectorSymbol}>{inputToken.symbol}</Text>
                  <Ionicons name="chevron-down" size={16} color={Colors.textSecondary} />
                </TouchableOpacity>
              </View>
            </Animated.View>

            {/* Flip Button */}
            <View style={styles.flipContainer}>
              <TouchableOpacity
                style={styles.flipButton}
                onPress={handleFlip}
                disabled={isProcessing}
                accessibilityRole="button"
                accessibilityLabel="Swap input and output tokens"
              >
                <Ionicons name="swap-vertical" size={22} color={Colors.primary} />
              </TouchableOpacity>
            </View>

            {/* Output Token Card */}
            <Animated.View entering={FadeInDown.delay(100)} style={styles.tokenCard}>
              <View style={styles.tokenCardHeader}>
                <Text style={styles.tokenCardLabel}>You Receive</Text>
                {status === 'quoting' && (
                  <ActivityIndicator size="small" color={Colors.primary} />
                )}
              </View>

              <View style={styles.tokenInputRow}>
                <Text style={[
                  styles.amountOutput,
                  !outputAmount && styles.amountOutputPlaceholder,
                ]}>
                  {outputAmount || '0.00'}
                </Text>

                <TouchableOpacity
                  style={styles.tokenSelector}
                  onPress={() => openSelector('output')}
                  disabled={isProcessing}
                  accessibilityRole="button"
                  accessibilityLabel={`Select output token, currently ${outputToken.symbol}`}
                >
                  {outputToken.logoURI ? (
                    <Image source={{ uri: outputToken.logoURI }} style={styles.tokenSelectorLogo} />
                  ) : (
                    <View style={[styles.tokenSelectorLogo, styles.tokenSelectorLogoPlaceholder]}>
                      <Text style={styles.tokenSelectorLogoLetter}>{outputToken.symbol[0]}</Text>
                    </View>
                  )}
                  <Text style={styles.tokenSelectorSymbol}>{outputToken.symbol}</Text>
                  <Ionicons name="chevron-down" size={16} color={Colors.textSecondary} />
                </TouchableOpacity>
              </View>
            </Animated.View>

            {/* Quote Details */}
            {quote && (
              <Animated.View entering={FadeInDown.delay(150)} style={styles.detailsCard}>
                {/* Rate */}
                {exchangeRate !== null && (
                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Rate</Text>
                    <Text style={styles.detailValue}>
                      1 {inputToken.symbol} = {exchangeRate.toFixed(exchangeRate < 1 ? 6 : 2)} {outputToken.symbol}
                    </Text>
                  </View>
                )}

                {/* Price Impact */}
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Price Impact</Text>
                  <Text style={[
                    styles.detailValue,
                    impactSeverity === 'high' && styles.detailValueDanger,
                    impactSeverity === 'medium' && styles.detailValueWarning,
                  ]}>
                    {parseFloat(priceImpact).toFixed(2)}%
                  </Text>
                </View>

                {/* Min Received */}
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Min. Received</Text>
                  <Text style={styles.detailValue}>
                    {formatTokenAmount(quote.otherAmountThreshold, outputToken.decimals)} {outputToken.symbol}
                  </Text>
                </View>

                {/* Slippage */}
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Slippage</Text>
                  <Text style={styles.detailValue}>{(slippage / 100).toFixed(1)}%</Text>
                </View>

                {/* Route */}
                {quote.routePlan && quote.routePlan.length > 0 && (
                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Route</Text>
                    <Text style={styles.detailValue} numberOfLines={1}>
                      {quote.routePlan.map(r => r.swapInfo.label).join(' → ')}
                    </Text>
                  </View>
                )}
              </Animated.View>
            )}

            {/* Price Impact Warning */}
            {impactSeverity === 'high' && quote && (
              <View style={styles.warningBanner}>
                <Ionicons name="warning" size={20} color={Colors.error} />
                <Text style={styles.warningText}>
                  High price impact! You may receive significantly less tokens.
                </Text>
              </View>
            )}

            {/* Error */}
            {error && (
              <View style={styles.errorBanner}>
                <Ionicons name="alert-circle" size={20} color={Colors.error} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}
          </>
        )}
      </ScrollView>

      {/* Bottom Action */}
      {status !== 'success' && (
        <View style={styles.bottomAction}>
          {isProcessing ? (
            <View style={styles.processingContainer}>
              <ActivityIndicator size="large" color={Colors.primary} />
              <Text style={styles.processingText}>
                {status === 'signing' ? 'Signing transaction...' :
                 status === 'swapping' ? 'Executing swap...' :
                 'Confirming...'}
              </Text>
            </View>
          ) : (
            <TouchableOpacity
              style={[
                styles.swapButton,
                !canSwap && styles.swapButtonDisabled,
              ]}
              onPress={handleSwap}
              disabled={!canSwap}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel={!inputAmount ? 'Enter amount' : status === 'quoting' ? 'Getting quote' : status === 'error' ? 'Try again' : 'Swap tokens'}
              accessibilityState={{ disabled: !canSwap }}
            >
              {status === 'error' ? (
                <TouchableOpacity
                  style={styles.swapButtonInner}
                  onPress={handleReset}
                  accessibilityRole="button"
                  accessibilityLabel="Try again"
                >
                  <Ionicons name="refresh" size={22} color="#0a0a0c" />
                  <Text style={styles.swapButtonText}>Try Again</Text>
                </TouchableOpacity>
              ) : (
                <View style={styles.swapButtonInner}>
                  <Ionicons name="swap-horizontal" size={22} color={canSwap ? '#0a0a0c' : Colors.textTertiary} />
                  <Text style={[
                    styles.swapButtonText,
                    !canSwap && styles.swapButtonTextDisabled,
                  ]}>
                    {!inputAmount ? 'Enter Amount' :
                     status === 'quoting' ? 'Getting Quote...' :
                     error ? 'Try Again' :
                     'Swap'}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Token Selector Modal */}
      <TokenSelector
        visible={selectorVisible}
        onClose={() => setSelectorVisible(false)}
        onSelect={handleTokenSelect}
        excludeMint={selectorTarget === 'input' ? outputToken.address : inputToken.address}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  devnetBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: Colors.warningDim,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.lg,
    borderWidth: 1,
    borderColor: 'rgba(255, 204, 0, 0.3)',
  },
  devnetTitle: {
    fontSize: 14,
    fontFamily: FontFamily.semibold,
    color: Colors.warning,
  },
  devnetText: {
    fontSize: 13,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    marginTop: 2,
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
    backgroundColor: Colors.surface,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 18,
    fontFamily: FontFamily.semibold,
    color: Colors.text,
  },
  settingsButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.full,
    gap: 4,
  },
  slippageText: {
    fontSize: 12,
    fontFamily: FontFamily.medium,
    color: Colors.textSecondary,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.md,
    paddingBottom: Spacing['4xl'],
  },
  // Token Card
  tokenCard: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.xl,
    padding: Spacing.lg,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  tokenCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.md,
  },
  tokenCardLabel: {
    fontSize: 13,
    fontFamily: FontFamily.medium,
    color: Colors.textTertiary,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  maxButton: {
    fontSize: 13,
    fontFamily: FontFamily.medium,
    color: Colors.primary,
  },
  tokenInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  amountInput: {
    flex: 1,
    fontSize: 28,
    fontFamily: FontFamily.semibold,
    color: Colors.text,
    marginRight: Spacing.md,
    padding: 0,
  },
  amountOutput: {
    flex: 1,
    fontSize: 28,
    fontFamily: FontFamily.semibold,
    color: Colors.text,
    marginRight: Spacing.md,
  },
  amountOutputPlaceholder: {
    color: Colors.textTertiary,
  },
  tokenSelector: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surfaceTertiary,
    borderRadius: BorderRadius.full,
    paddingVertical: Spacing.sm,
    paddingLeft: Spacing.sm,
    paddingRight: Spacing.md,
    gap: Spacing.sm,
  },
  tokenSelectorLogo: {
    width: 28,
    height: 28,
    borderRadius: 14,
  },
  tokenSelectorLogoPlaceholder: {
    backgroundColor: Colors.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  tokenSelectorLogoLetter: {
    fontSize: 14,
    fontFamily: FontFamily.semibold,
    color: Colors.textSecondary,
  },
  tokenSelectorSymbol: {
    fontSize: 15,
    fontFamily: FontFamily.semibold,
    color: Colors.text,
  },
  // Flip button
  flipContainer: {
    alignItems: 'center',
    marginVertical: -Spacing.md,
    zIndex: 10,
  },
  flipButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.surface,
    borderWidth: 3,
    borderColor: Colors.background,
    justifyContent: 'center',
    alignItems: 'center',
  },
  // Details card
  detailsCard: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    padding: Spacing.lg,
    marginTop: Spacing.lg,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: Spacing.sm,
  },
  detailLabel: {
    fontSize: 13,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
  },
  detailValue: {
    fontSize: 13,
    fontFamily: FontFamily.medium,
    color: Colors.text,
    maxWidth: '60%',
    textAlign: 'right',
  },
  detailValueWarning: {
    color: Colors.warning,
  },
  detailValueDanger: {
    color: Colors.error,
  },
  // Warning
  warningBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.errorDim,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginTop: Spacing.md,
    gap: Spacing.sm,
  },
  warningText: {
    flex: 1,
    fontSize: 13,
    fontFamily: FontFamily.medium,
    color: Colors.error,
  },
  // Error
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.errorDim,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginTop: Spacing.md,
    gap: Spacing.sm,
  },
  errorText: {
    flex: 1,
    fontSize: 13,
    fontFamily: FontFamily.medium,
    color: Colors.error,
  },
  // Bottom action
  bottomAction: {
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
    paddingBottom: 120,
  },
  swapButton: {
    backgroundColor: Colors.primary,
    borderRadius: BorderRadius.lg,
    paddingVertical: Spacing.lg,
    alignItems: 'center',
  },
  swapButtonDisabled: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  swapButtonInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  swapButtonText: {
    fontSize: 17,
    fontFamily: FontFamily.semibold,
    color: '#0a0a0c',
  },
  swapButtonTextDisabled: {
    color: Colors.textTertiary,
  },
  processingContainer: {
    alignItems: 'center',
    paddingVertical: Spacing.md,
    gap: Spacing.md,
  },
  processingText: {
    fontSize: 15,
    fontFamily: FontFamily.medium,
    color: Colors.primary,
  },
  // Success
  successCard: {
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.xl,
    padding: Spacing['3xl'],
    borderWidth: 1,
    borderColor: Colors.primary,
    marginTop: Spacing['3xl'],
  },
  successTitle: {
    fontSize: 22,
    fontFamily: FontFamily.semibold,
    color: Colors.text,
    marginTop: Spacing.lg,
  },
  successAmount: {
    fontSize: 16,
    fontFamily: FontFamily.medium,
    color: Colors.textSecondary,
    marginTop: Spacing.sm,
  },
  successSig: {
    fontSize: 12,
    fontFamily: FontFamily.mono,
    color: Colors.textTertiary,
    marginTop: Spacing.md,
  },
  successButton: {
    backgroundColor: Colors.primary,
    borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing['2xl'],
    paddingVertical: Spacing.md,
    marginTop: Spacing.xl,
  },
  successButtonText: {
    fontSize: 15,
    fontFamily: FontFamily.semibold,
    color: '#0a0a0c',
  },
});

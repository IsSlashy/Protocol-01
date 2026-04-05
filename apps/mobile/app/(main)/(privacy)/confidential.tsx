import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  TextInput,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { useWalletStore } from '@/stores/walletStore';
import { useConfidentialStore } from '@/stores/confidentialStore';
import { useStarkProver } from '@/providers/StarkProverProvider';
import {
  NATIVE_SOL_MINT_STR,
  USDC_DEVNET_MINT_STR,
  SUPPORTED_TOKENS,
  getTokenDecimals,
  getTokenSymbol,
  formatTokenAmount,
} from '@/services/zkspl';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import { requireBiometricAuth } from '@/utils/biometricGate';
import { p01Alert } from '@/stores/alertStore';

import ConfidentialBalanceCard from '@/components/privacy/ConfidentialBalanceCard';
import ConfidentialActions from '@/components/privacy/ConfidentialActions';
import PendingCreditsCard from '@/components/privacy/PendingCreditsCard';
import PrivacyInfoCard from '@/components/privacy/PrivacyInfoCard';
import AmountInputModal from '@/components/privacy/AmountInputModal';
import ZkProgressOverlay from '@/components/privacy/ZkProgressOverlay';

export default function ConfidentialBalanceScreen() {
  const router = useRouter();
  const { balance, publicKey } = useWalletStore();
  const {
    isInitialized,
    isLoading,
    balances,
    accounts,
    pendingCredits,
    error,
    zkWalletAddress,
    zkWalletBalance,
    selectedToken,
    stateValidation,
    publicTokenBalances,
    setSelectedToken,
    ensureInitialized,
    refreshBalance,
    refreshAllBalances,
    validateState,
    emergencyReset,
    deposit,
    withdraw,
    confidentialTransfer,
    depositStark,
    withdrawStark,
    confidentialTransferStark,
    getConfidentialProofInputs,
    getTransferProofInputs,
    sweepToMainWallet,
  } = useConfidentialStore();

  const {
    isReady: starkReady,
    generateConfidentialBalanceProof,
    generateTransferProof,
  } = useStarkProver();

  const [showBalance, setShowBalance] = useState(true);
  const [actionModal, setActionModal] = useState<'deposit' | 'withdraw' | 'transfer' | null>(null);
  const [amount, setAmount] = useState('');
  const [recipientAddress, setRecipientAddress] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  // Progress tracking
  const [progressStep, setProgressStep] = useState(0);
  const [progressMessage, setProgressMessage] = useState('');
  const [progressOperation, setProgressOperation] = useState<'deposit' | 'withdraw' | 'transfer' | 'sweep' | null>(null);

  // Token-aware balance computation
  const tokenDecimals = getTokenDecimals(selectedToken);
  const tokenSymbol = getTokenSymbol(selectedToken);
  const confidentialBalance = (balances[selectedToken] || 0) / Math.pow(10, tokenDecimals);
  const pendingCount = pendingCredits[selectedToken] || 0;
  const solBalance = (balances[NATIVE_SOL_MINT_STR] || 0) / 1e9;
  const usdcBalance = (balances[USDC_DEVNET_MINT_STR] || 0) / 1e6;

  useEffect(() => {
    if (publicKey) ensureInitialized();
  }, [publicKey]);

  const handleRefresh = useCallback(async () => {
    await refreshAllBalances();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [refreshAllBalances]);

  const runProgress = (startStep: number, messages: [number, string][]) => {
    let currentStep = startStep;
    return setInterval(() => {
      if (currentStep >= 85) { currentStep = 85; } else {
        const increment = currentStep < 40 ? 6 : currentStep < 65 ? 4 : 2;
        currentStep = Math.min(currentStep + increment, 85);
      }
      setProgressStep(currentStep);
      for (const [threshold, msg] of messages) {
        if (currentStep < threshold) { setProgressMessage(msg); break; }
      }
    }, 200);
  };

  const completeProgress = async () => {
    setProgressStep(100);
    setProgressMessage('Complete!');
    await new Promise(r => setTimeout(r, 500));
  };

  const resetProgress = () => {
    setIsProcessing(false);
    setProgressOperation(null);
    setProgressStep(0);
    setProgressMessage('');
  };

  const handleDeposit = async () => {
    if (!amount || parseFloat(amount) <= 0) { p01Alert('Invalid Amount', 'Please enter a valid amount'); return; }
    if (!publicKey) { p01Alert('Error', 'Wallet not connected'); return; }

    // For non-SOL tokens, check if the account exists and create it if needed
    if (selectedToken !== NATIVE_SOL_MINT_STR && !accounts[selectedToken]) {
      p01Alert('Account Required', `A confidential ${tokenSymbol} account needs to be created first. This will be done automatically.`);
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsProcessing(true);
    setProgressOperation('deposit');
    setProgressStep(0);
    setProgressMessage(`Preparing ${tokenSymbol} deposit...`);

    try {
      if (starkReady) {
        // --- STARK path (quantum-resistant) ---
        setProgressStep(5);
        setProgressMessage('Computing STARK proof inputs...');
        const inputs = await getConfidentialProofInputs(selectedToken, parseFloat(amount), false);

        setProgressStep(15);
        setProgressMessage('Generating STARK proof on-device...');
        const starkResult = await generateConfidentialBalanceProof(
          inputs.spendingKey, inputs.oldBalance, inputs.oldSalt,
          inputs.newBalance, inputs.newSalt, inputs.amount, inputs.amountSalt, inputs.tokenMint,
        );

        const proofBytes = Buffer.from(starkResult.proofHex, 'hex');
        const publicInputs = starkResult.publicInputs.map(s => BigInt(s));

        setProgressStep(40);
        setProgressMessage('Verifying STARK proof on-chain...');
        const interval = runProgress(40, [[60, 'Submitting deposit...'], [80, 'Confirming on Solana...'], [100, 'Complete!']]);
        await depositStark(selectedToken, parseFloat(amount), {
          proofBytes,
          publicInputs,
          proofSize: starkResult.proofSize,
        }, (step) => setProgressMessage(step));
        clearInterval(interval);
      } else {
        // --- Groth16 fallback ---
        const interval = runProgress(10, [[30, 'Generating proof...'], [55, 'Signing transaction...'], [75, 'Submitting to Solana...'], [100, 'Confirming...']]);
        await deposit(selectedToken, parseFloat(amount));
        clearInterval(interval);
      }
      await completeProgress();
      setActionModal(null);
      setAmount('');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      p01Alert('Success', `${tokenSymbol} deposited into confidential balance${starkReady ? ' (STARK verified)' : ''}`);
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      p01Alert('Error', (err as Error).message);
    } finally { resetProgress(); }
  };

  const handleWithdraw = async () => {
    if (!amount || parseFloat(amount) <= 0) { p01Alert('Invalid Amount', 'Please enter a valid amount'); return; }
    if (parseFloat(amount) > confidentialBalance) { p01Alert('Insufficient Balance', `You do not have enough confidential ${tokenSymbol}`); return; }
    if (!publicKey) { p01Alert('Error', 'Wallet not connected'); return; }

    // Biometric gate — require auth before withdrawing funds
    const authed = await requireBiometricAuth('Authenticate to withdraw funds');
    if (!authed) {
      p01Alert('Authentication Required', 'You must authenticate to withdraw funds.');
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsProcessing(true);
    setProgressOperation('withdraw');
    setProgressStep(0);
    setProgressMessage(`Preparing ${tokenSymbol} withdrawal...`);

    try {
      if (starkReady) {
        // --- STARK path (quantum-resistant) ---
        setProgressStep(5);
        setProgressMessage('Computing STARK proof inputs...');
        const inputs = await getConfidentialProofInputs(selectedToken, parseFloat(amount), true);

        setProgressStep(15);
        setProgressMessage('Generating STARK proof on-device...');
        const starkResult = await generateConfidentialBalanceProof(
          inputs.spendingKey, inputs.oldBalance, inputs.oldSalt,
          inputs.newBalance, inputs.newSalt, inputs.amount, inputs.amountSalt, inputs.tokenMint,
        );

        const proofBytes = Buffer.from(starkResult.proofHex, 'hex');
        const publicInputs = starkResult.publicInputs.map(s => BigInt(s));

        setProgressStep(40);
        setProgressMessage('Verifying STARK proof on-chain...');
        const interval = runProgress(40, [[60, 'Submitting withdrawal...'], [80, 'Confirming on Solana...'], [100, 'Complete!']]);
        await withdrawStark(selectedToken, parseFloat(amount), {
          proofBytes,
          publicInputs,
          proofSize: starkResult.proofSize,
        }, (step) => setProgressMessage(step));
        clearInterval(interval);
      } else {
        // --- Groth16 fallback ---
        const interval = runProgress(10, [[30, 'Generating ZK proof...'], [55, 'Signing transaction...'], [75, 'Submitting to Solana...'], [100, 'Confirming...']]);
        await withdraw(selectedToken, parseFloat(amount));
        clearInterval(interval);
      }
      await completeProgress();
      setActionModal(null);
      setAmount('');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      p01Alert('Success', `${tokenSymbol} withdrawn from confidential balance${starkReady ? ' (STARK verified)' : ''}`);
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      p01Alert('Error', (err as Error).message);
    } finally { resetProgress(); }
  };

  const handleTransfer = async () => {
    if (!amount || parseFloat(amount) <= 0) { p01Alert('Invalid Amount', 'Please enter a valid amount'); return; }
    if (!recipientAddress.trim()) { p01Alert('Missing Recipient', 'Please enter a recipient address'); return; }
    if (parseFloat(amount) > confidentialBalance) { p01Alert('Insufficient Balance', `You do not have enough confidential ${tokenSymbol}`); return; }
    try { new (require('@solana/web3.js').PublicKey)(recipientAddress.trim()); } catch { p01Alert('Invalid Address', 'Please enter a valid Solana address'); return; }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsProcessing(true);
    setProgressOperation('transfer');
    setProgressStep(0);
    setProgressMessage(`Preparing ${tokenSymbol} transfer...`);

    try {
      if (starkReady) {
        // --- STARK path (quantum-resistant) ---
        setProgressStep(5);
        setProgressMessage('Computing STARK proof inputs...');
        const inputs = await getTransferProofInputs(selectedToken, parseFloat(amount), recipientAddress.trim());

        setProgressStep(15);
        setProgressMessage('Generating STARK transfer proof...');
        const starkResult = await generateTransferProof(
          inputs.spendingKey, inputs.tokenMint,
          inputs.inAmount1, inputs.inRand1, inputs.inAmount2, inputs.inRand2,
          inputs.outAmount1, inputs.outRand1, inputs.outRecipient1,
          inputs.outAmount2, inputs.outRand2, inputs.outRecipient2,
          inputs.publicAmount,
        );

        const proofBytes = Buffer.from(starkResult.proofHex, 'hex');
        const publicInputs = starkResult.publicInputs.map(s => BigInt(s));

        setProgressStep(40);
        setProgressMessage('Verifying STARK proof on-chain...');
        const interval = runProgress(40, [[55, 'Creating commitment...'], [70, 'Submitting transfer...'], [85, 'Confirming on Solana...'], [100, 'Complete!']]);
        await confidentialTransferStark(selectedToken, recipientAddress.trim(), parseFloat(amount), {
          proofBytes,
          publicInputs,
          proofSize: starkResult.proofSize,
        }, (step) => setProgressMessage(step));
        clearInterval(interval);
      } else {
        // --- Groth16 fallback ---
        const interval = runProgress(10, [[25, 'Generating ZK proof...'], [45, 'Creating commitment...'], [65, 'Signing transaction...'], [80, 'Submitting to Solana...'], [100, 'Confirming...']]);
        await confidentialTransfer(selectedToken, recipientAddress.trim(), parseFloat(amount));
        clearInterval(interval);
      }
      await completeProgress();
      setActionModal(null);
      setAmount('');
      setRecipientAddress('');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      p01Alert('Transfer Sent', `The confidential ${tokenSymbol} transfer has been sent${starkReady ? ' (STARK verified)' : ''}. The recipient will see a pending credit they need to apply.`);
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      p01Alert('Error', (err as Error).message);
    } finally { resetProgress(); }
  };

  const handleSweepToMain = async () => {
    if (!publicKey) { p01Alert('Error', 'Main wallet not connected'); return; }
    if (!zkWalletAddress || zkWalletAddress === publicKey) { p01Alert('Same Wallet', 'ZK wallet and main wallet are the same address'); return; }

    // Fetch real on-chain balance before showing confirmation
    let realBalance = zkWalletBalance;
    try {
      const { getConnection } = require('@/services/solana/connection');
      const conn = getConnection();
      realBalance = await conn.getBalance(new (require('@solana/web3.js').PublicKey)(zkWalletAddress));
    } catch {}

    const available = (realBalance / 1e9) - 0.001; // reserve 1M lamports for rent + shield/unshield fees
    if (available <= 0) { p01Alert('No Funds', 'No funds available to send back'); return; }

    p01Alert(
      'Private Sweep to Main Wallet',
      `Privately send ${available.toFixed(4)} SOL to your main wallet via the shielded pool?\n\nThis breaks the on-chain link between wallets.\n\n${publicKey.slice(0, 8)}...${publicKey.slice(-6)}`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sweep',
          onPress: async () => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            setIsProcessing(true);
            setProgressOperation('sweep');
            setProgressStep(5);
            setProgressMessage('Preparing private sweep...');
            try {
              await sweepToMainWallet(publicKey, available, (step, message) => {
                if (step === 'shield') {
                  setProgressStep(30);
                  setProgressMessage(message);
                } else if (step === 'unshield') {
                  setProgressStep(65);
                  setProgressMessage(message);
                }
              });
              setProgressStep(100);
              setProgressMessage('Complete!');
              await new Promise(r => setTimeout(r, 500));
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              p01Alert('Success', `${available.toFixed(4)} SOL privately swept to your main wallet`);
            } catch (err) {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
              p01Alert('Error', (err as Error).message);
            } finally { resetProgress(); }
          },
        },
      ],
    );
  };

  const getModalConfig = () => {
    // Max deposit = public balance of the selected token (minus fee reserve for SOL)
    const pubBal = publicTokenBalances[selectedToken] || 0;
    const maxDeposit = selectedToken === NATIVE_SOL_MINT_STR
      ? Math.max(0, (pubBal - 15_000) / 1e9) // reserve 15k lamports for tx fee
      : pubBal / Math.pow(10, tokenDecimals); // USDC/other: full public token balance
    switch (actionModal) {
      case 'deposit': return { action: 'Deposit', subtitle: `Move ${tokenSymbol} into confidential balance`, icon: 'arrow-down' as const, color: P01Colors.cyan, dim: P01Colors.cyanDim, handler: handleDeposit, max: maxDeposit };
      case 'withdraw': return { action: 'Withdraw', subtitle: `Withdraw ${tokenSymbol} from confidential balance`, icon: 'arrow-up' as const, color: P01Colors.pink, dim: P01Colors.pinkDim, handler: handleWithdraw, max: confidentialBalance };
      case 'transfer': return { action: 'Transfer', subtitle: `Send ${tokenSymbol} privately to another user`, icon: 'flash' as const, color: P01Colors.blue, dim: P01Colors.blueDim, handler: handleTransfer, max: confidentialBalance };
      default: return null;
    }
  };

  const modalConfig = getModalConfig();

  const handleCopyAddress = () => {
    if (zkWalletAddress) {
      Clipboard.setStringAsync(zkWalletAddress);
      setTimeout(() => Clipboard.setStringAsync(''), 60000);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      p01Alert('Copied', 'ZK wallet address copied to clipboard. Clipboard will be cleared in 60 seconds.');
    }
  };

  const handlePasteRecipient = async () => {
    const text = await Clipboard.getStringAsync();
    if (text) {
      setRecipientAddress(text.trim());
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Gradient Header */}
      <LinearGradient colors={['#0d1117', '#0a0a0c']} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton} accessibilityRole="button" accessibilityLabel="Go back">
          <Ionicons name="arrow-back" size={24} color={Colors.textPrimary} />
        </TouchableOpacity>
        <View style={styles.headerTitle}>
          <Ionicons name="lock-closed" size={22} color={P01Colors.blue} />
          <Text style={styles.headerText}>Confidential Balance</Text>
        </View>
        <TouchableOpacity onPress={() => setShowBalance(!showBalance)} accessibilityRole="button" accessibilityLabel={showBalance ? 'Hide balance' : 'Show balance'}>
          <Ionicons name={showBalance ? 'eye' : 'eye-off'} size={22} color={Colors.textSecondary} />
        </TouchableOpacity>
      </LinearGradient>

      <ScrollView
        style={styles.content}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={handleRefresh} tintColor={P01Colors.cyan} />}
      >
        <ConfidentialBalanceCard
          isLoading={isLoading}
          isInitialized={isInitialized}
          confidentialBalance={confidentialBalance}
          showBalance={showBalance}
          onRefresh={handleRefresh}
          tokenSymbol={tokenSymbol}
        />

        {/* Token Selector */}
        <Animated.View entering={FadeInDown.delay(150)} style={styles.tokenSelectorRow}>
          {SUPPORTED_TOKENS.map((token) => {
            const isActive = token.mintStr === selectedToken;
            const bal = (balances[token.mintStr] || 0) / Math.pow(10, token.decimals);
            return (
              <TouchableOpacity
                key={token.mintStr}
                onPress={() => { setSelectedToken(token.mintStr); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
                style={[
                  styles.tokenChip,
                  isActive && styles.tokenChipActive,
                ]}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={`Select ${token.symbol}`}
                accessibilityState={{ selected: isActive }}
              >
                <Ionicons
                  name={token.symbol === 'SOL' ? 'diamond-outline' : 'cash-outline'}
                  size={16}
                  color={isActive ? P01Colors.cyan : Colors.textTertiary}
                />
                <Text style={[styles.tokenChipLabel, isActive && styles.tokenChipLabelActive]}>
                  {token.symbol}
                </Text>
                {showBalance && (
                  <Text style={[styles.tokenChipBalance, isActive && styles.tokenChipBalanceActive]}>
                    {token.decimals >= 9 ? bal.toFixed(4) : bal.toFixed(2)}
                  </Text>
                )}
              </TouchableOpacity>
            );
          })}
        </Animated.View>

        <ConfidentialActions
          confidentialBalance={confidentialBalance}
          onDeposit={() => setActionModal('deposit')}
          onWithdraw={() => setActionModal('withdraw')}
          onTransfer={() => setActionModal('transfer')}
        />

        <PendingCreditsCard count={pendingCount} />

        {/* ZK Wallet Balance */}
        <Animated.View entering={FadeInDown.delay(350)}>
          <Text style={styles.sectionTitle}>AVAILABLE TO DEPOSIT</Text>
          <View style={styles.walletCard}>
            <LinearGradient
              colors={selectedToken === NATIVE_SOL_MINT_STR ? ['#3b82f6', '#2563eb'] : ['#2563eb', '#7c3aed']}
              style={styles.walletIconCircle}
            >
              <Ionicons name={selectedToken === NATIVE_SOL_MINT_STR ? 'diamond-outline' : 'cash-outline'} size={20} color="#fff" />
            </LinearGradient>
            <View style={styles.walletInfo}>
              <Text style={styles.walletAvailableLabel}>
                {selectedToken === NATIVE_SOL_MINT_STR ? 'ZK Wallet SOL balance' : `${tokenSymbol} balance`}
              </Text>
              <Text style={styles.walletAmount}>
                {selectedToken === NATIVE_SOL_MINT_STR
                  ? `${(zkWalletBalance / 1e9).toFixed(4)} SOL`
                  : `${((publicTokenBalances[selectedToken] || 0) / Math.pow(10, tokenDecimals)).toFixed(tokenDecimals >= 9 ? 4 : 2)} ${tokenSymbol}`}
              </Text>
              {zkWalletAddress && (
                <View style={styles.addressRow}>
                  <View style={styles.addressPill}>
                    <Text style={styles.addressText}>
                      {zkWalletAddress.slice(0, 8)}...{zkWalletAddress.slice(-6)}
                    </Text>
                  </View>
                  <TouchableOpacity onPress={handleCopyAddress} style={styles.copyButton} accessibilityRole="button" accessibilityLabel="Copy ZK wallet address">
                    <Ionicons name="copy-outline" size={16} color={P01Colors.blue} />
                  </TouchableOpacity>
                </View>
              )}
              {publicKey && zkWalletAddress && publicKey !== zkWalletAddress && zkWalletBalance > 0.003 * 1e9 && (
                <TouchableOpacity onPress={handleSweepToMain} style={styles.sweepButton} accessibilityRole="button" accessibilityLabel="Private sweep to main wallet">
                  <Ionicons name="arrow-undo" size={14} color={P01Colors.cyan} />
                  <Text style={styles.sweepText}>Private sweep to main</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </Animated.View>

        <PrivacyInfoCard
          title="zkSPL Confidential Tokens"
          description="Your balance is stored as a Poseidon commitment on-chain. Only you know the plaintext balance. Deposits and withdrawals use ZK proofs to update the commitment without revealing the balance."
          gradientColors={[P01Colors.cyanDim, P01Colors.blueDim]}
          delay={400}
        />

        {/* State validation warning */}
        {stateValidation[selectedToken] && !stateValidation[selectedToken].isValid && (
          <Animated.View entering={FadeInDown.delay(420)}>
            <View style={styles.warningCard}>
              <View style={styles.warningAccent} />
              <View style={styles.warningContent}>
                <View style={styles.warningHeader}>
                  <Ionicons name="warning" size={20} color="#f59e0b" />
                  <Text style={styles.warningTitle}>State Desync Detected</Text>
                </View>
                <Text style={styles.warningText}>
                  {stateValidation[selectedToken].details}
                </Text>
                <Text style={styles.warningSubtext}>
                  Local nonce: {stateValidation[selectedToken].localNonce} | On-chain: {stateValidation[selectedToken].onChainNonce}
                </Text>
                <TouchableOpacity
                  style={styles.resetButton}
                  accessibilityRole="button"
                  accessibilityLabel="Emergency reset"
                  onPress={() => {
                    p01Alert(
                      'Emergency Reset',
                      'This will clear your local state for this token. Any confidential balance that cannot be recovered will be lost.\n\nYou will need to deposit fresh funds after reset.\n\nAre you sure?',
                      [
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: 'Reset State',
                          style: 'destructive',
                          onPress: async () => {
                            try {
                              await emergencyReset(selectedToken);
                              await refreshAllBalances();
                              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
                              p01Alert('State Reset', 'Local state has been cleared. You can now deposit fresh funds.');
                            } catch (err) {
                              p01Alert('Error', (err as Error).message);
                            }
                          },
                        },
                      ],
                    );
                  }}
                  activeOpacity={0.7}
                >
                  <Ionicons name="refresh" size={14} color="#f59e0b" />
                  <Text style={styles.resetButtonText}>Emergency Reset</Text>
                </TouchableOpacity>
              </View>
            </View>
          </Animated.View>
        )}

        {/* State valid indicator (subtle) */}
        {stateValidation[selectedToken]?.isValid && (
          <Animated.View entering={FadeInDown.delay(420)}>
            <View style={styles.validBadge}>
              <Ionicons name="checkmark-circle" size={14} color="#22c55e" />
              <Text style={styles.validText}>State verified — commitment matches on-chain</Text>
            </View>
          </Animated.View>
        )}

        {error && (
          <Animated.View entering={FadeInDown.delay(450)}>
            <View style={styles.errorCard}>
              <View style={styles.errorAccent} />
              <Ionicons name="alert-circle" size={20} color="#ef4444" />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          </Animated.View>
        )}
      </ScrollView>

      {modalConfig && (
        <AmountInputModal
          visible={actionModal !== null}
          action={modalConfig.action}
          subtitle={modalConfig.subtitle}
          iconName={modalConfig.icon}
          accentColor={modalConfig.color}
          dimColor={modalConfig.dim}
          amount={amount}
          onChangeAmount={setAmount}
          maxAmount={modalConfig.max}
          maxLabel={actionModal === 'deposit'
            ? `${modalConfig.max.toFixed(tokenDecimals >= 9 ? 4 : 2)} ${tokenSymbol}`
            : `${confidentialBalance.toFixed(tokenDecimals >= 9 ? 4 : 2)} ${tokenSymbol}`}
          tokenSymbol={tokenSymbol}
          isProcessing={isProcessing}
          onConfirm={modalConfig.handler}
          onClose={() => { setActionModal(null); setAmount(''); setRecipientAddress(''); }}
        >
          {actionModal === 'transfer' && (
            <View style={styles.recipientContainer}>
              <View style={styles.recipientLabelRow}>
                <Ionicons name="book-outline" size={14} color={Colors.textTertiary} />
                <Text style={styles.recipientLabel}>Recipient Address</Text>
              </View>
              <View style={styles.recipientInputRow}>
                <TextInput
                  style={styles.recipientInput}
                  value={recipientAddress}
                  onChangeText={setRecipientAddress}
                  placeholder="Solana address..."
                  placeholderTextColor={Colors.textTertiary}
                  autoCapitalize="none"
                  autoCorrect={false}
                  accessibilityLabel="Recipient address"
                  accessibilityHint="Enter the Solana address of the recipient"
                />
                <TouchableOpacity style={styles.pasteButton} onPress={handlePasteRecipient} accessibilityRole="button" accessibilityLabel="Paste address from clipboard">
                  <Ionicons name="clipboard-outline" size={16} color={P01Colors.blue} />
                  <Text style={styles.pasteText}>Paste</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </AmountInputModal>
      )}

      <ZkProgressOverlay
        visible={progressOperation !== null}
        operation={progressOperation}
        progressStep={progressStep}
        progressMessage={progressMessage}
        stepLabels={progressOperation === 'sweep' ? ['Prepare', 'Shield', 'Unshield', 'Done'] : undefined}
        stepThresholds={progressOperation === 'sweep' ? [10, 45, 80, 100] : undefined}
      />
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
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(59, 130, 246, 0.1)',
  },
  backButton: {
    padding: 8,
    marginLeft: -8,
  },
  headerTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerText: {
    fontSize: 18,
    fontFamily: FontFamily.bold,
    color: Colors.textPrimary,
  },
  content: {
    flex: 1,
  },
  scrollContent: {
    padding: Spacing.lg,
    paddingBottom: 120,
  },
  tokenSelectorRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: Spacing.md,
    marginBottom: Spacing.xs,
  },
  tokenChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  tokenChipActive: {
    borderColor: P01Colors.cyan,
    backgroundColor: 'rgba(57, 197, 187, 0.08)',
  },
  tokenChipLabel: {
    fontSize: 13,
    fontFamily: FontFamily.bold,
    color: Colors.textTertiary,
  },
  tokenChipLabelActive: {
    color: P01Colors.cyan,
  },
  tokenChipBalance: {
    fontSize: 11,
    fontFamily: FontFamily.mono,
    color: Colors.textTertiary,
  },
  tokenChipBalanceActive: {
    color: Colors.textSecondary,
  },
  sectionTitle: {
    fontSize: 11,
    fontFamily: FontFamily.bold,
    color: Colors.textTertiary,
    letterSpacing: 1,
    marginTop: Spacing.md,
    marginBottom: Spacing.sm,
  },
  walletCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    gap: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  walletIconCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  walletInfo: {
    flex: 1,
  },
  walletAvailableLabel: {
    fontSize: 11,
    fontFamily: FontFamily.medium,
    color: Colors.textTertiary,
    letterSpacing: 0.3,
    marginBottom: 2,
  },
  walletAmount: {
    fontSize: 16,
    fontFamily: FontFamily.bold,
    color: Colors.textPrimary,
  },
  addressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
    gap: 8,
  },
  addressPill: {
    backgroundColor: 'rgba(59, 130, 246, 0.08)',
    borderRadius: BorderRadius.sm,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  addressText: {
    fontSize: 12,
    fontFamily: FontFamily.mono,
    color: Colors.textSecondary,
  },
  copyButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(59, 130, 246, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sweepButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
    backgroundColor: 'rgba(57, 197, 187, 0.1)',
    borderRadius: BorderRadius.sm,
    paddingHorizontal: 10,
    paddingVertical: 6,
    alignSelf: 'flex-start',
  },
  sweepText: {
    fontSize: 12,
    fontFamily: FontFamily.medium,
    color: P01Colors.cyan,
  },
  warningCard: {
    flexDirection: 'row',
    backgroundColor: 'rgba(245, 158, 11, 0.08)',
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginTop: Spacing.md,
    overflow: 'hidden',
  },
  warningAccent: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 3,
    backgroundColor: '#f59e0b',
    borderTopLeftRadius: BorderRadius.md,
    borderBottomLeftRadius: BorderRadius.md,
  },
  warningContent: {
    flex: 1,
    marginLeft: 4,
  },
  warningHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  warningTitle: {
    fontSize: 14,
    fontFamily: FontFamily.bold,
    color: '#f59e0b',
  },
  warningText: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    marginBottom: 4,
  },
  warningSubtext: {
    fontSize: 11,
    fontFamily: FontFamily.mono,
    color: Colors.textTertiary,
    marginBottom: 10,
  },
  resetButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
    borderRadius: BorderRadius.sm,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  resetButtonText: {
    fontSize: 12,
    fontFamily: FontFamily.bold,
    color: '#f59e0b',
  },
  validBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: Spacing.sm,
    paddingVertical: 4,
  },
  validText: {
    fontSize: 11,
    fontFamily: FontFamily.regular,
    color: '#22c55e',
  },
  errorCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(239, 68, 68, 0.08)',
    borderRadius: BorderRadius.md,
    padding: Spacing.lg,
    marginTop: Spacing.md,
    overflow: 'hidden',
  },
  errorAccent: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 3,
    backgroundColor: '#ef4444',
    borderTopLeftRadius: BorderRadius.md,
    borderBottomLeftRadius: BorderRadius.md,
  },
  errorText: {
    flex: 1,
    fontSize: 13,
    fontFamily: FontFamily.regular,
    color: '#ef4444',
  },
  recipientContainer: {
    backgroundColor: Colors.background,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  recipientLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: Spacing.sm,
  },
  recipientLabel: {
    fontSize: 12,
    fontFamily: FontFamily.medium,
    color: Colors.textTertiary,
  },
  recipientInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  recipientInput: {
    flex: 1,
    fontSize: 14,
    fontFamily: FontFamily.mono,
    color: Colors.textPrimary,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: BorderRadius.sm,
  },
  pasteButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: P01Colors.blueDim,
    borderRadius: BorderRadius.sm,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  pasteText: {
    fontSize: 12,
    fontFamily: FontFamily.medium,
    color: P01Colors.blue,
  },
});

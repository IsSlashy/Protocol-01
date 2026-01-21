import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { useWalletStore } from '../../../stores/walletStore';
import { applyAmountNoise, createNoiseAdjustment } from '../../../utils/crypto/amountNoise';
import { applyTimingNoise, calculateNextPaymentWithNoise } from '../../../utils/privacy/timingNoise';
import {
  generateStealthKeys,
  generateStealthAddress,
  scanStealthPayment,
} from '../../../utils/crypto/stealth';
import {
  sendDecoyTransactions,
  sendPrivateTransaction,
  calculateDecoyFees,
  PRIVACY_LEVELS,
} from '../../../services/solana/decoyTransactions';
import { sendSol } from '../../../services/solana/transfer';
import { Keypair, PublicKey } from '@solana/web3.js';

const COLORS = {
  void: '#0a0a0c',
  surface: '#151518',
  border: '#2a2a30',
  cyan: '#39c5bb',
  pink: '#ff77a8',
  text: '#ffffff',
  textMuted: '#808088',
  success: '#22c55e',
  error: '#ef4444',
};

interface LogEntry {
  timestamp: string;
  message: string;
  type: 'info' | 'success' | 'error' | 'warning';
}

export default function PrivacyTestScreen() {
  const router = useRouter();
  const { publicKey, balance, refreshBalance } = useWalletStore();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [currentTest, setCurrentTest] = useState<string | null>(null);

  const addLog = useCallback((message: string, type: LogEntry['type'] = 'info') => {
    const timestamp = new Date().toLocaleTimeString('fr-FR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
    });
    setLogs(prev => [...prev, { timestamp, message, type }]);
    console.log(`[PrivacyTest] ${message}`);
  }, []);

  const clearLogs = () => setLogs([]);

  // ============================================
  // TEST 1: AMOUNT NOISE
  // ============================================
  const testAmountNoise = async () => {
    setCurrentTest('amount');
    setIsLoading(true);
    addLog('=== TEST AMOUNT NOISE ===', 'info');

    try {
      const baseAmount = 0.01; // 0.01 SOL
      const noisePercent = 10; // +/- 10%
      let noiseAdjustment = createNoiseAdjustment();
      const results: number[] = [];

      addLog(`Base amount: ${baseAmount} SOL`, 'info');
      addLog(`Noise: +/- ${noisePercent}%`, 'info');
      addLog(`Expected range: ${(baseAmount * 0.9).toFixed(4)} - ${(baseAmount * 1.1).toFixed(4)} SOL`, 'info');
      addLog('', 'info');

      for (let i = 0; i < 5; i++) {
        const remainingPayments = 5 - i;
        const noiseResult = await applyAmountNoise(
          baseAmount,
          noisePercent,
          noiseAdjustment.cumulative,
          remainingPayments
        );

        noiseAdjustment = {
          ...noiseAdjustment,
          cumulative: noiseResult.newCumulativeAdjustment,
          lastApplied: noiseResult.noiseDelta,
          timestamp: Date.now(),
        };

        const adjustedAmount = noiseResult.adjustedAmount;
        results.push(adjustedAmount);
        const variance = ((adjustedAmount - baseAmount) / baseAmount * 100).toFixed(2);
        const isInRange = adjustedAmount >= baseAmount * 0.9 && adjustedAmount <= baseAmount * 1.1;

        addLog(
          `Payment ${i + 1}: ${adjustedAmount.toFixed(6)} SOL (${variance > '0' ? '+' : ''}${variance}%) ${isInRange ? '✓' : '✗'}`,
          isInRange ? 'success' : 'warning'
        );
      }

      const total = results.reduce((a, b) => a + b, 0);
      const expectedTotal = baseAmount * 5;
      const totalVariance = ((total - expectedTotal) / expectedTotal * 100).toFixed(2);

      addLog('', 'info');
      addLog(`Total sent: ${total.toFixed(6)} SOL`, 'info');
      addLog(`Expected total: ${expectedTotal.toFixed(6)} SOL`, 'info');
      addLog(`Total variance: ${totalVariance}%`, Math.abs(parseFloat(totalVariance)) < 5 ? 'success' : 'warning');
      addLog('=== AMOUNT NOISE TEST COMPLETE ===', 'success');
    } catch (error: any) {
      addLog(`Error: ${error.message}`, 'error');
    } finally {
      setIsLoading(false);
      setCurrentTest(null);
    }
  };

  // ============================================
  // TEST 2: TIMING NOISE
  // ============================================
  const testTimingNoise = async () => {
    setCurrentTest('timing');
    setIsLoading(true);
    addLog('=== TEST TIMING NOISE ===', 'info');

    try {
      const scheduledTime = Date.now();
      const noiseHours = 1; // +/- 1 hour

      addLog(`Scheduled time: ${new Date(scheduledTime).toLocaleTimeString()}`, 'info');
      addLog(`Noise range: +/- ${noiseHours} hour(s)`, 'info');
      addLog(`Expected range: ${new Date(scheduledTime - noiseHours * 3600000).toLocaleTimeString()} - ${new Date(scheduledTime + noiseHours * 3600000).toLocaleTimeString()}`, 'info');
      addLog('', 'info');

      for (let i = 0; i < 5; i++) {
        const noisyTime = await applyTimingNoise(scheduledTime, noiseHours);
        const delayMs = noisyTime - scheduledTime;
        const delayMinutes = delayMs / 60000;
        const isInRange = Math.abs(delayMinutes) <= noiseHours * 60;

        addLog(
          `Execution ${i + 1}: ${new Date(noisyTime).toLocaleTimeString()} (${delayMinutes > 0 ? '+' : ''}${delayMinutes.toFixed(1)} min) ${isInRange ? '✓' : '✗'}`,
          isInRange ? 'success' : 'warning'
        );
      }

      addLog('', 'info');
      addLog('=== TIMING NOISE TEST COMPLETE ===', 'success');
    } catch (error: any) {
      addLog(`Error: ${error.message}`, 'error');
    } finally {
      setIsLoading(false);
      setCurrentTest(null);
    }
  };

  // ============================================
  // TEST 3: STEALTH ADDRESSES
  // ============================================
  const testStealthAddresses = async () => {
    setCurrentTest('stealth');
    setIsLoading(true);
    addLog('=== TEST STEALTH ADDRESSES ===', 'info');

    try {
      // Step 1: Generate stealth keys for recipient
      addLog('Step 1: Generating stealth keys...', 'info');
      const stealthKeys = await generateStealthKeys();
      addLog(`Spending Public Key: ${stealthKeys.spendingPublicKey.slice(0, 20)}...`, 'success');
      addLog(`Viewing Public Key: ${stealthKeys.viewingPublicKey.slice(0, 20)}...`, 'success');

      // Step 2: Generate stealth address
      addLog('', 'info');
      addLog('Step 2: Generating stealth address for payment...', 'info');
      const stealthAddr = await generateStealthAddress(
        stealthKeys.spendingPublicKey,
        stealthKeys.viewingPublicKey
      );
      addLog(`Stealth Address: ${stealthAddr.address.slice(0, 20)}...`, 'success');
      addLog(`Ephemeral Public Key: ${stealthAddr.ephemeralPublicKey.slice(0, 20)}...`, 'success');
      addLog(`View Tag: ${stealthAddr.viewTag}`, 'success');

      // Step 3: Simulate scanning for payment
      addLog('', 'info');
      addLog('Step 3: Simulating payment scan...', 'info');
      const scanResult = await scanStealthPayment(
        stealthAddr.ephemeralPublicKey,
        stealthKeys.viewingKey.secretKey,
        stealthKeys.spendingKey.secretKey,
        stealthAddr.viewTag
      );

      if (scanResult.found) {
        addLog(`Scan successful! Found stealth address: ${scanResult.stealthAddress?.slice(0, 20)}...`, 'success');
        addLog(`Private key recovered: ${scanResult.privateKey ? 'YES' : 'NO'}`, 'success');
      } else {
        addLog('Scan failed - payment not found', 'error');
      }

      // Copy stealth address for manual verification
      await Clipboard.setStringAsync(stealthAddr.address);
      addLog('', 'info');
      addLog('Stealth address copied to clipboard!', 'info');
      addLog(`Explorer: https://explorer.solana.com/address/${stealthAddr.address}?cluster=devnet`, 'info');

      addLog('', 'info');
      addLog('=== STEALTH ADDRESS TEST COMPLETE ===', 'success');
    } catch (error: any) {
      addLog(`Error: ${error.message}`, 'error');
    } finally {
      setIsLoading(false);
      setCurrentTest(null);
    }
  };

  // ============================================
  // TEST 4: DECOY TRANSACTIONS (REAL ON-CHAIN)
  // ============================================
  const testDecoyTransactions = async () => {
    if (!publicKey) {
      Alert.alert('Error', 'Wallet not connected');
      return;
    }

    const solBalance = balance?.sol || 0;
    if (solBalance < 0.01) {
      Alert.alert('Insufficient Balance', `You need at least 0.01 SOL. Current: ${solBalance.toFixed(4)} SOL`);
      return;
    }

    const feeEstimate = calculateDecoyFees('standard', 0.001);

    Alert.alert(
      'Test Decoy Transactions',
      `This will send REAL transactions on devnet:\n\n` +
      `- ${feeEstimate.decoyCount} decoy self-transfer(s)\n` +
      `- Estimated fees: ~${feeEstimate.totalFees.toFixed(6)} SOL\n\n` +
      `Current balance: ${solBalance.toFixed(4)} SOL\n\n` +
      `Continue?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Run Test',
          onPress: async () => {
            setCurrentTest('decoy');
            setIsLoading(true);
            addLog('=== TEST DECOY TRANSACTIONS (ON-CHAIN) ===', 'info');

            try {
              addLog(`Wallet: ${publicKey.slice(0, 8)}...${publicKey.slice(-8)}`, 'info');
              addLog(`Balance: ${solBalance.toFixed(4)} SOL`, 'info');
              addLog('', 'info');

              // Use standard level (1 decoy) to save SOL
              const level = PRIVACY_LEVELS.standard;
              const fees = calculateDecoyFees('standard', 0.001);
              addLog(`Privacy level: Standard (${level.decoyCount} decoy)`, 'info');
              addLog(`Estimated fees: ${fees.totalFees.toFixed(6)} SOL`, 'info');
              addLog('', 'info');

              addLog('Sending decoy transactions...', 'info');

              const signatures: string[] = [];

              // Send decoys (self-transfers) - amount 0.001 SOL, standard level
              const result = await sendDecoyTransactions(
                0.001, // Very small amount for decoys
                'standard',
                (progress) => {
                  addLog(`Progress: ${progress.current}/${progress.total} - ${progress.phase}`, 'info');
                  if (progress.currentSignature) {
                    signatures.push(progress.currentSignature);
                    addLog(`TX ${progress.current}: ${progress.currentSignature.slice(0, 20)}...`, 'success');
                  }
                }
              );

              addLog('', 'info');
              addLog('Transaction signatures:', 'info');
              result.decoys.forEach((decoy, i) => {
                addLog(`${i + 1}. https://explorer.solana.com/tx/${decoy.signature}?cluster=devnet`, 'success');
              });

              addLog('', 'info');
              addLog(`Total decoys sent: ${result.decoys.length}`, 'success');
              addLog(`Total fees: ${result.totalFeesSOL.toFixed(6)} SOL`, 'info');
              addLog('=== DECOY TRANSACTIONS TEST COMPLETE ===', 'success');

              // Refresh balance after transaction
              addLog('Refreshing balance...', 'info');
              await refreshBalance();
              const newBalance = useWalletStore.getState().balance;
              addLog(`New balance: ${newBalance?.sol?.toFixed(4) || '?'} SOL`, 'info');
            } catch (error: any) {
              addLog(`Error: ${error.message}`, 'error');
            } finally {
              setIsLoading(false);
              setCurrentTest(null);
              // Always refresh balance at the end
              refreshBalance();
            }
          },
        },
      ]
    );
  };

  // ============================================
  // FULL PRIVACY TEST (Amount + Timing + Stealth simulation)
  // ============================================
  const runAllTests = async () => {
    clearLogs();
    addLog('========================================', 'info');
    addLog('    PROTOCOL 01 PRIVACY TECH TESTS', 'info');
    addLog('========================================', 'info');
    addLog('', 'info');

    await testAmountNoise();
    addLog('', 'info');

    await testTimingNoise();
    addLog('', 'info');

    await testStealthAddresses();
    addLog('', 'info');

    addLog('========================================', 'info');
    addLog('All offline tests complete!', 'success');
    addLog('Run "Test Decoy TX" separately for on-chain test', 'info');
    addLog('========================================', 'info');
  };

  const getLogColor = (type: LogEntry['type']) => {
    switch (type) {
      case 'success': return COLORS.cyan;
      case 'error': return COLORS.error;
      case 'warning': return COLORS.pink;
      default: return COLORS.textMuted;
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: COLORS.void }} edges={['top']}>
      {/* Header */}
      <View style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 12,
      }}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={{
            width: 40,
            height: 40,
            borderRadius: 12,
            backgroundColor: COLORS.surface,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons name="arrow-back" size={20} color={COLORS.text} />
        </TouchableOpacity>
        <Text style={{ color: COLORS.text, fontSize: 18, fontWeight: '600' }}>
          Privacy Tech Tests
        </Text>
        <View style={{ width: 40 }} />
      </View>

      {/* Balance Info */}
      <View style={{
        marginHorizontal: 16,
        padding: 12,
        backgroundColor: COLORS.surface,
        borderRadius: 12,
        marginBottom: 12,
      }}>
        <Text style={{ color: COLORS.textMuted, fontSize: 12 }}>Wallet Balance</Text>
        <Text style={{ color: COLORS.cyan, fontSize: 20, fontWeight: '700' }}>
          {balance?.sol?.toFixed(4) || '0'} SOL
        </Text>
      </View>

      {/* Test Buttons */}
      <View style={{ paddingHorizontal: 16, marginBottom: 12 }}>
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
          <TouchableOpacity
            onPress={testAmountNoise}
            disabled={isLoading}
            style={{
              flex: 1,
              padding: 12,
              backgroundColor: currentTest === 'amount' ? COLORS.cyan : COLORS.surface,
              borderRadius: 12,
              alignItems: 'center',
            }}
          >
            {currentTest === 'amount' ? (
              <ActivityIndicator color={COLORS.void} />
            ) : (
              <>
                <Ionicons name="pulse" size={20} color={COLORS.cyan} />
                <Text style={{ color: COLORS.text, fontSize: 11, marginTop: 4 }}>Amount Noise</Text>
              </>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            onPress={testTimingNoise}
            disabled={isLoading}
            style={{
              flex: 1,
              padding: 12,
              backgroundColor: currentTest === 'timing' ? COLORS.cyan : COLORS.surface,
              borderRadius: 12,
              alignItems: 'center',
            }}
          >
            {currentTest === 'timing' ? (
              <ActivityIndicator color={COLORS.void} />
            ) : (
              <>
                <Ionicons name="time" size={20} color={COLORS.pink} />
                <Text style={{ color: COLORS.text, fontSize: 11, marginTop: 4 }}>Timing Noise</Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
          <TouchableOpacity
            onPress={testStealthAddresses}
            disabled={isLoading}
            style={{
              flex: 1,
              padding: 12,
              backgroundColor: currentTest === 'stealth' ? COLORS.cyan : COLORS.surface,
              borderRadius: 12,
              alignItems: 'center',
            }}
          >
            {currentTest === 'stealth' ? (
              <ActivityIndicator color={COLORS.void} />
            ) : (
              <>
                <Ionicons name="eye-off" size={20} color={COLORS.cyan} />
                <Text style={{ color: COLORS.text, fontSize: 11, marginTop: 4 }}>Stealth Address</Text>
              </>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            onPress={testDecoyTransactions}
            disabled={isLoading}
            style={{
              flex: 1,
              padding: 12,
              backgroundColor: currentTest === 'decoy' ? COLORS.pink : COLORS.surface,
              borderRadius: 12,
              alignItems: 'center',
              borderWidth: 1,
              borderColor: COLORS.pink + '50',
            }}
          >
            {currentTest === 'decoy' ? (
              <ActivityIndicator color={COLORS.void} />
            ) : (
              <>
                <Ionicons name="shuffle" size={20} color={COLORS.pink} />
                <Text style={{ color: COLORS.text, fontSize: 11, marginTop: 4 }}>Decoy TX</Text>
                <Text style={{ color: COLORS.pink, fontSize: 8 }}>ON-CHAIN</Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          onPress={runAllTests}
          disabled={isLoading}
          style={{
            padding: 14,
            backgroundColor: COLORS.cyan,
            borderRadius: 12,
            alignItems: 'center',
          }}
        >
          <Text style={{ color: COLORS.void, fontSize: 14, fontWeight: '600' }}>
            Run All Offline Tests
          </Text>
        </TouchableOpacity>
      </View>

      {/* Logs */}
      <View style={{ flex: 1, paddingHorizontal: 16 }}>
        <View style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 8,
        }}>
          <Text style={{ color: COLORS.textMuted, fontSize: 12, fontWeight: '500' }}>
            LOGS ({logs.length})
          </Text>
          <TouchableOpacity onPress={clearLogs}>
            <Text style={{ color: COLORS.cyan, fontSize: 12 }}>Clear</Text>
          </TouchableOpacity>
        </View>

        <ScrollView
          style={{
            flex: 1,
            backgroundColor: COLORS.surface,
            borderRadius: 12,
            padding: 12,
          }}
          showsVerticalScrollIndicator={false}
        >
          {logs.length === 0 ? (
            <Text style={{ color: COLORS.textMuted, fontSize: 12, fontStyle: 'italic' }}>
              No logs yet. Run a test to see results.
            </Text>
          ) : (
            logs.map((log, i) => (
              <Text
                key={i}
                style={{
                  color: getLogColor(log.type),
                  fontSize: 10,
                  fontFamily: 'monospace',
                  marginBottom: 2,
                }}
              >
                [{log.timestamp}] {log.message}
              </Text>
            ))
          )}
        </ScrollView>
      </View>

      {/* Checklist */}
      <View style={{
        padding: 16,
        backgroundColor: COLORS.surface,
        borderTopWidth: 1,
        borderTopColor: COLORS.border,
      }}>
        <Text style={{ color: COLORS.textMuted, fontSize: 10, marginBottom: 8 }}>
          VALIDATION CHECKLIST
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {[
            { name: 'Amount Noise', icon: 'pulse' },
            { name: 'Timing Noise', icon: 'time' },
            { name: 'Stealth Addr', icon: 'eye-off' },
            { name: 'Decoy TX', icon: 'shuffle' },
          ].map((item, i) => (
            <View
              key={i}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: COLORS.void,
                paddingHorizontal: 8,
                paddingVertical: 4,
                borderRadius: 6,
                gap: 4,
              }}
            >
              <Ionicons name={item.icon as any} size={12} color={COLORS.textMuted} />
              <Text style={{ color: COLORS.textMuted, fontSize: 10 }}>{item.name}</Text>
            </View>
          ))}
        </View>
      </View>
    </SafeAreaView>
  );
}

/**
 * Privacy tech tests — the developer tool behind the seven-tap door in About.
 *
 * 🎯 RETONED 2026-08-23. It is an internal screen, which is exactly why it had
 * drifted furthest: a local `COLORS` map with a green `#22c55e`, a red
 * `#ef4444`, a grey `#808088` that is in no palette, a `pink` key kept alive
 * next to `cyan`, and — twice, inline — `#8B5CF6`, a PURPLE, in a design system
 * whose header forbids purple in its first paragraph. A tool nobody outside the
 * team sees is still the team's own eye test.
 *
 * ⛔ NO SHOUTED MONO LABELS. `LOGS (12)`, `VALIDATION CHECKLIST`, `ON-CHAIN`,
 * `PQ-SAFE` were the arcade house style the brand is removing. The log stream
 * itself stays mono — that is data in columns, which is what mono is for.
 *
 * ⚠️ Every test button now says what it costs. Only one of the five spends
 * real devnet SOL, and it used to be distinguishable from the four free ones
 * only by being pink.
 */

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { p01Alert } from '@/stores/alertStore';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';

import { Header } from '@/components/common';
import { Button } from '@/components/ui';
import { Colors, FontFamily, FontSize, BorderRadius, Spacing, Layout } from '@/constants/theme';
import { useWalletStore } from '../../../stores/walletStore';
import { applyAmountNoise, createNoiseAdjustment } from '../../../utils/crypto/amountNoise';
import { applyTimingNoise } from '../../../utils/privacy/timingNoise';
import {
  generateStealthKeys,
  generateStealthAddress,
  scanStealthPayment,
} from '../../../utils/crypto/stealth';
import {
  sendDecoyTransactions,
  calculateDecoyFees,
  PRIVACY_LEVELS,
} from '../../../services/solana/decoyTransactions';
import { useStarkProver } from '../../../providers/StarkProverProvider';
import { runC7Bench, describeC7Headroom } from '../../../services/stark/c7Bench';
import { C7_EXPECTED_PROOF_SIZE } from '../../../services/stark/spendWitness';

interface LogEntry {
  timestamp: string;
  message: string;
  type: 'info' | 'success' | 'error' | 'warning';
}

type TestId = 'amount' | 'timing' | 'stealth' | 'decoy' | 'stark' | 'c7';

export default function PrivacyTestScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { publicKey, balance, refreshBalance } = useWalletStore();
  const { isReady: starkReady, generateProof: starkGenerateProof, generateSpendProof } = useStarkProver();
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
      addLog(`Viewing Public Key (X25519): ${Array.from(stealthKeys.viewingPublicKey.slice(0, 10)).map(b => b.toString(16).padStart(2, '0')).join('')}...`, 'success');

      // Step 2: Generate stealth address
      addLog('', 'info');
      addLog('Step 2: Generating stealth address for payment...', 'info');
      const stealthAddr = generateStealthAddress(
        stealthKeys.spendingKey.publicKey.toBytes(),
        stealthKeys.viewingPublicKey
      );
      addLog(`Stealth Address: ${stealthAddr.address.slice(0, 20)}...`, 'success');
      addLog(`Ephemeral Public Key: ${stealthAddr.ephemeralPublicKey.slice(0, 20)}...`, 'success');
      addLog(`View Tag: ${stealthAddr.viewTag}`, 'success');

      // Step 3: Simulate scanning for payment (round-trip verification)
      addLog('', 'info');
      addLog('Step 3: Simulating payment scan...', 'info');
      const scanResult = scanStealthPayment(
        stealthAddr.ephemeralPublicKey,
        stealthKeys.viewingSecretKey,
        stealthKeys.spendingKey.publicKey.toBytes(),
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
      p01Alert('Error', 'Wallet not connected');
      return;
    }

    const solBalance = balance?.sol || 0;
    if (solBalance < 0.01) {
      p01Alert('Insufficient Balance', `You need at least 0.01 SOL. Current: ${solBalance.toFixed(4)} SOL`);
      return;
    }

    const feeEstimate = calculateDecoyFees('standard', 0.001);

    p01Alert(
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
  // TEST 5: STARK PROOF (Quantum-Resistant)
  // ============================================
  const testStarkProof = async () => {
    setCurrentTest('stark');
    setIsLoading(true);
    addLog('=== TEST STARK PROOF (QUANTUM-RESISTANT) ===', 'info');

    try {
      if (!starkReady) {
        addLog('STARK WASM prover not ready', 'error');
        return;
      }

      addLog('WASM prover loaded, generating proof...', 'info');
      const testSecret = '123456789012345678';
      addLog(`Test secret: ${testSecret}`, 'info');

      const start = Date.now();
      const result = await starkGenerateProof(testSecret);
      const elapsed = Date.now() - start;

      addLog(`Proof generated in ${result.durationMs}ms (wall: ${elapsed}ms)`, 'success');
      addLog(`Proof size: ${result.proofSize} bytes`, 'success');
      addLog(`Commitment: ${result.commitment.slice(0, 32)}...`, 'success');
      addLog(`Proof hex: ${result.proofHex.slice(0, 40)}...`, 'info');
      addLog('', 'info');
      addLog('Properties:', 'info');
      addLog('  - Hash-based (no elliptic curves)', 'info');
      addLog('  - Quantum-resistant (Shor-safe)', 'info');
      addLog('  - ~9KB compact proof', 'info');
      addLog('  - Goldilocks field (2^64 - 2^32 + 1)', 'info');
      addLog('=== STARK PROOF TEST COMPLETE ===', 'success');
    } catch (error: any) {
      addLog(`Error: ${error.message}`, 'error');
    } finally {
      setIsLoading(false);
      setCurrentTest(null);
    }
  };

  // ============================================
  // TEST 6: CIRCUIT 7 SPEND PROOF — THE TIMING MEASUREMENT
  // ============================================
  //
  // 🎯 THIS IS THE NUMBER THAT DECIDES WHETHER MOBILE MAY ROUTE TO v4.
  //
  // `StarkProverProvider` gives every proof 180 000 ms. The tree records one
  // reason to fear that ceiling — memory/measured-on-device-proving-exceeds-180s
  // — and that note retracts itself in its own §"SECTION 1 IS WRONG": the 180 s
  // was a WebView HANG, not proving latency. The one real device datapoint in
  // the repository is the line it ends on, `circuit=3 prover=1482 ms`.
  //
  // Nothing here touches the chain. No RPC, no SOL, no note, no pool: circuit 7
  // DERIVES its subtree root from the path instead of checking it against a
  // fixed value, so a self-consistent synthetic path yields a valid proof. The
  // witness is copied felt for felt from
  // packages/stark-prover/scripts/c7-live-proof.ts, which is what makes the
  // number comparable to the desktop one. The proof is generated and discarded.
  //
  // ⚠️ FIVE RUNS, AND READ THE MEDIAN. C7's timings spread more than 2x across
  // samples in Node on this project's own hardware. One run is not a
  // measurement.
  const testC7SpendProof = async () => {
    setCurrentTest('c7');
    setIsLoading(true);
    addLog('=== TEST CIRCUIT 7 (SPEND) — ON-DEVICE TIMING ===', 'info');

    try {
      if (!starkReady) {
        addLog('STARK WASM prover not ready', 'error');
        return;
      }
      addLog('Synthetic witness, no pool and no chain. Nothing is submitted.', 'info');
      addLog('Five proofs — this may take a while. Do not background the app.', 'warning');

      const result = await runC7Bench(
        async (w) => generateSpendProof(
          w.nullifierPreimage, w.secret, w.blinding, w.tokenMint,
          w.pathElements, w.pathIndices, w.recipientHash,
        ),
        5,
        (line) => { console.log(line); addLog(line, 'info'); },
      );

      addLog('', 'info');
      addLog(describeC7Headroom(result, 'device'), 'success');
      addLog(`Proof size: ${result.proofSize} bytes = ${Math.ceil(result.proofSize / 1000)} upload chunks, 1 buffer`, 'info');
      addLog('v3 spends the same note on a C1+C3 pair: 147,038 bytes, 148 chunks, 2 buffers.', 'info');
      if (!result.sizeAsExpected) {
        addLog(`⛔ Expected ${C7_EXPECTED_PROOF_SIZE} bytes. The wire format moved — this number compares to nothing.`, 'error');
      }
      addLog('=== CIRCUIT 7 TEST COMPLETE ===', 'success');
    } catch (error: any) {
      addLog(`Error: ${error.message}`, 'error');
    } finally {
      setIsLoading(false);
      setCurrentTest(null);
    }
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
      case 'success': return Colors.primary;
      case 'error': return Colors.error;
      case 'warning': return Colors.yellow;
      default: return Colors.textTertiary;
    }
  };

  const TESTS: { id: TestId; label: string; note: string; icon: keyof typeof Ionicons.glyphMap; run: () => void; disabled?: boolean }[] = [
    { id: 'amount', label: 'Amount noise', note: 'Offline', icon: 'pulse-outline', run: testAmountNoise },
    { id: 'timing', label: 'Timing noise', note: 'Offline', icon: 'time-outline', run: testTimingNoise },
    { id: 'stealth', label: 'Stealth address', note: 'Offline', icon: 'eye-off-outline', run: testStealthAddresses },
    { id: 'decoy', label: 'Decoy transactions', note: 'Spends devnet SOL', icon: 'shuffle-outline', run: testDecoyTransactions },
    {
      id: 'stark',
      label: 'STARK proof',
      note: starkReady ? 'Offline, post-quantum' : 'Loading the WASM prover',
      icon: 'hardware-chip-outline',
      run: testStarkProof,
      disabled: !starkReady,
    },
    {
      id: 'c7',
      label: 'Circuit 7 spend proof',
      note: starkReady ? 'Offline, 5 runs, slow' : 'Loading the WASM prover',
      icon: 'stopwatch-outline',
      run: testC7SpendProof,
      disabled: !starkReady,
    },
  ];

  return (
    <View style={styles.screen}>
      <Header title="Privacy tech tests" showBack onBackPress={() => router.back()} />

      <View style={styles.balanceRow}>
        <Text style={styles.balanceLabel}>Wallet balance</Text>
        <Text style={styles.balanceValue}>{balance?.sol?.toFixed(4) || '0'} SOL</Text>
      </View>

      <View style={styles.tests}>
        {TESTS.map((test) => {
          const running = currentTest === test.id;
          const off = isLoading || test.disabled;
          return (
            <TouchableOpacity
              key={test.id}
              onPress={off ? undefined : test.run}
              disabled={off}
              activeOpacity={0.7}
              style={[styles.test, running && styles.testRunning, off && styles.testOff]}
              accessibilityRole="button"
              accessibilityLabel={`${test.label}. ${test.note}.`}
              accessibilityState={{ disabled: !!off, busy: running }}
            >
              <Ionicons
                name={test.icon}
                size={18}
                color={test.id === 'decoy' ? Colors.yellow : Colors.primary}
              />
              <View style={styles.testText}>
                <Text style={styles.testLabel}>{test.label}</Text>
                <Text style={[styles.testNote, test.id === 'decoy' && styles.testNoteWarn]}>
                  {running ? 'Running…' : test.note}
                </Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </View>

      <View style={styles.runAll}>
        <Button fullWidth onPress={runAllTests} disabled={isLoading}>
          Run the offline tests
        </Button>
      </View>

      {/* ── Log stream. Mono, because it is columns of data. ── */}
      <View style={styles.logsWrap}>
        <View style={styles.logsHeader}>
          <Text style={styles.logsTitle}>Logs ({logs.length})</Text>
          <TouchableOpacity
            onPress={clearLogs}
            style={styles.clear}
            accessibilityRole="button"
            accessibilityLabel="Clear the log"
          >
            <Text style={styles.clearText}>Clear</Text>
          </TouchableOpacity>
        </View>

        <ScrollView
          style={styles.logs}
          contentContainerStyle={{
            padding: Spacing.md,
            paddingBottom: Layout.tabBarTotalHeight + insets.bottom + Spacing.lg,
          }}
          showsVerticalScrollIndicator={false}
        >
          {logs.length === 0 ? (
            <Text style={styles.logsEmpty}>Nothing yet. Run a test.</Text>
          ) : (
            logs.map((log, i) => (
              <Text key={i} style={[styles.logLine, { color: getLogColor(log.type) }]}>
                [{log.timestamp}] {log.message}
              </Text>
            ))
          )}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.background },

  balanceRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.lg,
  },
  balanceLabel: {
    color: Colors.textTertiary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
  },
  balanceValue: {
    color: Colors.text,
    fontSize: FontSize.lg,
    fontFamily: FontFamily.mono,
  },

  tests: {
    paddingHorizontal: Spacing.xl,
    gap: Spacing.sm,
  },
  test: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    minHeight: 52,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderRadius: BorderRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    backgroundColor: Colors.surfaceSecondary,
  },
  testRunning: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primaryDim,
  },
  testOff: { opacity: 0.4 },
  testText: { flex: 1, minWidth: 0 },
  testLabel: {
    color: Colors.text,
    fontSize: FontSize.md,
    fontFamily: FontFamily.regular,
  },
  testNote: {
    color: Colors.textTertiary,
    fontSize: FontSize.xs,
    fontFamily: FontFamily.regular,
    marginTop: 1,
  },
  testNoteWarn: { color: Colors.yellow },

  runAll: {
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.lg,
  },

  logsWrap: { flex: 1, marginTop: Spacing.xl },
  logsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingBottom: Spacing.sm,
  },
  logsTitle: {
    color: Colors.textTertiary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
  },
  clear: {
    minHeight: 44,
    justifyContent: 'center',
    paddingLeft: Spacing.lg,
  },
  clearText: {
    color: Colors.primary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
  },
  logs: {
    flex: 1,
    marginHorizontal: Spacing.xl,
    borderRadius: BorderRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSoft,
    backgroundColor: Colors.surfaceSecondary,
  },
  logsEmpty: {
    color: Colors.textTertiary,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
  },
  logLine: {
    fontSize: 11,
    fontFamily: FontFamily.mono,
    lineHeight: 16,
    marginBottom: 1,
  },
});

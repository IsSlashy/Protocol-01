import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  StyleSheet,
  TextInput,
  Modal,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import Animated, {
  FadeInDown,
  FadeInUp,
} from 'react-native-reanimated';

import { useWalletStore } from '@/stores/walletStore';
import { useShieldedStore } from '@/stores/shieldedStore';
import { useZkProver } from '@/providers/ZkProverProvider';
import { usePrivyAuth } from '@/providers/PrivyProvider';
import { getKeypair } from '@/services/solana/wallet';
import { PublicKey, Transaction } from '@solana/web3.js';
import { Colors, FontFamily, BorderRadius, Spacing } from '@/constants/theme';

// P-01 Design System Colors - NO purple/violet allowed
const P01 = {
  cyan: '#39c5bb',
  cyanDim: 'rgba(57, 197, 187, 0.15)',
  pink: '#ff77a8',
  pinkDim: 'rgba(255, 119, 168, 0.15)',
  blue: '#3b82f6',
  blueDim: 'rgba(59, 130, 246, 0.15)',
};

export default function ShieldedWalletScreen() {
  const router = useRouter();
  const { balance, publicKey, isPrivyWallet } = useWalletStore();
  const { solanaWallet: privyWallet } = usePrivyAuth();
  const {
    isInitialized,
    isLoading,
    shieldedBalance,
    notes,
    zkAddress,
    pendingTransactions,
    initialize,
    ensureInitialized,
    refreshBalance,
    shield,
    unshield,
    importNote,
    clearNotes,
    scanStealthPayments,
    sweepAllStealthPayments,
    getPendingStealthPayments,
  } = useShieldedStore();

  // ZK Prover - uses backend prover (no local circuit files needed)
  const { isCircuitLoaded, error: proverError } = useZkProver();
  const [isLoadingProver, setIsLoadingProver] = useState(false);

  const [showBalance, setShowBalance] = useState(true);
  const [actionModal, setActionModal] = useState<'shield' | 'unshield' | null>(null);
  const [amount, setAmount] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importNoteString, setImportNoteString] = useState('');

  // Stealth recovery state
  const [showRecoveryModal, setShowRecoveryModal] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [isSweeping, setIsSweeping] = useState(false);
  const [foundPayments, setFoundPayments] = useState<Array<{ stealthAddress: string; amount: number; signature: string }>>([]);

  // Progress tracking for ZK operations
  const [progressStep, setProgressStep] = useState(0);
  const [progressMessage, setProgressMessage] = useState('');
  const [progressOperation, setProgressOperation] = useState<'shield' | 'unshield' | 'import' | null>(null);

  // Initialize on mount - handles both first init and app restart
  useEffect(() => {
    const initZk = async () => {
      if (publicKey) {
        // ensureInitialized will re-init if needed (e.g., after app restart)
        await ensureInitialized();
      }
    };
    initZk();
  }, [publicKey]);

  const handleRefresh = useCallback(async () => {
    await refreshBalance();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [refreshBalance]);

  const copyAddress = async () => {
    if (zkAddress) {
      await Clipboard.setStringAsync(zkAddress);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Copied', 'ZK address copied to clipboard');
    }
  };

  const handleShield = async () => {
    if (!amount || parseFloat(amount) <= 0) {
      Alert.alert('Invalid Amount', 'Please enter a valid amount');
      return;
    }

    if (!publicKey) {
      Alert.alert('Error', 'Wallet not connected');
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsProcessing(true);
    setProgressOperation('shield');
    setProgressStep(0);
    setProgressMessage('Preparing wallet...');

    try {
      let walletPubkey: PublicKey;
      let signTransaction: (tx: Transaction) => Promise<Transaction>;

      setProgressStep(10);
      setProgressMessage('Connecting to wallet...');

      // Use Privy signer if available, otherwise fall back to local keypair
      if (isPrivyWallet && privyWallet) {
        walletPubkey = new PublicKey(privyWallet.address);
        signTransaction = privyWallet.signTransaction;
      } else {
        // Get local keypair for signing
        const keypair = await getKeypair();
        if (!keypair) {
          throw new Error('Could not get wallet keypair');
        }
        walletPubkey = keypair.publicKey;
        signTransaction = async (tx: Transaction): Promise<Transaction> => {
          tx.sign(keypair);
          return tx;
        };
      }

      setProgressStep(20);
      setProgressMessage('Generating commitment...');

      // Start progress animation with proper closure handling
      let currentStep = 20;
      const progressInterval = setInterval(() => {
        if (currentStep >= 85) {
          currentStep = 85;
        } else {
          const increment = currentStep < 50 ? 8 : currentStep < 70 ? 5 : 2;
          currentStep = Math.min(currentStep + increment, 85);
        }
        setProgressStep(currentStep);

        // Update status message based on current step
        if (currentStep < 30) setProgressMessage('Generating commitment...');
        else if (currentStep < 50) setProgressMessage('Connecting to ZK prover...');
        else if (currentStep < 70) setProgressMessage('Generating ZK proof...');
        else if (currentStep < 85) setProgressMessage('Building transaction...');
        else setProgressMessage('Submitting to Solana...');
      }, 800);

      await shield(parseFloat(amount), walletPubkey, signTransaction);

      clearInterval(progressInterval);
      setProgressStep(100);
      setProgressMessage('Complete!');

      await new Promise(resolve => setTimeout(resolve, 500));

      setActionModal(null);
      setAmount('');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Success', 'SOL has been shielded successfully');
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Error', (err as Error).message);
    } finally {
      setIsProcessing(false);
      setProgressOperation(null);
      setProgressStep(0);
      setProgressMessage('');
    }
  };

  const handleUnshield = async () => {
    if (!amount || parseFloat(amount) <= 0) {
      Alert.alert('Invalid Amount', 'Please enter a valid amount');
      return;
    }

    if (parseFloat(amount) > shieldedBalance) {
      Alert.alert('Insufficient Balance', 'You do not have enough shielded SOL');
      return;
    }

    if (!publicKey) {
      Alert.alert('Error', 'Wallet not connected');
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsProcessing(true);
    setProgressOperation('unshield');
    setProgressStep(0);
    setProgressMessage('Preparing withdrawal...');

    try {
      let walletPubkey: PublicKey;
      let signTransaction: (tx: Transaction) => Promise<Transaction>;

      setProgressStep(10);
      setProgressMessage('Connecting to wallet...');

      // Use Privy signer if available, otherwise fall back to local keypair
      if (isPrivyWallet && privyWallet) {
        walletPubkey = new PublicKey(privyWallet.address);
        signTransaction = privyWallet.signTransaction;
      } else {
        // Get local keypair for signing
        const keypair = await getKeypair();
        if (!keypair) {
          throw new Error('Could not get wallet keypair');
        }
        walletPubkey = keypair.publicKey;
        signTransaction = async (tx: Transaction): Promise<Transaction> => {
          tx.sign(keypair);
          return tx;
        };
      }

      setProgressStep(15);
      setProgressMessage('Selecting notes...');

      // Start progress animation with proper closure handling
      let currentStep = 15;
      const progressInterval = setInterval(() => {
        if (currentStep >= 85) {
          currentStep = 85;
        } else {
          const increment = currentStep < 40 ? 6 : currentStep < 60 ? 4 : 2;
          currentStep = Math.min(currentStep + increment, 85);
        }
        setProgressStep(currentStep);

        // Update status message based on current step
        if (currentStep < 25) setProgressMessage('Selecting notes...');
        else if (currentStep < 40) setProgressMessage('Building Merkle proof...');
        else if (currentStep < 55) setProgressMessage('Connecting to ZK prover...');
        else if (currentStep < 70) setProgressMessage('Generating ZK proof...');
        else if (currentStep < 85) setProgressMessage('Building transaction...');
        else setProgressMessage('Submitting to Solana...');
      }, 600);

      // Unshield to own wallet
      await unshield(parseFloat(amount), walletPubkey, walletPubkey, signTransaction);

      clearInterval(progressInterval);
      setProgressStep(100);
      setProgressMessage('Complete!');

      await new Promise(resolve => setTimeout(resolve, 500));

      setActionModal(null);
      setAmount('');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Success', 'SOL has been unshielded successfully');
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Error', (err as Error).message);
    } finally {
      setIsProcessing(false);
      setProgressOperation(null);
      setProgressStep(0);
      setProgressMessage('');
    }
  };

  const handleImportNote = async () => {
    if (!importNoteString.trim()) {
      Alert.alert('Error', 'Please paste a note string');
      return;
    }

    if (!importNoteString.startsWith('p01note:')) {
      Alert.alert('Invalid Format', 'Note string must start with "p01note:"');
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsProcessing(true);
    setProgressOperation('import');
    setProgressStep(0);
    setProgressMessage('Parsing note...');

    try {
      setProgressStep(20);
      setProgressMessage('Decoding note data...');

      // Start progress animation with proper closure handling
      let currentStep = 20;
      const progressInterval = setInterval(() => {
        if (currentStep >= 90) {
          currentStep = 90;
        } else {
          const increment = currentStep < 50 ? 15 : 8;
          currentStep = Math.min(currentStep + increment, 90);
        }
        setProgressStep(currentStep);

        // Update status message based on current step
        if (currentStep < 30) setProgressMessage('Decoding note data...');
        else if (currentStep < 50) setProgressMessage('Validating commitment...');
        else if (currentStep < 70) setProgressMessage('Verifying Merkle path...');
        else if (currentStep < 90) setProgressMessage('Adding to wallet...');
        else setProgressMessage('Updating balance...');
      }, 400);

      await importNote(importNoteString.trim());

      clearInterval(progressInterval);
      setProgressStep(100);
      setProgressMessage('Complete!');

      await new Promise(resolve => setTimeout(resolve, 500));

      setShowImportModal(false);
      setImportNoteString('');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Success', 'Note imported successfully! Your shielded balance has been updated.');
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Import Failed', (err as Error).message);
    } finally {
      setIsProcessing(false);
      setProgressOperation(null);
      setProgressStep(0);
      setProgressMessage('');
    }
  };

  const handlePasteNote = async () => {
    const text = await Clipboard.getStringAsync();
    if (text) {
      setImportNoteString(text);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  const handleClearNotes = () => {
    Alert.alert(
      'Clear All Notes',
      'This will permanently delete all your shielded notes. This cannot be undone. Are you sure?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            try {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
              await clearNotes();
              Alert.alert('Cleared', 'All shielded notes have been cleared.');
            } catch (err) {
              Alert.alert('Error', (err as Error).message);
            }
          },
        },
      ]
    );
  };

  // Stealth payment recovery handlers
  const handleOpenRecovery = async () => {
    setShowRecoveryModal(true);
    setFoundPayments([]);
    // Auto-scan when opening
    await handleScanStealth();
  };

  const handleScanStealth = async () => {
    setIsScanning(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      const result = await scanStealthPayments();
      setFoundPayments(result.payments);

      if (result.found > 0) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } else {
        // Check if there are already pending payments from previous scans
        const pending = getPendingStealthPayments();
        if (pending.length > 0) {
          setFoundPayments(pending);
        }
      }
    } catch (err) {
      console.error('[Recovery] Scan error:', err);
      Alert.alert('Scan Error', (err as Error).message);
    } finally {
      setIsScanning(false);
    }
  };

  const handleSweepAll = async () => {
    if (!publicKey) {
      Alert.alert('Error', 'Wallet not connected');
      return;
    }

    setIsSweeping(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);

    try {
      const result = await sweepAllStealthPayments(publicKey);

      if (result.success && result.swept > 0) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        Alert.alert(
          'Recovery Complete!',
          `Recovered ${result.totalAmount.toFixed(4)} SOL from ${result.swept} stealth payment(s).\n\nFunds are now in your transparent wallet.`,
          [{ text: 'OK', onPress: () => setShowRecoveryModal(false) }]
        );
        setFoundPayments([]);
        // Refresh balance
        await refreshBalance();
      } else if (result.errors.length > 0) {
        Alert.alert('Partial Recovery', `Some payments failed:\n${result.errors.join('\n')}`);
      } else {
        Alert.alert('Nothing to Recover', 'No stealth payments found to sweep.');
      }
    } catch (err) {
      console.error('[Recovery] Sweep error:', err);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Sweep Error', (err as Error).message);
    } finally {
      setIsSweeping(false);
    }
  };

  const formatShieldedBalance = () => {
    if (!showBalance) return '****';
    return `${shieldedBalance.toFixed(4)} SOL`;
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
        >
          <Ionicons name="arrow-back" size={24} color={Colors.textPrimary} />
        </TouchableOpacity>
        <View style={styles.headerTitle}>
          <Ionicons name="shield-checkmark" size={20} color={P01.cyan} />
          <Text style={styles.headerText}>Shielded Wallet</Text>
        </View>
        <View style={styles.headerActions}>
          <TouchableOpacity onPress={() => setShowBalance(!showBalance)}>
            <Ionicons
              name={showBalance ? 'eye' : 'eye-off'}
              size={22}
              color={Colors.textSecondary}
            />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setShowInfo(true)} style={{ marginLeft: 16 }}>
            <Ionicons name="information-circle-outline" size={22} color={Colors.textSecondary} />
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView
        style={styles.content}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={isLoading}
            onRefresh={handleRefresh}
            tintColor={P01.cyan}
          />
        }
      >
        {/* Shielded Balance Card */}
        <Animated.View entering={FadeInDown.delay(100)}>
          <LinearGradient
            colors={[Colors.surface, Colors.background]}
            style={styles.balanceCard}
          >
            <View style={styles.balanceHeader}>
              <View style={styles.balanceLabel}>
                <Ionicons name="shield" size={18} color={P01.cyan} />
                <Text style={styles.balanceLabelText}>Shielded Balance</Text>
              </View>
              <TouchableOpacity onPress={handleRefresh}>
                <Ionicons
                  name="refresh"
                  size={18}
                  color={Colors.textSecondary}
                  style={isLoading ? styles.spinning : undefined}
                />
              </TouchableOpacity>
            </View>

            <View style={styles.balanceAmount}>
              <Ionicons name="lock-closed" size={28} color={P01.cyan} style={{ opacity: 0.6 }} />
              <Text style={styles.balanceValue}>
                {isLoading ? '...' : formatShieldedBalance()}
              </Text>
            </View>

            <Text style={styles.balanceSubtext}>
              Fully private • Zero-knowledge protected
            </Text>

            {/* ZK Address */}
            <TouchableOpacity onPress={copyAddress} style={styles.zkAddressContainer}>
              <View style={styles.zkAddressLabel}>
                <Text style={styles.zkAddressLabelText}>ZK Address</Text>
                <View style={styles.copyButton}>
                  <Ionicons name="copy-outline" size={14} color={P01.cyan} />
                  <Text style={styles.copyText}>Copy</Text>
                </View>
              </View>
              <Text style={styles.zkAddress} numberOfLines={1}>
                {zkAddress || 'Initializing...'}
              </Text>
            </TouchableOpacity>

          </LinearGradient>
        </Animated.View>

        {/* Action Buttons */}
        <Animated.View entering={FadeInDown.delay(200)} style={styles.actionsContainer}>
          <TouchableOpacity
            style={[styles.actionButton, { backgroundColor: P01.cyanDim }]}
            onPress={() => setActionModal('shield')}
          >
            <Ionicons name="arrow-down" size={24} color={P01.cyan} />
            <Text style={[styles.actionText, { color: P01.cyan }]}>Shield</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.actionButton,
              { backgroundColor: P01.pinkDim },
              shieldedBalance <= 0 && styles.actionButtonDisabled,
            ]}
            onPress={() => {
              if (shieldedBalance <= 0) return;
              setActionModal('unshield');
            }}
            disabled={shieldedBalance <= 0 || isLoadingProver}
          >
            {isLoadingProver ? (
              <ActivityIndicator size="small" color={P01.pink} />
            ) : (
              <Ionicons name="arrow-up" size={24} color={shieldedBalance > 0 ? P01.pink : Colors.textTertiary} />
            )}
            <Text style={[styles.actionText, { color: shieldedBalance > 0 ? P01.pink : Colors.textTertiary }]}>
              {isLoadingProver ? 'Loading...' : 'Unshield'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.actionButton,
              { backgroundColor: P01.blueDim },
              shieldedBalance <= 0 && styles.actionButtonDisabled,
            ]}
            onPress={() => {
              if (shieldedBalance <= 0) return;
              router.push('/(main)/(wallet)/shielded-transfer');
            }}
            disabled={shieldedBalance <= 0 || isLoadingProver}
          >
            {isLoadingProver ? (
              <ActivityIndicator size="small" color={P01.blue} />
            ) : (
              <Ionicons name="flash" size={24} color={shieldedBalance > 0 ? P01.blue : Colors.textTertiary} />
            )}
            <Text style={[styles.actionText, { color: shieldedBalance > 0 ? P01.blue : Colors.textTertiary }]}>
              {isLoadingProver ? 'Loading...' : 'Transfer'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.actionButton,
              { backgroundColor: 'rgba(16, 185, 129, 0.15)' },
            ]}
            onPress={handleOpenRecovery}
          >
            <Ionicons name="scan" size={24} color="#10b981" />
            <Text style={[styles.actionText, { color: '#10b981' }]}>Recover</Text>
          </TouchableOpacity>
        </Animated.View>

        {/* Prover Status Info */}
        <Animated.View entering={FadeInDown.delay(250)}>
          <View style={[styles.proverWarning, { borderColor: 'rgba(96, 165, 250, 0.3)' }]}>
            <Ionicons name="server" size={16} color="#60a5fa" />
            <Text style={styles.proverWarningText}>
              ZK proofs generated via backend server. Ensure the relayer is running.
            </Text>
          </View>
        </Animated.View>

        {/* Transparent Balance */}
        <Animated.View entering={FadeInDown.delay(300)}>
          <Text style={styles.sectionTitle}>TRANSPARENT BALANCE</Text>
          <View style={styles.transparentCard}>
            <View style={styles.transparentIcon}>
              <Ionicons name="lock-open" size={20} color="#fff" />
            </View>
            <View style={styles.transparentInfo}>
              <Text style={styles.transparentAmount}>
                {balance?.sol?.toFixed(4) || '0'} SOL
              </Text>
              <Text style={styles.transparentLabel}>Available to shield</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={Colors.textTertiary} />
          </View>
        </Animated.View>

        {/* Pending Transactions */}
        {pendingTransactions.length > 0 && (
          <Animated.View entering={FadeInDown.delay(350)}>
            <Text style={styles.sectionTitle}>PENDING</Text>
            {pendingTransactions.map((tx) => (
              <View key={tx.id} style={styles.pendingCard}>
                <View style={styles.pendingIcon}>
                  <ActivityIndicator color="#fbbf24" size="small" />
                </View>
                <View style={styles.pendingInfo}>
                  <Text style={styles.pendingType}>{tx.type}</Text>
                  <Text style={styles.pendingStatus}>
                    {tx.status === 'generating_proof' ? 'Generating ZK proof...' : 'Processing...'}
                  </Text>
                </View>
              </View>
            ))}
          </Animated.View>
        )}

        {/* Shielded Notes */}
        <Animated.View entering={FadeInDown.delay(400)}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>SHIELDED NOTES ({notes.length})</Text>
            {notes.length > 0 && (
              <TouchableOpacity onPress={handleClearNotes} style={styles.clearButton}>
                <Ionicons name="trash-outline" size={14} color="#ef4444" />
                <Text style={styles.clearText}>Clear</Text>
              </TouchableOpacity>
            )}
          </View>
          <View style={styles.notesContainer}>
            {notes.length === 0 ? (
              <View style={styles.emptyNotes}>
                <Ionicons name="shield-outline" size={40} color={Colors.textTertiary} />
                <Text style={styles.emptyText}>No shielded notes yet</Text>
                <Text style={styles.emptySubtext}>
                  Shield some SOL to create your first private note
                </Text>
              </View>
            ) : (
              notes.slice(0, 5).map((note, index) => (
                <View key={index} style={styles.noteCard}>
                  <View style={styles.noteIcon}>
                    <Ionicons name="lock-closed" size={18} color={P01.cyan} />
                  </View>
                  <View style={styles.noteInfo}>
                    <Text style={styles.noteAmount}>
                      {showBalance ? `${(Number(note.amount) / 1e9).toFixed(4)} SOL` : '****'}
                    </Text>
                    <Text style={styles.noteIndex}>Index: {note.leafIndex ?? 'pending'}</Text>
                  </View>
                </View>
              ))
            )}
          </View>
        </Animated.View>

        {/* Privacy Info */}
        <Animated.View entering={FadeInDown.delay(500)}>
          <LinearGradient
            colors={[P01.cyanDim, P01.pinkDim]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.infoCard}
          >
            <View style={styles.infoIcon}>
              <Ionicons name="shield-checkmark" size={24} color={P01.cyan} />
            </View>
            <View style={styles.infoContent}>
              <Text style={styles.infoTitle}>ZK-SNARK Protection</Text>
              <Text style={styles.infoText}>
                Your shielded transactions use Groth16 zero-knowledge proofs.
                No one can see amounts, senders, or recipients on-chain.
              </Text>
            </View>
          </LinearGradient>
        </Animated.View>
      </ScrollView>

      {/* Shield/Unshield Modal */}
      <Modal
        visible={actionModal !== null}
        animationType="slide"
        transparent
        onRequestClose={() => setActionModal(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <View style={[
                styles.modalIcon,
                { backgroundColor: actionModal === 'shield' ? P01.cyanDim : P01.pinkDim }
              ]}>
                <Ionicons
                  name={actionModal === 'shield' ? 'arrow-down' : 'arrow-up'}
                  size={28}
                  color={actionModal === 'shield' ? P01.cyan : P01.pink}
                />
              </View>
              <View>
                <Text style={styles.modalTitle}>
                  {actionModal === 'shield' ? 'Shield SOL' : 'Unshield SOL'}
                </Text>
                <Text style={styles.modalSubtitle}>
                  {actionModal === 'shield'
                    ? 'Move SOL into shielded pool'
                    : 'Withdraw from shielded pool'}
                </Text>
              </View>
            </View>

            <View style={styles.inputContainer}>
              <View style={styles.inputHeader}>
                <Text style={styles.inputLabel}>Amount</Text>
                <TouchableOpacity onPress={() => {
                  const max = actionModal === 'shield'
                    ? (balance?.sol || 0)
                    : shieldedBalance;
                  setAmount(max.toString());
                }}>
                  <Text style={styles.maxButton}>
                    Max: {actionModal === 'shield'
                      ? `${(balance?.sol || 0).toFixed(4)} SOL`
                      : `${shieldedBalance.toFixed(4)} SOL`}
                  </Text>
                </TouchableOpacity>
              </View>
              <View style={styles.inputRow}>
                <TextInput
                  style={styles.input}
                  value={amount}
                  onChangeText={setAmount}
                  placeholder="0.0"
                  placeholderTextColor={Colors.textTertiary}
                  keyboardType="decimal-pad"
                />
                <Text style={styles.inputSuffix}>SOL</Text>
              </View>
            </View>

            {actionModal === 'shield' && notes.length === 0 && (
              <View style={styles.warningBox}>
                <Ionicons name="warning" size={20} color="#fbbf24" />
                <Text style={styles.warningText}>
                  Proof generation may take 30-60 seconds on first use.
                </Text>
              </View>
            )}

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.cancelButton}
                onPress={() => {
                  setActionModal(null);
                  setAmount('');
                }}
                disabled={isProcessing}
              >
                <Text style={styles.cancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.confirmButton,
                  { backgroundColor: actionModal === 'shield' ? P01.cyan : P01.pink }
                ]}
                onPress={actionModal === 'shield' ? handleShield : handleUnshield}
                disabled={isProcessing || !amount || parseFloat(amount) <= 0}
              >
                {isProcessing ? (
                  <ActivityIndicator color="#000" />
                ) : (
                  <Text style={styles.confirmText}>
                    {actionModal === 'shield' ? 'Shield' : 'Unshield'}
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Info Modal */}
      <Modal
        visible={showInfo}
        animationType="fade"
        transparent
        onRequestClose={() => setShowInfo(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.infoModalContent}>
            <View style={styles.infoModalHeader}>
              <View style={[styles.modalIcon, { backgroundColor: P01.cyanDim }]}>
                <Ionicons name="shield-checkmark" size={28} color={P01.cyan} />
              </View>
              <View>
                <Text style={styles.modalTitle}>Shielded Transactions</Text>
                <Text style={styles.modalSubtitle}>Zcash-style privacy on Solana</Text>
              </View>
            </View>

            <ScrollView style={styles.infoScroll}>
              <View style={styles.infoSection}>
                <Text style={styles.infoSectionTitle}>How it works</Text>
                <Text style={styles.infoSectionText}>
                  Shielded transactions use zero-knowledge proofs (ZK-SNARKs) to hide
                  amounts, senders, and recipients while proving the transaction is valid.
                </Text>
              </View>

              <View style={styles.infoSection}>
                <Text style={styles.infoSectionTitle}>Shield</Text>
                <Text style={styles.infoSectionText}>
                  Convert transparent SOL into shielded notes. Your deposit amount is visible,
                  but from then on, all movements are completely private.
                </Text>
              </View>

              <View style={styles.infoSection}>
                <Text style={styles.infoSectionTitle}>Transfer</Text>
                <Text style={styles.infoSectionText}>
                  Send shielded SOL to any ZK address. The amount, sender, and recipient
                  are all hidden. Only you and the recipient know the details.
                </Text>
              </View>

              <View style={styles.infoSection}>
                <Text style={styles.infoSectionTitle}>Unshield</Text>
                <Text style={styles.infoSectionText}>
                  Withdraw shielded SOL back to a transparent address. The withdrawal
                  amount becomes visible, but the source remains hidden.
                </Text>
              </View>
            </ScrollView>

            <TouchableOpacity
              style={[styles.confirmButton, { backgroundColor: P01.cyan }]}
              onPress={() => setShowInfo(false)}
            >
              <Text style={styles.confirmText}>Got it</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Import Note Modal */}
      <Modal
        visible={showImportModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowImportModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <View style={[styles.modalIcon, { backgroundColor: 'rgba(255, 204, 0, 0.15)' }]}>
                <Ionicons name="download" size={28} color="#ffcc00" />
              </View>
              <View>
                <Text style={styles.modalTitle}>Import Note</Text>
                <Text style={styles.modalSubtitle}>Receive a shielded transfer</Text>
              </View>
            </View>

            <Text style={styles.inputLabel}>Note String</Text>
            <View style={styles.importInputContainer}>
              <TextInput
                style={styles.importInput}
                value={importNoteString}
                onChangeText={setImportNoteString}
                placeholder="p01note:..."
                placeholderTextColor={Colors.textTertiary}
                multiline
                numberOfLines={4}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TouchableOpacity style={styles.pasteButton} onPress={handlePasteNote}>
                <Ionicons name="clipboard-outline" size={20} color={P01.cyan} />
                <Text style={styles.pasteText}>Paste</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.importHint}>
              Ask the sender to share the note string with you after they complete the transfer.
            </Text>

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.cancelButton}
                onPress={() => {
                  setShowImportModal(false);
                  setImportNoteString('');
                }}
              >
                <Text style={styles.cancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.confirmButton, { backgroundColor: '#ffcc00' }]}
                onPress={handleImportNote}
                disabled={isProcessing || !importNoteString.trim()}
              >
                {isProcessing ? (
                  <ActivityIndicator color="#000" />
                ) : (
                  <Text style={[styles.confirmText, { color: '#000' }]}>Import</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Recovery Modal - Scan & Sweep Stealth Payments */}
      <Modal
        visible={showRecoveryModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowRecoveryModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <View style={[styles.modalIcon, { backgroundColor: 'rgba(16, 185, 129, 0.15)' }]}>
                <Ionicons name="scan" size={28} color="#10b981" />
              </View>
              <View>
                <Text style={styles.modalTitle}>Recover Private Funds</Text>
                <Text style={styles.modalSubtitle}>Scan for stealth payments</Text>
              </View>
            </View>

            {/* Scanning Status */}
            {isScanning && (
              <View style={styles.recoveryStatus}>
                <ActivityIndicator color="#10b981" size="small" />
                <Text style={styles.recoveryStatusText}>Scanning for payments...</Text>
              </View>
            )}

            {/* Found Payments */}
            {!isScanning && foundPayments.length > 0 && (
              <View style={styles.recoveryPayments}>
                <Text style={styles.recoveryPaymentsTitle}>
                  Found {foundPayments.length} payment(s)
                </Text>
                {foundPayments.map((payment, index) => (
                  <View key={index} style={styles.recoveryPaymentItem}>
                    <Ionicons name="checkmark-circle" size={20} color="#10b981" />
                    <View style={styles.recoveryPaymentInfo}>
                      <Text style={styles.recoveryPaymentAmount}>{payment.amount} SOL</Text>
                      <Text style={styles.recoveryPaymentAddress}>
                        {payment.stealthAddress.slice(0, 16)}...{payment.stealthAddress.slice(-8)}
                      </Text>
                    </View>
                  </View>
                ))}
                <Text style={styles.recoveryHint}>
                  These funds are on stealth addresses. Sweep to transfer to your wallet.
                </Text>
              </View>
            )}

            {/* No Payments Found */}
            {!isScanning && foundPayments.length === 0 && (
              <View style={styles.recoveryEmpty}>
                <Ionicons name="search-outline" size={48} color={Colors.textTertiary} />
                <Text style={styles.recoveryEmptyText}>No stealth payments found</Text>
                <Text style={styles.recoveryEmptyHint}>
                  When someone sends you a private transfer, it will appear here.
                </Text>
              </View>
            )}

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.cancelButton}
                onPress={() => setShowRecoveryModal(false)}
              >
                <Text style={styles.cancelText}>Close</Text>
              </TouchableOpacity>

              {foundPayments.length > 0 ? (
                <TouchableOpacity
                  style={[styles.confirmButton, { backgroundColor: '#10b981' }]}
                  onPress={handleSweepAll}
                  disabled={isSweeping}
                >
                  {isSweeping ? (
                    <ActivityIndicator color="#000" />
                  ) : (
                    <Text style={[styles.confirmText, { color: '#000' }]}>
                      Sweep {foundPayments.reduce((sum, p) => sum + p.amount, 0).toFixed(4)} SOL
                    </Text>
                  )}
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  style={[styles.confirmButton, { backgroundColor: '#10b981' }]}
                  onPress={handleScanStealth}
                  disabled={isScanning}
                >
                  {isScanning ? (
                    <ActivityIndicator color="#000" />
                  ) : (
                    <Text style={[styles.confirmText, { color: '#000' }]}>Scan Again</Text>
                  )}
                </TouchableOpacity>
              )}
            </View>
          </View>
        </View>
      </Modal>

      {/* Progress Overlay Modal */}
      <Modal
        visible={progressOperation !== null}
        animationType="fade"
        transparent
        onRequestClose={() => {}}
      >
        <View style={styles.progressOverlay}>
          <View style={styles.progressModal}>
            {/* Operation Icon */}
            <View style={[
              styles.progressIcon,
              {
                backgroundColor: progressOperation === 'shield' ? P01.cyanDim :
                  progressOperation === 'unshield' ? P01.pinkDim :
                  'rgba(255, 204, 0, 0.15)'
              }
            ]}>
              <Ionicons
                name={
                  progressOperation === 'shield' ? 'arrow-down' :
                  progressOperation === 'unshield' ? 'arrow-up' :
                  'download'
                }
                size={32}
                color={
                  progressOperation === 'shield' ? P01.cyan :
                  progressOperation === 'unshield' ? P01.pink :
                  '#ffcc00'
                }
              />
            </View>

            {/* Operation Title */}
            <Text style={styles.progressTitle}>
              {progressOperation === 'shield' ? 'Shielding SOL' :
               progressOperation === 'unshield' ? 'Unshielding SOL' :
               'Importing Note'}
            </Text>

            {/* Progress Bar */}
            <View style={styles.progressBarContainer}>
              <View style={styles.progressBarBg}>
                <Animated.View
                  style={[
                    styles.progressBarFill,
                    {
                      width: `${progressStep}%`,
                      backgroundColor: progressOperation === 'shield' ? P01.cyan :
                        progressOperation === 'unshield' ? P01.pink :
                        '#ffcc00'
                    }
                  ]}
                />
              </View>
              <Text style={styles.progressPercent}>{Math.round(progressStep)}%</Text>
            </View>

            {/* Status Message */}
            <Text style={[
              styles.progressStatus,
              {
                color: progressOperation === 'shield' ? P01.cyan :
                  progressOperation === 'unshield' ? P01.pink :
                  '#ffcc00'
              }
            ]}>
              {progressMessage}
            </Text>

            {/* Steps indicator */}
            <View style={styles.progressSteps}>
              <View style={styles.stepItem}>
                <View style={[
                  styles.stepDot,
                  progressStep >= 10 && styles.stepDotActive,
                  { backgroundColor: progressStep >= 10 ? (
                    progressOperation === 'shield' ? P01.cyan :
                    progressOperation === 'unshield' ? P01.pink :
                    '#ffcc00'
                  ) : Colors.border }
                ]} />
                <Text style={[styles.stepText, progressStep >= 10 && styles.stepTextActive]}>
                  Prepare
                </Text>
              </View>
              <View style={[styles.stepLine, progressStep >= 30 && { backgroundColor: progressOperation === 'shield' ? P01.cyan : progressOperation === 'unshield' ? P01.pink : '#ffcc00' }]} />
              <View style={styles.stepItem}>
                <View style={[
                  styles.stepDot,
                  progressStep >= 50 && styles.stepDotActive,
                  { backgroundColor: progressStep >= 50 ? (
                    progressOperation === 'shield' ? P01.cyan :
                    progressOperation === 'unshield' ? P01.pink :
                    '#ffcc00'
                  ) : Colors.border }
                ]} />
                <Text style={[styles.stepText, progressStep >= 50 && styles.stepTextActive]}>
                  {progressOperation === 'import' ? 'Verify' : 'ZK Proof'}
                </Text>
              </View>
              <View style={[styles.stepLine, progressStep >= 70 && { backgroundColor: progressOperation === 'shield' ? P01.cyan : progressOperation === 'unshield' ? P01.pink : '#ffcc00' }]} />
              <View style={styles.stepItem}>
                <View style={[
                  styles.stepDot,
                  progressStep >= 85 && styles.stepDotActive,
                  { backgroundColor: progressStep >= 85 ? (
                    progressOperation === 'shield' ? P01.cyan :
                    progressOperation === 'unshield' ? P01.pink :
                    '#ffcc00'
                  ) : Colors.border }
                ]} />
                <Text style={[styles.stepText, progressStep >= 85 && styles.stepTextActive]}>
                  {progressOperation === 'import' ? 'Save' : 'Submit'}
                </Text>
              </View>
              <View style={[styles.stepLine, progressStep >= 100 && { backgroundColor: progressOperation === 'shield' ? P01.cyan : progressOperation === 'unshield' ? P01.pink : '#ffcc00' }]} />
              <View style={styles.stepItem}>
                <View style={[
                  styles.stepDot,
                  progressStep >= 100 && styles.stepDotActive,
                  { backgroundColor: progressStep >= 100 ? (
                    progressOperation === 'shield' ? P01.cyan :
                    progressOperation === 'unshield' ? P01.pink :
                    '#ffcc00'
                  ) : Colors.border }
                ]} />
                <Text style={[styles.stepText, progressStep >= 100 && styles.stepTextActive]}>
                  Done
                </Text>
              </View>
            </View>

            {/* Warning text */}
            {progressOperation !== 'import' && progressStep < 100 && (
              <Text style={styles.progressWarning}>
                Please keep the app open. This may take 30-60 seconds.
              </Text>
            )}
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
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    backgroundColor: Colors.surface,
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
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  content: {
    flex: 1,
  },
  scrollContent: {
    padding: Spacing.md,
    paddingBottom: 32,
  },
  balanceCard: {
    padding: Spacing.lg,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: `${P01.cyan}30`,
  },
  balanceHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.md,
  },
  balanceLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  balanceLabelText: {
    fontSize: 14,
    fontFamily: FontFamily.medium,
    color: Colors.textSecondary,
  },
  spinning: {
    opacity: 0.5,
  },
  balanceAmount: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    marginVertical: Spacing.lg,
  },
  balanceValue: {
    fontSize: 32,
    fontFamily: FontFamily.bold,
    color: Colors.textPrimary,
  },
  balanceSubtext: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    textAlign: 'center',
    marginBottom: Spacing.md,
  },
  zkAddressContainer: {
    backgroundColor: 'rgba(0,0,0,0.3)',
    borderRadius: BorderRadius.md,
    padding: Spacing.sm,
  },
  zkAddressLabel: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  zkAddressLabelText: {
    fontSize: 11,
    fontFamily: FontFamily.medium,
    color: Colors.textTertiary,
  },
  copyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  copyText: {
    fontSize: 11,
    fontFamily: FontFamily.medium,
    color: P01.cyan,
  },
  zkAddress: {
    fontSize: 12,
    fontFamily: FontFamily.mono,
    color: Colors.textPrimary,
  },
  actionsContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 24,
    marginVertical: Spacing.lg,
  },
  actionButton: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 72,
    height: 72,
    borderRadius: 36,
    gap: 4,
  },
  actionText: {
    fontSize: 12,
    fontFamily: FontFamily.medium,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: Spacing.md,
    marginBottom: Spacing.sm,
  },
  sectionTitle: {
    fontSize: 11,
    fontFamily: FontFamily.bold,
    color: Colors.textTertiary,
    letterSpacing: 1,
  },
  clearButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  clearText: {
    fontSize: 11,
    fontFamily: FontFamily.medium,
    color: '#ef4444',
  },
  transparentCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    gap: 12,
  },
  transparentIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#3b82f6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  transparentInfo: {
    flex: 1,
  },
  transparentAmount: {
    fontSize: 16,
    fontFamily: FontFamily.bold,
    color: Colors.textPrimary,
  },
  transparentLabel: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
  },
  pendingCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    gap: 12,
    marginBottom: Spacing.sm,
  },
  pendingIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(251, 191, 36, 0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pendingInfo: {
    flex: 1,
  },
  pendingType: {
    fontSize: 14,
    fontFamily: FontFamily.medium,
    color: Colors.textPrimary,
    textTransform: 'capitalize',
  },
  pendingStatus: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
  },
  notesContainer: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    overflow: 'hidden',
  },
  emptyNotes: {
    alignItems: 'center',
    padding: Spacing.xl,
  },
  emptyText: {
    fontSize: 14,
    fontFamily: FontFamily.medium,
    color: Colors.textSecondary,
    marginTop: Spacing.sm,
  },
  emptySubtext: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    marginTop: 4,
    textAlign: 'center',
  },
  noteCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    gap: 12,
  },
  noteIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: P01.cyanDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  noteInfo: {
    flex: 1,
  },
  noteAmount: {
    fontSize: 14,
    fontFamily: FontFamily.mono,
    color: Colors.textPrimary,
  },
  noteIndex: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
  },
  infoCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginTop: Spacing.md,
    gap: 12,
    borderWidth: 1,
    borderColor: `${P01.cyan}30`,
  },
  infoIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: P01.cyanDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  infoContent: {
    flex: 1,
  },
  infoTitle: {
    fontSize: 14,
    fontFamily: FontFamily.bold,
    color: Colors.textPrimary,
    marginBottom: 4,
  },
  infoText: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    lineHeight: 18,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.8)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: BorderRadius.xl,
    borderTopRightRadius: BorderRadius.xl,
    padding: Spacing.lg,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: Spacing.lg,
  },
  modalIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalTitle: {
    fontSize: 18,
    fontFamily: FontFamily.bold,
    color: Colors.textPrimary,
  },
  modalSubtitle: {
    fontSize: 13,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
  },
  inputContainer: {
    backgroundColor: Colors.background,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  inputHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.sm,
  },
  inputLabel: {
    fontSize: 12,
    fontFamily: FontFamily.medium,
    color: Colors.textTertiary,
  },
  maxButton: {
    fontSize: 12,
    fontFamily: FontFamily.medium,
    color: P01.cyan,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  input: {
    flex: 1,
    fontSize: 24,
    fontFamily: FontFamily.bold,
    color: Colors.textPrimary,
  },
  inputSuffix: {
    fontSize: 18,
    fontFamily: FontFamily.medium,
    color: Colors.textSecondary,
  },
  warningBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(251, 191, 36, 0.1)',
    borderRadius: BorderRadius.md,
    padding: Spacing.sm,
    marginBottom: Spacing.md,
  },
  warningText: {
    flex: 1,
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: '#fbbf24',
  },
  stealthToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(255, 119, 168, 0.1)',
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
    borderWidth: 1,
    borderColor: 'rgba(255, 119, 168, 0.3)',
  },
  stealthToggleInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
  },
  stealthToggleTitle: {
    fontSize: 14,
    fontFamily: FontFamily.bold,
    color: '#ff77a8',
  },
  stealthToggleDesc: {
    fontSize: 11,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
  },
  modalActions: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  cancelButton: {
    flex: 1,
    backgroundColor: Colors.background,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    alignItems: 'center',
  },
  cancelText: {
    fontSize: 16,
    fontFamily: FontFamily.bold,
    color: Colors.textPrimary,
  },
  confirmButton: {
    flex: 1,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    alignItems: 'center',
  },
  confirmText: {
    fontSize: 16,
    fontFamily: FontFamily.bold,
    color: '#000',
  },
  infoModalContent: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.xl,
    margin: Spacing.lg,
    padding: Spacing.lg,
    maxHeight: '80%',
  },
  infoModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: Spacing.lg,
  },
  infoScroll: {
    marginBottom: Spacing.md,
  },
  infoSection: {
    backgroundColor: Colors.background,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.sm,
  },
  infoSectionTitle: {
    fontSize: 14,
    fontFamily: FontFamily.bold,
    color: Colors.textPrimary,
    marginBottom: 4,
  },
  infoSectionText: {
    fontSize: 13,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    lineHeight: 20,
  },
  actionButtonDisabled: {
    opacity: 0.5,
  },
  proverWarning: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(251, 191, 36, 0.1)',
    borderRadius: BorderRadius.md,
    padding: Spacing.sm,
    marginBottom: Spacing.md,
  },
  proverWarningText: {
    flex: 1,
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: '#fbbf24',
  },
  importInputContainer: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: Spacing.sm,
  },
  importInput: {
    padding: Spacing.md,
    fontSize: 14,
    fontFamily: FontFamily.mono,
    color: Colors.textPrimary,
    minHeight: 100,
    textAlignVertical: 'top',
  },
  pasteButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    padding: Spacing.sm,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  pasteText: {
    fontSize: 13,
    fontFamily: FontFamily.medium,
    color: P01.cyan,
  },
  importHint: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    marginBottom: Spacing.lg,
    lineHeight: 18,
  },
  // Progress Modal Styles
  progressOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.9)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.lg,
  },
  progressModal: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.xl,
    padding: Spacing.xl,
    width: '100%',
    maxWidth: 340,
    alignItems: 'center',
  },
  progressIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.lg,
  },
  progressTitle: {
    fontSize: 20,
    fontFamily: FontFamily.bold,
    color: Colors.textPrimary,
    marginBottom: Spacing.lg,
  },
  progressBarContainer: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginBottom: Spacing.md,
  },
  progressBarBg: {
    flex: 1,
    height: 8,
    backgroundColor: Colors.background,
    borderRadius: 4,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    borderRadius: 4,
  },
  progressPercent: {
    fontSize: 14,
    fontFamily: FontFamily.bold,
    color: Colors.textSecondary,
    minWidth: 40,
    textAlign: 'right',
  },
  progressStatus: {
    fontSize: 14,
    fontFamily: FontFamily.medium,
    textAlign: 'center',
    marginBottom: Spacing.lg,
  },
  progressSteps: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    marginBottom: Spacing.md,
  },
  stepItem: {
    alignItems: 'center',
    gap: 4,
  },
  stepDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: Colors.border,
  },
  stepDotActive: {
    transform: [{ scale: 1.1 }],
  },
  stepText: {
    fontSize: 10,
    fontFamily: FontFamily.medium,
    color: Colors.textTertiary,
  },
  stepTextActive: {
    color: Colors.textPrimary,
  },
  stepLine: {
    width: 24,
    height: 2,
    backgroundColor: Colors.border,
    marginHorizontal: 4,
    marginBottom: 16,
  },
  progressWarning: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    textAlign: 'center',
    marginTop: Spacing.sm,
  },
  // Private Send Button Styles
  privateSendButton: {
    marginTop: Spacing.md,
    borderRadius: BorderRadius.lg,
    overflow: 'hidden',
  },
  privateSendButtonDisabled: {
    opacity: 0.5,
  },
  privateSendGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.md,
    gap: 12,
  },
  privateSendText: {
    fontSize: 15,
    fontFamily: FontFamily.bold,
    color: '#fff',
  },
  privateSendSubtext: {
    fontSize: 11,
    fontFamily: FontFamily.regular,
    color: 'rgba(255, 255, 255, 0.7)',
  },
  // Denomination Selection Styles
  denominationContainer: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginTop: Spacing.sm,
  },
  denominationButton: {
    flex: 1,
    backgroundColor: Colors.background,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: Colors.border,
  },
  denominationButtonActive: {
    borderColor: P01.cyan,
    backgroundColor: P01.cyanDim,
  },
  denominationButtonDisabled: {
    opacity: 0.5,
  },
  denominationText: {
    fontSize: 16,
    fontFamily: FontFamily.bold,
    color: Colors.textSecondary,
  },
  denominationTextActive: {
    color: P01.cyan,
  },
  denominationTextDisabled: {
    color: Colors.textTertiary,
  },
  denominationInsufficient: {
    fontSize: 9,
    fontFamily: FontFamily.regular,
    color: '#ef4444',
    marginTop: 4,
  },
  denominationNote: {
    fontSize: 11,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    marginTop: Spacing.sm,
    textAlign: 'center',
  },
  inputHint: {
    fontSize: 11,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    marginTop: 6,
    lineHeight: 16,
  },
  confirmButtonDisabled: {
    opacity: 0.5,
  },
  // Recovery Modal Styles
  recoveryStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: 'rgba(16, 185, 129, 0.1)',
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  recoveryStatusText: {
    fontSize: 14,
    fontFamily: FontFamily.medium,
    color: '#10b981',
  },
  recoveryPayments: {
    backgroundColor: Colors.background,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  recoveryPaymentsTitle: {
    fontSize: 14,
    fontFamily: FontFamily.bold,
    color: '#10b981',
    marginBottom: Spacing.sm,
  },
  recoveryPaymentItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  recoveryPaymentInfo: {
    flex: 1,
  },
  recoveryPaymentAmount: {
    fontSize: 16,
    fontFamily: FontFamily.bold,
    color: Colors.textPrimary,
  },
  recoveryPaymentAddress: {
    fontSize: 11,
    fontFamily: FontFamily.mono,
    color: Colors.textTertiary,
  },
  recoveryHint: {
    fontSize: 11,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    marginTop: Spacing.sm,
    lineHeight: 16,
  },
  recoveryEmpty: {
    alignItems: 'center',
    paddingVertical: Spacing.xl,
  },
  recoveryEmptyText: {
    fontSize: 16,
    fontFamily: FontFamily.bold,
    color: Colors.textSecondary,
    marginTop: Spacing.md,
  },
  recoveryEmptyHint: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    marginTop: Spacing.xs,
    textAlign: 'center',
    lineHeight: 18,
  },
});

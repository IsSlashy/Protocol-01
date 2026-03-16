import React, { useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors, FontSize } from '@/constants/theme';
import { p01Alert } from '@/stores/alertStore';
import { useWalletStore } from '@/stores/walletStore';
import { useDenominatedPoolStore } from '@/stores/denominatedPoolStore';
import { findPool } from '@/services/denominatedPool';
import { getConnection } from '@/services/solana/connection';
import { deriveRouteStealthKeypair } from '@/services/privacyRouter/stealthManager';
import { estimateFees } from '@/services/privacyRouter/routePlanner';
import type { PrivacyLevel, RouteFeeEstimate } from '@/services/privacyRouter/types';
import { PRIVACY_LEVEL_CONFIGS } from '@/services/privacyRouter/types';

// ---------------------------------------------------------------------------
// Privacy level display metadata
// ---------------------------------------------------------------------------

const LEVEL_LABELS: Record<PrivacyLevel, string> = {
  1: 'Basic',
  2: 'Standard',
  3: 'Enhanced',
  4: 'Maximum',
  5: 'Paranoid',
};

const LEVEL_TIMES: Record<PrivacyLevel, string> = {
  1: '~30min-1h',
  2: '~1-4h',
  3: '~4-8h',
  4: '~8-16h',
  5: '~24-48h',
};

const LEVEL_FEE_PERCENTS: Record<PrivacyLevel, string> = {
  1: '~0.8%',
  2: '~1.6%',
  3: '~2.4%',
  4: '~3.2%',
  5: '~4.0%',
};

const ALL_LEVELS: PrivacyLevel[] = [1, 2, 3, 4, 5];

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export default function PrivateSendScreen() {
  const router = useRouter();
  const { balance, publicKey } = useWalletStore();

  const [amount, setAmount] = useState('');
  const [recipient, setRecipient] = useState('');
  const [privacyLevel, setPrivacyLevel] = useState<PrivacyLevel>(3);
  const [isStarting, setIsStarting] = useState(false);

  const solBalance = balance?.sol ?? 0;

  // Compute fee estimate whenever amount or privacy level changes
  const feeEstimate = useMemo<RouteFeeEstimate | null>(() => {
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) return null;
    return estimateFees({ amount: amt, privacyLevel });
  }, [amount, privacyLevel]);

  const levelConfig = PRIVACY_LEVEL_CONFIGS[privacyLevel];
  const parsedAmount = parseFloat(amount);
  const hasValidAmount = !isNaN(parsedAmount) && parsedAmount > 0;
  const hasRecipient = recipient.trim().length >= 32;
  const hasEnoughBalance = hasValidAmount && parsedAmount <= solBalance;
  const canStart = hasValidAmount && hasRecipient && hasEnoughBalance && !isStarting;

  // ── Handlers ──────────────────────────────────────────────────────

  const handlePaste = useCallback(async () => {
    const text = await Clipboard.getStringAsync();
    if (text) {
      setRecipient(text.trim());
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  }, []);

  const handleMax = useCallback(() => {
    if (solBalance > 0) {
      // Leave a small buffer for network fees
      const max = Math.max(0, solBalance - 0.01);
      setAmount(max > 0 ? max.toFixed(4) : '0');
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  }, [solBalance]);

  const handleSelectLevel = useCallback((level: PrivacyLevel) => {
    setPrivacyLevel(level);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, []);

  const shieldNote = useDenominatedPoolStore((s) => s.shieldNote);

  const handleStartRoute = useCallback(async () => {
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) return;

    // Validate recipient address
    try {
      new (require('@solana/web3.js').PublicKey)(recipient.trim());
    } catch {
      p01Alert('Invalid address', 'Please enter a valid Solana address.');
      return;
    }

    if (amt < 0.1) {
      p01Alert('Minimum amount', 'The minimum routable amount is 0.1 SOL.');
      return;
    }

    setIsStarting(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);

    try {
      console.log(`[PrivateSend] Starting route: ${amt} SOL → ${recipient.trim().slice(0, 8)}... | Level ${privacyLevel} (${LEVEL_LABELS[privacyLevel]})`);
      console.log(`[PrivateSend] Config: ${levelConfig.splits} splits, ${levelConfig.hops} hops`);

      // ── Step 1: Transfer SOL to stealth intermediary ─────────────
      // This breaks the on-chain link between the user's wallet and the pool.
      // On-chain it looks like a normal SOL transfer to a random address.
      const { sha256: sha256Early } = require('@noble/hashes/sha256');
      const { bytesToHex: bthEarly } = require('@noble/hashes/utils');
      const skHash = bthEarly(sha256Early(new TextEncoder().encode(publicKey || 'default')));
      const ephemeralRouteId = `ephemeral_${Date.now().toString(36)}`;

      const stealthKeypair = deriveRouteStealthKeypair({
        spendingKeyHash: skHash,
        routeId: ephemeralRouteId,
        hopIndex: 0,
        outputIndex: 0,
      });

      const stealthAddress = stealthKeypair.publicKey;
      console.log(`[PrivateSend] 🕵️ Step 1a: Transferring ${amt} SOL to stealth intermediary...`);
      console.log(`[PrivateSend] 🕵️ Stealth: ${stealthAddress.toBase58().slice(0, 12)}... (ephemeral, no link to you)`);

      // Transfer SOL from user wallet to stealth address
      const { SystemProgram, Transaction, PublicKey: PubKey } = require('@solana/web3.js');
      const connection = getConnection();
      const lamports = Math.round(amt * 1_000_000_000);

      const transferTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: new PubKey(publicKey),
          toPubkey: stealthAddress,
          lamports,
        })
      );

      // Sign with Privy wallet
      const { getPrivySigner } = require('@/stores/walletStore');
      const signTransaction = getPrivySigner();
      if (signTransaction) {
        const { blockhash } = await connection.getLatestBlockhash();
        transferTx.recentBlockhash = blockhash;
        transferTx.feePayer = new PubKey(publicKey);
        const signed = await signTransaction(transferTx);
        const txSig = await connection.sendRawTransaction(signed.serialize());
        await connection.confirmTransaction(txSig, 'confirmed');
        console.log(`[PrivateSend] 🕵️ Transfer TX: ${txSig.slice(0, 16)}... (confirmed)`);
      } else {
        throw new Error('No wallet signer available — Privy wallet required');
      }

      console.log(`[PrivateSend] 💰 SOL transferred to stealth address — wallet balance deducted`);

      // ── Step 1b: Shield from stealth address into anonymity pool ──
      const pool = findPool('SOL', amt);
      if (!pool) {
        throw new Error(`No pool available for ${amt} SOL. Available: 0.1, 0.5, 1, 5, 10 SOL`);
      }

      console.log(`[PrivateSend] 🛡️ Step 1b: Shielding from stealth into anonymity pool...`);
      console.log(`[PrivateSend] 🛡️ Pool: ${pool.poolPDA.toBase58().slice(0, 12)}... (${pool.denomination} SOL)`);
      console.log(`[PrivateSend] 🛡️ Source: ${stealthAddress.toBase58().slice(0, 12)}... (NOT your wallet)`);

      const noteId = await shieldNote(pool);
      console.log(`[PrivateSend] 🛡️ Shield confirmed! Note: ${noteId}`);
      console.log(`[PrivateSend] ✅ On-chain trail: YourWallet → Stealth → Pool (link broken)`);

      // ── Step 2: Plan the route for remaining hops ─────────────────
      const { sha256 } = await import('@noble/hashes/sha256');
      const { bytesToHex } = await import('@noble/hashes/utils');
      const spendingKeyHash = bytesToHex(sha256(new TextEncoder().encode(publicKey || 'default')));

      const { startPrivateRoute, isPrivacyRouterAvailable } = await import('@/services/privacyRouter');

      // Ensure autonomous runner is started (idempotent)
      if (!isPrivacyRouterAvailable()) {
        console.log('[PrivateSend] Starting autonomous runner...');
        const { startAutonomousRunner } = await import('@/services/privacyRouter/autonomousRunner');
        await startAutonomousRunner();
      }

      console.log('[PrivateSend] Planning remaining route hops...');
      const route = await startPrivateRoute({
        amount: amt,
        destination: recipient.trim(),
        privacyLevel,
        spendingKeyHash,
      });

      console.log(`[PrivateSend] ✅ Route created: ${route.id.slice(0, 12)}...`);
      console.log(`[PrivateSend] 📊 ${route.hops.length} hops | ${route.numOutputs} splits | ${route.sourceDenomination} → ${route.targetDenomination} SOL`);
      console.log(`[PrivateSend] 💰 Fee estimate: ${route.totalFeeEstimate.toFixed(4)} SOL`);
      console.log(`[PrivateSend] ⏱️ ETA: ${new Date(route.estimatedCompletionAt).toLocaleTimeString()}`);

      route.hops.forEach((hop, i) => {
        console.log(`[PrivateSend]   Hop ${i + 1}: ${hop.type} | ${hop.amount} SOL | stealth: ${hop.stealthAddress.slice(0, 8)}... | scheduled: ${new Date(hop.scheduledAt).toLocaleTimeString()}`);
      });

      // Refresh wallet balance to reflect the locked SOL
      useWalletStore.getState().refreshBalance?.();

      p01Alert(
        'SOL Locked & Route Active',
        `${pool.denomination} SOL shielded into anonymity pool.\n\n${route.hops.length} hops will execute over ${feeEstimate?.estimatedDuration || 'several hours'} to deliver funds to the destination.\n\nRoute: ${route.id.slice(0, 12)}...`,
      );
      router.back();
    } catch (err: any) {
      console.error('[PrivateSend] ❌ Error:', err.message, err.stack?.slice(0, 300));
      p01Alert('Error', err.message || 'Failed to create privacy route.');
    } finally {
      setIsStarting(false);
    }
  }, [amount, recipient, privacyLevel, publicKey, levelConfig, feeEstimate, router, shieldNote]);

  // ── Render ────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={22} color={Colors.text} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Ionicons name="git-network-outline" size={20} color={P01Colors.cyan} />
          <Text style={styles.headerTitle}>Private Send</Text>
        </View>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* Subtitle */}
        <Animated.View entering={FadeInDown.delay(50).duration(300)}>
          <Text style={styles.subtitle}>
            Enhanced privacy with multi-hop routing
          </Text>
        </Animated.View>

        {/* ── Amount Input ───────────────────────────────────────── */}
        <Animated.View
          entering={FadeInDown.delay(100).duration(300)}
          style={styles.card}
        >
          <Text style={styles.sectionLabel}>AMOUNT</Text>
          <View style={styles.amountRow}>
            <TextInput
              style={styles.amountInput}
              value={amount}
              onChangeText={setAmount}
              placeholder="0.00"
              placeholderTextColor={Colors.textTertiary}
              keyboardType="decimal-pad"
              selectionColor={P01Colors.cyan}
            />
            <Text style={styles.amountSuffix}>SOL</Text>
          </View>
          <View style={styles.balanceRow}>
            <Text style={styles.balanceText}>
              Balance: {solBalance.toFixed(4)} SOL
            </Text>
            <TouchableOpacity onPress={handleMax} style={styles.maxBtn}>
              <Text style={styles.maxBtnText}>MAX</Text>
            </TouchableOpacity>
          </View>
          {hasValidAmount && !hasEnoughBalance && (
            <View style={styles.warningRow}>
              <Ionicons name="warning" size={14} color={Colors.warning} />
              <Text style={styles.warningText}>Insufficient balance</Text>
            </View>
          )}
        </Animated.View>

        {/* ── Recipient Input ────────────────────────────────────── */}
        <Animated.View
          entering={FadeInDown.delay(150).duration(300)}
          style={styles.card}
        >
          <Text style={styles.sectionLabel}>DESTINATION ADDRESS</Text>
          <View style={styles.recipientRow}>
            <TextInput
              style={styles.recipientInput}
              value={recipient}
              onChangeText={setRecipient}
              placeholder="Solana address (base58)"
              placeholderTextColor={Colors.textTertiary}
              autoCapitalize="none"
              autoCorrect={false}
              selectionColor={P01Colors.cyan}
            />
            <TouchableOpacity onPress={handlePaste} style={styles.pasteBtn}>
              <Ionicons name="clipboard-outline" size={18} color={P01Colors.cyan} />
            </TouchableOpacity>
          </View>
        </Animated.View>

        {/* ── Privacy Level Selector ─────────────────────────────── */}
        <Animated.View
          entering={FadeInDown.delay(200).duration(300)}
          style={styles.card}
        >
          <Text style={styles.sectionLabel}>PRIVACY LEVEL</Text>
          <View style={styles.levelRow}>
            {ALL_LEVELS.map((level) => {
              const isSelected = level === privacyLevel;
              return (
                <TouchableOpacity
                  key={level}
                  onPress={() => handleSelectLevel(level)}
                  activeOpacity={0.7}
                  style={[
                    styles.levelPill,
                    isSelected && styles.levelPillActive,
                  ]}
                >
                  <Text
                    style={[
                      styles.levelPillText,
                      isSelected && styles.levelPillTextActive,
                    ]}
                  >
                    {level}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Selected level label */}
          <View style={styles.levelLabelRow}>
            <Text style={styles.levelName}>{LEVEL_LABELS[privacyLevel]}</Text>
            <Text style={styles.levelFee}>{LEVEL_FEE_PERCENTS[privacyLevel]} fees</Text>
          </View>

          {/* Level details card */}
          <View style={styles.levelDetails}>
            <View style={styles.levelDetailRow}>
              <Ionicons name="layers-outline" size={14} color={Colors.textTertiary} />
              <Text style={styles.levelDetailLabel}>Hops</Text>
              <Text style={styles.levelDetailValue}>{levelConfig.hops}</Text>
            </View>
            <View style={styles.levelDetailDivider} />
            <View style={styles.levelDetailRow}>
              <Ionicons name="git-branch-outline" size={14} color={Colors.textTertiary} />
              <Text style={styles.levelDetailLabel}>Splits</Text>
              <Text style={styles.levelDetailValue}>{levelConfig.splits} wallets</Text>
            </View>
            <View style={styles.levelDetailDivider} />
            <View style={styles.levelDetailRow}>
              <Ionicons name="time-outline" size={14} color={Colors.textTertiary} />
              <Text style={styles.levelDetailLabel}>Estimated time</Text>
              <Text style={styles.levelDetailValue}>{LEVEL_TIMES[privacyLevel]}</Text>
            </View>
            <View style={styles.levelDetailDivider} />
            <View style={styles.levelDetailRow}>
              <Ionicons name="people-outline" size={14} color={Colors.textTertiary} />
              <Text style={styles.levelDetailLabel}>Anonymity set</Text>
              <Text style={styles.levelDetailValue}>
                {levelConfig.splits * levelConfig.hops}x multiplier
              </Text>
            </View>
          </View>
        </Animated.View>

        {/* ── Fee Breakdown Card ─────────────────────────────────── */}
        {feeEstimate && (
          <Animated.View
            entering={FadeInUp.delay(100).duration(300)}
            style={styles.card}
          >
            <Text style={styles.sectionLabel}>FEE BREAKDOWN</Text>
            <View style={styles.feeGrid}>
              <FeeRow
                icon="shield-outline"
                label="Shield fees"
                value={`${feeEstimate.shieldFees.toFixed(6)} SOL`}
                sublabel="0.3% per shield"
              />
              <View style={styles.feeDivider} />
              <FeeRow
                icon="shield-half-outline"
                label="Unshield fees"
                value={`${feeEstimate.unshieldFees.toFixed(6)} SOL`}
                sublabel="0.5% per unshield"
              />
              <View style={styles.feeDivider} />
              <FeeRow
                icon="flash-outline"
                label="Network fees"
                value={`${feeEstimate.networkFees.toFixed(6)} SOL`}
                sublabel={`${feeEstimate.numTransactions} transactions`}
              />
              <View style={styles.feeDivider} />

              {/* Total */}
              <View style={styles.feeTotalRow}>
                <View style={styles.feeTotalLeft}>
                  <Ionicons name="calculator-outline" size={14} color={P01Colors.cyan} />
                  <Text style={styles.feeTotalLabel}>Total cost</Text>
                </View>
                <View style={styles.feeTotalRight}>
                  <Text style={styles.feeTotalValue}>
                    {feeEstimate.totalFees.toFixed(6)} SOL
                  </Text>
                  <Text style={styles.feeTotalPercent}>
                    ({feeEstimate.totalCostPercent.toFixed(2)}%)
                  </Text>
                </View>
              </View>
            </View>
          </Animated.View>
        )}

        {/* ── Privacy Explanation ────────────────────────────────── */}
        <Animated.View
          entering={FadeInDown.delay(300).duration(300)}
          style={styles.infoCard}
        >
          <Ionicons
            name="information-circle-outline"
            size={16}
            color={Colors.textTertiary}
          />
          <Text style={styles.infoText}>
            Your funds will be split into{' '}
            <Text style={styles.infoHighlight}>{levelConfig.splits}</Text>{' '}
            separate notes, each routed through{' '}
            <Text style={styles.infoHighlight}>{levelConfig.hops}</Text>{' '}
            anonymity pools with randomized time delays. The route is encrypted
            and stored locally — only your spending key can reconstruct it.
          </Text>
        </Animated.View>

        {/* Bottom spacer for button + liquid glass tab bar */}
        <View style={{ height: 180 }} />
      </ScrollView>

      {/* ── Action Button ──────────────────────────────────────── */}
      <View style={styles.bottomBar}>
        <TouchableOpacity
          onPress={handleStartRoute}
          disabled={!canStart}
          activeOpacity={0.8}
          style={{ width: '100%' }}
        >
          <LinearGradient
            colors={
              canStart
                ? [P01Colors.cyan, '#20A89E']
                : ['rgba(57,197,187,0.3)', 'rgba(57,197,187,0.15)']
            }
            style={styles.startBtn}
          >
            {isStarting ? (
              <ActivityIndicator size="small" color="#000" />
            ) : (
              <>
                <Ionicons name="rocket-outline" size={20} color="#000" />
                <Text style={styles.startBtnText}>Start Private Send</Text>
              </>
            )}
          </LinearGradient>
        </TouchableOpacity>

        {!canStart && hasValidAmount && hasRecipient && !hasEnoughBalance && (
          <Text style={styles.bottomHint}>Insufficient SOL balance</Text>
        )}
        {!canStart && !hasValidAmount && (
          <Text style={styles.bottomHint}>Enter an amount to continue</Text>
        )}
        {!canStart && hasValidAmount && !hasRecipient && (
          <Text style={styles.bottomHint}>Enter a destination address</Text>
        )}
      </View>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Fee Row sub-component
// ---------------------------------------------------------------------------

function FeeRow({
  icon,
  label,
  value,
  sublabel,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
  sublabel: string;
}) {
  return (
    <View style={styles.feeRow}>
      <View style={styles.feeRowLeft}>
        <Ionicons name={icon} size={14} color={Colors.textTertiary} />
        <View>
          <Text style={styles.feeLabel}>{label}</Text>
          <Text style={styles.feeSublabel}>{sublabel}</Text>
        </View>
      </View>
      <Text style={styles.feeValue}>{value}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },

  // ── Header ──────────────────────────────────────────
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
  },
  headerCenter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 9999,
    backgroundColor: Colors.surfaceSecondary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    color: Colors.text,
    fontSize: 20,
    fontFamily: FontFamily.bold,
  },

  // ── Scroll ──────────────────────────────────────────
  scrollView: { flex: 1 },
  scrollContent: {
    paddingHorizontal: Spacing.xl,
    paddingBottom: 40,
  },

  subtitle: {
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    textAlign: 'center',
    marginBottom: Spacing.lg,
  },

  // ── Cards ───────────────────────────────────────────
  card: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.lg,
    marginBottom: Spacing.md,
  },
  sectionLabel: {
    fontSize: 11,
    fontFamily: FontFamily.bold,
    color: Colors.textTertiary,
    letterSpacing: 1.2,
    marginBottom: Spacing.md,
  },

  // ── Amount ──────────────────────────────────────────
  amountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Spacing.sm,
  },
  amountInput: {
    flex: 1,
    fontSize: 32,
    fontFamily: FontFamily.mono,
    color: Colors.text,
    padding: 0,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    paddingBottom: Spacing.sm,
  },
  amountSuffix: {
    fontSize: FontSize.lg,
    fontFamily: FontFamily.semibold,
    color: Colors.textSecondary,
    marginLeft: Spacing.sm,
    paddingBottom: Spacing.sm,
  },
  balanceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: Spacing.sm,
  },
  balanceText: {
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
  },
  maxBtn: {
    paddingHorizontal: Spacing.md,
    paddingVertical: 4,
    borderRadius: BorderRadius.sm,
    backgroundColor: P01Colors.cyanDim,
    borderWidth: 1,
    borderColor: `${P01Colors.cyan}40`,
  },
  maxBtnText: {
    fontSize: 11,
    fontFamily: FontFamily.bold,
    color: P01Colors.cyan,
    letterSpacing: 0.8,
  },
  warningRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: Spacing.sm,
  },
  warningText: {
    fontSize: FontSize.xs,
    fontFamily: FontFamily.medium,
    color: Colors.warning,
  },

  // ── Recipient ───────────────────────────────────────
  recipientRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  recipientInput: {
    flex: 1,
    fontSize: FontSize.md,
    fontFamily: FontFamily.mono,
    color: Colors.text,
    padding: 0,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    paddingBottom: Spacing.sm,
  },
  pasteBtn: {
    width: 40,
    height: 40,
    borderRadius: BorderRadius.sm,
    backgroundColor: P01Colors.cyanDim,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: `${P01Colors.cyan}30`,
  },

  // ── Privacy Level ───────────────────────────────────
  levelRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginBottom: Spacing.md,
  },
  levelPill: {
    flex: 1,
    paddingVertical: Spacing.md,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  levelPillActive: {
    backgroundColor: P01Colors.cyanDim,
    borderColor: P01Colors.cyan,
    shadowColor: P01Colors.cyan,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 6,
  },
  levelPillText: {
    fontSize: FontSize.md,
    fontFamily: FontFamily.bold,
    color: Colors.textSecondary,
  },
  levelPillTextActive: {
    color: P01Colors.cyan,
  },
  levelLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.sm,
  },
  levelName: {
    fontSize: FontSize.lg,
    fontFamily: FontFamily.semibold,
    color: Colors.text,
  },
  levelFee: {
    fontSize: FontSize.sm,
    fontFamily: FontFamily.mono,
    color: P01Colors.pink,
  },

  // ── Level details ───────────────────────────────────
  levelDetails: {
    backgroundColor: 'rgba(0,0,0,0.2)',
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
  },
  levelDetailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 7,
  },
  levelDetailLabel: {
    flex: 1,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
  },
  levelDetailValue: {
    fontSize: FontSize.sm,
    fontFamily: FontFamily.monoMedium,
    color: Colors.text,
  },
  levelDetailDivider: {
    height: 1,
    backgroundColor: Colors.border,
    marginHorizontal: 4,
  },

  // ── Fee Breakdown ───────────────────────────────────
  feeGrid: {
    backgroundColor: 'rgba(0,0,0,0.2)',
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
  },
  feeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
  },
  feeRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  feeLabel: {
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
  },
  feeSublabel: {
    fontSize: FontSize.xs,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    marginTop: 1,
  },
  feeValue: {
    fontSize: FontSize.sm,
    fontFamily: FontFamily.mono,
    color: Colors.text,
  },
  feeDivider: {
    height: 1,
    backgroundColor: Colors.border,
    marginHorizontal: 4,
  },
  feeTotalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 10,
  },
  feeTotalLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  feeTotalLabel: {
    fontSize: FontSize.md,
    fontFamily: FontFamily.semibold,
    color: P01Colors.cyan,
  },
  feeTotalRight: {
    alignItems: 'flex-end',
  },
  feeTotalValue: {
    fontSize: FontSize.md,
    fontFamily: FontFamily.monoMedium,
    color: P01Colors.cyan,
  },
  feeTotalPercent: {
    fontSize: FontSize.xs,
    fontFamily: FontFamily.mono,
    color: P01Colors.pink,
    marginTop: 2,
  },

  // ── Info card ───────────────────────────────────────
  infoCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  infoText: {
    flex: 1,
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    lineHeight: 18,
  },
  infoHighlight: {
    color: P01Colors.cyan,
    fontFamily: FontFamily.semibold,
  },

  // ── Bottom bar ──────────────────────────────────────
  // Extra paddingBottom to sit above the liquid glass tab bar (~90px)
  bottomBar: {
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.md,
    paddingBottom: 100,
    backgroundColor: Colors.background,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    alignItems: 'center',
  },
  startBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 16,
    borderRadius: BorderRadius.md,
  },
  startBtnText: {
    fontSize: FontSize.lg,
    fontFamily: FontFamily.bold,
    color: '#000',
  },
  bottomHint: {
    fontSize: FontSize.xs,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    marginTop: Spacing.sm,
  },
});

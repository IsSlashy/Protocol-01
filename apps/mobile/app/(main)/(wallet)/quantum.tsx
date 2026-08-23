/**
 * Quantum Wallet screen.
 *
 * Single-screen view of the post-quantum smart-contract wallet:
 *   - init (first time)
 *   - receive (auto-deposits from the user's Ed25519 in the background)
 *   - send (optimistic UI, STARK-gated background settlement)
 *   - pending sends list
 *
 * 🎯 RESTYLED 2026-08-23. The old header of this file said the visuals
 * "matched P-01 design tokens (cyan + pink … Orbitron for hero numbers)". All
 * three of those are retired: pink is gone, Orbitron was never in
 * `FontFamily`, and the panels here were painted with `'#101014'` and
 * `'#0d0d10'` written out by hand — the literal values of `Colors.surface` and
 * `Colors.surfaceSecondary`, copied rather than imported, which is how a screen
 * gets left behind by a theme change.
 *
 *   - ⛔ `P01Colors.green` IS GONE from the confirmed-send state. The design
 *     system's first line is "NO green"; the token was quietly aliased to cyan
 *     in the sweep, so this screen was already rendering cyan while claiming
 *     green. It says what it means now.
 *   - ⛔ `P01Colors.pinkHot` was the failure colour and the cancel affordance.
 *     Failure is `Colors.error`.
 *   - "QUANTUM WALLET", "CREATE QUANTUM VAULT", "SEND INSTANT" were caps with
 *     letterspacing and `fontWeight: '900'` on top of a bold face. Sentence
 *     case, display face for the heading, `ui/Button` for the actions — which
 *     also gets the 44pt floor and the busy state the hand-rolled buttons
 *     lacked.
 *   - the cancel control was an 11pt word with 4pt of padding. 44pt.
 *
 * ⛔ `initWallet`, `enqueueSend`, `startAutoDeposit`, `wipeLocal` and the
 * prover handshake are untouched.
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  StyleSheet,
  Pressable,
  Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';

import { Colors, FontFamily, FontSize, BorderRadius, Spacing, Layout } from '@/constants/theme';
import { Button } from '@/components/ui/Button';
import { useQuantumWalletStore, preProveQuantumAuth } from '@/stores/quantumWalletStore';
import { useStarkProver } from '@/providers/StarkProverProvider';

const lamportsToSol = (n: number) => (n / LAMPORTS_PER_SOL).toFixed(4);

export default function QuantumWalletScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const prover = useStarkProver();

  const {
    initialized,
    ownerIdB58,
    balanceLamports,
    nonce,
    pendingSends,
    ed25519BalanceLamports,
    isProcessing,
    initWallet,
    hydrate,
    refreshOnChainState,
    startAutoDeposit,
    stopAutoDeposit,
    enqueueSend,
    cancelPending,
    wipeLocal,
  } = useQuantumWalletStore();

  const [isInitializing, setIsInitializing] = useState(false);
  const [sendAmount, setSendAmount] = useState('');
  const [sendRecipient, setSendRecipient] = useState('');
  const [isSending, setIsSending] = useState(false);

  useEffect(() => {
    void hydrate();
  }, []);

  useEffect(() => {
    if (initialized) {
      void startAutoDeposit();
      // Pre-prove in the background so the first send is instant.
      if (prover.isReady) void preProveQuantumAuth(prover);
    }
    return () => {
      stopAutoDeposit();
    };
  }, [initialized, prover.isReady]);

  const handleInit = useCallback(async () => {
    if (!prover.isReady) {
      Alert.alert('STARK prover not ready', 'Wait a few seconds for the on-device prover to load, then try again.');
      return;
    }
    setIsInitializing(true);
    try {
      await initWallet({ prover, enableRecovery: false });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err: any) {
      Alert.alert('Init failed', err.message ?? 'unknown error');
    } finally {
      setIsInitializing(false);
    }
  }, [prover, initWallet]);

  const handleSend = useCallback(async () => {
    if (!sendAmount || !sendRecipient) {
      Alert.alert('Missing field', 'Recipient and amount are required.');
      return;
    }
    const amount = parseFloat(sendAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      Alert.alert('Invalid amount', 'Enter a positive number in SOL.');
      return;
    }
    let recipientPk: PublicKey;
    try {
      recipientPk = new PublicKey(sendRecipient.trim());
    } catch {
      Alert.alert('Invalid recipient', 'Not a valid Solana address.');
      return;
    }
    const amountLamports = Math.floor(amount * LAMPORTS_PER_SOL);
    setIsSending(true);
    try {
      await enqueueSend({ prover, recipient: recipientPk, amountLamports });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setSendAmount('');
      setSendRecipient('');
    } catch (err: any) {
      Alert.alert('Send failed', err.message ?? 'unknown error');
    } finally {
      setIsSending(false);
    }
  }, [sendAmount, sendRecipient, prover, enqueueSend]);

  const handleCopyAddress = useCallback(async () => {
    if (!ownerIdB58) return;
    await Clipboard.setStringAsync(ownerIdB58);
    Haptics.selectionAsync();
    Alert.alert('Copied', 'Your address is now on the clipboard.\nClipboard auto-clears in 60s.');
    setTimeout(() => {
      Clipboard.setStringAsync('').catch(() => {});
    }, 60_000);
  }, [ownerIdB58]);

  const unifiedSol = lamportsToSol(balanceLamports + ed25519BalanceLamports);
  const inTransitSol = ed25519BalanceLamports > 0 ? lamportsToSol(ed25519BalanceLamports) : null;

  return (
    <ScrollView
      style={st.root}
      contentContainerStyle={[
        st.scroll,
        {
          paddingTop: insets.top + Spacing.md,
          paddingBottom: Layout.tabBarTotalHeight + insets.bottom + Spacing['2xl'],
        },
      ]}
      keyboardShouldPersistTaps="handled"
    >
      {/* ── Header ── */}
      <View style={st.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={st.headerBtn}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="chevron-back" size={22} color={Colors.textSecondary} />
        </TouchableOpacity>
        <View style={st.headerTitleWrap}>
          <Text style={st.title} accessibilityRole="header">Quantum wallet</Text>
          <Text style={st.subtitle}>STARK-gated custody</Text>
        </View>
        <TouchableOpacity
          onPress={() => refreshOnChainState()}
          style={st.headerBtn}
          accessibilityRole="button"
          accessibilityLabel="Refresh on-chain state"
        >
          <Ionicons name="refresh-outline" size={20} color={Colors.textSecondary} />
        </TouchableOpacity>
      </View>

      {/* ── Balance ── */}
      <View style={st.hero}>
        <Text style={st.heroLabel}>Unified balance</Text>
        <View style={st.heroRow}>
          <Text style={st.heroAmount}>{unifiedSol}</Text>
          <Text style={st.heroUnit}>SOL</Text>
        </View>
        {inTransitSol ? (
          <View style={st.transitRow}>
            <ActivityIndicator size="small" color={Colors.textSecondary} />
            <Text style={st.transitText}>{inTransitSol} SOL moving into the vault…</Text>
          </View>
        ) : null}
        {initialized ? (
          <View style={st.metaRow}>
            <View style={st.metaPill}>
              <Text style={st.metaPillText}>nonce {nonce}</Text>
            </View>
            <View style={[st.metaPill, st.metaPillAccent]}>
              <Ionicons name="shield-checkmark" size={11} color={Colors.primary} />
              <Text style={[st.metaPillText, { color: Colors.primary }]}>PQ vault</Text>
            </View>
          </View>
        ) : null}
      </View>

      {/* ── Init ── */}
      {!initialized ? (
        <View style={st.card}>
          <Text style={st.cardHeading}>Create your quantum-safe vault</Text>
          <Text style={st.body}>
            Funds in this vault are released only on presentation of a STARK proof of preimage
            knowledge. If your Ed25519 key is broken by a future quantum computer, the vault does
            not open with it.
          </Text>
          <Button
            variant="primary"
            size="lg"
            fullWidth
            loading={isInitializing}
            disabled={!prover.isReady}
            onPress={handleInit}
            style={st.cardAction}
          >
            {prover.isReady ? 'Create vault' : 'Loading prover…'}
          </Button>
        </View>
      ) : null}

      {/* ── Send ── */}
      {initialized ? (
        <View style={st.card}>
          <Text style={st.cardHeading}>Send</Text>
          <TextInput
            style={st.input}
            placeholder="Recipient address"
            placeholderTextColor={Colors.textTertiary}
            value={sendRecipient}
            onChangeText={setSendRecipient}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Recipient address"
          />
          <TextInput
            style={st.input}
            placeholder="Amount in SOL"
            placeholderTextColor={Colors.textTertiary}
            value={sendAmount}
            onChangeText={setSendAmount}
            keyboardType="decimal-pad"
            accessibilityLabel="Amount in SOL"
          />
          <Button
            variant="primary"
            size="lg"
            fullWidth
            loading={isSending}
            onPress={handleSend}
            style={st.cardAction}
          >
            Send
          </Button>
          <Text style={st.hint}>
            The balance drops straight away. The STARK proof and the on-chain settlement happen
            afterwards, in the background; only the first send waits for a full prove.
          </Text>
        </View>
      ) : null}

      {/* ── Receive ── */}
      {initialized && ownerIdB58 ? (
        <View style={st.card}>
          <Text style={st.cardHeading}>Receive</Text>
          <Pressable
            onPress={handleCopyAddress}
            style={st.addrBox}
            accessibilityRole="button"
            accessibilityLabel="Copy your vault address"
          >
            <Text style={st.addrText} numberOfLines={1} ellipsizeMode="middle">
              {ownerIdB58}
            </Text>
            <Ionicons name="copy-outline" size={16} color={Colors.textSecondary} />
          </Pressable>
          <Text style={st.hint}>
            Share this with anyone. Funds land in your Ed25519 layer and move into the quantum
            vault within seconds, with nothing for you to do.
          </Text>
        </View>
      ) : null}

      {/* ── Pending sends ── */}
      {pendingSends.length > 0 ? (
        <View style={st.card}>
          <View style={st.cardHeadingRow}>
            <Text style={st.cardHeading}>In flight</Text>
            {isProcessing ? <ActivityIndicator size="small" color={Colors.textSecondary} /> : null}
          </View>
          {pendingSends.map((p) => (
            <View key={p.id} style={st.pendingRow}>
              <View style={{ flex: 1 }}>
                <Text style={st.pendingAmount}>
                  {lamportsToSol(p.amountLamports)} SOL →{' '}
                  <Text style={st.pendingRecipient}>{p.recipient.slice(0, 4)}…{p.recipient.slice(-4)}</Text>
                </Text>
                <Text style={[
                  st.pendingStatus,
                  p.status === 'confirmed' && { color: Colors.primary },
                  p.status === 'failed' && { color: Colors.error },
                ]}>
                  {p.status === 'proving' ? 'Generating STARK proof…'
                    : p.status === 'submitting' ? 'Submitting on-chain…'
                    : p.status === 'confirmed' ? 'Confirmed'
                    : p.status === 'failed' ? (p.error ?? 'Failed')
                    : 'Queued'}
                </Text>
              </View>
              {p.status === 'pending' ? (
                <TouchableOpacity
                  onPress={() => cancelPending(p.id)}
                  style={st.cancelBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel this send"
                >
                  <Text style={st.cancelText}>Cancel</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}

      {/* ── Destructive, and last ── */}
      {initialized ? (
        <TouchableOpacity
          onPress={() =>
            Alert.alert(
              'Wipe local quantum state?',
              'This deletes the spending secret on this device. The on-chain PDA remains, but you will lose access to its funds unless you have a SPHINCS+ recovery key configured.',
              [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Wipe', style: 'destructive', onPress: wipeLocal },
              ],
            )
          }
          style={st.wipeBtn}
          accessibilityRole="button"
          accessibilityLabel="Wipe local quantum state"
        >
          <Text style={st.wipeText}>Wipe local quantum state</Text>
        </TouchableOpacity>
      ) : null}
    </ScrollView>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  scroll: { paddingHorizontal: Spacing.xl, gap: Spacing.lg },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
  },
  headerBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitleWrap: { flex: 1, alignItems: 'center' },
  title: {
    fontFamily: FontFamily.displayMedium,
    fontSize: FontSize.xl,
    color: Colors.text,
  },
  subtitle: {
    fontSize: FontSize.xs,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    marginTop: 1,
  },

  hero: { paddingVertical: Spacing.lg },
  heroLabel: {
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    marginBottom: Spacing.sm,
  },
  heroRow: { flexDirection: 'row', alignItems: 'baseline', gap: Spacing.sm },
  heroAmount: {
    fontFamily: FontFamily.display,
    fontSize: FontSize['4xl'],
    color: Colors.text,
    letterSpacing: -1,
  },
  heroUnit: {
    fontSize: FontSize.xl,
    fontFamily: FontFamily.display,
    color: Colors.textSecondary,
  },
  transitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginTop: Spacing.sm,
  },
  transitText: {
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
  },
  metaRow: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.md, flexWrap: 'wrap' },
  metaPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 3,
    borderRadius: BorderRadius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  metaPillAccent: { borderColor: Colors.primaryMuted, backgroundColor: Colors.primaryDim },
  metaPillText: {
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
    fontFamily: FontFamily.mono,
  },

  card: {
    backgroundColor: Colors.surface,
    borderColor: Colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: BorderRadius.lg,
    padding: Spacing.lg,
    gap: Spacing.md,
  },
  cardHeadingRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  cardHeading: {
    fontSize: FontSize.lg,
    fontFamily: FontFamily.displayMedium,
    color: Colors.text,
    flex: 1,
  },
  cardAction: { marginTop: Spacing.xs },
  body: {
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    lineHeight: 20,
  },
  input: {
    backgroundColor: Colors.surfaceSecondary,
    borderColor: Colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: BorderRadius.md,
    minHeight: 48,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.lg,
    color: Colors.text,
    fontFamily: FontFamily.mono,
    fontSize: FontSize.sm,
  },
  hint: {
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    lineHeight: 19,
  },
  addrBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.md,
    minHeight: 48,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.lg,
    borderColor: Colors.border,
    borderWidth: StyleSheet.hairlineWidth,
  },
  addrText: {
    flex: 1,
    fontFamily: FontFamily.mono,
    fontSize: FontSize.sm,
    color: Colors.text,
  },
  pendingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.borderSoft,
  },
  pendingAmount: {
    fontSize: FontSize.sm,
    fontFamily: FontFamily.medium,
    color: Colors.text,
  },
  pendingRecipient: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
  },
  pendingStatus: {
    fontSize: FontSize.xs,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  cancelBtn: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: Spacing.md,
  },
  cancelText: {
    fontSize: FontSize.sm,
    fontFamily: FontFamily.medium,
    color: Colors.error,
  },
  wipeBtn: {
    alignSelf: 'center',
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: Spacing.lg,
    marginTop: Spacing.sm,
  },
  wipeText: {
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    textDecorationLine: 'underline',
  },
});

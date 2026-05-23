/**
 * Quantum Wallet screen.
 *
 * Single-screen demo of the post-quantum smart-contract wallet:
 *   - init (first time)
 *   - receive (auto-deposits from the user's Ed25519 in the background)
 *   - send (optimistic UI, STARK-gated background settlement)
 *   - pending sends list
 *
 * Visual: matches P-01 design tokens (cyan + pink, dark canvas, Orbitron
 * for hero numbers via FontFamily.heading).
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
  Share,
  Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { Colors, P01Colors, FontFamily, BorderRadius, Spacing } from '@/constants/theme';
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
      contentContainerStyle={[st.scroll, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 100 }]}
      keyboardShouldPersistTaps="handled"
    >
      {/* ── Header ── */}
      <View style={st.header}>
        <TouchableOpacity onPress={() => router.back()} style={st.headerBtn}>
          <Ionicons name="chevron-back" size={24} color={Colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text style={st.title}>QUANTUM WALLET</Text>
          <Text style={st.subtitle}>STARK-gated · post-quantum</Text>
        </View>
        <TouchableOpacity onPress={() => refreshOnChainState()} style={st.headerBtn}>
          <Ionicons name="refresh" size={20} color={P01Colors.cyan} />
        </TouchableOpacity>
      </View>

      {/* ── Balance hero ── */}
      <Animated.View entering={FadeIn.duration(300)} style={st.heroCard}>
        <Text style={st.heroLabel}>Unified balance</Text>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
          <Text style={st.heroAmount}>{unifiedSol}</Text>
          <Text style={st.heroUnit}>SOL</Text>
        </View>
        {inTransitSol ? (
          <View style={st.transitRow}>
            <ActivityIndicator size="small" color={P01Colors.pink} />
            <Text style={st.transitText}>{inTransitSol} SOL migrating to vault…</Text>
          </View>
        ) : null}
        {initialized ? (
          <View style={st.metaRow}>
            <View style={st.metaPill}>
              <Text style={st.metaPillText}>nonce {nonce}</Text>
            </View>
            <View style={[st.metaPill, { borderColor: P01Colors.cyan + '55' }]}>
              <Ionicons name="shield-checkmark" size={11} color={P01Colors.cyan} />
              <Text style={[st.metaPillText, { color: P01Colors.cyan }]}>PQ vault</Text>
            </View>
          </View>
        ) : null}
      </Animated.View>

      {/* ── Init prompt ── */}
      {!initialized ? (
        <Animated.View entering={FadeInDown.duration(300).delay(80)} style={st.initCard}>
          <Ionicons name="construct" size={28} color={P01Colors.pink} />
          <Text style={st.initTitle}>Create your quantum-safe vault</Text>
          <Text style={st.initDesc}>
            Funds in this vault are released only on presentation of a STARK proof of preimage
            knowledge. Even if your Ed25519 key is broken by a future quantum computer, your
            funds remain unrecoverable to anyone except you.
          </Text>
          <TouchableOpacity
            disabled={isInitializing || !prover.isReady}
            onPress={handleInit}
            style={[
              st.bigBtn,
              { opacity: prover.isReady ? 1 : 0.5 },
            ]}
          >
            {isInitializing ? (
              <ActivityIndicator color="#000" />
            ) : (
              <>
                <Ionicons name="shield" size={18} color="#000" />
                <Text style={st.bigBtnText}>
                  {prover.isReady ? 'CREATE QUANTUM VAULT' : 'LOADING PROVER…'}
                </Text>
              </>
            )}
          </TouchableOpacity>
        </Animated.View>
      ) : null}

      {/* ── Send ── */}
      {initialized ? (
        <Animated.View entering={FadeInDown.duration(300).delay(120)} style={st.card}>
          <View style={st.cardHeader}>
            <Ionicons name="arrow-up-circle" size={18} color={P01Colors.pink} />
            <Text style={st.cardTitle}>Send</Text>
          </View>
          <TextInput
            style={st.input}
            placeholder="Recipient address"
            placeholderTextColor={Colors.textSecondary}
            value={sendRecipient}
            onChangeText={setSendRecipient}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TextInput
            style={st.input}
            placeholder="Amount in SOL"
            placeholderTextColor={Colors.textSecondary}
            value={sendAmount}
            onChangeText={setSendAmount}
            keyboardType="decimal-pad"
          />
          <TouchableOpacity
            disabled={isSending}
            onPress={handleSend}
            style={[st.bigBtn, { backgroundColor: P01Colors.pink }]}
          >
            {isSending ? (
              <ActivityIndicator color="#000" />
            ) : (
              <>
                <Ionicons name="paper-plane" size={18} color="#000" />
                <Text style={st.bigBtnText}>SEND INSTANT</Text>
              </>
            )}
          </TouchableOpacity>
          <Text style={st.hint}>
            UI deducts immediately. STARK proves + on-chain settles in the background. Cached
            proof is reused across sends — only the first one waits for full prove time.
          </Text>
        </Animated.View>
      ) : null}

      {/* ── Receive ── */}
      {initialized && ownerIdB58 ? (
        <Animated.View entering={FadeInDown.duration(300).delay(160)} style={st.card}>
          <View style={st.cardHeader}>
            <Ionicons name="arrow-down-circle" size={18} color={P01Colors.cyan} />
            <Text style={st.cardTitle}>Receive</Text>
          </View>
          <Pressable onPress={handleCopyAddress} style={st.addrBox}>
            <Text style={st.addrText} numberOfLines={1} ellipsizeMode="middle">
              {ownerIdB58}
            </Text>
            <Ionicons name="copy" size={16} color={P01Colors.cyan} />
          </Pressable>
          <Text style={st.hint}>
            Share this address with anyone. Funds land in your Ed25519 layer, then auto-migrate
            into the quantum vault within seconds — no user action required.
          </Text>
        </Animated.View>
      ) : null}

      {/* ── Pending sends ── */}
      {pendingSends.length > 0 ? (
        <Animated.View entering={FadeInDown.duration(300).delay(200)} style={st.card}>
          <View style={st.cardHeader}>
            <Ionicons name="time" size={18} color={P01Colors.yellow} />
            <Text style={st.cardTitle}>In flight</Text>
            {isProcessing ? <ActivityIndicator size="small" color={P01Colors.yellow} /> : null}
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
                  p.status === 'confirmed' && { color: P01Colors.green },
                  p.status === 'failed' && { color: P01Colors.pinkHot },
                ]}>
                  {p.status === 'proving' ? 'Generating STARK proof…'
                    : p.status === 'submitting' ? 'Submitting on-chain…'
                    : p.status === 'confirmed' ? '✓ Confirmed'
                    : p.status === 'failed' ? `✗ ${p.error ?? 'failed'}`
                    : 'Queued'}
                </Text>
              </View>
              {p.status === 'pending' ? (
                <TouchableOpacity onPress={() => cancelPending(p.id)}>
                  <Text style={st.cancelBtn}>cancel</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          ))}
        </Animated.View>
      ) : null}

      {/* ── Danger zone (collapsed by default — surfaced for the demo) ── */}
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
        >
          <Text style={st.wipeText}>Wipe local quantum state</Text>
        </TouchableOpacity>
      ) : null}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  scroll: { paddingHorizontal: 20, gap: 14 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  headerBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontFamily: FontFamily.bold,
    fontSize: 16,
    fontWeight: '900',
    letterSpacing: 2,
    color: Colors.text,
  },
  subtitle: {
    fontSize: 10,
    color: Colors.textSecondary,
    marginTop: 2,
    letterSpacing: 0.5,
  },
  heroCard: {
    backgroundColor: '#151518',
    borderColor: P01Colors.cyan + '33',
    borderWidth: 1,
    borderRadius: BorderRadius.lg,
    padding: 20,
    marginTop: 8,
  },
  heroLabel: {
    fontSize: 11,
    color: Colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
    marginBottom: 6,
  },
  heroAmount: {
    fontFamily: FontFamily.bold,
    fontSize: 44,
    fontWeight: '900',
    color: P01Colors.cyan,
  },
  heroUnit: {
    fontSize: 18,
    fontWeight: '600',
    color: Colors.textSecondary,
  },
  transitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
  },
  transitText: {
    fontSize: 11,
    color: P01Colors.pink,
  },
  metaRow: { flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' },
  metaPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2a2a30',
  },
  metaPillText: {
    fontSize: 10,
    color: Colors.textSecondary,
    fontFamily: FontFamily.mono,
  },
  initCard: {
    backgroundColor: '#151518',
    borderColor: P01Colors.pink + '33',
    borderWidth: 1,
    borderRadius: BorderRadius.lg,
    padding: 18,
    gap: 8,
    alignItems: 'center',
  },
  initTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.text,
    textAlign: 'center',
  },
  initDesc: {
    fontSize: 12,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 17,
    marginBottom: 6,
  },
  card: {
    backgroundColor: '#151518',
    borderColor: '#2a2a30',
    borderWidth: 1,
    borderRadius: BorderRadius.lg,
    padding: 14,
    gap: 10,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cardTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.text,
    flex: 1,
  },
  input: {
    backgroundColor: '#0f0f12',
    borderColor: '#2a2a30',
    borderWidth: 1,
    borderRadius: BorderRadius.md,
    paddingVertical: 12,
    paddingHorizontal: 14,
    color: Colors.text,
    fontFamily: FontFamily.mono,
    fontSize: 13,
  },
  bigBtn: {
    backgroundColor: P01Colors.cyan,
    borderRadius: BorderRadius.md,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  bigBtnText: {
    fontWeight: '900',
    color: '#000',
    fontSize: 13,
    letterSpacing: 1,
  },
  hint: {
    fontSize: 11,
    color: Colors.textSecondary,
    lineHeight: 15,
  },
  addrBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#0f0f12',
    borderRadius: BorderRadius.md,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderColor: P01Colors.cyan + '44',
    borderWidth: 1,
  },
  addrText: {
    flex: 1,
    fontFamily: FontFamily.mono,
    fontSize: 12,
    color: P01Colors.cyan,
  },
  pendingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#2a2a30',
  },
  pendingAmount: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.text,
  },
  pendingRecipient: {
    fontFamily: FontFamily.mono,
    fontSize: 11,
    color: Colors.textSecondary,
    fontWeight: '400',
  },
  pendingStatus: {
    fontSize: 11,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  cancelBtn: {
    fontSize: 11,
    color: P01Colors.pinkHot,
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  wipeBtn: {
    alignSelf: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginTop: 10,
  },
  wipeText: {
    fontSize: 11,
    color: Colors.textSecondary,
    textDecorationLine: 'underline',
  },
});

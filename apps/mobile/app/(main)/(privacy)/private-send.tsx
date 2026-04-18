import React, { useState, useCallback, useMemo } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput, ActivityIndicator, StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import { p01Alert } from '@/stores/alertStore';
import { useT } from '@/i18n';
import { useWalletStore } from '@/stores/walletStore';
import { useDenominatedPoolStore } from '@/stores/denominatedPoolStore';
import { getConnection } from '@/services/solana/connection';
import { deriveRouteStealthKeypair } from '@/services/privacyRouter/stealthManager';
import { estimateFees } from '@/services/privacyRouter/routePlanner';
import type { PrivacyLevel, RouteFeeEstimate } from '@/services/privacyRouter/types';
import { PRIVACY_LEVEL_CONFIGS } from '@/services/privacyRouter/types';
import { findPool } from '@/services/denominatedPool';

type SendSource = 'wallet' | 'note';

export default function PrivateSendScreen() {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = require('expo-router').useLocalSearchParams() as { address?: string };
  const { balance, publicKey } = useWalletStore();
  const notes = useDenominatedPoolStore(s => s.notes);
  const shieldNote = useDenominatedPoolStore(s => s.shieldNote);

  const [source, setSource] = useState<SendSource>('wallet');
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [recipient, setRecipient] = useState(params.address || '');
  const [privacyLevel, setPrivacyLevel] = useState<PrivacyLevel>(3);
  const [isStarting, setIsStarting] = useState(false);

  const solBalance = balance?.sol ?? 0;
  const availableNotes = useMemo(() => notes.filter(n => n.token === 'SOL' && n.status === 'mature'), [notes]);
  const selectedNote = availableNotes.find(n => n.id === selectedNoteId);
  const levelConfig = PRIVACY_LEVEL_CONFIGS[privacyLevel];
  const LEVELS: { level: PrivacyLevel; label: string; time: string; fee: string }[] = [
    { level: 1, label: t('privateSend.basic'), time: '~30m-1h', fee: '~0.8%' },
    { level: 2, label: t('privateSend.standard'), time: '~1-4h', fee: '~1.6%' },
    { level: 3, label: t('privateSend.enhanced'), time: '~4-8h', fee: '~2.4%' },
    { level: 4, label: t('privateSend.maximum'), time: '~8-16h', fee: '~3.2%' },
    { level: 5, label: t('privateSend.paranoid'), time: '~24-48h', fee: '~4.0%' },
  ];
  const levelInfo = LEVELS.find(l => l.level === privacyLevel)!;

  const parsedAmount = parseFloat(amount);
  const hasAmount = !isNaN(parsedAmount) && parsedAmount > 0;
  const hasRecipient = recipient.trim().length >= 32;
  const hasBalance = source === 'note' ? hasAmount && !!selectedNote : hasAmount && parsedAmount <= solBalance;
  const canStart = hasAmount && hasRecipient && hasBalance && !isStarting;

  const feeEstimate = useMemo<RouteFeeEstimate | null>(() => {
    if (!hasAmount) return null;
    return estimateFees({ amount: parsedAmount, privacyLevel });
  }, [amount, privacyLevel]);

  const handlePaste = useCallback(async () => {
    const text = await Clipboard.getStringAsync();
    if (text) { setRecipient(text.trim()); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }
  }, []);

  const handleSelectNote = useCallback((noteId: string) => {
    setSelectedNoteId(noteId);
    const note = availableNotes.find(n => n.id === noteId);
    if (note) setAmount(note.denomination.toString());
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [availableNotes]);

  // ── Start Route ─────────────────────────────────────────────
  const handleStartRoute = useCallback(async () => {
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) return;

    let finalDestination = recipient.trim();
    try {
      const { isMetaAddress, deriveStealthForRecipient } = require('@/services/stealth/keys');
      if (isMetaAddress(finalDestination)) {
        const stealth = deriveStealthForRecipient(finalDestination);
        finalDestination = stealth.address;
      } else {
        new (require('@solana/web3.js').PublicKey)(finalDestination);
      }
    } catch {
      return p01Alert(t('common.invalidAddress'), t('alerts.invalidAddress'));
    }

    if (amt < 0.1) return p01Alert(t('common.warning'), t('privateSend.minimumAmount'));

    const srcLabel = source === 'note' && selectedNote
      ? `shielded note (${selectedNote.denomination} SOL)` : `wallet (${amt} SOL)`;

    p01Alert(t('privateSend.confirmPrivateSend'),
      `${t('common.send')} ${amt} SOL to ${finalDestination.slice(0, 8)}...${finalDestination.slice(-4)}\n\nSource: ${srcLabel}\nPrivacy: ${levelInfo.label}\n\n${t('privateSend.irreversible')}`,
      [{ text: t('common.cancel'), style: 'cancel' },
       { text: t('common.send'), style: 'destructive', onPress: () => executePrivateSend(amt, finalDestination) }],
      'warning');
  }, [amount, recipient, privacyLevel, source, selectedNote]);

  const executePrivateSend = useCallback(async (amt: number, dest: string) => {
    setIsStarting(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    try {
      console.log(`[PrivateSend] ${amt} SOL → ${dest.slice(0, 8)}... | Level ${privacyLevel}`);

      if (source === 'note' && selectedNote) {
        useDenominatedPoolStore.getState().lockNote(selectedNote.id);
        const { sha256 } = await import('@noble/hashes/sha2.js');
        const { bytesToHex } = await import('@noble/hashes/utils.js');
        const skHash = bytesToHex(sha256(new TextEncoder().encode(publicKey || 'default')));
        const { startPrivateRoute, isPrivacyRouterAvailable } = await import('@/services/privacyRouter');
        if (!isPrivacyRouterAvailable()) {
          const { startAutonomousRunner } = await import('@/services/privacyRouter/autonomousRunner');
          await startAutonomousRunner();
        }
        const route = await startPrivateRoute({ amount: selectedNote.denomination, destination: dest, privacyLevel, spendingKeyHash: skHash });
        useWalletStore.getState().refreshBalance?.();
        p01Alert(t('privateSend.routeActive'), t('privateSend.routeDesc', { hops: route.hops.length }));
        router.back(); return;
      }

      // FROM WALLET: stealth → shield → route
      const { sha256: sha256E } = require('@noble/hashes/sha2');
      const { bytesToHex: bthE } = require('@noble/hashes/utils');
      const skHash = bthE(sha256E(new TextEncoder().encode(publicKey || 'default')));
      const ephId = `ephemeral_${Date.now().toString(36)}`;
      const stealthKp = deriveRouteStealthKeypair({ spendingKeyHash: skHash, routeId: ephId, hopIndex: 0, outputIndex: 0 });

      const { ALL_POOLS, SOL_POOLS } = require('@/services/denominatedPool');
      const solPools = (SOL_POOLS || ALL_POOLS.filter((p: any) => p.token === 'SOL')).sort((a: any, b: any) => b.denomination - a.denomination);
      const pool = solPools.find((p: any) => p.denomination <= amt);
      if (!pool) throw new Error(`No pool for ${amt} SOL.`);

      const { SystemProgram, Transaction, PublicKey: PubKey } = require('@solana/web3.js');
      const connection = getConnection();
      const lamports = Math.round(pool.denomination * 1e9) + Math.round(pool.denomination * 1e9 * 0.003) + 10_000_000;

      const transferTx = new Transaction().add(SystemProgram.transfer({ fromPubkey: new PubKey(publicKey), toPubkey: stealthKp.publicKey, lamports }));
      const { getPrivySigner } = require('@/stores/walletStore');
      const signTx = getPrivySigner();
      if (!signTx) throw new Error('No wallet signer available');
      const { blockhash } = await connection.getLatestBlockhash();
      transferTx.recentBlockhash = blockhash; transferTx.feePayer = new PubKey(publicKey);
      const signed = await signTx(transferTx);
      const txSig = await connection.sendRawTransaction(signed.serialize());
      await connection.confirmTransaction(txSig, 'confirmed');

      const noteId = await shieldNote(pool);

      const { sha256 } = await import('@noble/hashes/sha2.js');
      const { bytesToHex } = await import('@noble/hashes/utils.js');
      const spendingKeyHash = bytesToHex(sha256(new TextEncoder().encode(publicKey || 'default')));
      const { startPrivateRoute, isPrivacyRouterAvailable } = await import('@/services/privacyRouter');
      if (!isPrivacyRouterAvailable()) {
        const { startAutonomousRunner } = await import('@/services/privacyRouter/autonomousRunner');
        await startAutonomousRunner();
      }
      const route = await startPrivateRoute({ amount: amt, destination: dest, privacyLevel, spendingKeyHash });
      useWalletStore.getState().refreshBalance?.();
      p01Alert(t('privateSend.routeActive'), `${pool.denomination} SOL shielded. ${route.hops.length} hops over ${feeEstimate?.estimatedDuration || 'several hours'}.`);
      router.back();
    } catch (err: any) {
      console.error('[PrivateSend]', err.message);
      p01Alert(t('common.error'), err.message || t('alerts.errorGeneric'));
    } finally { setIsStarting(false); }
  }, [publicKey, levelConfig, feeEstimate, router, shieldNote, source, selectedNote, selectedNoteId, privacyLevel]);

  return (
    <View style={[st.container, { paddingTop: insets.top }]}>
      <View style={st.header}>
        <TouchableOpacity onPress={() => router.back()} style={st.backBtn}>
          <Ionicons name="arrow-back" size={20} color={Colors.text} />
        </TouchableOpacity>
        <Text style={st.headerTitle}>{t('privateSend.title')}</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: Spacing.xl, paddingBottom: insets.bottom + 120 }}
        showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

        {/* Source selector */}
        <Animated.View entering={FadeInDown.delay(50).duration(250)} style={st.card}>
          <Text style={st.label}>{t('privateSend.sendFrom')}</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {[
              { key: 'wallet' as const, icon: 'wallet-outline', title: t('privateSend.walletSource'), sub: `${solBalance.toFixed(2)} SOL`, color: P01Colors.cyan },
              { key: 'note' as const, icon: 'shield-checkmark-outline', title: t('privateSend.noteSource'), sub: t('privateSend.notesAvailable', { count: availableNotes.length }), color: '#8B8BFF', disabled: availableNotes.length === 0 },
            ].map(s => (
              <TouchableOpacity key={s.key} onPress={() => { setSource(s.key); if (s.key === 'wallet') setSelectedNoteId(null); }}
                disabled={s.disabled} activeOpacity={0.7}
                style={[st.sourceBtn, source === s.key && { backgroundColor: `${s.color}15`, borderColor: s.color }, s.disabled && { opacity: 0.4 }]}>
                <Ionicons name={s.icon as any} size={18} color={source === s.key ? s.color : Colors.textSecondary} />
                <Text style={[st.sourceName, source === s.key && { color: s.color }]}>{s.title}</Text>
                <Text style={st.sourceSub}>{s.sub}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Note list */}
          {source === 'note' && availableNotes.length > 0 && (
            <View style={{ marginTop: 10, gap: 6 }}>
              {availableNotes.map(n => (
                <TouchableOpacity key={n.id} onPress={() => handleSelectNote(n.id)} activeOpacity={0.7}
                  style={[st.noteRow, selectedNoteId === n.id && { backgroundColor: 'rgba(139,139,255,0.1)', borderColor: '#8B8BFF' }]}>
                  <Ionicons name={selectedNoteId === n.id ? 'radio-button-on' : 'radio-button-off'} size={16}
                    color={selectedNoteId === n.id ? '#8B8BFF' : Colors.textTertiary} />
                  <Text style={st.noteDenom}>{n.denomination} SOL</Text>
                  <View style={[st.badge, { backgroundColor: 'rgba(16,185,129,0.15)' }]}>
                    <Text style={[st.badgeText, { color: P01Colors.green }]}>{t('privacy.mature').toUpperCase()}</Text>
                  </View>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </Animated.View>

        {/* Amount */}
        <Animated.View entering={FadeInDown.delay(100).duration(250)} style={{ alignItems: 'center', marginVertical: 20 }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
            <TextInput style={st.amountInput} value={amount} onChangeText={setAmount}
              placeholder="0" placeholderTextColor={Colors.textTertiary} keyboardType="decimal-pad" />
            <Text style={st.amountSuffix}>SOL</Text>
          </View>
          <Text style={st.balText}>{t('common.available')}: {solBalance.toFixed(4)} SOL</Text>
          <View style={{ flexDirection: 'row', gap: 6, marginTop: 10 }}>
            {[0.25, 0.5, 0.75, 1].map(pct => (
              <TouchableOpacity key={pct} onPress={() => { setAmount((Math.max(0, solBalance - 0.01) * pct).toFixed(4)); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
                style={st.pctBtn}>
                <Text style={st.pctText}>{pct === 1 ? t('send.max') : `${pct * 100}%`}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </Animated.View>

        {/* Recipient */}
        <Animated.View entering={FadeInDown.delay(150).duration(250)} style={st.card}>
          <Text style={st.label}>{t('privateSend.destination')}</Text>
          <View style={st.recipientWrap}>
            <TextInput style={st.recipientInput} value={recipient} onChangeText={setRecipient}
              placeholder={t('privateSend.enterDestination')} placeholderTextColor={Colors.textTertiary}
              autoCapitalize="none" autoCorrect={false} multiline numberOfLines={2} />
            <View style={{ flexDirection: 'row', gap: 4 }}>
              <TouchableOpacity onPress={() => router.push('/(main)/(wallet)/scan')} style={st.iconBtn}>
                <Ionicons name="scan-outline" size={16} color={P01Colors.cyan} />
              </TouchableOpacity>
              <TouchableOpacity onPress={handlePaste} style={st.iconBtn}>
                <Ionicons name="clipboard-outline" size={16} color={P01Colors.cyan} />
              </TouchableOpacity>
            </View>
          </View>
        </Animated.View>

        {/* Privacy Level */}
        <Animated.View entering={FadeInDown.delay(200).duration(250)} style={st.card}>
          <Text style={st.label}>{t('privateSend.privacyLevel')}</Text>
          <View style={{ flexDirection: 'row', gap: 6, marginBottom: 12 }}>
            {LEVELS.map(l => {
              const sel = l.level === privacyLevel;
              return (
                <TouchableOpacity key={l.level} onPress={() => { setPrivacyLevel(l.level); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
                  style={[st.lvlPill, sel && st.lvlPillActive]}>
                  <Text style={[st.lvlNum, sel && { color: P01Colors.cyan }]}>{l.level}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 }}>
            <Text style={st.lvlLabel}>{levelInfo.label}</Text>
            <Text style={st.lvlFee}>{levelInfo.fee}</Text>
          </View>

          <View style={st.detailBox}>
            {[
              [t('privateSend.hops'), `${levelConfig.hops}`, 'layers-outline'],
              [t('privateSend.splits'), `${levelConfig.splits}`, 'git-branch-outline'],
              [t('privateSend.estimatedTime'), levelInfo.time, 'time-outline'],
            ].map(([label, val, icon], i) => (
              <View key={label}>
                {i > 0 && <View style={st.detailDivider} />}
                <View style={st.detailRow}>
                  <Ionicons name={icon as any} size={13} color={Colors.textTertiary} />
                  <Text style={st.detailLabel}>{label}</Text>
                  <Text style={st.detailValue}>{val}</Text>
                </View>
              </View>
            ))}
          </View>
        </Animated.View>

        {/* Fees */}
        {feeEstimate && (
          <Animated.View entering={FadeInDown.delay(250).duration(250)} style={st.card}>
            <Text style={st.label}>{t('privateSend.fees')}</Text>
            <View style={st.detailBox}>
              {[
                [t('privateSend.shieldFees'), `${feeEstimate.shieldFees.toFixed(6)} SOL`],
                [t('privateSend.unshieldFees'), `${feeEstimate.unshieldFees.toFixed(6)} SOL`],
                [t('privateSend.networkFees'), `${feeEstimate.networkFees.toFixed(6)} SOL`],
              ].map(([k, v], i) => (
                <View key={k}>
                  {i > 0 && <View style={st.detailDivider} />}
                  <View style={st.detailRow}>
                    <Text style={st.detailLabel}>{k}</Text>
                    <Text style={st.detailValue}>{v}</Text>
                  </View>
                </View>
              ))}
              <View style={st.detailDivider} />
              <View style={st.detailRow}>
                <Text style={[st.detailLabel, { color: P01Colors.cyan, fontFamily: FontFamily.semibold }]}>{t('privateSend.totalFees')}</Text>
                <Text style={[st.detailValue, { color: P01Colors.cyan }]}>{feeEstimate.totalFees.toFixed(6)} SOL ({feeEstimate.totalCostPercent.toFixed(2)}%)</Text>
              </View>
            </View>
          </Animated.View>
        )}
      </ScrollView>

      {/* CTA */}
      <View style={[st.cta, { bottom: insets.bottom + 90 }]}>
        <TouchableOpacity onPress={handleStartRoute} disabled={!canStart} activeOpacity={0.8}
          style={[st.ctaBtn, !canStart && { opacity: 0.4 }]}>
          {isStarting ? <ActivityIndicator size="small" color="#000" /> : (
            <>
              <Ionicons name="rocket-outline" size={18} color="#000" />
              <Text style={st.ctaText}>{t('privateSend.startPrivateSend')}</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl, paddingVertical: Spacing.lg,
  },
  backBtn: {
    width: 40, height: 40, borderRadius: BorderRadius.full,
    backgroundColor: Colors.surfaceSecondary, alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: { fontSize: 20, fontFamily: FontFamily.bold, color: Colors.text },

  // Cards
  card: {
    backgroundColor: Colors.surfaceSecondary, borderRadius: BorderRadius.xl,
    padding: Spacing.xl, marginBottom: 12,
  },
  label: { fontSize: 11, fontFamily: FontFamily.bold, color: Colors.textTertiary, letterSpacing: 1, marginBottom: 10 },

  // Source selector
  sourceBtn: {
    flex: 1, paddingVertical: 12, borderRadius: BorderRadius.md, alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: Colors.surfaceTertiary,
  },
  sourceName: { fontSize: 12, fontFamily: FontFamily.medium, color: Colors.textSecondary, marginTop: 4 },
  sourceSub: { fontSize: 10, fontFamily: FontFamily.regular, color: Colors.textTertiary, marginTop: 2 },

  // Note row
  noteRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: Colors.surfaceTertiary,
  },
  noteDenom: { flex: 1, fontSize: 13, fontFamily: FontFamily.mono, color: Colors.text },
  badge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  badgeText: { fontSize: 9, fontFamily: FontFamily.bold },

  // Amount
  amountInput: { fontSize: 48, fontFamily: FontFamily.bold, color: Colors.text, minWidth: 60, textAlign: 'center' },
  amountSuffix: { fontSize: 22, fontFamily: FontFamily.medium, color: Colors.textSecondary, marginLeft: 8 },
  balText: { fontSize: 13, fontFamily: FontFamily.regular, color: Colors.textSecondary, marginTop: 6 },
  pctBtn: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: BorderRadius.full,
    backgroundColor: 'rgba(57,197,187,0.08)', borderWidth: 1, borderColor: 'rgba(57,197,187,0.15)',
  },
  pctText: { fontSize: 12, fontFamily: FontFamily.semibold, color: P01Colors.cyan },

  // Recipient
  recipientWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.surfaceTertiary, paddingHorizontal: 12, paddingVertical: 8,
  },
  recipientInput: { flex: 1, fontSize: 14, fontFamily: FontFamily.mono, color: Colors.text, minHeight: 44, padding: 0 },
  iconBtn: {
    width: 34, height: 34, borderRadius: BorderRadius.full,
    backgroundColor: 'rgba(57,197,187,0.08)', alignItems: 'center', justifyContent: 'center',
  },

  // Privacy level
  lvlPill: {
    flex: 1, paddingVertical: 10, borderRadius: BorderRadius.md, alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: Colors.surfaceTertiary,
  },
  lvlPillActive: { backgroundColor: 'rgba(57,197,187,0.12)', borderColor: P01Colors.cyan },
  lvlNum: { fontSize: 15, fontFamily: FontFamily.bold, color: Colors.textSecondary },
  lvlLabel: { fontSize: 16, fontFamily: FontFamily.semibold, color: Colors.text },
  lvlFee: { fontSize: 13, fontFamily: FontFamily.mono, color: P01Colors.pink },

  // Detail box
  detailBox: {
    backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: BorderRadius.md, padding: 12,
    borderWidth: 1, borderColor: Colors.surfaceTertiary,
  },
  detailRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 7 },
  detailLabel: { flex: 1, fontSize: 13, fontFamily: FontFamily.regular, color: Colors.textTertiary },
  detailValue: { fontSize: 13, fontFamily: FontFamily.mono, color: Colors.text },
  detailDivider: { height: 1, backgroundColor: Colors.surfaceTertiary },

  // CTA
  cta: { position: 'absolute', bottom: 0, left: 0, right: 0, paddingHorizontal: Spacing.xl },
  ctaBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 16, borderRadius: BorderRadius.md, backgroundColor: P01Colors.cyan,
  },
  ctaText: { fontSize: 16, fontFamily: FontFamily.bold, color: '#000' },
});

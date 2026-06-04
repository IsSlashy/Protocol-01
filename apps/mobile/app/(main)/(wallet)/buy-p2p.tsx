// ═══════════════════════════════════════════════════════════════════════════
// BuyP2PScreen — encrypted Mugen P2P buy flow (FROST quorum + Arcium MPC).
// ─────────────────────────────────────────────────────────────────────────
// Flow:
//   1. On mount → listPrivateMatches() for live activity feed + auto-generate
//      a taker-nonce keypair (the ephemeral MPC anchor for this session).
//   2. User fills the "Find my match" form (desired crypto, max fiat, rails).
//   3. Submit → client.blindTake(...) with a 2-step pill
//      (Step 1/2 FROST quorum → Step 2/2 settling; matching runs off-chain).
//   4. PrivacyReceiptRN renders the 4-layer receipt + claim card (if matched).
//   5. claim wires to client.claimMatch(...); on tokenEscrow=true the
//      TradeLifecycleCardRN mounts below with injected network layer props.
// ═══════════════════════════════════════════════════════════════════════════

import { MaterialIcons } from '@expo/vector-icons';
import { Keypair } from '@solana/web3.js';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import LiveActivityList from '@/components/mugen/LiveActivityList';
import PrivacyReceiptRN, {
  type PrivacyReceiptClaimResult,
  type PrivacyReceiptMatchedOrder,
  type PrivacyReceiptThreshold,
} from '@/components/mugen/PrivacyReceiptRN';
import TradeLifecycleCardRN from '@/components/mugen/TradeLifecycleCardRN';
import { GojoColors, Mono } from '@/components/mugen/SharedStyles';
import {
  MugenApiError,
  getMugenEncryptedClient,
} from '@/services/mugen-encrypted';
import type {
  BlindTakeResponse,
  ClaimMatchResponse,
  FiatCurrency,
  PrivateMatchReceipt,
  SubmitPhase,
} from '@/services/mugen-encrypted/types';
import { useWalletStore } from '@/stores/walletStore';

// ─── Payment rails (bitmask) ────────────────────────────────────────────────

interface PaymentOption {
  key: 'sepa' | 'revolut' | 'wise' | 'cash' | 'zelle';
  label: string;
  bit: number;
  icon: keyof typeof MaterialIcons.glyphMap;
}

const PAYMENT_OPTIONS: readonly PaymentOption[] = [
  { key: 'sepa', label: 'SEPA', bit: 1, icon: 'account-balance' },
  { key: 'revolut', label: 'Revolut', bit: 2, icon: 'credit-card' },
  { key: 'wise', label: 'Wise', bit: 4, icon: 'swap-horiz' },
  { key: 'cash', label: 'Cash', bit: 8, icon: 'payments' },
  { key: 'zelle', label: 'Zelle', bit: 16, icon: 'send' },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function solToLamports(sol: number): number {
  // guard against FP drift; 9 decimals is SOL precision
  return Math.round(sol * 1_000_000_000);
}

function friendlyApiError(err: unknown): string {
  if (err instanceof MugenApiError) {
    switch (err.code) {
      case 'THRESHOLD_REJECTED': {
        const signerCount = err.signers?.length ?? 0;
        return (
          "Quorum didn't approve — try again in a moment." +
          (signerCount > 0 ? ` (${signerCount} signer(s) saw it)` : '')
        );
      }
      case 'COORDINATOR_UNREACHABLE':
        return 'FROST signer network unreachable — check your connection.';
      case 'NETWORK_ERROR':
        return 'Network error — retry.';
      case 'TIMEOUT':
        return 'Request timed out.';
      default:
        return err.detail ?? err.message ?? 'Something went wrong';
    }
  }
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}

function useNewTakerNonce(): {
  takerNoncePubkey: string;
  regenerate: () => void;
} {
  const [takerNoncePubkey, setTakerNoncePubkey] = useState<string>(() =>
    Keypair.generate().publicKey.toBase58(),
  );
  const regenerate = useCallback(() => {
    setTakerNoncePubkey(Keypair.generate().publicKey.toBase58());
  }, []);
  return { takerNoncePubkey, regenerate };
}

// ─── Main screen ────────────────────────────────────────────────────────────

export default function BuyP2PScreen(): React.ReactElement {
  const router = useRouter();
  const { publicKey } = useWalletStore();
  const client = useMemo(() => getMugenEncryptedClient(), []);

  // Prefill from buy.tsx hand-off (P-01 rail). All optional.
  const params = useLocalSearchParams<{
    desiredSol?: string;
    maxFiat?: string;
    fiatCurrency?: string;
    stealth?: string;
  }>();
  const prefillCurrency: FiatCurrency =
    params.fiatCurrency === 'USD' ? 'USD' : 'EUR';

  // Taker-nonce for this session
  const { takerNoncePubkey, regenerate: regenerateNonce } = useNewTakerNonce();

  // Form state — prefilled from params when present
  const [formOpen, setFormOpen] = useState<boolean>(
    Boolean(params.desiredSol || params.maxFiat),
  );
  const [desiredSol, setDesiredSol] = useState<string>(
    params.desiredSol ?? '0.01',
  );
  const [maxFiat, setMaxFiat] = useState<string>(params.maxFiat ?? '100');
  const [fiatCurrency, setFiatCurrency] = useState<FiatCurrency>(prefillCurrency);
  const [paymentMask, setPaymentMask] = useState<number>(1); // SEPA default

  // Submit state machine
  const [phase, setPhase] = useState<SubmitPhase>('idle');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [takeResult, setTakeResult] = useState<BlindTakeResponse | null>(null);

  // Claim state
  const [claimInFlight, setClaimInFlight] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claimResult, setClaimResult] = useState<ClaimMatchResponse | null>(null);

  // Live activity feed
  const [matches, setMatches] = useState<PrivateMatchReceipt[]>([]);
  const [feedLoading, setFeedLoading] = useState<boolean>(true);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const mountedRef = useRef<boolean>(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshFeed = useCallback(async () => {
    try {
      const res = await client.listPrivateMatches();
      if (!mountedRef.current) return;
      setMatches(res.matches);
      setFeedError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setFeedError(friendlyApiError(err));
    } finally {
      if (mountedRef.current) {
        setFeedLoading(false);
        setRefreshing(false);
      }
    }
  }, [client]);

  useEffect(() => {
    void refreshFeed();
    const id = setInterval(() => {
      void refreshFeed();
    }, 15_000);
    return () => clearInterval(id);
  }, [refreshFeed]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void refreshFeed();
  }, [refreshFeed]);

  // ─── Payment rail toggle ────────────────────────────────────────────────────
  const togglePaymentRail = useCallback((bit: number) => {
    setPaymentMask((prev) => prev ^ bit);
  }, []);

  // ─── Submit handler ─────────────────────────────────────────────────────────
  const canSubmit =
    phase === 'idle' &&
    Number.parseFloat(desiredSol) > 0 &&
    Number.parseFloat(maxFiat) > 0 &&
    paymentMask > 0;

  const onFindMatch = useCallback(async () => {
    const sol = Number.parseFloat(desiredSol);
    const fiat = Number.parseFloat(maxFiat);
    if (!Number.isFinite(sol) || sol <= 0) {
      setSubmitError('Enter a crypto amount greater than 0.');
      return;
    }
    if (!Number.isFinite(fiat) || fiat <= 0) {
      setSubmitError('Enter a max fiat amount greater than 0.');
      return;
    }
    if (paymentMask === 0) {
      setSubmitError('Select at least one payment rail.');
      return;
    }

    setSubmitError(null);
    setTakeResult(null);
    setClaimResult(null);
    setClaimError(null);
    setPhase('threshold');

    // UX: visibly hop to 'mpc' shortly after — the server pipeline runs both
    // phases inside blindTake(), but showing a 2-step pill makes the wait
    // feel intentional instead of opaque.
    const hopTimer = setTimeout(() => {
      if (mountedRef.current) setPhase('mpc');
    }, 900);

    try {
      const res = await client.blindTake({
        desiredCryptoAmountLamports: solToLamports(sol),
        maxFiatAmountCents: Math.round(fiat * 100),
        fiatCurrency,
        paymentMethodsMask: paymentMask,
        takerNoncePubkey,
      });
      if (!mountedRef.current) return;
      setTakeResult(res);
      setPhase('done');
    } catch (err) {
      if (!mountedRef.current) return;
      setSubmitError(friendlyApiError(err));
      setPhase('idle');
    } finally {
      clearTimeout(hopTimer);
      // Fire-and-forget refresh so the new match (if any) surfaces in the feed.
      void refreshFeed();
    }
  }, [
    desiredSol,
    maxFiat,
    paymentMask,
    fiatCurrency,
    takerNoncePubkey,
    client,
    refreshFeed,
  ]);

  // ─── Claim handler (passed into PrivacyReceiptRN) ───────────────────────────
  const onClaim = useCallback(async () => {
    if (!takeResult || takeResult.matched !== true) return;
    const matchedNonce = takeResult.matchedOrderNonce;
    if (!publicKey) {
      setClaimError('Connect a wallet to claim the match.');
      return;
    }
    setClaimInFlight(true);
    setClaimError(null);
    try {
      const res = await client.claimMatch({
        takerNoncePubkey,
        matchedMakerNonce: matchedNonce,
        takerWallet: publicKey,
      });
      if (!mountedRef.current) return;
      setClaimResult(res);
    } catch (err) {
      if (!mountedRef.current) return;
      setClaimError(friendlyApiError(err));
    } finally {
      if (mountedRef.current) setClaimInFlight(false);
      void refreshFeed();
    }
  }, [takeResult, client, takerNoncePubkey, publicKey, refreshFeed]);

  // ─── Derived data for the receipt component ─────────────────────────────────
  const threshold: PrivacyReceiptThreshold | undefined = useMemo(() => {
    if (!takeResult?.threshold) return undefined;
    const t = takeResult.threshold;
    return {
      signaturesCount: t.signaturesCount,
      threshold: t.threshold,
      totalSigners: t.totalSigners,
      signers: t.signers,
      txHashHex: t.txHashHex,
    };
  }, [takeResult]);

  const matchedOrder: PrivacyReceiptMatchedOrder | undefined = useMemo(() => {
    if (!takeResult || takeResult.matched !== true || !takeResult.matchedOrder) {
      return undefined;
    }
    const m = takeResult.matchedOrder;
    return {
      makerNoncePubkey: m.makerNoncePubkey,
      cryptoAmountLamports: m.cryptoAmountLamports,
      fiatAmountCents: m.fiatAmountCents,
      fiatCurrency: m.fiatCurrency,
      paymentMethods: m.paymentMethods,
      mpcTxSignature: m.mpcTxSignature,
    };
  }, [takeResult]);

  const receiptClaimResult: PrivacyReceiptClaimResult | undefined = useMemo(() => {
    if (!claimResult) return undefined;
    return {
      tokenEscrow: claimResult.tokenEscrow,
      escrowPDA: claimResult.escrowPDA,
      vaultPDA: claimResult.vaultPDA,
      orderPDA: claimResult.orderPDA,
      reputationPDA: claimResult.reputationPDA,
      txSignature: claimResult.txSignature,
      fallbackReason: claimResult.fallbackReason,
    };
  }, [claimResult]);

  const showLifecycle =
    claimResult?.tokenEscrow === true &&
    !!claimResult.escrowPDA &&
    !!claimResult.orderPDA &&
    !!claimResult.vaultPDA;

  // ─── Render ─────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Go back"
          onPress={() => router.back()}
          style={({ pressed }) => [styles.backBtn, { opacity: pressed ? 0.6 : 1 }]}
        >
          <MaterialIcons name="arrow-back" size={20} color={GojoColors.white} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Buy Crypto · P2P</Text>
          <Text style={styles.headerSubtitle}>
            Encrypted · FROST 2/3 · Arcium MPC · No KYC
          </Text>
        </View>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={GojoColors.violetLight}
          />
        }
      >
        {/* Info banner */}
        <View style={styles.infoCard}>
          <MaterialIcons name="shield" size={16} color={GojoColors.violetLight} />
          <Text style={styles.infoText}>
            Your terms never leave the device in plaintext. A FROST 2-of-3 quorum
            approves the encrypted order before a relayer settles it on-chain.
            Order matching runs off-chain.
          </Text>
        </View>

        {/* Taker-nonce row */}
        <View style={styles.nonceCard}>
          <View style={styles.nonceRow}>
            <MaterialIcons name="vpn-key" size={13} color={GojoColors.blueLight} />
            <Text style={styles.nonceLabel}>TAKER NONCE</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Regenerate taker nonce"
              onPress={regenerateNonce}
              disabled={phase !== 'idle'}
              style={({ pressed }) => [
                styles.nonceBtn,
                { opacity: phase !== 'idle' ? 0.4 : pressed ? 0.6 : 1 },
              ]}
            >
              <MaterialIcons name="refresh" size={11} color={GojoColors.blueLight} />
              <Text style={styles.nonceBtnText}>new</Text>
            </Pressable>
          </View>
          <Text style={styles.nonceValue} numberOfLines={1}>
            {takerNoncePubkey}
          </Text>
        </View>

        {/* Find my match button / form */}
        {!formOpen && phase === 'idle' && !takeResult ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open find my match form"
            onPress={() => setFormOpen(true)}
            style={({ pressed }) => [
              styles.primaryBtn,
              { opacity: pressed ? 0.8 : 1 },
            ]}
          >
            <MaterialIcons name="search" size={14} color={GojoColors.white} />
            <Text style={styles.primaryBtnText}>FIND MY MATCH</Text>
          </Pressable>
        ) : null}

        {formOpen && !takeResult ? (
          <View style={styles.formCard}>
            <Text style={styles.formTitle}>PRIVATE BUY REQUEST</Text>

            {/* Desired crypto */}
            <View style={styles.fieldRow}>
              <Text style={styles.fieldLabel}>Desired SOL</Text>
              <TextInput
                value={desiredSol}
                onChangeText={setDesiredSol}
                keyboardType="decimal-pad"
                placeholder="0.01"
                placeholderTextColor={GojoColors.subtle}
                style={styles.input}
                accessibilityLabel="Desired crypto amount in SOL"
                editable={phase === 'idle'}
              />
            </View>

            {/* Max fiat + currency picker */}
            <View style={styles.fieldRow}>
              <Text style={styles.fieldLabel}>Max fiat</Text>
              <View style={styles.fiatRow}>
                <TextInput
                  value={maxFiat}
                  onChangeText={setMaxFiat}
                  keyboardType="decimal-pad"
                  placeholder="100"
                  placeholderTextColor={GojoColors.subtle}
                  style={[styles.input, { flex: 1 }]}
                  accessibilityLabel="Max fiat amount"
                  editable={phase === 'idle'}
                />
                {(['EUR', 'USD'] as const).map((c) => (
                  <Pressable
                    key={c}
                    accessibilityRole="button"
                    accessibilityLabel={`Select ${c}`}
                    onPress={() => setFiatCurrency(c)}
                    disabled={phase !== 'idle'}
                    style={({ pressed }) => [
                      styles.currencyChip,
                      {
                        borderColor:
                          fiatCurrency === c
                            ? GojoColors.borderActive
                            : GojoColors.borderSubtle,
                        backgroundColor:
                          fiatCurrency === c
                            ? 'rgba(139,92,246,0.2)'
                            : 'transparent',
                        opacity: pressed ? 0.7 : 1,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.currencyChipText,
                        {
                          color:
                            fiatCurrency === c
                              ? GojoColors.white
                              : GojoColors.mutedLight,
                        },
                      ]}
                    >
                      {c}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            {/* Payment rails */}
            <View>
              <Text style={styles.fieldLabel}>Payment rails</Text>
              <View style={styles.railsGrid}>
                {PAYMENT_OPTIONS.map((opt) => {
                  const active = (paymentMask & opt.bit) !== 0;
                  return (
                    <Pressable
                      key={opt.key}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: active }}
                      accessibilityLabel={`Toggle ${opt.label}`}
                      onPress={() => togglePaymentRail(opt.bit)}
                      disabled={phase !== 'idle'}
                      style={({ pressed }) => [
                        styles.railChip,
                        {
                          borderColor: active
                            ? GojoColors.borderActive
                            : GojoColors.borderSubtle,
                          backgroundColor: active
                            ? 'rgba(139,92,246,0.18)'
                            : 'rgba(255,255,255,0.02)',
                          opacity: pressed ? 0.7 : 1,
                        },
                      ]}
                    >
                      <MaterialIcons
                        name={opt.icon}
                        size={13}
                        color={active ? GojoColors.violetLight : GojoColors.mutedLight}
                      />
                      <Text
                        style={[
                          styles.railChipText,
                          {
                            color: active
                              ? GojoColors.white
                              : GojoColors.mutedLight,
                          },
                        ]}
                      >
                        {opt.label}
                      </Text>
                      {active ? (
                        <MaterialIcons
                          name="check"
                          size={11}
                          color={GojoColors.successLight}
                        />
                      ) : null}
                    </Pressable>
                  );
                })}
              </View>
            </View>

            {/* Submit */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Submit blind take"
              onPress={onFindMatch}
              disabled={!canSubmit}
              style={({ pressed }) => [
                styles.primaryBtn,
                {
                  opacity: !canSubmit ? 0.45 : pressed ? 0.8 : 1,
                  marginTop: 4,
                },
              ]}
            >
              {phase === 'idle' ? (
                <>
                  <MaterialIcons name="memory" size={14} color={GojoColors.white} />
                  <Text style={styles.primaryBtnText}>SUBMIT ENCRYPTED</Text>
                </>
              ) : (
                <>
                  <ActivityIndicator size="small" color={GojoColors.white} />
                  <Text style={styles.primaryBtnText}>
                    {phase === 'threshold'
                      ? 'STEP 1/2 · FROST QUORUM…'
                      : phase === 'mpc'
                        ? 'STEP 2/2 · SETTLING…'
                        : 'DONE'}
                  </Text>
                </>
              )}
            </Pressable>

            {submitError ? (
              <View style={styles.errorCard}>
                <MaterialIcons
                  name="error-outline"
                  size={13}
                  color={GojoColors.errorLight}
                />
                <Text style={styles.errorTextInline}>{submitError}</Text>
              </View>
            ) : null}
          </View>
        ) : null}

        {/* Progress pill (shown even when form is closed, for visual continuity) */}
        {phase !== 'idle' && phase !== 'done' && !formOpen ? (
          <View style={styles.progressPill}>
            <ActivityIndicator size="small" color={GojoColors.violetLight} />
            <Text style={styles.progressText}>
              {phase === 'threshold'
                ? 'Step 1/2 · FROST quorum approving…'
                : 'Step 2/2 · settling in flight…'}
            </Text>
          </View>
        ) : null}

        {/* Privacy receipt — render on ANY response (match or no-match) */}
        {takeResult ? (
          <View style={styles.receiptWrap}>
            <PrivacyReceiptRN
              operation="take"
              computationOffset={takeResult.computationOffset}
              txSignature={takeResult.txSignature}
              threshold={threshold}
              matched={takeResult.matched}
              fiatCurrency={fiatCurrency}
              matchedOrder={matchedOrder}
              takerNoncePubkey={takerNoncePubkey}
              onClaim={takeResult.matched === true ? onClaim : undefined}
              claimInFlight={claimInFlight}
              claimResult={receiptClaimResult}
            />
            {claimError ? (
              <View style={styles.errorCard}>
                <MaterialIcons
                  name="error-outline"
                  size={13}
                  color={GojoColors.errorLight}
                />
                <Text style={styles.errorTextInline}>claim error: {claimError}</Text>
              </View>
            ) : null}

            {/* Retry button when no match — lets user submit again without
                losing the feed scroll position. */}
            {takeResult.matched === false ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Try another match"
                onPress={() => {
                  setTakeResult(null);
                  setFormOpen(true);
                  setSubmitError(null);
                  regenerateNonce();
                }}
                style={({ pressed }) => [
                  styles.secondaryBtn,
                  { opacity: pressed ? 0.7 : 1 },
                ]}
              >
                <MaterialIcons
                  name="refresh"
                  size={13}
                  color={GojoColors.violetLight}
                />
                <Text style={styles.secondaryBtnText}>TRY ANOTHER MATCH</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {/* Trade lifecycle — only when claim produced a token escrow */}
        {showLifecycle && claimResult?.escrowPDA && claimResult.orderPDA && claimResult.vaultPDA ? (
          <View style={styles.lifecycleWrap}>
            <TradeLifecycleCardRN
              escrowPDA={claimResult.escrowPDA}
              orderPDA={claimResult.orderPDA}
              vaultPDA={claimResult.vaultPDA}
              initialTxSignature={claimResult.txSignature ?? takeResult?.txSignature ?? ''}
              getEscrowStatus={(pda) => client.getEscrowStatus(pda)}
              confirmPayment={(args) => client.confirmPayment(args)}
              releaseEscrow={(args) => client.releaseEscrow(args)}
              dispute={(args) => client.dispute(args)}
            />
          </View>
        ) : null}

        {/* Live activity feed */}
        <View style={styles.activityWrap}>
          <LiveActivityList
            matches={matches}
            loading={feedLoading}
            error={feedError}
          />
        </View>

        <View style={{ height: 48 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: GojoColors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: GojoColors.border,
    backgroundColor: GojoColors.bgCardFilled,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    color: GojoColors.white,
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  headerSubtitle: {
    color: GojoColors.violetLight,
    fontFamily: Mono,
    fontSize: 10,
    letterSpacing: 1,
    marginTop: 2,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: 14,
    gap: 14,
  },
  infoCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: GojoColors.border,
    backgroundColor: 'rgba(139,92,246,0.06)',
  },
  infoText: {
    flex: 1,
    color: GojoColors.text,
    fontSize: 12,
    lineHeight: 17,
  },
  nonceCard: {
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: GojoColors.borderSubtle,
    backgroundColor: GojoColors.bgCardFilled,
    gap: 6,
  },
  nonceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  nonceLabel: {
    flex: 1,
    fontFamily: Mono,
    fontSize: 10,
    letterSpacing: 1.5,
    color: GojoColors.blueLight,
  },
  nonceBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(96,165,250,0.25)',
  },
  nonceBtnText: {
    fontFamily: Mono,
    fontSize: 10,
    color: GojoColors.blueLight,
    letterSpacing: 0.8,
  },
  nonceValue: {
    fontFamily: Mono,
    fontSize: 11,
    color: GojoColors.violetLight,
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: GojoColors.borderActive,
    backgroundColor: 'rgba(139,92,246,0.25)',
  },
  primaryBtnText: {
    color: GojoColors.white,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  secondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: GojoColors.border,
    marginTop: 10,
    alignSelf: 'center',
  },
  secondaryBtnText: {
    color: GojoColors.violetLight,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
  },
  formCard: {
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: GojoColors.border,
    backgroundColor: GojoColors.bgCardFilled,
    gap: 12,
  },
  formTitle: {
    color: GojoColors.white,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.5,
  },
  fieldRow: {
    gap: 6,
  },
  fieldLabel: {
    fontFamily: Mono,
    fontSize: 10,
    letterSpacing: 1.2,
    color: GojoColors.mutedLight,
  },
  input: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: GojoColors.borderSubtle,
    backgroundColor: 'rgba(0,0,0,0.35)',
    color: GojoColors.white,
    fontFamily: Mono,
    fontSize: 13,
  },
  fiatRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  currencyChip: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
  },
  currencyChipText: {
    fontFamily: Mono,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  railsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 6,
  },
  railChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
  },
  railChipText: {
    fontFamily: Mono,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  progressPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: GojoColors.borderActive,
    backgroundColor: 'rgba(139,92,246,0.08)',
  },
  progressText: {
    color: GojoColors.violetLight,
    fontFamily: Mono,
    fontSize: 11,
    flex: 1,
  },
  errorCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: GojoColors.borderError,
    backgroundColor: 'rgba(239,68,68,0.08)',
  },
  errorTextInline: {
    flex: 1,
    color: GojoColors.errorLight,
    fontFamily: Mono,
    fontSize: 11,
    lineHeight: 15,
  },
  receiptWrap: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: GojoColors.border,
    overflow: 'hidden',
    backgroundColor: GojoColors.bgCardFilled,
  },
  lifecycleWrap: {
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: GojoColors.border,
    backgroundColor: GojoColors.bgCardFilled,
  },
  activityWrap: {
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: GojoColors.borderSubtle,
    backgroundColor: 'rgba(255,255,255,0.02)',
  },
});

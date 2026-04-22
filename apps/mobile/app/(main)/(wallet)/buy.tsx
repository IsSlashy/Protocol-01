import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Platform,
  ActivityIndicator,
  Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { WebView } from 'react-native-webview';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';

import { useWalletStore } from '@/stores/walletStore';
import { useAutoShieldStore } from '@/stores/autoShieldStore';
import { Colors, FontFamily, BorderRadius, Spacing } from '@/constants/theme';
import { p01Alert } from '@/stores/alertStore';
import { isMainnet } from '@/services/solana/connection';
import {
  getCryptoPrices,
  P01_NETWORK_FEE_BPS,
} from '@/services/payments/p01-payments';
import {
  createMoonPayUrl,
  loadMoonPayConfigFromEnv,
  type MoonPayFiatCurrency,
} from '@/services/payments/moonpay';
import { splitAmount, type SplitResult } from '@/services/payments/denomination';
import {
  registerTreasuryRoute,
  getTreasuryRouteStatus,
  getTreasuryHealth,
  type TreasuryBufferRoute,
  type TreasuryBufferStatus,
  type TreasuryHealth,
  type TreasuryRouteStatus,
} from '@/services/payments/treasury-buffer-client';
import { GojoColors } from '@/components/mugen/SharedStyles';

// ─── Design Tokens ──────────────────────────────────────────────────────────

const P01 = {
  cyan: '#39c5bb',
  cyanDim: 'rgba(57, 197, 187, 0.15)',
  cyanBright: '#00ffe5',
  pink: '#ff77a8',
  pinkDim: 'rgba(255, 119, 168, 0.15)',
  green: '#22c55e',
  greenDim: 'rgba(34, 197, 94, 0.15)',
  purple: '#7c3aed',
  purpleDim: 'rgba(124, 58, 237, 0.15)',
};

// ─── SOL Denominations (fixed — maps to shielded pool tiers) ────────────────

const SOL_TIERS = [
  { sol: 0.1, lamports: '100000000', label: '0.1 SOL' },
  { sol: 1, lamports: '1000000000', label: '1 SOL' },
  { sol: 10, lamports: '10000000000', label: '10 SOL' },
];

// ─── Fiat rounding ladder ───────────────────────────────────────────────────

const FIAT_LADDER = [
  5, 10, 15, 20, 25, 30, 40, 50, 75, 100,
  150, 200, 250, 300, 400, 500, 750, 1000,
  1500, 2000, 2500, 3000, 4000, 5000, 7500, 10000,
];

function roundUpFiat(raw: number): number {
  for (const step of FIAT_LADDER) {
    if (step >= raw) return step;
  }
  return Math.ceil(raw / 1000) * 1000;
}

// ─── Payment Rails ──────────────────────────────────────────────────────────

type Rail = 'p01' | 'moonpay';

const RAILS = {
  p01: {
    name: 'P-01 Network',
    feePct: 0.5,
    delay: '1-2h',
    methods: 'IBAN \u00b7 Revolut \u00b7 Wise',
    kyc: 'Aucun KYC',
    privacy: '8 couches',
    icon: 'shield-checkmark' as const,
    color: P01.cyan,
    colorDim: P01.cyanDim,
    tag: 'RECOMMAND\u00c9',
    tagColor: P01.cyan,
  },
  moonpay: {
    name: 'MoonPay',
    feePct: 4.5,
    delay: '~5 min',
    methods: 'Carte \u00b7 Apple Pay \u00b7 Google Pay',
    kyc: 'KYC chez MoonPay',
    privacy: 'Auto-shield',
    icon: 'card' as const,
    color: P01.purple,
    colorDim: P01.purpleDim,
    tag: 'RAPIDE',
    tagColor: P01.purple,
  },
};

// ─── MoonPay config (driven by EXPO_PUBLIC_MOONPAY_* env vars) ──────────────

/**
 * Load MoonPay config lazily so a missing env var surfaces at the moment the
 * user taps Buy (with a readable error), rather than at module import time
 * (which would crash the whole Buy screen).
 */
function tryLoadMoonPayConfig(): ReturnType<typeof loadMoonPayConfigFromEnv> | null {
  try {
    return loadMoonPayConfigFromEnv();
  } catch (err) {
    console.warn('[Buy] MoonPay config not available:', (err as Error).message);
    return null;
  }
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function BuyScreen() {
  const router = useRouter();
  const { publicKey } = useWalletStore();
  const isOnMainnet = isMainnet();

  // State
  const [selectedTier, setSelectedTier] = useState(0); // index into SOL_TIERS
  const [selectedRail, setSelectedRail] = useState<Rail>('p01');
  const [solPrice, setSolPrice] = useState(0);
  const [priceLoading, setPriceLoading] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [paymentUrl, setPaymentUrl] = useState('');
  const [fiatCurrency] = useState<MoonPayFiatCurrency>('USD');

  // Treasury Buffer routing (MoonPay rail only). When set, MoonPay is pointed
  // at `bufferAddress` and the backend will forward to the stealth address
  // after a randomized delay. When null, we fell back to direct stealth payout.
  const [treasuryRoute, setTreasuryRoute] = useState<TreasuryBufferRoute | null>(null);
  const [treasuryStatus, setTreasuryStatus] = useState<TreasuryBufferStatus | null>(null);
  const [treasuryError, setTreasuryError] = useState<string | null>(null);
  const [treasuryFellBack, setTreasuryFellBack] = useState(false);
  // Pre-tap health snapshot — refreshed on mount + when MoonPay rail picked.
  const [treasuryHealth, setTreasuryHealth] = useState<TreasuryHealth | null>(null);

  // Derived values
  const tier = SOL_TIERS[selectedTier];
  const rail = RAILS[selectedRail];
  const fiatRaw = tier.sol * solPrice * (1 + rail.feePct / 100);
  const fiatRounded = solPrice > 0 ? roundUpFiat(Math.ceil(fiatRaw)) : 0;
  const feeAmount = fiatRounded > 0 ? (fiatRounded * rail.feePct / 100) : 0;
  const solAfterFee = tier.sol * (1 - P01_NETWORK_FEE_BPS / 10000);

  // ─── L1 denomination preview ─────────────────────────────────────
  // Compute what the incoming SOL will split into (pool tiers) +
  // untracked residual in fiat. Shown on the MoonPay rail preview.
  const splitPreview: SplitResult | null = React.useMemo(() => {
    if (solPrice <= 0 || fiatRounded <= 0) return null;
    try {
      return splitAmount({
        fiatAmount: fiatRounded,
        fiatCurrency,
        solPriceInFiat: solPrice,
      });
    } catch {
      return null;
    }
  }, [fiatRounded, fiatCurrency, solPrice]);

  // Network info (devnet allowed for testing, badge shown)
  const isDevnet = !isOnMainnet;

  // ── Treasury health probe (pre-tap) ───────────────────────────────
  // Fired on mount and again whenever the user switches to the MoonPay rail.
  // We swallow errors → treat as healthy:false so the UI can show the
  // "buffer offline" warning *before* the user commits.
  useEffect(() => {
    if (selectedRail !== 'moonpay') return;
    let cancelled = false;
    void (async () => {
      try {
        const h = await getTreasuryHealth();
        if (!cancelled) setTreasuryHealth(h);
      } catch (err) {
        if (!cancelled) {
          setTreasuryHealth({
            bufferAddress: '',
            bufferBalanceLamports: 0,
            minBalanceLamports: 0,
            healthy: false,
            reason: err instanceof Error ? err.message : String(err),
            lastTickAt: null,
            lastPayoutAt: null,
            queue: { pending: 0, funded: 0, paid: 0, failed: 0, expired: 0 },
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedRail]);

  // Fetch SOL price
  useEffect(() => {
    const fetch = async () => {
      try {
        const prices = await getCryptoPrices();
        if (prices.SOL) setSolPrice(prices.SOL);
      } catch { /* fallback */ }
      setPriceLoading(false);
    };
    fetch();
    const interval = setInterval(fetch, 30_000);
    return () => clearInterval(interval);
  }, []);

  // ── Treasury status polling ────────────────────────────────────────
  // Polls /api/treasury/status/:id every 10s while the WebView is open OR
  // the route is still in flight (pending/funded). Stops on terminal status.
  useEffect(() => {
    if (!treasuryRoute) return;
    const terminal = (s: TreasuryRouteStatus | undefined): boolean =>
      s === 'paid' || s === 'failed' || s === 'expired';
    if (terminal(treasuryStatus?.status)) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async (): Promise<void> => {
      try {
        const s = await getTreasuryRouteStatus(treasuryRoute.id);
        if (cancelled) return;
        setTreasuryStatus(s);
        if (terminal(s.status)) return;
      } catch (err) {
        if (cancelled) return;
        console.warn(
          '[Buy] Treasury status poll failed:',
          err instanceof Error ? err.message : String(err),
        );
      }
      if (!cancelled) {
        timer = setTimeout(() => {
          void tick();
        }, 10_000);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
    // Re-run when id or terminal-state flip happens.
  }, [treasuryRoute, treasuryStatus?.status]);

  const haptic = () => {
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  // ── Buy handler ───────────────────────────────────────────────────

  const handleBuy = async () => {
    if (!publicKey) {
      p01Alert('No Wallet', 'Please create or import a wallet first.');
      return;
    }

    haptic();
    setIsLoading(true);

    try {
      // Generate a one-time stealth address for delivery.
      // The main wallet is NEVER exposed to the payment provider.
      // The autonomousRunner will detect funds arriving here and
      // auto-shield into the denominated pool.
      const autoShield = useAutoShieldStore.getState();
      const receiveAddress = await autoShield.generateReceiveAddress();

      // Tag this address with purchase metadata
      const addresses = autoShield.addresses;
      const lastAddr = addresses[addresses.length - 1];
      if (lastAddr && lastAddr.address === receiveAddress) {
        lastAddr.source = selectedRail === 'moonpay' ? 'moonpay' : 'mugen';
        lastAddr.expectedLamports = Number(tier.lamports);
      }

      if (selectedRail === 'moonpay') {
        const moonPayConfig = tryLoadMoonPayConfig();
        if (!moonPayConfig) {
          p01Alert(
            'MoonPay Unavailable',
            'MoonPay API key is not configured. Set EXPO_PUBLIC_MOONPAY_API_KEY in your env.',
          );
          return;
        }

        // ── Treasury Buffer registration (privacy hop before stealth) ──
        // Reset stale state from any previous attempt.
        setTreasuryRoute(null);
        setTreasuryStatus(null);
        setTreasuryError(null);
        setTreasuryFellBack(false);

        // Expected lamports = tier SOL (we want the buffer to forward the
        // pool-tier amount; fee slippage is absorbed by the tolerance BPS
        // on the backend). Use tier.lamports directly — authoritative.
        const expectedLamports = Number(tier.lamports);

        let payoutAddress: string = receiveAddress;
        let route: TreasuryBufferRoute | null = null;
        try {
          route = await registerTreasuryRoute({
            fiatAmount: fiatRounded, // major units, backend expects this
            fiatCurrency: fiatCurrency === 'GBP' ? 'USD' : fiatCurrency,
            destStealthAddress: receiveAddress,
            expectedSolAmount: expectedLamports,
          });
          payoutAddress = route.bufferAddress;
          setTreasuryRoute(route);
          console.log(
            `[Buy] Treasury route armed id=${route.id.slice(0, 8)}... ` +
              `buffer=${route.bufferAddress.slice(0, 8)}... ` +
              `payoutAt=+${Math.max(0, route.scheduledPayoutAt - Date.now())}ms`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn('[Buy] Treasury buffer unavailable, falling back:', msg);
          setTreasuryFellBack(true);
          setTreasuryError(msg);
        }

        const { widgetUrl, sessionId, signed } = createMoonPayUrl(
          {
            fiatAmount: fiatRounded,
            fiatCurrency,
            cryptoCurrency: 'sol',
            // Point MoonPay at the buffer when available; the backend forwards
            // to the stealth address after a randomized delay. Fall back to
            // direct stealth payout only if the registration failed.
            stealthAddress: payoutAddress,
            externalTransactionId: receiveAddress, // correlates webhook → auto-shield addr
          },
          moonPayConfig,
        );
        console.log(
          `[Buy] MoonPay ${moonPayConfig.mode} session=${sessionId} signed=${signed} ` +
            `payoutTo=${payoutAddress.slice(0, 8)}... ` +
            `(${route ? 'buffer' : 'direct-stealth'}) ` +
            `stealth=${receiveAddress.slice(0, 8)}... expected=${tier.sol} SOL`,
        );
        if (splitPreview) {
          console.log(
            `[Buy] L1 preview: ${splitPreview.splits
              .map((s) => `${s.count}x${s.denomination}`)
              .join(' + ')} + residual ${splitPreview.residualFiat.toFixed(2)} ${fiatCurrency}`,
          );
        }
        setPaymentUrl(widgetUrl);
        setShowPaymentModal(true);
      } else {
        // P-01 Network (Mugen P2P) — hand off to buy-p2p screen.
        // The P2P flow is FROST 2/3 + Arcium MPC encrypted; it owns its own
        // taker-nonce + receipt + lifecycle UI, so we simply prefill the
        // form with the tier amount the user already chose here.
        router.push({
          pathname: '/(main)/(wallet)/buy-p2p',
          params: {
            desiredSol: String(tier.sol),
            maxFiat: String(fiatRounded),
            fiatCurrency,
            stealth: receiveAddress,
          },
        });
      }
    } catch (error) {
      console.error('Payment error:', error);
      p01Alert('Error', 'Failed to initiate payment. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleWebViewNav = (navState: any) => {
    if (navState.url?.includes('success') || navState.url?.includes('complete')) {
      setShowPaymentModal(false);
      const msg = selectedRail === 'p01'
        ? `Your ${tier.label} purchase is being processed.\n\nYour SOL will arrive at a one-time stealth address, pass through the mixer, and auto-shield into your privacy pool.\n\nEstimated: 1-2 hours. You'll be notified.`
        : `Your ${tier.label} purchase via MoonPay is processing.\n\nOnce received, your SOL will be automatically shielded into the privacy pool.\n\nEstimated: ~5 minutes. You'll be notified.`;
      p01Alert('Purchase Initiated', msg);
    }
  };

  // ── Render ────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <Animated.View entering={FadeInDown.delay(100)} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color={Colors.text} />
        </TouchableOpacity>
        <View style={{ alignItems: 'center' }}>
          <Text style={styles.headerTitle}>Buy Crypto</Text>
          {isDevnet && (
            <View style={{ backgroundColor: 'rgba(251,146,60,0.2)', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4, marginTop: 2 }}>
              <Text style={{ fontSize: 9, fontFamily: FontFamily.mono, color: '#fb923c' }}>DEVNET</Text>
            </View>
          )}
        </View>
        <View style={{ width: 40 }} />
      </Animated.View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* ── SOL Denomination Selector ── */}
        <Animated.View entering={FadeInUp.delay(150)}>
          <Text style={styles.sectionLabel}>SELECT AMOUNT</Text>
          <View style={styles.tierRow}>
            {SOL_TIERS.map((t, i) => {
              const active = i === selectedTier;
              const fiat = solPrice > 0 ? roundUpFiat(Math.ceil(t.sol * solPrice * 1.005)) : 0;
              return (
                <TouchableOpacity
                  key={i}
                  onPress={() => { setSelectedTier(i); haptic(); }}
                  style={[styles.tierCard, active && styles.tierCardActive]}
                >
                  <LinearGradient
                    colors={active ? ['rgba(57,197,187,0.15)', 'rgba(57,197,187,0.05)'] : ['transparent', 'transparent']}
                    style={styles.tierGradient}
                  >
                    <Text style={[styles.tierSol, active && styles.tierSolActive]}>
                      {t.label}
                    </Text>
                    <Text style={styles.tierFiat}>
                      {priceLoading ? '...' : `$${fiat}`}
                    </Text>
                    <Text style={styles.tierPool}>Pool tier</Text>
                  </LinearGradient>
                </TouchableOpacity>
              );
            })}
          </View>
        </Animated.View>

        {/* ── Payment Rail Selector ── */}
        <Animated.View entering={FadeInUp.delay(250)}>
          <Text style={[styles.sectionLabel, { marginTop: Spacing['2xl'] }]}>PAYMENT METHOD</Text>

          {(['p01', 'moonpay'] as Rail[]).map((railId) => {
            const r = RAILS[railId];
            const active = railId === selectedRail;
            const fiat = railId === 'p01'
              ? (solPrice > 0 ? roundUpFiat(Math.ceil(tier.sol * solPrice * 1.005)) : 0)
              : (solPrice > 0 ? roundUpFiat(Math.ceil(tier.sol * solPrice * 1.045)) : 0);

            return (
              <TouchableOpacity
                key={railId}
                onPress={() => { setSelectedRail(railId); haptic(); }}
                style={[styles.railCard, active && { borderColor: r.color }]}
              >
                <View style={styles.railHeader}>
                  <View style={[styles.railIcon, { backgroundColor: r.colorDim }]}>
                    <Ionicons name={r.icon} size={22} color={r.color} />
                  </View>
                  <View style={styles.railInfo}>
                    <View style={styles.railNameRow}>
                      <Text style={styles.railName}>{r.name}</Text>
                      <View style={[styles.railTag, { backgroundColor: r.colorDim }]}>
                        <Text style={[styles.railTagText, { color: r.color }]}>{r.tag}</Text>
                      </View>
                    </View>
                    <Text style={styles.railMethods}>{r.methods}</Text>
                  </View>
                  <View style={[styles.radioOuter, active && { borderColor: r.color }]}>
                    {active && <View style={[styles.radioInner, { backgroundColor: r.color }]} />}
                  </View>
                </View>

                <View style={styles.railDetails}>
                  <View style={styles.railDetail}>
                    <Text style={styles.railDetailLabel}>Fee</Text>
                    <Text style={[styles.railDetailValue, railId === 'p01' && { color: P01.green }]}>
                      {r.feePct}%
                    </Text>
                  </View>
                  <View style={styles.railDetailDivider} />
                  <View style={styles.railDetail}>
                    <Text style={styles.railDetailLabel}>Delay</Text>
                    <Text style={styles.railDetailValue}>{r.delay}</Text>
                  </View>
                  <View style={styles.railDetailDivider} />
                  <View style={styles.railDetail}>
                    <Text style={styles.railDetailLabel}>KYC</Text>
                    <Text style={[styles.railDetailValue, railId === 'p01' && { color: P01.green }]}>
                      {r.kyc}
                    </Text>
                  </View>
                  <View style={styles.railDetailDivider} />
                  <View style={styles.railDetail}>
                    <Text style={styles.railDetailLabel}>Privacy</Text>
                    <Text style={[styles.railDetailValue, { color: P01.cyan }]}>{r.privacy}</Text>
                  </View>
                </View>

                {active && (
                  <View style={styles.railSummary}>
                    <Text style={styles.railSummaryText}>
                      You pay <Text style={styles.railSummaryBold}>${fiat}</Text>
                      {' \u2192 '}receive <Text style={[styles.railSummaryBold, { color: P01.cyan }]}>{tier.label}</Text>
                    </Text>
                    {railId === 'moonpay' && splitPreview && splitPreview.splits.length > 0 && (
                      <View style={styles.splitPreview}>
                        <Text style={styles.splitPreviewLabel}>L1 AUTO-SHIELD PREVIEW</Text>
                        <Text style={styles.splitPreviewBody}>
                          {splitPreview.splits
                            .map((s) => `${s.count} \u00d7 ${s.denomination} SOL`)
                            .join('  +  ')}
                        </Text>
                        {splitPreview.residualFiat > 0.005 && (
                          <Text style={styles.splitPreviewResidual}>
                            + residual {splitPreview.residualFiat.toFixed(2)} {fiatCurrency} (tracked)
                          </Text>
                        )}
                        {splitPreview.privacyWarning && (
                          <Text style={styles.splitPreviewWarning}>
                            {splitPreview.privacyWarning}
                          </Text>
                        )}
                      </View>
                    )}
                  </View>
                )}
              </TouchableOpacity>
            );
          })}
        </Animated.View>

        {/* ── Pre-tap buffer health warning (MoonPay rail only) ── */}
        {selectedRail === 'moonpay' &&
          treasuryHealth &&
          !treasuryHealth.healthy &&
          !treasuryRoute && (
          <Animated.View
            entering={FadeInUp.delay(280)}
            style={[
              styles.treasuryCard,
              { borderColor: GojoColors.borderError, backgroundColor: 'rgba(239,68,68,0.06)' },
            ]}
          >
            <View style={styles.treasuryHeader}>
              <View style={[styles.treasuryIcon, { backgroundColor: 'rgba(239,68,68,0.18)' }]}>
                <Ionicons name="warning" size={18} color={GojoColors.errorLight} />
              </View>
              <Text style={[styles.treasuryTitle, { color: GojoColors.errorLight }]}>
                Buffer Offline {'\u2014'} Direct Stealth Payout
              </Text>
            </View>
            <Text style={styles.treasuryStatus}>
              {treasuryHealth.reason ?? 'Buffer wallet not ready.'}
              {' '}MoonPay will deliver SOL directly to your stealth address; the timing-decorrelation hop is skipped this time.
            </Text>
          </Animated.View>
        )}

        {/* ── Treasury Buffer status (MoonPay rail only) ── */}
        {selectedRail === 'moonpay' && (treasuryRoute || treasuryFellBack) && (
          <Animated.View entering={FadeInUp.delay(300)} style={styles.treasuryCard}>
            <View style={styles.treasuryHeader}>
              <View style={[styles.treasuryIcon, { backgroundColor: 'rgba(139,92,246,0.18)' }]}>
                <Ionicons
                  name={treasuryFellBack ? 'alert-circle' : 'git-branch-outline'}
                  size={18}
                  color={treasuryFellBack ? GojoColors.warning : GojoColors.violet}
                />
              </View>
              <Text style={styles.treasuryTitle}>
                {treasuryFellBack ? 'Direct Stealth Payout (Buffer Unavailable)' : 'Privacy Path'}
              </Text>
            </View>

            {/* Path diagram */}
            {!treasuryFellBack && (
              <View style={styles.pathRow}>
                <View style={styles.pathNode}>
                  <Text style={styles.pathNodeText}>MoonPay</Text>
                  <Text style={styles.pathNodeSub}>KYC</Text>
                </View>
                <Text style={styles.pathArrow}>{'\u2192'}</Text>
                <View style={[styles.pathNode, styles.pathNodeActive]}>
                  <Text style={[styles.pathNodeText, { color: GojoColors.violetLight }]}>Buffer</Text>
                  <Text style={styles.pathNodeSub}>L2</Text>
                </View>
                <Text style={styles.pathArrow}>{'\u2192'}</Text>
                <View style={styles.pathNode}>
                  <Text style={styles.pathNodeText}>Stealth</Text>
                  <Text style={styles.pathNodeSub}>ML-KEM-768</Text>
                </View>
                <Text style={styles.pathArrow}>{'\u2192'}</Text>
                <View style={styles.pathNode}>
                  <Text style={styles.pathNodeText}>Wallet</Text>
                  <Text style={styles.pathNodeSub}>L11</Text>
                </View>
              </View>
            )}

            {/* Status line */}
            {(() => {
              if (treasuryFellBack) {
                return (
                  <Text style={styles.treasuryStatus}>
                    {treasuryError ?? 'Treasury buffer offline'}. MoonPay will send SOL directly to the freshly-generated stealth address.
                  </Text>
                );
              }
              if (!treasuryRoute) return null;
              const secs = Math.max(
                0,
                Math.round((treasuryRoute.scheduledPayoutAt - Date.now()) / 1000),
              );
              const s = treasuryStatus?.status ?? 'pending';
              if (s === 'pending') {
                return (
                  <Text style={styles.treasuryStatus}>
                    Waiting for MoonPay payment {'\u00b7'} buffer forwarding scheduled in ~{secs}s after funding.
                  </Text>
                );
              }
              if (s === 'funded') {
                const cohort = treasuryStatus?.cohort;
                if (cohort && !cohort.cohortReady && cohort.cohortWaitMsRemaining > 0) {
                  const cohortSecs = Math.ceil(cohort.cohortWaitMsRemaining / 1000);
                  return (
                    <Text style={[styles.treasuryStatus, { color: GojoColors.violetLight }]}>
                      Funded {'\u00b7'} waiting for cohort ({cohort.cohortCandidatesCount}/{cohort.minCohortSize}) {'\u00b7'} max wait {cohortSecs}s
                    </Text>
                  );
                }
                return (
                  <Text style={[styles.treasuryStatus, { color: GojoColors.blueLight }]}>
                    Payment received by buffer {'\u00b7'} forwarding to stealth in ~{secs}s...
                  </Text>
                );
              }
              if (s === 'paid') {
                return (
                  <View>
                    <Text style={[styles.treasuryStatus, { color: GojoColors.successLight }]}>
                      {'\u2713'} SOL arrived at your stealth address.
                    </Text>
                    {treasuryStatus?.payoutTx && (
                      <Text style={styles.treasuryStatusMono} numberOfLines={1}>
                        payout: {treasuryStatus.payoutTx.slice(0, 16)}...{treasuryStatus.payoutTx.slice(-6)}
                      </Text>
                    )}
                  </View>
                );
              }
              if (s === 'failed') {
                return (
                  <Text style={[styles.treasuryStatus, { color: GojoColors.errorLight }]}>
                    Forwarding failed: {treasuryStatus?.failureReason ?? 'unknown error'}
                  </Text>
                );
              }
              if (s === 'expired') {
                return (
                  <Text style={[styles.treasuryStatus, { color: GojoColors.warningLight }]}>
                    Route expired before funding. If you paid, contact support with id {treasuryRoute.id.slice(0, 8)}.
                  </Text>
                );
              }
              return null;
            })()}

            {/* Route id + honesty note */}
            {treasuryRoute && (
              <View style={styles.treasuryFooter}>
                <Text style={styles.treasuryIdLabel}>ROUTE</Text>
                <Text style={styles.treasuryIdValue} numberOfLines={1}>
                  {treasuryRoute.id}
                </Text>
              </View>
            )}
            {treasuryRoute && treasuryStatus?.status === 'funded' && (
              <Text style={styles.treasuryHonesty}>
                If this takes more than 5 min, the treasury wallet may be unfunded {'\u2014'} contact support.
              </Text>
            )}
          </Animated.View>
        )}

        {/* ── Privacy Info ── */}
        <Animated.View entering={FadeInUp.delay(350)}>
          <LinearGradient
            colors={['rgba(57,197,187,0.08)', 'rgba(57,197,187,0.02)']}
            style={styles.privacyCard}
          >
            <Ionicons name="shield-checkmark" size={18} color={P01.cyan} />
            <Text style={styles.privacyText}>
              {selectedRail === 'p01'
                ? 'Your purchase is anonymized through 8 privacy layers: denominated amounts, noise engine, multi-hop mixer, and ZK shielded pool. No trace.'
                : 'After MoonPay delivers your SOL, it is automatically shielded into the privacy pool. KYC stays at MoonPay, not on P-01.'
              }
            </Text>
          </LinearGradient>
        </Animated.View>

        <View style={{ height: 120 }} />
      </ScrollView>

      {/* ── Buy Button (sticky) ── */}
      <Animated.View entering={FadeInUp.delay(400)} style={styles.buyContainer}>
        <TouchableOpacity
          onPress={handleBuy}
          disabled={isLoading || priceLoading || solPrice === 0}
          style={styles.buyButton}
        >
          <LinearGradient
            colors={isLoading ? ['#333', '#333'] : [P01.cyan, '#2ba8a0']}
            style={styles.buyGradient}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
          >
            {isLoading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <>
                <Ionicons name={rail.icon} size={20} color="#000" style={{ marginRight: 8 }} />
                <Text style={styles.buyText}>
                  Buy {tier.label} for ${fiatRounded}
                </Text>
              </>
            )}
          </LinearGradient>
        </TouchableOpacity>
        <Text style={styles.buySubtext}>
          via {rail.name} \u00b7 {rail.feePct}% fee \u00b7 {rail.delay}
        </Text>
      </Animated.View>

      {/* ── Payment WebView Modal ── */}
      <Modal
        visible={showPaymentModal}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setShowPaymentModal(false)}
      >
        <SafeAreaView style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={() => setShowPaymentModal(false)}>
              <Ionicons name="close" size={28} color={Colors.text} />
            </TouchableOpacity>
            <Text style={styles.modalTitle}>{rail.name} Payment</Text>
            <View style={{ width: 28 }} />
          </View>
          {paymentUrl ? (
            <WebView
              source={{ uri: paymentUrl }}
              style={{ flex: 1 }}
              onNavigationStateChange={handleWebViewNav}
              startInLoadingState
              renderLoading={() => (
                <View style={styles.webViewLoading}>
                  <ActivityIndicator size="large" color={P01.cyan} />
                </View>
              )}
            />
          ) : null}
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
  },
  backBtn: { width: 40, height: 40, justifyContent: 'center' },
  headerTitle: { fontSize: 18, fontFamily: FontFamily.semibold, color: Colors.text },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: Spacing.lg },

  // Section
  sectionLabel: {
    fontSize: 11,
    fontFamily: FontFamily.mono,
    color: Colors.textTertiary,
    letterSpacing: 1.5,
    marginBottom: Spacing.sm,
    marginTop: Spacing.lg,
  },

  // SOL tier selector
  tierRow: { flexDirection: 'row', gap: Spacing.sm },
  tierCard: {
    flex: 1,
    borderRadius: BorderRadius.lg,
    borderWidth: 1.5,
    borderColor: Colors.border,
    overflow: 'hidden',
  },
  tierCardActive: { borderColor: P01.cyan },
  tierGradient: {
    paddingVertical: Spacing.lg,
    alignItems: 'center',
    gap: 4,
  },
  tierSol: {
    fontSize: 20,
    fontFamily: FontFamily.bold,
    color: Colors.textSecondary,
  },
  tierSolActive: { color: P01.cyan },
  tierFiat: {
    fontSize: 14,
    fontFamily: FontFamily.mono,
    color: Colors.text,
  },
  tierPool: {
    fontSize: 10,
    fontFamily: FontFamily.mono,
    color: Colors.textTertiary,
    marginTop: 2,
  },

  // Rail selector
  railCard: {
    borderRadius: BorderRadius.lg,
    borderWidth: 1.5,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    marginBottom: Spacing.md,
    overflow: 'hidden',
  },
  railHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.lg,
    gap: Spacing.md,
  },
  railIcon: {
    width: 44,
    height: 44,
    borderRadius: BorderRadius.md,
    justifyContent: 'center',
    alignItems: 'center',
  },
  railInfo: { flex: 1 },
  railNameRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  railName: { fontSize: 16, fontFamily: FontFamily.semibold, color: Colors.text },
  railTag: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
    borderRadius: BorderRadius.sm,
  },
  railTagText: { fontSize: 9, fontFamily: FontFamily.mono, letterSpacing: 1 },
  railMethods: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  radioOuter: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: Colors.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  radioInner: { width: 12, height: 12, borderRadius: 6 },

  // Rail details
  railDetails: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    paddingVertical: Spacing.md,
    marginHorizontal: Spacing.lg,
  },
  railDetail: { flex: 1, alignItems: 'center' },
  railDetailDivider: { width: 1, backgroundColor: Colors.border },
  railDetailLabel: {
    fontSize: 9,
    fontFamily: FontFamily.mono,
    color: Colors.textTertiary,
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  railDetailValue: {
    fontSize: 12,
    fontFamily: FontFamily.semibold,
    color: Colors.text,
  },

  // Rail summary
  railSummary: {
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.lg,
  },
  railSummaryText: {
    fontSize: 13,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
  railSummaryBold: { fontFamily: FontFamily.semibold, color: Colors.text },

  // L1 split preview (MoonPay rail)
  splitPreview: {
    marginTop: Spacing.md,
    paddingTop: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
  splitPreviewLabel: {
    fontSize: 9,
    fontFamily: FontFamily.mono,
    color: Colors.textTertiary,
    letterSpacing: 1.5,
    marginBottom: 6,
  },
  splitPreviewBody: {
    fontSize: 13,
    fontFamily: FontFamily.mono,
    color: P01.cyan,
    lineHeight: 20,
  },
  splitPreviewResidual: {
    marginTop: 4,
    fontSize: 11,
    fontFamily: FontFamily.mono,
    color: Colors.textSecondary,
  },
  splitPreviewWarning: {
    marginTop: 4,
    fontSize: 10,
    fontFamily: FontFamily.regular,
    color: '#fb923c',
    lineHeight: 14,
  },

  // Treasury buffer card (Gojo theme)
  treasuryCard: {
    marginTop: Spacing['2xl'],
    padding: Spacing.lg,
    borderRadius: BorderRadius.md,
    backgroundColor: GojoColors.bgCardFilled,
    borderWidth: 1,
    borderColor: GojoColors.border,
  },
  treasuryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginBottom: Spacing.md,
  },
  treasuryIcon: {
    width: 32,
    height: 32,
    borderRadius: BorderRadius.sm,
    justifyContent: 'center',
    alignItems: 'center',
  },
  treasuryTitle: {
    fontSize: 13,
    fontFamily: FontFamily.semibold,
    color: GojoColors.white,
    letterSpacing: 0.3,
  },
  pathRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.md,
  },
  pathNode: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderRadius: BorderRadius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: GojoColors.borderSubtle,
    backgroundColor: 'rgba(255,255,255,0.02)',
  },
  pathNodeActive: {
    borderColor: GojoColors.borderActive,
    backgroundColor: 'rgba(139,92,246,0.08)',
  },
  pathNodeText: {
    fontSize: 10,
    fontFamily: FontFamily.semibold,
    color: GojoColors.text,
  },
  pathNodeSub: {
    fontSize: 8,
    fontFamily: FontFamily.mono,
    color: GojoColors.muted,
    marginTop: 1,
    letterSpacing: 0.5,
  },
  pathArrow: {
    fontSize: 11,
    color: GojoColors.subtle,
    marginHorizontal: 2,
  },
  treasuryStatus: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: GojoColors.text,
    lineHeight: 18,
  },
  treasuryStatusMono: {
    marginTop: 2,
    fontSize: 10,
    fontFamily: FontFamily.mono,
    color: GojoColors.mutedLight,
  },
  treasuryFooter: {
    marginTop: Spacing.sm,
    paddingTop: Spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: GojoColors.borderSubtle,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  treasuryIdLabel: {
    fontSize: 9,
    fontFamily: FontFamily.mono,
    color: GojoColors.muted,
    letterSpacing: 1,
  },
  treasuryIdValue: {
    flex: 1,
    fontSize: 10,
    fontFamily: FontFamily.mono,
    color: GojoColors.mutedLight,
  },
  treasuryHonesty: {
    marginTop: 6,
    fontSize: 10,
    fontFamily: FontFamily.regular,
    color: GojoColors.warningLight,
    lineHeight: 14,
  },

  // Privacy card
  privacyCard: {
    flexDirection: 'row',
    borderRadius: BorderRadius.md,
    padding: Spacing.lg,
    marginTop: Spacing['2xl'],
    gap: Spacing.md,
    borderWidth: 1,
    borderColor: 'rgba(57,197,187,0.2)',
  },
  privacyText: {
    flex: 1,
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    lineHeight: 18,
  },

  // Buy button
  buyContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: Spacing.lg,
    paddingBottom: Platform.OS === 'ios' ? 34 : Spacing.lg,
    paddingTop: Spacing.md,
    backgroundColor: Colors.background,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  buyButton: { borderRadius: BorderRadius.lg, overflow: 'hidden' },
  buyGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
  },
  buyText: {
    fontSize: 16,
    fontFamily: FontFamily.bold,
    color: '#000',
  },
  buySubtext: {
    fontSize: 11,
    fontFamily: FontFamily.mono,
    color: Colors.textTertiary,
    textAlign: 'center',
    marginTop: 6,
  },

  // Modal
  modalContainer: { flex: 1, backgroundColor: Colors.background },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  modalTitle: { fontSize: 16, fontFamily: FontFamily.semibold, color: Colors.text },
  webViewLoading: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: Colors.background,
  },
});

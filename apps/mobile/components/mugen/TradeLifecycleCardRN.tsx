// ═══════════════════════════════════════════════════════════════════════════
// TradeLifecycleCardRN — React Native port of TradeLifecycleCard.
// Polls escrow status every 4 s; renders a 3-step vertical state machine:
//   Escrow locked → Fiat sent → Crypto released
// plus a dispute escape hatch. Network layer is injected via props so this
// component stays pure and testable (no hardcoded fetch/API paths).
// ═══════════════════════════════════════════════════════════════════════════

import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import CopyLink from './CopyLink';
import { GojoColors, Mono } from './SharedStyles';
import type {
  ConfirmPaymentResponse,
  DisputeResponse,
  EscrowStatusLabel,
  EscrowStatusResponse,
  ReleaseEscrowResponse,
} from '../../services/mugen-encrypted/types';

const POLL_INTERVAL_MS = 4_000;
const TERMINAL: EscrowStatusLabel[] = ['released', 'expired', 'resolved'];

export interface TradeLifecycleCardRNProps {
  escrowPDA: string;
  orderPDA: string;
  vaultPDA: string;
  initialTxSignature: string;
  /** Network layer injected by parent. */
  getEscrowStatus: (escrowPDA: string) => Promise<EscrowStatusResponse>;
  confirmPayment: (args: {
    escrowPDA: string;
    as: 'taker' | 'maker';
  }) => Promise<ConfirmPaymentResponse>;
  releaseEscrow: (args: { escrowPDA: string }) => Promise<ReleaseEscrowResponse>;
  dispute: (args: {
    escrowPDA: string;
    as: 'taker' | 'maker';
    reason: number;
  }) => Promise<DisputeResponse>;
}

// ─── Formatters ─────────────────────────────────────────────────────────────

function formatLamports(raw: string): string {
  try {
    const lamports = BigInt(raw);
    const whole = lamports / 1_000_000_000n;
    const frac = lamports % 1_000_000_000n;
    const fracStr = frac.toString().padStart(9, '0').replace(/0+$/, '') || '0';
    return `${whole.toString()}.${fracStr}`;
  } catch {
    return raw;
  }
}

function formatFiatCents(raw: string): string {
  try {
    const cents = BigInt(raw);
    const whole = cents / 100n;
    const frac = (cents % 100n).toString().padStart(2, '0');
    return `${whole.toString()}.${frac}`;
  } catch {
    return raw;
  }
}

function formatCountdown(expiresAt: number, nowSec: number): string {
  if (expiresAt === 0) return '—';
  const diff = expiresAt - nowSec;
  if (diff <= 0) return 'expired';
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  const s = diff % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ─── Step card ──────────────────────────────────────────────────────────────

type StepState = 'idle' | 'active' | 'done' | 'skipped';
type IconName = keyof typeof MaterialIcons.glyphMap;

interface StepCardProps {
  step: number;
  accent: string;
  icon: IconName;
  title: string;
  state: StepState;
  children?: React.ReactNode;
}

function StepCard({
  step,
  accent,
  icon,
  title,
  state,
  children,
}: StepCardProps): React.ReactElement {
  const borderColor =
    state === 'done'
      ? GojoColors.borderSuccess
      : state === 'active'
        ? `${accent}70`
        : state === 'skipped'
          ? 'rgba(255,255,255,0.08)'
          : GojoColors.borderSubtle;
  const bg =
    state === 'done'
      ? 'rgba(34,197,94,0.08)'
      : state === 'active'
        ? `${accent}10`
        : 'rgba(255,255,255,0.02)';
  const titleColor =
    state === 'done'
      ? GojoColors.successLight
      : state === 'active'
        ? GojoColors.white
        : GojoColors.mutedLight;

  return (
    <View style={[styles.step, { borderColor, backgroundColor: bg }]}>
      <View style={styles.stepHeader}>
        <View
          style={[
            styles.stepNum,
            {
              backgroundColor:
                state === 'done' ? 'rgba(34,197,94,0.2)' : `${accent}22`,
            },
          ]}
        >
          {state === 'done' ? (
            <MaterialIcons name="check-circle" size={13} color={GojoColors.successLight} />
          ) : (
            <Text style={[styles.stepNumText, { color: accent }]}>{step}</Text>
          )}
        </View>
        <MaterialIcons
          name={icon}
          size={14}
          color={state === 'done' ? GojoColors.successLight : accent}
        />
        <Text style={[styles.stepTitle, { color: titleColor }]}>{title}</Text>
      </View>
      <View style={styles.stepBody}>{children}</View>
    </View>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

export default function TradeLifecycleCardRN({
  escrowPDA,
  orderPDA,
  vaultPDA,
  initialTxSignature,
  getEscrowStatus,
  confirmPayment,
  releaseEscrow,
  dispute,
}: TradeLifecycleCardRNProps): React.ReactElement {
  const [escrow, setEscrow] = useState<EscrowStatusResponse | null>(null);
  const [pollErr, setPollErr] = useState<string | null>(null);
  const [nowSec, setNowSec] = useState<number>(() => Math.floor(Date.now() / 1000));

  const [confirming, setConfirming] = useState(false);
  const [confirmErr, setConfirmErr] = useState<string | null>(null);
  const [confirmTx, setConfirmTx] = useState<string | null>(null);

  const [releasing, setReleasing] = useState(false);
  const [releaseErr, setReleaseErr] = useState<string | null>(null);
  const [releaseResult, setReleaseResult] = useState<ReleaseEscrowResponse | null>(
    null,
  );

  const [disputeOpen, setDisputeOpen] = useState(false);
  const [disputeReason, setDisputeReason] = useState<string>('1');
  const [disputeSide] = useState<'taker' | 'maker'>('taker');
  const [disputing, setDisputing] = useState(false);
  const [disputeErr, setDisputeErr] = useState<string | null>(null);
  const [disputeTx, setDisputeTx] = useState<string | null>(null);

  const pollingRef = useRef<boolean>(true);
  const mountedRef = useRef<boolean>(true);

  // ─── Polling ──────────────────────────────────────────────────────────────
  const fetchStatus = useCallback(async () => {
    if (!pollingRef.current) return;
    try {
      const json = await getEscrowStatus(escrowPDA);
      if (!mountedRef.current) return;
      setEscrow(json);
      setPollErr(null);
      if (TERMINAL.includes(json.status)) {
        pollingRef.current = false;
      }
    } catch (err) {
      if (!mountedRef.current) return;
      setPollErr(err instanceof Error ? err.message : 'network error');
    }
  }, [escrowPDA, getEscrowStatus]);

  useEffect(() => {
    mountedRef.current = true;
    pollingRef.current = true;
    void fetchStatus();
    const pollId = setInterval(() => {
      if (!pollingRef.current) {
        clearInterval(pollId);
        return;
      }
      void fetchStatus();
    }, POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      pollingRef.current = false;
      clearInterval(pollId);
    };
  }, [fetchStatus]);

  // Countdown tick (1 s)
  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  // ─── Actions ──────────────────────────────────────────────────────────────
  const onConfirmFiat = useCallback(async () => {
    setConfirming(true);
    setConfirmErr(null);
    try {
      const res = await confirmPayment({ escrowPDA, as: 'taker' });
      setConfirmTx(res.txSignature);
      pollingRef.current = true;
      void fetchStatus();
    } catch (err) {
      setConfirmErr(err instanceof Error ? err.message : 'Network error');
    } finally {
      setConfirming(false);
    }
  }, [escrowPDA, confirmPayment, fetchStatus]);

  const onReleaseCrypto = useCallback(async () => {
    setReleasing(true);
    setReleaseErr(null);
    try {
      const res = await releaseEscrow({ escrowPDA });
      setReleaseResult(res);
      pollingRef.current = true;
      void fetchStatus();
    } catch (err) {
      setReleaseErr(err instanceof Error ? err.message : 'Network error');
    } finally {
      setReleasing(false);
    }
  }, [escrowPDA, releaseEscrow, fetchStatus]);

  const onSubmitDispute = useCallback(async () => {
    const parsed = Number.parseInt(disputeReason, 10);
    const reason = Number.isFinite(parsed) ? Math.max(1, Math.min(10, parsed)) : 1;
    setDisputing(true);
    setDisputeErr(null);
    try {
      const res = await dispute({ escrowPDA, as: disputeSide, reason });
      setDisputeTx(res.txSignature);
      setDisputeOpen(false);
      pollingRef.current = true;
      void fetchStatus();
    } catch (err) {
      setDisputeErr(err instanceof Error ? err.message : 'Network error');
    } finally {
      setDisputing(false);
    }
  }, [escrowPDA, disputeSide, disputeReason, dispute, fetchStatus]);

  // ─── Derived flags ────────────────────────────────────────────────────────
  const status: EscrowStatusLabel = escrow?.status ?? 'unknown';
  const loading = !escrow && !pollErr;
  const confirmDone =
    status === 'payment_confirmed' || status === 'released' || status === 'resolved';
  const confirmActive = status === 'awaiting_payment';
  const releaseDone = status === 'released' || status === 'resolved';
  const releaseActive = status === 'payment_confirmed';
  const isDisputed = status === 'disputed';
  const isExpired = status === 'expired';

  // ─── Badge color ──────────────────────────────────────────────────────────
  const badgeColors = releaseDone
    ? { bg: 'rgba(34,197,94,0.1)', bd: GojoColors.borderSuccess, tx: GojoColors.successLight }
    : isDisputed
      ? { bg: 'rgba(239,68,68,0.1)', bd: GojoColors.borderError, tx: GojoColors.errorLight }
      : isExpired
        ? { bg: 'rgba(245,158,11,0.1)', bd: GojoColors.borderWarning, tx: GojoColors.warningLight }
        : { bg: 'rgba(196,181,253,0.08)', bd: GojoColors.border, tx: GojoColors.violetLight };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.headerRow}>
        <MaterialIcons name="schedule" size={14} color={GojoColors.violetLight} />
        <Text style={styles.headerText}>TRADE LIFECYCLE</Text>
        <View
          style={[
            styles.statusBadge,
            { borderColor: badgeColors.bd, backgroundColor: badgeColors.bg },
          ]}
        >
          <Text style={[styles.statusBadgeText, { color: badgeColors.tx }]}>
            {loading ? 'loading…' : status.replace('_', ' ')}
          </Text>
        </View>
      </View>

      {pollErr ? (
        <View style={styles.errorCallout}>
          <Text style={styles.errorCalloutText}>poll error: {pollErr}</Text>
        </View>
      ) : null}

      {isDisputed ? (
        <View style={styles.disputedCallout}>
          <MaterialIcons name="warning" size={14} color={GojoColors.errorLight} />
          <Text style={styles.disputedText}>
            Dispute opened (reason code {escrow?.disputeReason ?? '?'}). Awaiting
            arbiter.
          </Text>
        </View>
      ) : null}

      {/* STEP 1 — Escrow locked */}
      <StepCard
        step={1}
        accent={GojoColors.violetLight}
        icon="lock"
        title="Escrow locked"
        state="done"
      >
        <KvRow label="crypto" value={escrow ? `${formatLamports(escrow.cryptoAmount)} SOL` : '…'} valueColor={GojoColors.successLight} />
        <KvRow label="fiat due" value={escrow ? formatFiatCents(escrow.fiatAmount) : '…'} valueColor={GojoColors.warningLight} />
        <KvRow
          label="expires"
          value={escrow ? formatCountdown(escrow.expiresAt, nowSec) : '—'}
          valueColor={
            isExpired || (escrow && nowSec >= escrow.expiresAt)
              ? GojoColors.errorLight
              : GojoColors.violetLight
          }
        />
        <View style={styles.kvRow}>
          <Text style={styles.kvLabel}>vault:</Text>
          <CopyLink value={vaultPDA} type="address" label="vault PDA" />
        </View>
        <View style={styles.kvRow}>
          <Text style={styles.kvLabel}>init tx:</Text>
          <CopyLink value={initialTxSignature} type="tx" label="initial escrow tx" />
        </View>
        <View style={styles.kvRow}>
          <Text style={styles.kvLabel}>order:</Text>
          <CopyLink value={orderPDA} type="address" label="order PDA" />
        </View>
      </StepCard>

      {/* STEP 2 — Fiat sent */}
      <StepCard
        step={2}
        accent={GojoColors.warningLight}
        icon="send"
        title="Fiat sent"
        state={
          confirmDone
            ? 'done'
            : confirmActive
              ? 'active'
              : isDisputed || isExpired
                ? 'skipped'
                : 'idle'
        }
      >
        {confirmDone ? (
          <View style={{ gap: 5 }}>
            <View style={styles.inlineRow}>
              <MaterialIcons name="check-circle" size={12} color={GojoColors.successLight} />
              <Text style={[styles.mono, { color: GojoColors.successLight }]}>
                confirmed on-chain
              </Text>
            </View>
            {confirmTx && confirmTx !== 'already-confirmed' ? (
              <CopyLink value={confirmTx} type="tx" label="confirm payment tx" />
            ) : null}
          </View>
        ) : confirmActive ? (
          <View style={{ gap: 8 }}>
            <Text style={styles.bodyText}>
              Send the fiat off-chain via your chosen rail, then tap below to flip
              the escrow to PAYMENT_CONFIRMED.
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Confirm fiat sent"
              disabled={confirming}
              onPress={onConfirmFiat}
              style={({ pressed }) => [
                styles.actionButton,
                {
                  borderColor: 'rgba(252,211,77,0.45)',
                  backgroundColor: confirming
                    ? 'rgba(252,211,77,0.08)'
                    : 'rgba(252,211,77,0.2)',
                  opacity: pressed ? 0.7 : 1,
                },
              ]}
            >
              <MaterialIcons
                name={confirming ? 'hourglass-empty' : 'send'}
                size={12}
                color={GojoColors.warningLight}
              />
              <Text style={[styles.actionButtonText, { color: GojoColors.warningLight }]}>
                I sent the fiat
              </Text>
            </Pressable>
            {confirmErr ? <Text style={styles.errorText}>error: {confirmErr}</Text> : null}
          </View>
        ) : (
          <Text style={styles.mutedMono}>waiting for escrow state…</Text>
        )}
      </StepCard>

      {/* STEP 3 — Crypto released */}
      <StepCard
        step={3}
        accent={GojoColors.successLight}
        icon="paid"
        title="Crypto released"
        state={
          releaseDone
            ? 'done'
            : releaseActive
              ? 'active'
              : isDisputed || isExpired
                ? 'skipped'
                : 'idle'
        }
      >
        {releaseDone && releaseResult ? (
          <View style={{ gap: 5 }}>
            <View style={styles.inlineRow}>
              <MaterialIcons name="check-circle" size={12} color={GojoColors.successLight} />
              <Text style={[styles.mono, { color: GojoColors.successLight }]}>
                released
              </Text>
            </View>
            <CopyLink value={releaseResult.txSignature} type="tx" label="release tx" />
            <View style={styles.feeBlock}>
              <Text style={styles.feeLine}>
                <Text style={styles.kvLabel}>buyer: </Text>
                <Text style={{ color: GojoColors.successLight }}>
                  {formatLamports(releaseResult.feeSplit.buyerAmount)} SOL
                </Text>
              </Text>
              <Text style={styles.feeLineMuted}>
                fee {releaseResult.feeSplit.feeBps}bps ={' '}
                {formatLamports(releaseResult.feeSplit.totalFee)} SOL
              </Text>
              <Text style={styles.feeLineMuted}>
                P01 {formatLamports(releaseResult.feeSplit.p01)} · Mugen{' '}
                {formatLamports(releaseResult.feeSplit.mugen)} · Treasury{' '}
                {formatLamports(releaseResult.feeSplit.treasury)} · Noise{' '}
                {formatLamports(releaseResult.feeSplit.noise)}
              </Text>
            </View>
          </View>
        ) : releaseDone ? (
          <Text style={[styles.mono, { color: GojoColors.successLight }]}>
            released on-chain (detected via polling)
          </Text>
        ) : releaseActive ? (
          <View style={{ gap: 8 }}>
            <Text style={styles.bodyText}>
              Fiat received? Release the locked crypto to the buyer. Fees split
              automatically across the 4 wallets.
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Release crypto"
              disabled={releasing}
              onPress={onReleaseCrypto}
              style={({ pressed }) => [
                styles.actionButton,
                {
                  borderColor: 'rgba(134,239,172,0.45)',
                  backgroundColor: releasing
                    ? 'rgba(134,239,172,0.08)'
                    : 'rgba(134,239,172,0.2)',
                  opacity: pressed ? 0.7 : 1,
                },
              ]}
            >
              <MaterialIcons
                name={releasing ? 'hourglass-empty' : 'paid'}
                size={12}
                color={GojoColors.successLight}
              />
              <Text style={[styles.actionButtonText, { color: GojoColors.successLight }]}>
                Release crypto
              </Text>
            </Pressable>
            {releaseErr ? <Text style={styles.errorText}>error: {releaseErr}</Text> : null}
          </View>
        ) : (
          <Text style={styles.mutedMono}>unlocks after fiat confirmation</Text>
        )}
      </StepCard>

      {/* Dispute row */}
      <View style={styles.disputeRow}>
        {!releaseDone && !isExpired && !isDisputed ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={disputeOpen ? 'Cancel dispute' : 'Open dispute'}
            onPress={() => setDisputeOpen((v) => !v)}
            style={({ pressed }) => [
              styles.disputeToggleBtn,
              { opacity: pressed ? 0.7 : 1 },
            ]}
          >
            <MaterialIcons name="gavel" size={11} color={GojoColors.errorLight} />
            <Text style={styles.disputeToggleText}>
              {disputeOpen ? 'cancel dispute' : 'open dispute'}
            </Text>
          </Pressable>
        ) : null}
        {disputeTx ? (
          <View style={styles.inlineRow}>
            <Text style={[styles.mono, { color: GojoColors.errorLight }]}>
              dispute tx:
            </Text>
            <CopyLink value={disputeTx} type="tx" label="dispute tx" tint={GojoColors.errorLight} />
          </View>
        ) : null}
      </View>

      {disputeOpen ? (
        <View style={styles.disputeFormCard}>
          <Text style={styles.disputeFormTitle}>OPEN A DISPUTE</Text>
          <View style={styles.inlineRow}>
            <Text style={styles.kvLabel}>reason (1-10):</Text>
            <TextInput
              value={disputeReason}
              onChangeText={setDisputeReason}
              placeholder="1"
              placeholderTextColor={GojoColors.subtle}
              keyboardType="number-pad"
              maxLength={2}
              style={styles.disputeInput}
              accessibilityLabel="Dispute reason code"
            />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Submit dispute"
            disabled={disputing}
            onPress={onSubmitDispute}
            style={({ pressed }) => [
              styles.actionButton,
              {
                alignSelf: 'flex-start',
                borderColor: 'rgba(239,68,68,0.45)',
                backgroundColor: disputing
                  ? 'rgba(239,68,68,0.08)'
                  : 'rgba(239,68,68,0.2)',
                opacity: pressed ? 0.7 : 1,
              },
            ]}
          >
            <MaterialIcons
              name={disputing ? 'hourglass-empty' : 'gavel'}
              size={11}
              color={GojoColors.errorLight}
            />
            <Text style={[styles.actionButtonText, { color: '#fecaca' }]}>
              Submit dispute
            </Text>
          </Pressable>
          {disputeErr ? <Text style={styles.errorText}>error: {disputeErr}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

// ─── Small helpers ──────────────────────────────────────────────────────────

interface KvRowProps {
  label: string;
  value: string;
  valueColor?: string;
}

function KvRow({ label, value, valueColor = GojoColors.text }: KvRowProps): React.ReactElement {
  return (
    <View style={styles.kvRow}>
      <Text style={styles.kvLabel}>{label}:</Text>
      <Text style={[styles.kvValue, { color: valueColor }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 10,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerText: {
    color: GojoColors.violetLight,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.5,
    flex: 1,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
  },
  statusBadgeText: {
    fontFamily: Mono,
    fontSize: 10,
    letterSpacing: 1,
  },
  errorCallout: {
    padding: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.3)',
    backgroundColor: 'rgba(239,68,68,0.06)',
  },
  errorCalloutText: {
    fontFamily: Mono,
    fontSize: 10,
    color: GojoColors.errorLight,
  },
  disputedCallout: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: GojoColors.borderError,
    backgroundColor: 'rgba(239,68,68,0.1)',
  },
  disputedText: {
    flex: 1,
    fontFamily: Mono,
    fontSize: 11,
    color: '#fecaca',
  },
  step: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 8,
  },
  stepHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  stepNum: {
    width: 22,
    height: 22,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepNumText: {
    fontSize: 11,
    fontWeight: '700',
  },
  stepTitle: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  stepBody: {
    gap: 5,
  },
  kvRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  kvLabel: {
    fontFamily: Mono,
    fontSize: 11,
    color: GojoColors.mutedLight,
  },
  kvValue: {
    fontFamily: Mono,
    fontSize: 11,
  },
  inlineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  mono: {
    fontFamily: Mono,
    fontSize: 11,
  },
  mutedMono: {
    fontFamily: Mono,
    fontSize: 11,
    color: GojoColors.mutedLight,
  },
  bodyText: {
    color: GojoColors.text,
    fontSize: 12,
    lineHeight: 17,
  },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1,
  },
  actionButtonText: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  errorText: {
    fontFamily: Mono,
    fontSize: 10,
    color: GojoColors.errorLight,
  },
  feeBlock: {
    gap: 2,
    marginTop: 4,
  },
  feeLine: {
    fontFamily: Mono,
    fontSize: 10,
    color: GojoColors.text,
  },
  feeLineMuted: {
    fontFamily: Mono,
    fontSize: 10,
    color: GojoColors.mutedLight,
  },
  disputeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 8,
  },
  disputeToggleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.25)',
  },
  disputeToggleText: {
    fontFamily: Mono,
    fontSize: 10,
    color: GojoColors.errorLight,
  },
  disputeFormCard: {
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: GojoColors.borderError,
    backgroundColor: 'rgba(239,68,68,0.05)',
    gap: 8,
  },
  disputeFormTitle: {
    fontSize: 12,
    color: GojoColors.errorLight,
    fontWeight: '700',
    letterSpacing: 1.5,
  },
  disputeInput: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    backgroundColor: 'rgba(0,0,0,0.35)',
    color: GojoColors.text,
    fontFamily: Mono,
    fontSize: 12,
    minWidth: 60,
  },
});

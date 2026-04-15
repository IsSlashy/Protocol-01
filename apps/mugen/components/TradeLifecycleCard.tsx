'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Loader2,
  Lock,
  Coins,
  Send,
  AlertTriangle,
  ExternalLink,
  Copy,
  Check,
  Clock,
  ShieldAlert,
} from 'lucide-react';

// ═══════════════════════════════════════════════════════════════════════════
// TradeLifecycleCard
//
// Renders the full post-escrow P2P trade state machine:
//   ESCROW_AWAITING_PAYMENT → PAYMENT_CONFIRMED → RELEASED
// plus a dispute escape hatch (AWAITING/CONFIRMED → DISPUTED).
//
// Polls GET /api/trade/escrow-status every 4s until a terminal state
// (released | expired | resolved | disputed terminal). Abortable — clears
// on unmount. Uses the same Gojo glass aesthetic as PrivacyReceipt.
// ═══════════════════════════════════════════════════════════════════════════

export interface TradeLifecycleCardProps {
  escrowPDA: string;
  orderPDA: string;
  vaultPDA: string;
  initialTxSignature: string;
}

type Status =
  | 'awaiting_payment'
  | 'payment_confirmed'
  | 'released'
  | 'disputed'
  | 'resolved'
  | 'expired'
  | 'unknown';

interface EscrowStatusResponse {
  exists: true;
  status: Status;
  statusCode: number;
  maker: string;
  taker: string;
  cryptoAmount: string;
  fiatAmount: string;
  expiresAt: number;
  paymentConfirmedAt: number;
  vault: string;
  tokenMint: string;
  disputeReason: number;
  disputeInitiator: string;
}

interface ReleaseFeeSplit {
  p01: string;
  mugen: string;
  treasury: string;
  noise: string;
  buyerAmount: string;
  totalFee: string;
  feeBps: number;
}

interface ReleaseSuccessPayload {
  txSignature: string;
  feeSplit: ReleaseFeeSplit;
}

const POLL_INTERVAL_MS = 4_000;
const TERMINAL: Status[] = ['released', 'expired', 'resolved'];

function txExplorerUrl(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}
function addressExplorerUrl(addr: string): string {
  return `https://explorer.solana.com/address/${addr}?cluster=devnet`;
}
function shortenSig(sig: string): string {
  return sig.length <= 20 ? sig : `${sig.slice(0, 10)}…${sig.slice(-6)}`;
}
function shortenPubkey(pk: string): string {
  return pk.length <= 14 ? pk : `${pk.slice(0, 6)}…${pk.slice(-4)}`;
}

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

function formatAbsoluteTime(tsSec: number): string {
  if (!tsSec) return '—';
  const d = new Date(tsSec * 1000);
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

// ─── Atomic UI bits ────────────────────────────────────────────────────────

interface CopyBtnProps {
  value: string;
  label: string;
  tint?: string;
}
function CopyBtn({ value, label, tint = '#c4b5fd' }: CopyBtnProps) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(
    async (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard) {
          await navigator.clipboard.writeText(value);
          setCopied(true);
        }
      } catch {
        /* best-effort */
      }
    },
    [value],
  );
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '1.1rem',
        height: '1.1rem',
        padding: 0,
        border: `1px solid ${tint}30`,
        borderRadius: '6px',
        background: `${tint}10`,
        color: copied ? '#86efac' : tint,
        cursor: 'pointer',
      }}
    >
      {copied ? <Check size={10} /> : <Copy size={10} />}
    </button>
  );
}

interface OnchainAnchorProps {
  kind: 'tx' | 'address';
  value: string;
  label: string;
  tint?: string;
}
function OnchainAnchor({ kind, value, label, tint = '#93c5fd' }: OnchainAnchorProps) {
  const href = kind === 'tx' ? txExplorerUrl(value) : addressExplorerUrl(value);
  const short = kind === 'tx' ? shortenSig(value) : shortenPubkey(value);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open ${label} on Solana Explorer (devnet)`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.25rem',
          color: tint,
          textDecoration: 'none',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '0.65rem',
        }}
      >
        <code style={{ background: 'transparent', color: 'inherit' }}>{short}</code>
        <ExternalLink size={10} aria-hidden="true" />
      </a>
      <CopyBtn value={value} label={label} tint={tint} />
    </span>
  );
}

interface StepCardProps {
  step: number;
  accent: string;
  icon: React.ReactNode;
  title: string;
  state: 'idle' | 'active' | 'done' | 'skipped';
  children: React.ReactNode;
}
function StepCard({ step, accent, icon, title, state, children }: StepCardProps) {
  const borderColor =
    state === 'done'
      ? 'rgba(34,197,94,0.4)'
      : state === 'active'
        ? `${accent}70`
        : state === 'skipped'
          ? 'rgba(255,255,255,0.08)'
          : 'rgba(255,255,255,0.12)';
  const bg =
    state === 'done'
      ? 'linear-gradient(135deg, rgba(34,197,94,0.10), rgba(34,197,94,0.02))'
      : state === 'active'
        ? `linear-gradient(135deg, ${accent}14, ${accent}04)`
        : 'rgba(255,255,255,0.02)';
  const titleColor =
    state === 'done' ? '#86efac' : state === 'active' ? '#ffffff' : '#8888aa';
  return (
    <div
      style={{
        flex: '1 1 220px',
        minWidth: 0,
        background: bg,
        border: `1px solid ${borderColor}`,
        borderRadius: '14px',
        padding: '0.9rem 1rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.6rem',
        transition: 'border-color 200ms ease, background 200ms ease',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '1.4rem',
            height: '1.4rem',
            borderRadius: '999px',
            background: state === 'done' ? 'rgba(34,197,94,0.2)' : `${accent}20`,
            color: state === 'done' ? '#86efac' : accent,
            fontFamily: "'Orbitron', sans-serif",
            fontSize: '0.7rem',
            fontWeight: 700,
          }}
        >
          {state === 'done' ? <CheckCircle2 size={12} /> : step}
        </span>
        <span style={{ color: state === 'done' ? '#86efac' : accent }}>{icon}</span>
        <span
          style={{
            fontFamily: "'Orbitron', sans-serif",
            fontSize: '0.75rem',
            fontWeight: 700,
            color: titleColor,
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
          }}
        >
          {title}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
        {children}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Main component
// ═══════════════════════════════════════════════════════════════════════════

export default function TradeLifecycleCard({
  escrowPDA,
  orderPDA,
  vaultPDA,
  initialTxSignature,
}: TradeLifecycleCardProps) {
  const [escrow, setEscrow] = useState<EscrowStatusResponse | null>(null);
  const [pollErr, setPollErr] = useState<string | null>(null);
  const [nowSec, setNowSec] = useState<number>(() =>
    Math.floor(Date.now() / 1000),
  );

  // Action state
  const [confirming, setConfirming] = useState(false);
  const [confirmErr, setConfirmErr] = useState<string | null>(null);
  const [confirmTx, setConfirmTx] = useState<string | null>(null);

  const [releasing, setReleasing] = useState(false);
  const [releaseErr, setReleaseErr] = useState<string | null>(null);
  const [releaseResult, setReleaseResult] = useState<ReleaseSuccessPayload | null>(
    null,
  );

  const [disputeOpen, setDisputeOpen] = useState(false);
  const [disputeReason, setDisputeReason] = useState<number>(1);
  const [disputeSide, setDisputeSide] = useState<'taker' | 'maker'>('taker');
  const [disputing, setDisputing] = useState(false);
  const [disputeErr, setDisputeErr] = useState<string | null>(null);
  const [disputeTx, setDisputeTx] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const pollingRef = useRef<boolean>(true);

  // ── Polling ─────────────────────────────────────────────────────────────
  const fetchStatus = useCallback(async () => {
    if (!pollingRef.current) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch(
        `/api/trade/escrow-status?escrowPDA=${encodeURIComponent(escrowPDA)}`,
        { signal: ctrl.signal, cache: 'no-store' },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setPollErr(j.error || `HTTP ${res.status}`);
        return;
      }
      const json = (await res.json()) as EscrowStatusResponse;
      setEscrow(json);
      setPollErr(null);
      if (TERMINAL.includes(json.status)) {
        pollingRef.current = false;
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setPollErr(err instanceof Error ? err.message : 'network error');
    }
  }, [escrowPDA]);

  useEffect(() => {
    pollingRef.current = true;
    fetchStatus();
    const t = setInterval(() => {
      if (!pollingRef.current) {
        clearInterval(t);
        return;
      }
      fetchStatus();
    }, POLL_INTERVAL_MS);
    return () => {
      pollingRef.current = false;
      clearInterval(t);
      if (abortRef.current) abortRef.current.abort();
    };
  }, [fetchStatus]);

  // Countdown tick
  useEffect(() => {
    const i = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(i);
  }, []);

  // ── Actions ─────────────────────────────────────────────────────────────
  const onConfirmFiat = useCallback(async () => {
    setConfirming(true);
    setConfirmErr(null);
    try {
      const res = await fetch('/api/trade/confirm-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ escrowPDA, as: 'taker' }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        txSignature?: string;
        alreadyConfirmed?: boolean;
        error?: string;
        detail?: string;
        note?: string;
      };
      if (!res.ok || !json.ok) {
        setConfirmErr(json.detail || json.error || `HTTP ${res.status}`);
      } else {
        if (json.txSignature) setConfirmTx(json.txSignature);
        if (json.alreadyConfirmed && !json.txSignature) {
          setConfirmTx('already-confirmed');
        }
        // Kick an immediate status refresh.
        pollingRef.current = true;
        fetchStatus();
      }
    } catch (err) {
      setConfirmErr(err instanceof Error ? err.message : 'Network error');
    } finally {
      setConfirming(false);
    }
  }, [escrowPDA, fetchStatus]);

  const onReleaseCrypto = useCallback(async () => {
    setReleasing(true);
    setReleaseErr(null);
    try {
      const res = await fetch('/api/trade/release-escrow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ escrowPDA }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        txSignature?: string;
        feeSplit?: ReleaseFeeSplit;
        error?: string;
        detail?: string;
      };
      if (!res.ok || !json.ok || !json.txSignature || !json.feeSplit) {
        setReleaseErr(json.detail || json.error || `HTTP ${res.status}`);
      } else {
        setReleaseResult({
          txSignature: json.txSignature,
          feeSplit: json.feeSplit,
        });
        pollingRef.current = true;
        fetchStatus();
      }
    } catch (err) {
      setReleaseErr(err instanceof Error ? err.message : 'Network error');
    } finally {
      setReleasing(false);
    }
  }, [escrowPDA, fetchStatus]);

  const onSubmitDispute = useCallback(async () => {
    setDisputing(true);
    setDisputeErr(null);
    try {
      const res = await fetch('/api/trade/dispute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          escrowPDA,
          as: disputeSide,
          reason: disputeReason,
        }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        txSignature?: string;
        error?: string;
        detail?: string;
      };
      if (!res.ok || !json.ok || !json.txSignature) {
        setDisputeErr(json.detail || json.error || `HTTP ${res.status}`);
      } else {
        setDisputeTx(json.txSignature);
        setDisputeOpen(false);
        pollingRef.current = true;
        fetchStatus();
      }
    } catch (err) {
      setDisputeErr(err instanceof Error ? err.message : 'Network error');
    } finally {
      setDisputing(false);
    }
  }, [escrowPDA, disputeSide, disputeReason, fetchStatus]);

  // ── Derived flags ───────────────────────────────────────────────────────
  const status = escrow?.status ?? 'unknown';
  const loading = !escrow && !pollErr;

  const lockedDone = !!escrow;
  const confirmDone =
    status === 'payment_confirmed' ||
    status === 'released' ||
    status === 'resolved';
  const confirmActive = status === 'awaiting_payment';
  const releaseDone = status === 'released' || status === 'resolved';
  const releaseActive = status === 'payment_confirmed';
  const isDisputed = status === 'disputed';
  const isExpired = status === 'expired';

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        marginTop: '1rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.85rem',
      }}
    >
      {/* Header row */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '0.65rem',
          fontFamily: "'Orbitron', sans-serif",
          fontSize: '0.78rem',
          fontWeight: 700,
          color: '#c4b5fd',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
        }}
      >
        <Clock size={14} aria-hidden="true" />
        Trade lifecycle
        <span
          style={{
            marginLeft: 'auto',
            padding: '0.15rem 0.55rem',
            borderRadius: '999px',
            border: `1px solid ${
              releaseDone
                ? 'rgba(34,197,94,0.4)'
                : isDisputed
                  ? 'rgba(239,68,68,0.4)'
                  : isExpired
                    ? 'rgba(245,158,11,0.4)'
                    : 'rgba(196,181,253,0.3)'
            }`,
            background: releaseDone
              ? 'rgba(34,197,94,0.1)'
              : isDisputed
                ? 'rgba(239,68,68,0.1)'
                : isExpired
                  ? 'rgba(245,158,11,0.1)'
                  : 'rgba(196,181,253,0.08)',
            color: releaseDone
              ? '#86efac'
              : isDisputed
                ? '#fca5a5'
                : isExpired
                  ? '#fcd34d'
                  : '#c4b5fd',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '0.6rem',
            letterSpacing: '0.12em',
          }}
        >
          {loading ? 'loading…' : status.replace('_', ' ')}
        </span>
      </div>

      {pollErr && (
        <div
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '0.65rem',
            color: '#fca5a5',
            background: 'rgba(239,68,68,0.06)',
            border: '1px solid rgba(239,68,68,0.25)',
            borderRadius: '8px',
            padding: '0.4rem 0.6rem',
          }}
        >
          poll error: {pollErr}
        </div>
      )}

      {isDisputed && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.55rem',
            padding: '0.65rem 0.85rem',
            borderRadius: '10px',
            background: 'rgba(239,68,68,0.1)',
            border: '1px solid rgba(239,68,68,0.35)',
            color: '#fecaca',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '0.72rem',
          }}
        >
          <AlertTriangle size={14} />
          Dispute opened (reason code {escrow?.disputeReason ?? '?'}). Awaiting
          arbiter.
        </div>
      )}

      {/* 3-column state machine (stacks on mobile via flex-wrap) */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.75rem',
        }}
      >
        {/* STEP 1 — Escrow locked */}
        <StepCard
          step={1}
          accent="#c4b5fd"
          icon={<Lock size={13} aria-hidden="true" />}
          title="Escrow locked"
          state="done"
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
            <div
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '0.7rem',
                color: '#d1d5db',
              }}
            >
              <span style={{ color: '#8888aa' }}>crypto: </span>
              <span style={{ color: '#86efac' }}>
                {escrow
                  ? `${formatLamports(escrow.cryptoAmount)} SOL`
                  : '…'}
              </span>
            </div>
            <div
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '0.7rem',
                color: '#d1d5db',
              }}
            >
              <span style={{ color: '#8888aa' }}>fiat due: </span>
              <span style={{ color: '#fcd34d' }}>
                {escrow ? formatFiatCents(escrow.fiatAmount) : '…'}
              </span>
            </div>
            <div
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '0.65rem',
                color: '#8888aa',
              }}
            >
              expires:{' '}
              <span
                style={{
                  color: isExpired || (escrow && nowSec >= escrow.expiresAt)
                    ? '#fca5a5'
                    : '#c4b5fd',
                }}
              >
                {escrow ? formatCountdown(escrow.expiresAt, nowSec) : '—'}
              </span>
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                fontSize: '0.65rem',
                fontFamily: "'JetBrains Mono', monospace",
                color: '#8888aa',
              }}
            >
              vault:{' '}
              <OnchainAnchor
                kind="address"
                value={vaultPDA}
                label="vault PDA"
                tint="#c4b5fd"
              />
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                fontSize: '0.65rem',
                fontFamily: "'JetBrains Mono', monospace",
                color: '#8888aa',
              }}
            >
              init tx:{' '}
              <OnchainAnchor
                kind="tx"
                value={initialTxSignature}
                label="initial escrow tx"
                tint="#93c5fd"
              />
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                fontSize: '0.65rem',
                fontFamily: "'JetBrains Mono', monospace",
                color: '#8888aa',
              }}
            >
              order:{' '}
              <OnchainAnchor
                kind="address"
                value={orderPDA}
                label="order PDA"
                tint="#c4b5fd"
              />
            </div>
          </div>
        </StepCard>

        {/* STEP 2 — Fiat sent */}
        <StepCard
          step={2}
          accent="#fcd34d"
          icon={<Send size={13} aria-hidden="true" />}
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
            <div
              style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}
            >
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  color: '#86efac',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '0.7rem',
                }}
              >
                <CheckCircle2 size={12} /> confirmed on-chain
              </div>
              {escrow?.paymentConfirmedAt ? (
                <div
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '0.62rem',
                    color: '#8888aa',
                  }}
                >
                  at {formatAbsoluteTime(escrow.paymentConfirmedAt)}
                </div>
              ) : null}
              {confirmTx && confirmTx !== 'already-confirmed' && (
                <OnchainAnchor
                  kind="tx"
                  value={confirmTx}
                  label="confirm payment tx"
                  tint="#86efac"
                />
              )}
            </div>
          ) : confirmActive ? (
            <div
              style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}
            >
              <p
                style={{
                  margin: 0,
                  fontFamily: "'Inter', sans-serif",
                  fontSize: '0.7rem',
                  color: '#d1d5db',
                  lineHeight: 1.45,
                }}
              >
                Send the fiat off-chain via your chosen rail, then click below
                to flip the escrow to{' '}
                <code style={{ color: '#fcd34d' }}>PAYMENT_CONFIRMED</code>.
              </p>
              <button
                type="button"
                disabled={confirming}
                onClick={onConfirmFiat}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.45rem',
                  padding: '0.55rem 0.8rem',
                  borderRadius: '10px',
                  border: '1px solid rgba(252,211,77,0.4)',
                  background: confirming
                    ? 'rgba(252,211,77,0.08)'
                    : 'rgba(252,211,77,0.18)',
                  color: '#fcd34d',
                  fontFamily: "'Orbitron', sans-serif",
                  fontSize: '0.7rem',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  cursor: confirming ? 'wait' : 'pointer',
                }}
              >
                {confirming ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Send size={12} />
                )}
                I sent the fiat
              </button>
              {confirmErr && (
                <div
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '0.62rem',
                    color: '#fca5a5',
                  }}
                >
                  error: {confirmErr}
                </div>
              )}
            </div>
          ) : (
            <div
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '0.65rem',
                color: '#8888aa',
              }}
            >
              waiting for escrow state…
            </div>
          )}
        </StepCard>

        {/* STEP 3 — Crypto released */}
        <StepCard
          step={3}
          accent="#86efac"
          icon={<Coins size={13} aria-hidden="true" />}
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
            <div
              style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}
            >
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  color: '#86efac',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '0.7rem',
                }}
              >
                <CheckCircle2 size={12} /> released
              </div>
              <OnchainAnchor
                kind="tx"
                value={releaseResult.txSignature}
                label="release tx"
                tint="#86efac"
              />
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.12rem',
                  marginTop: '0.2rem',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '0.6rem',
                  color: '#d1d5db',
                }}
              >
                <div>
                  <span style={{ color: '#8888aa' }}>buyer: </span>
                  <span style={{ color: '#86efac' }}>
                    {formatLamports(releaseResult.feeSplit.buyerAmount)} SOL
                  </span>
                </div>
                <div style={{ color: '#8888aa' }}>
                  fee {releaseResult.feeSplit.feeBps}bps ={' '}
                  {formatLamports(releaseResult.feeSplit.totalFee)} SOL
                </div>
                <div style={{ color: '#8888aa', paddingLeft: '0.35rem' }}>
                  P01 {formatLamports(releaseResult.feeSplit.p01)} · Mugen{' '}
                  {formatLamports(releaseResult.feeSplit.mugen)} · Treasury{' '}
                  {formatLamports(releaseResult.feeSplit.treasury)} · Noise{' '}
                  {formatLamports(releaseResult.feeSplit.noise)}
                </div>
              </div>
            </div>
          ) : releaseDone ? (
            <div
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '0.65rem',
                color: '#86efac',
              }}
            >
              released on-chain (detected via polling)
            </div>
          ) : releaseActive ? (
            <div
              style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}
            >
              <p
                style={{
                  margin: 0,
                  fontFamily: "'Inter', sans-serif",
                  fontSize: '0.7rem',
                  color: '#d1d5db',
                  lineHeight: 1.45,
                }}
              >
                Fiat received? Release the locked crypto to the buyer. Fees
                split automatically across the 4 wallets.
              </p>
              <button
                type="button"
                disabled={releasing}
                onClick={onReleaseCrypto}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.45rem',
                  padding: '0.55rem 0.8rem',
                  borderRadius: '10px',
                  border: '1px solid rgba(134,239,172,0.4)',
                  background: releasing
                    ? 'rgba(134,239,172,0.08)'
                    : 'rgba(134,239,172,0.18)',
                  color: '#86efac',
                  fontFamily: "'Orbitron', sans-serif",
                  fontSize: '0.7rem',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  cursor: releasing ? 'wait' : 'pointer',
                }}
              >
                {releasing ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Coins size={12} />
                )}
                Release crypto
              </button>
              {releaseErr && (
                <div
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '0.62rem',
                    color: '#fca5a5',
                  }}
                >
                  error: {releaseErr}
                </div>
              )}
            </div>
          ) : (
            <div
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '0.65rem',
                color: '#8888aa',
              }}
            >
              unlocks after fiat confirmation
            </div>
          )}
        </StepCard>
      </div>

      {/* Dispute escape hatch */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'flex-end',
          alignItems: 'flex-start',
          gap: '0.5rem',
        }}
      >
        {!releaseDone && !isExpired && !isDisputed && (
          <button
            type="button"
            onClick={() => setDisputeOpen((v) => !v)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.3rem',
              padding: '0.3rem 0.55rem',
              borderRadius: '8px',
              border: '1px solid rgba(239,68,68,0.25)',
              background: 'transparent',
              color: '#fca5a5',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '0.62rem',
              cursor: 'pointer',
            }}
            aria-expanded={disputeOpen}
            aria-label="Open dispute form"
          >
            <ShieldAlert size={11} />
            {disputeOpen ? 'cancel dispute' : 'open dispute'}
          </button>
        )}
        {disputeTx && (
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '0.62rem',
              color: '#fca5a5',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.35rem',
            }}
          >
            dispute tx:{' '}
            <OnchainAnchor
              kind="tx"
              value={disputeTx}
              label="dispute tx"
              tint="#fca5a5"
            />
          </span>
        )}
      </div>

      {disputeOpen && (
        <div
          style={{
            background: 'rgba(239,68,68,0.05)',
            border: '1px solid rgba(239,68,68,0.3)',
            borderRadius: '12px',
            padding: '0.75rem 0.9rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.55rem',
          }}
        >
          <div
            style={{
              fontFamily: "'Orbitron', sans-serif",
              fontSize: '0.72rem',
              color: '#fca5a5',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}
          >
            Open a dispute
          </div>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: '0.6rem',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '0.68rem',
              color: '#d1d5db',
            }}
          >
            <label
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.35rem',
              }}
            >
              <span style={{ color: '#8888aa' }}>role:</span>
              <select
                value={disputeSide}
                onChange={(e) =>
                  setDisputeSide(e.target.value as 'taker' | 'maker')
                }
                style={{
                  background: 'rgba(0,0,0,0.35)',
                  border: '1px solid rgba(255,255,255,0.15)',
                  borderRadius: '6px',
                  color: '#d1d5db',
                  padding: '0.2rem 0.4rem',
                  fontFamily: 'inherit',
                  fontSize: 'inherit',
                }}
              >
                <option value="taker">taker (buyer)</option>
                <option value="maker">maker (seller)</option>
              </select>
            </label>
            <label
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.35rem',
              }}
            >
              <span style={{ color: '#8888aa' }}>reason:</span>
              <select
                value={disputeReason}
                onChange={(e) =>
                  setDisputeReason(Number.parseInt(e.target.value, 10))
                }
                style={{
                  background: 'rgba(0,0,0,0.35)',
                  border: '1px solid rgba(255,255,255,0.15)',
                  borderRadius: '6px',
                  color: '#d1d5db',
                  padding: '0.2rem 0.4rem',
                  fontFamily: 'inherit',
                  fontSize: 'inherit',
                }}
              >
                <option value={1}>1 — fiat not received</option>
                <option value={2}>2 — fiat amount mismatch</option>
                <option value={3}>3 — wrong payment method</option>
                <option value={4}>4 — buyer unresponsive</option>
                <option value={5}>5 — seller unresponsive</option>
                <option value={6}>6 — suspected scam</option>
                <option value={7}>7 — chargeback risk</option>
                <option value={8}>8 — payment reversed</option>
                <option value={9}>9 — other</option>
                <option value={10}>10 — force-majeure</option>
              </select>
            </label>
          </div>
          <button
            type="button"
            disabled={disputing}
            onClick={onSubmitDispute}
            style={{
              alignSelf: 'flex-start',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.4rem',
              padding: '0.45rem 0.75rem',
              borderRadius: '8px',
              border: '1px solid rgba(239,68,68,0.4)',
              background: disputing
                ? 'rgba(239,68,68,0.08)'
                : 'rgba(239,68,68,0.18)',
              color: '#fecaca',
              fontFamily: "'Orbitron', sans-serif",
              fontSize: '0.68rem',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              cursor: disputing ? 'wait' : 'pointer',
            }}
          >
            {disputing ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <ShieldAlert size={11} />
            )}
            Submit dispute
          </button>
          {disputeErr && (
            <div
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '0.62rem',
                color: '#fca5a5',
              }}
            >
              error: {disputeErr}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

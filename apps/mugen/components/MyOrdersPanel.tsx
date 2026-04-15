'use client';

import { useCallback, useState } from 'react';
import {
  Search,
  Trash2,
  Loader2,
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  ExternalLink,
} from 'lucide-react';
import type {
  FiatCurrency,
  OrderType,
  ThresholdMetaSuccess,
  ThresholdMetaFailure,
  MpcApiError,
} from '@/lib/mpc-types';

// ═══════════════════════════════════════════════════════════════════════════
// MyOrdersPanel — lookup-by-nonce + cancel for encrypted maker orders.
// Mirrors the Gojo theme of EncryptedOfferForm / BlindTakeForm.
// ═══════════════════════════════════════════════════════════════════════════

const PAYMENT_METHODS: readonly { label: string; bit: number }[] = [
  { label: 'SEPA', bit: 1 },
  { label: 'Revolut', bit: 2 },
  { label: 'Wise', bit: 4 },
  { label: 'Cash', bit: 8 },
  { label: 'Zelle', bit: 16 },
];

function decodePaymentMethods(mask: number): string[] {
  return PAYMENT_METHODS.filter((m) => (mask & m.bit) !== 0).map((m) => m.label);
}

function lamportsToSol(lamports: number): string {
  return (lamports / 1e9).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

function formatFiat(cents: number, currency: FiatCurrency): string {
  const v = cents / 100;
  return `${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

function formatRelativeExpiry(expiresAtUnix: number): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const delta = expiresAtUnix - nowSec;
  if (delta <= 0) return 'expired';
  const days = Math.floor(delta / 86400);
  const hrs = Math.floor((delta % 86400) / 3600);
  const mins = Math.floor((delta % 3600) / 60);
  if (days > 0) return `in ${days}d ${hrs}h`;
  if (hrs > 0) return `in ${hrs}h ${mins}m`;
  if (mins > 0) return `in ${mins}m`;
  return 'in <1m';
}

// ═══════════════════════════════════════════════════════════════════════════
// TYPES (local — mirrors routes)
// ═══════════════════════════════════════════════════════════════════════════

interface RegistryEntry {
  makerNoncePubkey: string;
  makerWallet: string | null;
  orderType: OrderType;
  cryptoAmountLamports: number;
  fiatAmountCents: number;
  fiatCurrency: FiatCurrency;
  paymentMethods: number;
  expiresAtUnix: number;
  computationOffset: string;
  mpcTxSignature: string;
  registeredAt: number;
}

interface MineOk {
  ok: true;
  entry: RegistryEntry;
}

interface CancelOk {
  ok: true;
  txSignature: string;
  threshold?: ThresholdMetaSuccess;
}

type CancelPhase = 'idle' | 'threshold' | 'mpc' | 'done';

type ErrorKind = 'threshold' | 'unreachable' | 'not-found' | 'generic';

// ═══════════════════════════════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════════════════════════════

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '0.7rem',
  textTransform: 'uppercase',
  letterSpacing: '0.12em',
  color: '#8888aa',
  marginBottom: '0.4rem',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  background: 'rgba(10,10,24,0.6)',
  border: '1px solid rgba(139,92,246,0.2)',
  borderRadius: '10px',
  padding: '0.65rem 0.8rem',
  color: '#ffffff',
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '0.78rem',
  outline: 'none',
};

// ═══════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════

export default function MyOrdersPanel() {
  const [nonceInput, setNonceInput] = useState<string>('');
  const [lookingUp, setLookingUp] = useState(false);
  const [entry, setEntry] = useState<RegistryEntry | null>(null);
  const [lookupMsg, setLookupMsg] = useState<string | null>(null);

  const [cancelling, setCancelling] = useState(false);
  const [cancelPhase, setCancelPhase] = useState<CancelPhase>('idle');
  const [cancelResult, setCancelResult] = useState<CancelOk | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<ErrorKind | null>(null);
  const [errorSigners, setErrorSigners] = useState<
    { region: string; port: number }[] | null
  >(null);
  const [errorThreshold, setErrorThreshold] = useState<ThresholdMetaFailure | null>(null);

  const resetErrors = useCallback(() => {
    setError(null);
    setErrorKind(null);
    setErrorSigners(null);
    setErrorThreshold(null);
  }, []);

  const onLookup = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      resetErrors();
      setCancelResult(null);
      setCancelPhase('idle');
      setEntry(null);
      setLookupMsg(null);

      const trimmed = nonceInput.trim();
      if (trimmed.length < 32) {
        setLookupMsg('Enter a valid base58 pubkey (≥ 32 chars).');
        return;
      }

      setLookingUp(true);
      try {
        const res = await fetch('/api/orders/mine', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ makerNoncePubkey: trimmed }),
        });
        const json: MineOk | MpcApiError = await res.json();
        if (!res.ok || !('ok' in json)) {
          if (res.status === 404) {
            setLookupMsg(
              'No matching order. Nonces are one-shot and removed after match or cancel.',
            );
          } else {
            const errJson = json as MpcApiError;
            setLookupMsg(errJson.detail || errJson.error || `HTTP ${res.status}`);
          }
          return;
        }
        setEntry(json.entry);
      } catch (err) {
        setLookupMsg(err instanceof Error ? err.message : 'Network error');
      } finally {
        setLookingUp(false);
      }
    },
    [nonceInput, resetErrors],
  );

  const onCancel = useCallback(async () => {
    if (!entry) return;
    const ok = window.confirm(
      'Cancel this encrypted order? This pushes a cancel request through the FROST quorum and Arcium MPC. The nonce becomes unusable afterwards.',
    );
    if (!ok) return;

    resetErrors();
    setCancelResult(null);
    setCancelling(true);
    setCancelPhase('threshold');
    try {
      const res = await fetch('/api/orders/cancel-encrypted', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ makerNoncePubkey: entry.makerNoncePubkey }),
      });
      const json: CancelOk | MpcApiError = await res.json();
      if (!res.ok || !('ok' in json)) {
        const errJson = json as MpcApiError;
        if (res.status === 409) {
          setErrorKind('threshold');
          setErrorSigners(errJson.signers ?? null);
          setErrorThreshold(errJson.threshold ?? null);
          setError(errJson.detail || errJson.error || 'Threshold rejected');
        } else if (res.status === 503) {
          setErrorKind('unreachable');
          setError(errJson.detail || errJson.error || 'FROST quorum unreachable');
        } else if (res.status === 404) {
          setErrorKind('not-found');
          setError('Order no longer in registry (expired or already cancelled).');
        } else {
          setErrorKind('generic');
          setError(errJson.detail || errJson.error || `HTTP ${res.status}`);
        }
        setCancelPhase('idle');
      } else {
        setCancelPhase('mpc');
        setCancelResult(json);
        setCancelPhase('done');
        // Order is gone from the registry server-side; clear the local card.
        setEntry(null);
      }
    } catch (err) {
      setErrorKind('generic');
      setError(err instanceof Error ? err.message : 'Network error');
      setCancelPhase('idle');
    } finally {
      setCancelling(false);
    }
  }, [entry, resetErrors]);

  return (
    <div style={{ padding: '1.4rem 1.4rem 1.6rem' }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.55rem',
          marginBottom: '0.4rem',
        }}
      >
        <h3
          style={{
            margin: 0,
            fontFamily: "'Orbitron', sans-serif",
            fontSize: '1rem',
            fontWeight: 700,
            color: '#ffffff',
            letterSpacing: '0.04em',
          }}
        >
          My private orders
        </h3>
        <span
          style={{
            padding: '0.2rem 0.55rem',
            borderRadius: '999px',
            background: 'rgba(139,92,246,0.12)',
            border: '1px solid rgba(139,92,246,0.3)',
            color: '#c4b5fd',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '0.6rem',
            textTransform: 'uppercase',
            letterSpacing: '0.14em',
          }}
        >
          L8 ⟷ L9
        </span>
      </div>
      <p
        style={{
          margin: '0 0 1.1rem',
          fontFamily: "'Inter', sans-serif",
          fontSize: '0.8rem',
          color: '#8888aa',
          lineHeight: 1.5,
        }}
      >
        Paste your maker nonce to find + manage your encrypted order.
      </p>

      {/* Lookup form */}
      <form onSubmit={onLookup} style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
        <div>
          <label style={labelStyle}>Maker nonce (base58 pubkey)</label>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <input
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={nonceInput}
              onChange={(e) => setNonceInput(e.target.value)}
              placeholder="e.g. 7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU"
              style={inputStyle}
            />
            <button
              type="submit"
              disabled={lookingUp}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.55rem 0.9rem',
                borderRadius: '10px',
                border: '1px solid rgba(139,92,246,0.35)',
                background: lookingUp
                  ? 'rgba(139,92,246,0.1)'
                  : 'linear-gradient(135deg, rgba(59,130,246,0.3), rgba(139,92,246,0.3))',
                color: '#ffffff',
                fontFamily: "'Orbitron', sans-serif",
                fontSize: '0.72rem',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                cursor: lookingUp ? 'not-allowed' : 'pointer',
                opacity: lookingUp ? 0.65 : 1,
                whiteSpace: 'nowrap',
              }}
            >
              {lookingUp ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Search size={13} />
              )}
              Look up
            </button>
          </div>
        </div>
      </form>

      {/* Lookup message (404 / validation) */}
      {lookupMsg && !entry && (
        <div
          style={{
            marginTop: '0.85rem',
            padding: '0.7rem 0.9rem',
            borderRadius: '10px',
            background: 'rgba(139,92,246,0.05)',
            border: '1px dashed rgba(139,92,246,0.25)',
            color: '#a5b4fc',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '0.72rem',
            lineHeight: 1.5,
          }}
        >
          {lookupMsg}
        </div>
      )}

      {/* Order card */}
      {entry && (
        <div
          style={{
            marginTop: '1rem',
            padding: '1rem',
            borderRadius: '12px',
            background: 'rgba(10,10,24,0.55)',
            border: '1px solid rgba(139,92,246,0.25)',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem',
          }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '0.7rem',
            }}
          >
            <Field label="Order type" value={entry.orderType.toUpperCase()} color="#c4b5fd" />
            <Field
              label="Crypto amount"
              value={`${lamportsToSol(entry.cryptoAmountLamports)} SOL`}
              color="#93c5fd"
            />
            <Field
              label="Fiat amount"
              value={formatFiat(entry.fiatAmountCents, entry.fiatCurrency)}
              color="#60a5fa"
            />
            <Field
              label="Expires"
              value={formatRelativeExpiry(entry.expiresAtUnix)}
              color="#fcd34d"
            />
          </div>

          <div>
            <div style={labelStyle}>Payment methods</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
              {decodePaymentMethods(entry.paymentMethods).map((m) => (
                <span
                  key={m}
                  style={{
                    padding: '0.25rem 0.6rem',
                    borderRadius: '999px',
                    background: 'rgba(139,92,246,0.12)',
                    border: '1px solid rgba(139,92,246,0.25)',
                    color: '#c4b5fd',
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '0.66rem',
                    textTransform: 'uppercase',
                    letterSpacing: '0.1em',
                  }}
                >
                  {m}
                </span>
              ))}
              {decodePaymentMethods(entry.paymentMethods).length === 0 && (
                <span
                  style={{
                    color: '#8888aa',
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '0.7rem',
                  }}
                >
                  none
                </span>
              )}
            </div>
          </div>

          {/* Cancel button */}
          <button
            type="button"
            onClick={onCancel}
            disabled={cancelling}
            style={{
              marginTop: '0.3rem',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem',
              padding: '0.75rem 1rem',
              borderRadius: '12px',
              border: '1px solid rgba(239,68,68,0.35)',
              background: cancelling
                ? 'rgba(239,68,68,0.08)'
                : 'linear-gradient(135deg, rgba(239,68,68,0.2), rgba(185,28,28,0.25))',
              color: '#fca5a5',
              fontFamily: "'Orbitron', sans-serif",
              fontWeight: 700,
              fontSize: '0.8rem',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              cursor: cancelling ? 'not-allowed' : 'pointer',
              opacity: cancelling ? 0.65 : 1,
            }}
          >
            {cancelling && cancelPhase === 'threshold' ? (
              <>
                <ShieldCheck size={14} />
                <Loader2 size={14} className="animate-spin" />
                Requesting FROST quorum…
              </>
            ) : cancelling && cancelPhase === 'mpc' ? (
              <>
                <Trash2 size={14} />
                <Loader2 size={14} className="animate-spin" />
                Cancelling on MPC…
              </>
            ) : (
              <>
                <Trash2 size={14} />
                Cancel order
              </>
            )}
          </button>
        </div>
      )}

      {/* Cancel step indicator */}
      {(cancelling || cancelPhase === 'done') && (
        <div style={{ marginTop: '0.9rem' }}>
          <StepIndicator phase={cancelPhase} />
        </div>
      )}

      {/* Cancel success */}
      {cancelResult && cancelPhase === 'done' && (
        <div
          style={{
            marginTop: '0.9rem',
            padding: '0.9rem 1rem',
            borderRadius: '12px',
            background: 'rgba(34,197,94,0.08)',
            border: '1px solid rgba(34,197,94,0.3)',
            color: '#86efac',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '0.78rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
          }}
        >
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <CheckCircle2 size={14} />
            <strong>Order cancelled on Arcium MPC</strong>
          </div>
          <div style={{ color: '#bbf7d0', fontSize: '0.72rem', wordBreak: 'break-all' }}>
            Tx:{' '}
            <a
              href={`https://explorer.solana.com/tx/${cancelResult.txSignature}?cluster=devnet`}
              target="_blank"
              rel="noreferrer"
              style={{
                color: '#86efac',
                textDecoration: 'underline',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.3rem',
              }}
            >
              {cancelResult.txSignature.slice(0, 16)}…{cancelResult.txSignature.slice(-8)}
              <ExternalLink size={11} />
            </a>
          </div>
          {cancelResult.threshold && (
            <div style={{ color: '#bbf7d0', fontSize: '0.7rem' }}>
              FROST: {cancelResult.threshold.signaturesCount} of{' '}
              {cancelResult.threshold.totalSigners} signers (threshold{' '}
              {cancelResult.threshold.threshold}).
            </div>
          )}
        </div>
      )}

      {/* Error — threshold rejected */}
      {error && errorKind === 'threshold' && (
        <div
          style={{
            marginTop: '0.9rem',
            padding: '0.9rem 1rem',
            borderRadius: '12px',
            background: 'rgba(245,158,11,0.08)',
            border: '1px solid rgba(245,158,11,0.3)',
            color: '#fcd34d',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '0.78rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
          }}
        >
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <ShieldCheck size={14} />
            <strong>
              Threshold rejected ({errorThreshold?.signaturesCount ?? '?'} of{' '}
              {errorThreshold?.totalSigners ?? '?'} signers approved, need{' '}
              {errorThreshold?.threshold ?? 2})
            </strong>
          </div>
          {errorSigners && errorSigners.length > 0 && (
            <div style={{ color: '#fde68a', fontSize: '0.72rem' }}>
              Online: {errorSigners.map((s) => `${s.region} (:${s.port})`).join(', ')}
            </div>
          )}
          <div style={{ color: '#fde68a', fontSize: '0.72rem' }}>
            The relayer refuses to sign the cancel tx without distributed quorum approval.
          </div>
        </div>
      )}

      {/* Error — FROST unreachable */}
      {error && errorKind === 'unreachable' && (
        <div
          style={{
            marginTop: '0.9rem',
            padding: '0.9rem 1rem',
            borderRadius: '12px',
            background: 'rgba(239,68,68,0.08)',
            border: '1px solid rgba(239,68,68,0.3)',
            color: '#fca5a5',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '0.78rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
          }}
        >
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <AlertTriangle size={14} />
            <strong>FROST quorum unreachable</strong>
          </div>
          <div style={{ color: '#fecaca', fontSize: '0.72rem' }}>
            Start the signers locally with:
          </div>
          <code
            style={{
              background: 'rgba(0,0,0,0.3)',
              padding: '0.4rem 0.6rem',
              borderRadius: '6px',
              color: '#fca5a5',
              fontSize: '0.72rem',
              wordBreak: 'break-all',
            }}
          >
            pnpm --filter @protocol-01/frost-signer dev:all
          </code>
        </div>
      )}

      {/* Error — not-found at cancel time */}
      {error && errorKind === 'not-found' && (
        <div
          style={{
            marginTop: '0.9rem',
            padding: '0.8rem 1rem',
            borderRadius: '12px',
            background: 'rgba(139,92,246,0.05)',
            border: '1px solid rgba(139,92,246,0.3)',
            color: '#c4b5fd',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '0.78rem',
            display: 'flex',
            gap: '0.5rem',
            alignItems: 'center',
          }}
        >
          <XCircle size={14} />
          <span>{error}</span>
        </div>
      )}

      {/* Error — generic */}
      {error && errorKind === 'generic' && (
        <div
          style={{
            marginTop: '0.9rem',
            padding: '0.8rem 1rem',
            borderRadius: '12px',
            background: 'rgba(239,68,68,0.08)',
            border: '1px solid rgba(239,68,68,0.25)',
            color: '#fca5a5',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '0.8rem',
            display: 'flex',
            gap: '0.6rem',
            alignItems: 'flex-start',
          }}
        >
          <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: '2px' }} />
          <span style={{ wordBreak: 'break-word' }}>{error}</span>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Small labelled value cell
// ═══════════════════════════════════════════════════════════════════════════

function Field({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div>
      <div style={labelStyle}>{label}</div>
      <div
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '0.85rem',
          color,
          fontWeight: 600,
        }}
      >
        {value}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Step indicator — threshold → mpc → done
// ═══════════════════════════════════════════════════════════════════════════

function StepIndicator({ phase }: { phase: CancelPhase }) {
  const steps: { key: CancelPhase; label: string; icon: React.ReactNode }[] = [
    { key: 'threshold', label: 'FROST quorum', icon: <ShieldCheck size={12} /> },
    { key: 'mpc', label: 'MPC cancel', icon: <Trash2 size={12} /> },
  ];
  const order: CancelPhase[] = ['idle', 'threshold', 'mpc', 'done'];
  const currentIdx = order.indexOf(phase);
  return (
    <div
      style={{
        display: 'flex',
        gap: '0.4rem',
        alignItems: 'center',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: '0.68rem',
        color: '#8888aa',
      }}
    >
      {steps.map((s, i) => {
        const sIdx = order.indexOf(s.key);
        const isActive = phase === s.key;
        const isDone = currentIdx > sIdx;
        const color = isDone ? '#4ade80' : isActive ? '#c4b5fd' : '#555570';
        return (
          <span
            key={s.key}
            style={{
              display: 'inline-flex',
              gap: '0.3rem',
              alignItems: 'center',
              padding: '0.3rem 0.55rem',
              borderRadius: '8px',
              border: `1px solid ${color}40`,
              background: `${color}15`,
              color,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
            }}
          >
            {isActive ? <Loader2 size={12} className="animate-spin" /> : s.icon}
            {i + 1}. {s.label}
            {isDone ? ' ✓' : ''}
          </span>
        );
      })}
    </div>
  );
}

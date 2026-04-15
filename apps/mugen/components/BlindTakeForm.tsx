'use client';

import { useCallback, useEffect, useState } from 'react';
import { Keypair } from '@solana/web3.js';
import { Loader2, RefreshCw, AlertTriangle, Search, ShieldCheck, Lock } from 'lucide-react';
import PrivacyReceipt from './PrivacyReceipt';
import type {
  FiatCurrency,
  BlindTakeRequest,
  BlindTakeResponse,
  MpcApiError,
  ThresholdMetaFailure,
  SubmitPhase,
} from '@/lib/mpc-types';

const PAYMENT_METHODS: readonly { label: string; bit: number }[] = [
  { label: 'SEPA', bit: 1 },
  { label: 'Revolut', bit: 2 },
  { label: 'Wise', bit: 4 },
  { label: 'Cash', bit: 8 },
  { label: 'Zelle', bit: 16 },
];

function genNonce(): string {
  return Keypair.generate().publicKey.toBase58();
}

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
  border: '1px solid rgba(59,130,246,0.2)',
  borderRadius: '10px',
  padding: '0.65rem 0.8rem',
  color: '#ffffff',
  fontFamily: "'Inter', sans-serif",
  fontSize: '0.9rem',
  outline: 'none',
};

const pillButtonStyle = (active: boolean): React.CSSProperties => ({
  padding: '0.45rem 0.9rem',
  borderRadius: '999px',
  border: active ? '1px solid rgba(59,130,246,0.6)' : '1px solid rgba(255,255,255,0.08)',
  background: active ? 'rgba(59,130,246,0.15)' : 'rgba(255,255,255,0.02)',
  color: active ? '#93c5fd' : '#8888aa',
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '0.7rem',
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
  cursor: 'pointer',
  transition: 'all 0.15s ease',
});

const submitButtonStyle = (disabled: boolean): React.CSSProperties => ({
  width: '100%',
  padding: '0.85rem 1rem',
  borderRadius: '12px',
  border: '1px solid rgba(139,92,246,0.35)',
  background: disabled
    ? 'rgba(139,92,246,0.08)'
    : 'linear-gradient(135deg, rgba(139,92,246,0.35), rgba(59,130,246,0.35))',
  color: '#ffffff',
  fontFamily: "'Orbitron', sans-serif",
  fontWeight: 700,
  fontSize: '0.85rem',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.6 : 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.5rem',
  transition: 'transform 0.15s ease',
});

// ═══════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════

export default function BlindTakeForm() {
  const [cryptoSol, setCryptoSol] = useState<string>('1');
  const [maxFiat, setMaxFiat] = useState<string>('200');
  const [fiatCurrency, setFiatCurrency] = useState<FiatCurrency>('EUR');
  const [methods, setMethods] = useState<number>(1);
  // Client-only nonce init — avoids SSR/CSR hydration mismatch
  // (Keypair.generate() produces fresh bytes per render).
  const [nonce, setNonce] = useState<string>('');
  useEffect(() => {
    if (!nonce) setNonce(genNonce());
  }, [nonce]);
  const [submitting, setSubmitting] = useState(false);
  const [phase, setPhase] = useState<SubmitPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<'threshold' | 'unreachable' | 'generic' | null>(null);
  const [errorSigners, setErrorSigners] = useState<{ region: string; port: number }[] | null>(null);
  const [errorThreshold, setErrorThreshold] = useState<ThresholdMetaFailure | null>(null);
  const [result, setResult] = useState<BlindTakeResponse | null>(null);

  const toggleMethod = useCallback((bit: number) => {
    setMethods((prev) => prev ^ bit);
  }, []);

  const refreshNonce = useCallback(() => {
    setNonce(genNonce());
  }, []);

  const onSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setErrorKind(null);
    setErrorSigners(null);
    setErrorThreshold(null);
    setResult(null);

    const solNum = parseFloat(cryptoSol);
    const fiatNum = parseFloat(maxFiat);
    if (!Number.isFinite(solNum) || solNum <= 0) {
      setError('Desired crypto amount must be positive');
      setErrorKind('generic');
      return;
    }
    if (!Number.isFinite(fiatNum) || fiatNum <= 0) {
      setError('Max fiat amount must be positive');
      setErrorKind('generic');
      return;
    }
    if (methods <= 0) {
      setError('Select at least one accepted payment method');
      setErrorKind('generic');
      return;
    }

    const payload: BlindTakeRequest = {
      desiredCryptoAmountLamports: Math.round(solNum * 1e9),
      maxFiatAmountCents: Math.round(fiatNum * 100),
      fiatCurrency,
      paymentMethodsMask: methods,
      takerNoncePubkey: nonce,
    };

    setSubmitting(true);
    setPhase('threshold');
    try {
      const res = await fetch('/api/trade/blind-take', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json: BlindTakeResponse | MpcApiError = await res.json();
      if (!res.ok || !('matched' in json)) {
        const errJson = json as MpcApiError;
        if (res.status === 409) {
          setErrorKind('threshold');
          setErrorSigners(errJson.signers ?? null);
          setErrorThreshold(errJson.threshold ?? null);
          setError(errJson.detail || errJson.error || 'Threshold rejected');
        } else if (res.status === 503) {
          setErrorKind('unreachable');
          setError(errJson.detail || errJson.error || 'FROST quorum unreachable');
        } else {
          setErrorKind('generic');
          setError(errJson.detail || errJson.error || `HTTP ${res.status}`);
        }
        setPhase('idle');
      } else {
        setPhase('mpc');
        setResult(json as BlindTakeResponse);
        setPhase('done');
      }
    } catch (err) {
      setErrorKind('generic');
      setError(err instanceof Error ? err.message : 'Network error');
      setPhase('idle');
    } finally {
      setSubmitting(false);
    }
  }, [cryptoSol, maxFiat, fiatCurrency, methods, nonce]);

  return (
    <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.1rem' }}>
      {/* Amounts */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.8rem' }}>
        <div>
          <label style={labelStyle}>Desired crypto (SOL)</label>
          <input
            type="number"
            step="0.01"
            min="0"
            value={cryptoSol}
            onChange={(e) => setCryptoSol(e.target.value)}
            style={inputStyle}
          />
        </div>
        <div>
          <label style={labelStyle}>Max fiat</label>
          <input
            type="number"
            step="0.01"
            min="0"
            value={maxFiat}
            onChange={(e) => setMaxFiat(e.target.value)}
            style={inputStyle}
          />
        </div>
      </div>

      {/* Currency */}
      <div>
        <label style={labelStyle}>Currency</label>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {(['EUR', 'USD'] as FiatCurrency[]).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setFiatCurrency(c)}
              style={pillButtonStyle(fiatCurrency === c)}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* Payment methods */}
      <div>
        <label style={labelStyle}>Accepted payment methods (bitmask = {methods})</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
          {PAYMENT_METHODS.map((m) => (
            <button
              key={m.bit}
              type="button"
              onClick={() => toggleMethod(m.bit)}
              style={pillButtonStyle((methods & m.bit) !== 0)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* Nonce */}
      <div>
        <label style={labelStyle}>Taker nonce</label>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <code
            style={{
              flex: 1,
              background: 'rgba(10,10,24,0.6)',
              border: '1px solid rgba(59,130,246,0.2)',
              borderRadius: '10px',
              padding: '0.55rem 0.7rem',
              color: '#93c5fd',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '0.72rem',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {nonce}
          </code>
          <button
            type="button"
            onClick={refreshNonce}
            style={{
              background: 'rgba(59,130,246,0.1)',
              border: '1px solid rgba(59,130,246,0.25)',
              borderRadius: '10px',
              padding: '0.55rem',
              color: '#93c5fd',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
            }}
            title="Regenerate nonce"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {/* Submit */}
      <button type="submit" disabled={submitting} style={submitButtonStyle(submitting)}>
        {submitting && phase === 'threshold' ? (
          <>
            <ShieldCheck size={14} />
            <Loader2 size={14} className="animate-spin" />
            Step 1/2 · Requesting 2-of-3 FROST quorum…
          </>
        ) : submitting && phase === 'mpc' ? (
          <>
            <Lock size={14} />
            <Loader2 size={14} className="animate-spin" />
            Step 2/2 · Running MPC match…
          </>
        ) : (
          <>
            <Search size={14} />
            Attempt blind take
          </>
        )}
      </button>

      {/* Step indicator */}
      {(submitting || phase === 'done') && <StepIndicator phase={phase} />}

      {/* Error — threshold rejected */}
      {error && errorKind === 'threshold' && (
        <div
          style={{
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
            The relayer refuses to sign the MPC tx without distributed quorum approval.
          </div>
        </div>
      )}

      {/* Error — FROST unreachable */}
      {error && errorKind === 'unreachable' && (
        <div
          style={{
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

      {/* Error — generic */}
      {error && errorKind === 'generic' && (
        <div
          style={{
            display: 'flex',
            gap: '0.6rem',
            alignItems: 'flex-start',
            padding: '0.8rem 1rem',
            borderRadius: '12px',
            background: 'rgba(239,68,68,0.08)',
            border: '1px solid rgba(239,68,68,0.25)',
            color: '#fca5a5',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '0.8rem',
          }}
        >
          <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: '2px' }} />
          <span style={{ wordBreak: 'break-word' }}>{error}</span>
        </div>
      )}

      {/* Result — Privacy Receipt (matched or no-match) */}
      {result && (
        <PrivacyReceipt
          operation="take"
          computationOffset={result.computationOffset}
          txSignature={result.txSignature}
          threshold={result.threshold}
          matched={result.matched}
          matchedOrder={result.matched ? result.matchedOrder : undefined}
          takerNoncePubkey={nonce}
          fiatCurrency={fiatCurrency}
        />
      )}

      {/* Matched-only details */}
      {result && result.matched && (
        <div
          style={{
            padding: '0.8rem 1rem',
            borderRadius: '12px',
            background: 'rgba(34,197,94,0.05)',
            border: '1px solid rgba(34,197,94,0.2)',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.3rem',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '0.72rem',
          }}
        >
          <div style={{ wordBreak: 'break-all' }}>
            <span style={{ color: '#8888aa' }}>matched order nonce: </span>
            <span style={{ color: '#86efac' }}>{result.matchedOrderNonce}</span>
          </div>
          <div>
            <span style={{ color: '#8888aa' }}>crypto: </span>
            <span style={{ color: '#86efac' }}>
              {(result.matchedCryptoAmount / 1e9).toFixed(4)} SOL
            </span>
            <span style={{ color: '#555570' }}> ({result.matchedCryptoAmount.toLocaleString()} lamports)</span>
          </div>
          <div>
            <span style={{ color: '#8888aa' }}>fiat: </span>
            <span style={{ color: '#86efac' }}>
              {(result.matchedFiatAmount / 100).toFixed(2)} {fiatCurrency}
            </span>
          </div>
        </div>
      )}
    </form>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Step indicator — 2-step progress (threshold → mpc)
// ═══════════════════════════════════════════════════════════════════════════

function StepIndicator({ phase }: { phase: SubmitPhase }) {
  const steps: { key: SubmitPhase; label: string; icon: React.ReactNode }[] = [
    { key: 'threshold', label: 'FROST quorum', icon: <ShieldCheck size={12} /> },
    { key: 'mpc', label: 'MPC match', icon: <Lock size={12} /> },
  ];
  const order: SubmitPhase[] = ['idle', 'threshold', 'mpc', 'done'];
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
        const color = isDone ? '#4ade80' : isActive ? '#93c5fd' : '#555570';
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

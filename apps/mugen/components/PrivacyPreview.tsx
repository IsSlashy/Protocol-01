'use client';

import { useEffect, useState } from 'react';
import { Shield, Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react';

// ─── Types ──────────────────────────────────────────────────────────────────
// Matches the shape of POST /api/denomination/plan. Redeclared here since
// Next.js doesn't share API types natively. Keep in sync with the route.

export interface DenominationSplit {
  /** Denomination value in SOL (e.g. 1.0, 0.1, 0.01) */
  denomination: number;
  /** Number of notes of this denomination */
  count: number;
}

export interface DenominationPlanResponse {
  /** Breakdown by denomination. Only entries with count > 0. */
  splits: DenominationSplit[];
  /** Sum of all splits in SOL (routed privately through the pool). */
  canonicalSolTotal: number;
  /** Leftover fiat that couldn't fit canonical denominations. */
  residualFiat: number;
  /** Residual as a percentage of total fiat [0..100]. */
  residualPercent: number;
  /** Non-null when residual exceeds the configured ratio. */
  privacyWarning: string | null;
  /** Spot price used for the split (fiat per 1 SOL). */
  solPriceInFiat: number;
  /** Fiat currency echoed back. */
  fiatCurrency: 'USD' | 'EUR';
  /** Server timestamp. */
  timestamp: number;
  /** Largest denomination used in the split. */
  maxDenomination: number;
}

interface PrivacyPreviewProps {
  fiatAmount: number;
  fiatCurrency: 'USD' | 'EUR';
  token: string;
}

type FetchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: DenominationPlanResponse }
  | { status: 'error'; message: string };

// ─── Helpers ────────────────────────────────────────────────────────────────

function residualCue(percent: number): {
  border: string;
  glow: string;
  icon: 'ok' | 'warn' | 'danger' | 'neutral';
  message: string;
  color: string;
} {
  if (percent <= 5) {
    return {
      border: '#22c55e',
      glow: 'rgba(34,197,94,0.12)',
      icon: 'ok',
      message: 'Low residual — strong privacy',
      color: '#22c55e',
    };
  }
  if (percent <= 15) {
    return {
      border: '#3b82f6',
      glow: 'rgba(59,130,246,0.12)',
      icon: 'neutral',
      message: 'Acceptable residual — privacy preserved',
      color: '#60a5fa',
    };
  }
  if (percent <= 30) {
    return {
      border: '#f59e0b',
      glow: 'rgba(245,158,11,0.12)',
      icon: 'warn',
      message: 'Residual >15% — consider paying a bit more for stronger privacy',
      color: '#f59e0b',
    };
  }
  return {
    border: '#ef4444',
    glow: 'rgba(239,68,68,0.12)',
    icon: 'danger',
    message: 'Residual very high — adjust the amount for meaningful privacy',
    color: '#ef4444',
  };
}

function formatFiat(amount: number, currency: 'USD' | 'EUR'): string {
  const symbol = currency === 'USD' ? '$' : '€';
  return `${symbol}${amount.toFixed(2)}`;
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function PrivacyPreview({ fiatAmount, fiatCurrency, token }: PrivacyPreviewProps) {
  const [state, setState] = useState<FetchState>({ status: 'idle' });

  const enabled = fiatAmount > 0 && token === 'SOL' && (fiatCurrency === 'USD' || fiatCurrency === 'EUR');

  useEffect(() => {
    if (!enabled) {
      setState({ status: 'idle' });
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setState({ status: 'loading' });
      try {
        const res = await fetch('/api/denomination/plan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fiatAmount, fiatCurrency, usePoolSupportedOnly: true }),
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = (await res.json()) as DenominationPlanResponse;
        setState({ status: 'success', data });
      } catch (err) {
        if (controller.signal.aborted) return;
        const message = err instanceof Error ? err.message : 'unknown error';
        setState({ status: 'error', message });
      }
    }, 500);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [fiatAmount, fiatCurrency, token, enabled]);

  if (!enabled) return null;

  // Base card styling, mirrors the GlassCard aesthetic from pay/page.tsx and
  // how-it-works/page.tsx — translucent background, subtle top highlight, glow.
  const cardBase: React.CSSProperties = {
    position: 'relative',
    width: '100%',
    maxWidth: '600px',
    margin: '0 auto 1.25rem',
    padding: '1.1rem 1.1rem 1rem',
    borderRadius: '16px',
    background: 'rgba(255,255,255,0.03)',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    border: '1px solid rgba(255,255,255,0.06)',
    overflow: 'hidden',
    boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
  };

  if (state.status === 'loading' || state.status === 'idle') {
    return (
      <div style={cardBase}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <Loader2 size={14} style={{ color: '#8b5cf6', animation: 'spin 1s linear infinite' }} />
          <span style={{ fontSize: '0.72rem', color: '#8888aa', fontFamily: "'JetBrains Mono',monospace" }}>
            Computing privacy split...
          </span>
        </div>
        <style dangerouslySetInnerHTML={{ __html: '@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}' }} />
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div style={{ ...cardBase, borderLeft: '3px solid rgba(255,255,255,0.1)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <AlertTriangle size={14} style={{ color: '#8888aa' }} />
          <span style={{ fontSize: '0.7rem', color: '#8888aa', fontFamily: "'JetBrains Mono',monospace" }}>
            Privacy split unavailable — payment will proceed without split preview
          </span>
        </div>
      </div>
    );
  }

  const { data } = state;
  const cue = residualCue(data.residualPercent);

  const labelStyle: React.CSSProperties = {
    fontSize: '0.6rem',
    color: '#555570',
    fontFamily: "'JetBrains Mono',monospace",
    textTransform: 'uppercase',
    letterSpacing: '0.15em',
  };
  const valueStyle: React.CSSProperties = {
    fontSize: '0.78rem',
    color: 'white',
    fontFamily: "'JetBrains Mono',monospace",
  };
  const divider: React.CSSProperties = {
    height: '1px',
    background: 'rgba(255,255,255,0.05)',
    margin: '0.7rem 0',
  };

  return (
    <div
      style={{
        ...cardBase,
        borderLeft: `3px solid ${cue.border}`,
      }}
    >
      {/* Gradient glow */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: '1px',
          background: `linear-gradient(90deg, transparent, ${cue.glow}, transparent)`,
        }}
      />

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.9rem' }}>
        <Shield size={14} style={{ color: '#8b5cf6' }} />
        <span
          style={{
            fontSize: '0.7rem',
            color: 'white',
            fontFamily: "'Orbitron',sans-serif",
            fontWeight: 700,
            letterSpacing: '0.15em',
            textTransform: 'uppercase',
          }}
        >
          Privacy Breakdown
        </span>
      </div>

      {/* You pay */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={labelStyle}>You pay</span>
        <span style={valueStyle}>{formatFiat(fiatAmount, data.fiatCurrency)}</span>
      </div>

      <div style={divider} />

      {/* Routed privately */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
        <span style={labelStyle}>Routed privately</span>
        <span style={{ ...valueStyle, color: '#a78bfa' }}>
          {data.canonicalSolTotal.toFixed(4)} SOL
          <span style={{ color: '#555570', marginLeft: '0.4rem' }}>
            ({formatFiat(data.canonicalSolTotal * data.solPriceInFiat, data.fiatCurrency)} eq.)
          </span>
        </span>
      </div>

      {/* Splits */}
      <ul style={{ listStyle: 'none', margin: 0, padding: '0 0 0 0.6rem' }}>
        {data.splits.map(s => (
          <li
            key={s.denomination}
            style={{
              fontSize: '0.7rem',
              color: '#8888aa',
              fontFamily: "'JetBrains Mono',monospace",
              padding: '0.15rem 0',
            }}
          >
            <span style={{ color: '#555570' }}>•</span>{' '}
            {s.count}× {s.denomination} SOL
          </li>
        ))}
      </ul>

      <div style={divider} />

      {/* Residual */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={labelStyle}>Tracked residual</span>
        <span style={valueStyle}>
          {formatFiat(data.residualFiat, data.fiatCurrency)}{' '}
          <span style={{ color: cue.color }}>({data.residualPercent.toFixed(1)}%)</span>
        </span>
      </div>

      {/* Message */}
      <div
        style={{
          marginTop: '0.9rem',
          padding: '0.55rem 0.7rem',
          borderRadius: '10px',
          background: cue.glow,
          border: `1px solid ${cue.border}22`,
          display: 'flex',
          alignItems: 'flex-start',
          gap: '0.5rem',
        }}
      >
        {cue.icon === 'ok' && <CheckCircle2 size={12} style={{ color: cue.color, marginTop: '0.15rem', flexShrink: 0 }} />}
        {cue.icon === 'neutral' && <Shield size={12} style={{ color: cue.color, marginTop: '0.15rem', flexShrink: 0 }} />}
        {(cue.icon === 'warn' || cue.icon === 'danger') && (
          <AlertTriangle size={12} style={{ color: cue.color, marginTop: '0.15rem', flexShrink: 0 }} />
        )}
        <span
          style={{
            fontSize: '0.68rem',
            color: cue.color,
            fontFamily: "'JetBrains Mono',monospace",
            lineHeight: 1.5,
          }}
        >
          {cue.message}
        </span>
      </div>
    </div>
  );
}

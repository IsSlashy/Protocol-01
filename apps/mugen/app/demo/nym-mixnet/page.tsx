'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  Globe,
  Loader2,
  Radio,
  ShieldCheck,
  Waves,
  XCircle,
  Zap,
} from 'lucide-react';
import MugenNavbar from '@/components/MugenNavbar';
import {
  getNymState,
  initNym,
  nymFetch,
  onNymStateChange,
  resetNym,
  type NymFetchResult,
  type NymMetadata,
} from '@/lib/nym';

// ═══════════════════════════════════════════════════════════════════════════
// GLASS CARD
// ═══════════════════════════════════════════════════════════════════════════

function GlassCard({
  children,
  glow,
  style,
}: {
  children: React.ReactNode;
  glow?: 'blue' | 'violet';
  style?: React.CSSProperties;
}) {
  const glowShadow =
    glow === 'blue'
      ? '0 8px 32px rgba(59,130,246,0.12), 0 0 60px rgba(59,130,246,0.04)'
      : glow === 'violet'
        ? '0 8px 32px rgba(139,92,246,0.12), 0 0 60px rgba(139,92,246,0.04)'
        : '0 8px 32px rgba(0,0,0,0.3)';

  return (
    <div
      style={{
        position: 'relative',
        background: 'rgba(255,255,255,0.03)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: '20px',
        padding: '2rem',
        boxShadow: glowShadow,
        overflow: 'hidden',
        ...style,
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: '1px',
          background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent)',
        }}
      />
      {children}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// HOP CHAIN VISUAL
// ═══════════════════════════════════════════════════════════════════════════

type HopState = 'idle' | 'active' | 'done';

function HopChain({ state }: { state: HopState }) {
  const nodes = ['You', 'Entry', 'Hop 1', 'Hop 2', 'Hop 3', 'Exit', 'Target'];
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.3rem',
        flexWrap: 'wrap',
        justifyContent: 'center',
        margin: '1rem 0',
      }}
    >
      {nodes.map((name, i) => {
        const isFirst = i === 0;
        const isLast = i === nodes.length - 1;
        const isEntry = name === 'Entry';
        const isExit = name === 'Exit';
        const isMix = name.startsWith('Hop');
        const color = isFirst
          ? '#60a5fa'
          : isLast
            ? '#22c55e'
            : isEntry || isExit
              ? '#a78bfa'
              : '#8b5cf6';

        return (
          <div key={name} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
            <div
              style={{
                padding: '0.4rem 0.6rem',
                borderRadius: '8px',
                background: `linear-gradient(135deg, ${color}20, ${color}08)`,
                border: `1px solid ${color}40`,
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '0.65rem',
                color,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                fontWeight: 600,
                boxShadow: state === 'active' && isMix ? `0 0 10px ${color}60` : undefined,
                animation: state === 'active' && isMix ? 'pulse 1.2s infinite' : undefined,
              }}
            >
              {name}
            </div>
            {i < nodes.length - 1 && (
              <ArrowRight size={10} style={{ color: '#444466', flexShrink: 0 }} />
            )}
          </div>
        );
      })}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.55; }
        }
      `}</style>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// STATUS PILL
// ═══════════════════════════════════════════════════════════════════════════

function StatePill({ state }: { state: NymMetadata['state'] }) {
  const config = {
    uninitialized: { label: 'Uninitialized', color: '#8888aa', bg: 'rgba(136,136,170,0.1)', border: 'rgba(136,136,170,0.3)' },
    initializing: { label: 'Initializing…', color: '#fbbf24', bg: 'rgba(251,191,36,0.1)', border: 'rgba(251,191,36,0.3)' },
    ready: { label: 'Ready', color: '#22c55e', bg: 'rgba(34,197,94,0.1)', border: 'rgba(34,197,94,0.3)' },
    error: { label: 'Error', color: '#ef4444', bg: 'rgba(239,68,68,0.1)', border: 'rgba(239,68,68,0.3)' },
  }[state];

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.35rem',
        padding: '0.25rem 0.6rem',
        borderRadius: '999px',
        background: config.bg,
        border: `1px solid ${config.border}`,
        color: config.color,
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: '0.65rem',
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        fontWeight: 600,
      }}
    >
      <span
        style={{
          width: '7px',
          height: '7px',
          borderRadius: '50%',
          background: config.color,
          boxShadow: `0 0 8px ${config.color}`,
        }}
      />
      {config.label}
    </span>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PAGE
// ═══════════════════════════════════════════════════════════════════════════

const TARGETS = [
  {
    id: 'solana-devnet',
    label: 'Solana Devnet — getSlot',
    url: process.env.NEXT_PUBLIC_SOLANA_RPC ?? 'https://api.devnet.solana.com',
    method: 'POST' as const,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot' }),
  },
  {
    id: 'solana-mainnet',
    label: 'Solana Mainnet — getSlot',
    url: 'https://api.mainnet-beta.solana.com',
    method: 'POST' as const,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot' }),
  },
  {
    id: 'httpbin',
    label: 'httpbin.org/get — echoes apparent IP',
    url: 'https://httpbin.org/get',
    method: 'GET' as const,
    body: undefined,
  },
];

export default function NymMixnetDemoPage() {
  const [meta, setMeta] = useState<NymMetadata>(() => getNymState());
  const [targetId, setTargetId] = useState<string>(TARGETS[0]!.id);
  const [busy, setBusy] = useState<'mix' | 'plain' | null>(null);
  const [result, setResult] = useState<NymFetchResult<unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const unsub = onNymStateChange((m) => {
      if (mountedRef.current) setMeta(m);
    });
    return () => {
      mountedRef.current = false;
      unsub();
    };
  }, []);

  const target = useMemo(() => TARGETS.find((t) => t.id === targetId) ?? TARGETS[0]!, [targetId]);

  const handleConnect = useCallback(async () => {
    setError(null);
    try {
      await initNym();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handleReset = useCallback(async () => {
    await resetNym();
    setResult(null);
    setError(null);
  }, []);

  const handleRunMix = useCallback(async () => {
    if (busy) return;
    setBusy('mix');
    setError(null);
    setResult(null);
    try {
      const res = await nymFetch(target.url, {
        method: target.method,
        headers: target.body ? { 'content-type': 'application/json' } : undefined,
        body: target.body,
        disableFallback: true,
      });
      if (mountedRef.current) setResult(res);
    } catch (err: unknown) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [busy, target]);

  const handleRunPlain = useCallback(async () => {
    if (busy) return;
    setBusy('plain');
    setError(null);
    setResult(null);
    try {
      const start = Date.now();
      const response = await fetch(target.url, {
        method: target.method,
        headers: target.body ? { 'content-type': 'application/json' } : undefined,
        body: target.body,
      });
      const latencyMs = Date.now() - start;
      const clone = response.clone();
      let data: unknown;
      try {
        data = await clone.json();
      } catch {
        data = await response.text();
      }
      if (mountedRef.current) {
        setResult({ response, data, viaMixnet: false, latencyMs, hops: 0 });
      }
    } catch (err: unknown) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [busy, target]);

  const hopState: HopState =
    busy === 'mix' ? 'active' : result?.viaMixnet ? 'done' : 'idle';

  return (
    <div
      style={{
        minHeight: '100vh',
        background:
          'radial-gradient(ellipse at top, #0a0a1a 0%, #050510 60%, #000000 100%)',
        color: '#ffffff',
        fontFamily: "'Inter', system-ui, sans-serif",
      }}
    >
      <MugenNavbar />

      <main style={{ maxWidth: '64rem', margin: '0 auto', padding: '6rem 1.5rem 6rem' }}>
        {/* ───── HERO ───── */}
        <header style={{ textAlign: 'center', marginBottom: '3rem' }}>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.4rem',
              padding: '0.3rem 0.8rem',
              borderRadius: '999px',
              background: 'rgba(59,130,246,0.1)',
              border: '1px solid rgba(59,130,246,0.3)',
              color: '#60a5fa',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '0.65rem',
              letterSpacing: '0.15em',
              textTransform: 'uppercase',
              marginBottom: '1rem',
            }}
          >
            <Waves size={11} />
            Web MVP
          </div>
          <h1
            style={{
              fontFamily: "'Orbitron', sans-serif",
              fontSize: 'clamp(2rem, 5vw, 3rem)',
              fontWeight: 700,
              margin: 0,
              background: 'linear-gradient(135deg, #60a5fa, #a78bfa)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              letterSpacing: '-0.02em',
            }}
          >
            Demo: Nym 5-hop Mixnet
          </h1>
          <p
            style={{
              marginTop: '1rem',
              color: '#a78bfa',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '0.85rem',
              letterSpacing: '0.05em',
            }}
          >
            Layer 0 of the Privacy Stack — your IP never touches the destination
          </p>
          <p
            style={{
              marginTop: '1.5rem',
              color: '#8888aa',
              lineHeight: 1.7,
              fontSize: '0.95rem',
              maxWidth: '40rem',
              margin: '1.5rem auto 0',
            }}
          >
            This page runs the Nym <code style={{ color: '#60a5fa' }}>mixFetch</code> client in
            your browser. When you trigger a test request, it's routed through a Nym entry
            gateway, 3 mix nodes, and a Nym exit gateway before reaching the destination. No
            observer — including the destination — sees your IP.
          </p>
        </header>

        {/* ───── SECTION 1 — CLIENT STATUS ───── */}
        <section style={{ marginBottom: '3rem' }}>
          <h2
            style={{
              fontFamily: "'Orbitron', sans-serif",
              fontSize: '1.1rem',
              color: '#ffffff',
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
              marginBottom: '1rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
            }}
          >
            <Radio size={16} style={{ color: '#60a5fa' }} />
            Nym Client
          </h2>
          <GlassCard glow="blue">
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '1rem',
                marginBottom: '1rem',
              }}
            >
              <div>
                <div
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '0.7rem',
                    color: '#666688',
                    letterSpacing: '0.1em',
                    textTransform: 'uppercase',
                    marginBottom: '0.35rem',
                  }}
                >
                  State
                </div>
                <StatePill state={meta.state} />
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '0.7rem',
                    color: '#666688',
                    letterSpacing: '0.1em',
                    textTransform: 'uppercase',
                    marginBottom: '0.35rem',
                  }}
                >
                  Entry Gateway
                </div>
                <code
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '0.75rem',
                    color: meta.entryGatewayId ? '#a78bfa' : '#555570',
                    wordBreak: 'break-all',
                  }}
                >
                  {meta.entryGatewayId ?? '—'}
                </code>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {meta.state !== 'ready' && meta.state !== 'initializing' && (
                  <button
                    onClick={handleConnect}
                    style={{
                      padding: '0.55rem 1rem',
                      borderRadius: '10px',
                      background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
                      border: 'none',
                      color: '#ffffff',
                      fontFamily: "'Orbitron', sans-serif",
                      fontSize: '0.75rem',
                      letterSpacing: '0.1em',
                      textTransform: 'uppercase',
                      cursor: 'pointer',
                      fontWeight: 700,
                    }}
                  >
                    Connect to Nym
                  </button>
                )}
                {meta.state === 'ready' && (
                  <button
                    onClick={handleReset}
                    style={{
                      padding: '0.55rem 1rem',
                      borderRadius: '10px',
                      background: 'rgba(255,255,255,0.05)',
                      border: '1px solid rgba(255,255,255,0.12)',
                      color: '#8888aa',
                      fontFamily: "'Orbitron', sans-serif",
                      fontSize: '0.75rem',
                      letterSpacing: '0.1em',
                      textTransform: 'uppercase',
                      cursor: 'pointer',
                    }}
                  >
                    Reset
                  </button>
                )}
              </div>
            </div>

            <HopChain state={hopState} />

            {meta.error && (
              <div
                style={{
                  marginTop: '0.75rem',
                  padding: '0.75rem 1rem',
                  borderRadius: '10px',
                  background: 'rgba(239,68,68,0.08)',
                  border: '1px solid rgba(239,68,68,0.25)',
                  color: '#fca5a5',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '0.75rem',
                }}
              >
                {meta.error}
              </div>
            )}
          </GlassCard>
        </section>

        {/* ───── SECTION 2 — TEST REQUEST ───── */}
        <section style={{ marginBottom: '3rem' }}>
          <h2
            style={{
              fontFamily: "'Orbitron', sans-serif",
              fontSize: '1.1rem',
              color: '#ffffff',
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
              marginBottom: '1rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
            }}
          >
            <Globe size={16} style={{ color: '#a78bfa' }} />
            Test Request
          </h2>
          <GlassCard glow="violet">
            <label
              style={{
                display: 'block',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '0.7rem',
                color: '#666688',
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                marginBottom: '0.5rem',
              }}
            >
              Target URL
            </label>
            <select
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              disabled={busy !== null}
              style={{
                width: '100%',
                padding: '0.65rem 0.9rem',
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(139,92,246,0.3)',
                borderRadius: '10px',
                color: '#ffffff',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '0.8rem',
                marginBottom: '1rem',
              }}
            >
              {TARGETS.map((t) => (
                <option key={t.id} value={t.id} style={{ background: '#0a0a1a' }}>
                  {t.label}
                </option>
              ))}
            </select>

            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
              <button
                onClick={handleRunMix}
                disabled={busy !== null}
                style={{
                  flex: 1,
                  minWidth: '14rem',
                  padding: '0.75rem 1rem',
                  borderRadius: '12px',
                  background:
                    busy === 'mix'
                      ? 'rgba(139,92,246,0.25)'
                      : 'linear-gradient(135deg, #8b5cf6, #3b82f6)',
                  border: 'none',
                  color: '#ffffff',
                  fontFamily: "'Orbitron', sans-serif",
                  fontSize: '0.78rem',
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                  cursor: busy !== null ? 'not-allowed' : 'pointer',
                  fontWeight: 700,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.5rem',
                  opacity: busy !== null && busy !== 'mix' ? 0.5 : 1,
                }}
              >
                {busy === 'mix' ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <ShieldCheck size={14} />
                )}
                Run via Nym
              </button>
              <button
                onClick={handleRunPlain}
                disabled={busy !== null}
                style={{
                  flex: 1,
                  minWidth: '14rem',
                  padding: '0.75rem 1rem',
                  borderRadius: '12px',
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  color: '#8888aa',
                  fontFamily: "'Orbitron', sans-serif",
                  fontSize: '0.78rem',
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                  cursor: busy !== null ? 'not-allowed' : 'pointer',
                  fontWeight: 700,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.5rem',
                  opacity: busy !== null && busy !== 'plain' ? 0.5 : 1,
                }}
              >
                {busy === 'plain' ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Zap size={14} />
                )}
                Run Plain Fetch (Comparison)
              </button>
            </div>

            {error && (
              <div
                style={{
                  marginTop: '1rem',
                  padding: '0.75rem 1rem',
                  borderRadius: '10px',
                  background: 'rgba(239,68,68,0.08)',
                  border: '1px solid rgba(239,68,68,0.25)',
                  color: '#fca5a5',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '0.75rem',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '0.5rem',
                }}
              >
                <XCircle size={14} style={{ flexShrink: 0, marginTop: '2px' }} />
                <span style={{ wordBreak: 'break-word' }}>{error}</span>
              </div>
            )}

            {result && (
              <div
                style={{
                  marginTop: '1rem',
                  padding: '1rem',
                  borderRadius: '12px',
                  background: result.viaMixnet
                    ? 'linear-gradient(135deg, rgba(34,197,94,0.05), rgba(139,92,246,0.04))'
                    : 'rgba(251,191,36,0.05)',
                  border: `1px solid ${
                    result.viaMixnet ? 'rgba(34,197,94,0.25)' : 'rgba(251,191,36,0.25)'
                  }`,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    marginBottom: '0.75rem',
                    fontFamily: "'Orbitron', sans-serif",
                    fontSize: '0.8rem',
                    fontWeight: 700,
                    color: result.viaMixnet ? '#86efac' : '#fbbf24',
                    textTransform: 'uppercase',
                    letterSpacing: '0.1em',
                  }}
                >
                  <CheckCircle2 size={14} />
                  {result.viaMixnet ? 'Via Mixnet' : 'Plain Fetch'}
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
                    gap: '0.75rem',
                    marginBottom: '0.75rem',
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '0.75rem',
                  }}
                >
                  <div>
                    <div style={{ color: '#666688', fontSize: '0.65rem', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: '0.2rem' }}>
                      Latency
                    </div>
                    <div style={{ color: '#ffffff' }}>{result.latencyMs} ms</div>
                  </div>
                  <div>
                    <div style={{ color: '#666688', fontSize: '0.65rem', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: '0.2rem' }}>
                      Hops
                    </div>
                    <div style={{ color: '#ffffff' }}>{result.hops}</div>
                  </div>
                  <div>
                    <div style={{ color: '#666688', fontSize: '0.65rem', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: '0.2rem' }}>
                      Status
                    </div>
                    <div style={{ color: '#ffffff' }}>{result.response.status}</div>
                  </div>
                </div>
                <div
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '0.65rem',
                    color: '#666688',
                    letterSpacing: '0.1em',
                    textTransform: 'uppercase',
                    marginBottom: '0.35rem',
                  }}
                >
                  Response Snippet
                </div>
                <pre
                  style={{
                    background: 'rgba(0,0,0,0.4)',
                    border: '1px solid rgba(255,255,255,0.06)',
                    borderRadius: '8px',
                    padding: '0.75rem',
                    margin: 0,
                    color: '#a78bfa',
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '0.7rem',
                    lineHeight: 1.5,
                    overflow: 'auto',
                    maxHeight: '14rem',
                  }}
                >
                  {(() => {
                    try {
                      const s = JSON.stringify(result.data, null, 2);
                      return s.length > 2000 ? s.slice(0, 2000) + '\n…' : s;
                    } catch {
                      const s = String(result.data);
                      return s.length > 2000 ? s.slice(0, 2000) + '…' : s;
                    }
                  })()}
                </pre>
              </div>
            )}
          </GlassCard>
        </section>

        {/* ───── SECTION 3 — THE PRIVACY CLAIM ───── */}
        <section style={{ marginBottom: '3rem' }}>
          <h2
            style={{
              fontFamily: "'Orbitron', sans-serif",
              fontSize: '1.1rem',
              color: '#ffffff',
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
              marginBottom: '1rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
            }}
          >
            <ShieldCheck size={16} style={{ color: '#22c55e' }} />
            What Nym gives you
          </h2>
          <GlassCard>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(16rem, 1fr))', gap: '1rem' }}>
              {[
                {
                  title: '5-hop routing',
                  body: 'Your traffic passes through 3 mix nodes between an entry and exit gateway. No single node sees both sender and destination.',
                },
                {
                  title: 'Sphinx packet format',
                  body: 'Every packet is onion-encrypted with layered Sphinx headers. Each hop peels one layer; correlation attacks on packet shape fail.',
                },
                {
                  title: 'Cover traffic + delays',
                  body: "Clients emit constant-rate loops and fake messages. Timing analysis can't distinguish your request from noise.",
                },
                {
                  title: 'Unlinkable from IP',
                  body: 'The destination sees the exit gateway — not your IP. Not even Nym operators can correlate sender to destination.',
                },
              ].map((f) => (
                <div
                  key={f.title}
                  style={{
                    padding: '1rem',
                    background: 'rgba(255,255,255,0.02)',
                    border: '1px solid rgba(255,255,255,0.06)',
                    borderRadius: '12px',
                  }}
                >
                  <div
                    style={{
                      fontFamily: "'Orbitron', sans-serif",
                      fontSize: '0.85rem',
                      color: '#60a5fa',
                      fontWeight: 700,
                      marginBottom: '0.45rem',
                    }}
                  >
                    {f.title}
                  </div>
                  <div style={{ color: '#8888aa', fontSize: '0.8rem', lineHeight: 1.6 }}>{f.body}</div>
                </div>
              ))}
            </div>
            <div
              style={{
                marginTop: '1.5rem',
                padding: '1rem',
                background: 'rgba(251,191,36,0.05)',
                border: '1px solid rgba(251,191,36,0.2)',
                borderRadius: '10px',
                color: '#fbbf24',
                fontSize: '0.78rem',
                lineHeight: 1.6,
              }}
            >
              <strong style={{ fontFamily: "'Orbitron', sans-serif", letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                Honest limits:
              </strong>{' '}
              Nym is slower than plain HTTPS — expect 1–5s per round trip in the real world.
              Gateway discovery depends on Nym's validator API. This demo is browser-only; the
              mobile app uses a different strategy (Phase 2). The mixnet is not yet wired into
              the encrypted buy flow — that's intentional, because latency can affect trade UX
              and we're keeping opt-in for now.
            </div>
            <a
              href="https://nym.com"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.4rem',
                marginTop: '1.25rem',
                color: '#60a5fa',
                textDecoration: 'none',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '0.75rem',
                letterSpacing: '0.08em',
              }}
            >
              Learn more at nym.com <ExternalLink size={11} />
            </a>
          </GlassCard>
        </section>

        {/* ───── FOOTER NAV ───── */}
        <div style={{ textAlign: 'center', paddingTop: '1rem' }}>
          <Link
            href="/how-it-works"
            style={{
              color: '#8888aa',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '0.75rem',
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              textDecoration: 'none',
            }}
          >
            ← Back to How It Works
          </Link>
        </div>
      </main>
    </div>
  );
}

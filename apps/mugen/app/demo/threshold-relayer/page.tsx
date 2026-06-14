'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  Layers,
  Loader2,
  Network,
  Radio,
  ShieldCheck,
  Wifi,
  WifiOff,
  XCircle,
  Zap,
} from 'lucide-react';
import MugenNavbar from '@/components/MugenNavbar';
import {
  DEFAULT_SIGNER_PORTS,
  DEFAULT_THRESHOLD,
  generateTxHashHex,
  getSignerInfos,
  regionLabelForPort,
  requestThresholdApproval,
  type SignerInfo,
  type SignerSignature,
  type ThresholdApproval,
} from '@/lib/frost-coordinator';

// ═══════════════════════════════════════════════════════════════════════════
// GLASS CARD — matches encrypted-flow / how-it-works style
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
// SIGNER STATUS GRID
// ═══════════════════════════════════════════════════════════════════════════

function SignerCard({ signer }: { signer: SignerInfo }) {
  const online = signer.online;
  const truncatedKey = signer.pubkey
    ? `${signer.pubkey.slice(0, 8)}…${signer.pubkey.slice(-6)}`
    : '—';

  return (
    <div
      style={{
        position: 'relative',
        background: online
          ? 'linear-gradient(135deg, rgba(34,197,94,0.06), rgba(59,130,246,0.04))'
          : 'rgba(239,68,68,0.04)',
        border: `1px solid ${online ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)'}`,
        borderRadius: '14px',
        padding: '1.1rem 1.2rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.55rem',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem' }}>
          <span
            style={{
              width: '9px',
              height: '9px',
              borderRadius: '50%',
              background: online ? '#22c55e' : '#ef4444',
              boxShadow: online ? '0 0 10px #22c55e' : '0 0 8px #ef4444',
            }}
          />
          <span
            style={{
              fontFamily: "'Orbitron', sans-serif",
              fontSize: '0.85rem',
              fontWeight: 700,
              color: '#ffffff',
              letterSpacing: '0.05em',
            }}
          >
            {signer.region}
          </span>
        </div>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.3rem',
            padding: '0.18rem 0.5rem',
            borderRadius: '999px',
            background: online ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
            border: `1px solid ${online ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.35)'}`,
            color: online ? '#86efac' : '#fca5a5',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '0.6rem',
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
          }}
        >
          {online ? <Wifi size={9} /> : <WifiOff size={9} />}
          {online ? 'Online' : 'Offline'}
        </span>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          color: '#8888aa',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '0.7rem',
        }}
      >
        <Radio size={11} />
        <span>:{signer.port}</span>
        <span style={{ color: '#444466' }}>·</span>
        <span style={{ color: '#666688' }}>{signer.signerId}</span>
      </div>
      <div
        style={{
          color: online ? '#a78bfa' : '#665577',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '0.72rem',
          wordBreak: 'break-all',
        }}
        title={signer.pubkey || 'no pubkey'}
      >
        {truncatedKey}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// STEPPER — per-signer pending/signed/failed status
// ═══════════════════════════════════════════════════════════════════════════

type StepState = 'pending' | 'signed' | 'failed';

interface StepRow {
  port: number;
  region: string;
  state: StepState;
  signature?: SignerSignature;
}

function StepperRow({ row }: { row: StepRow }) {
  const colors: Record<StepState, { bg: string; border: string; text: string }> = {
    pending: { bg: 'rgba(255,255,255,0.04)', border: 'rgba(255,255,255,0.08)', text: '#8888aa' },
    signed: { bg: 'rgba(34,197,94,0.08)', border: 'rgba(34,197,94,0.3)', text: '#86efac' },
    failed: { bg: 'rgba(239,68,68,0.08)', border: 'rgba(239,68,68,0.3)', text: '#fca5a5' },
  };
  const c = colors[row.state];
  const Icon = row.state === 'pending' ? Loader2 : row.state === 'signed' ? CheckCircle2 : XCircle;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '0.6rem',
        padding: '0.65rem 0.9rem',
        background: c.bg,
        border: `1px solid ${c.border}`,
        borderRadius: '10px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', minWidth: 0 }}>
        <Icon
          size={14}
          className={row.state === 'pending' ? 'animate-spin' : undefined}
          style={{ color: c.text, flexShrink: 0 }}
        />
        <span
          style={{
            fontFamily: "'Orbitron', sans-serif",
            fontSize: '0.78rem',
            fontWeight: 700,
            color: '#ffffff',
            letterSpacing: '0.04em',
          }}
        >
          {row.region}
        </span>
        <span
          style={{
            color: '#666688',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '0.68rem',
          }}
        >
          :{row.port}
        </span>
      </div>
      <span
        style={{
          color: c.text,
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '0.65rem',
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
        }}
      >
        {row.state === 'pending' ? 'Pending' : row.state === 'signed' ? '✓ Signed' : '✗ Failed'}
      </span>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PAGE
// ═══════════════════════════════════════════════════════════════════════════

const POLL_INTERVAL_MS = 2000;

export default function ThresholdRelayerDemoPage() {
  // ── Signer health polling ──────────────────────────────────────────────
  const [signers, setSigners] = useState<SignerInfo[]>(
    DEFAULT_SIGNER_PORTS.map((port) => ({
      pubkey: '',
      region: regionLabelForPort(port),
      port,
      signerId: `signer-${port}`,
      version: '',
      online: false,
    })),
  );
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const poll = async () => {
      try {
        const infos = await getSignerInfos();
        if (mountedRef.current) setSigners(infos);
      } catch {
        /* ignore */
      }
    };
    void poll();
    const id = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(id);
    };
  }, []);

  const onlineCount = signers.filter((s) => s.online).length;

  // ── Approval request state ─────────────────────────────────────────────
  const [requesting, setRequesting] = useState(false);
  const [txHashHex, setTxHashHex] = useState<string | null>(null);
  const [steps, setSteps] = useState<StepRow[]>([]);
  const [result, setResult] = useState<ThresholdApproval | null>(null);
  const [showSignatures, setShowSignatures] = useState(false);

  const handleRequest = useCallback(async () => {
    if (requesting) return;
    setRequesting(true);
    setResult(null);
    setShowSignatures(false);

    const hash = generateTxHashHex();
    setTxHashHex(hash);

    const initialSteps: StepRow[] = DEFAULT_SIGNER_PORTS.map((port) => ({
      port,
      region: regionLabelForPort(port),
      state: 'pending',
    }));
    setSteps(initialSteps);

    try {
      const approval = await requestThresholdApproval(hash, DEFAULT_THRESHOLD, DEFAULT_SIGNER_PORTS);
      const byPort = new Map<number, SignerSignature>();
      for (const sig of approval.signatures) byPort.set(sig.port, sig);
      setSteps(
        DEFAULT_SIGNER_PORTS.map((port) => {
          const sig = byPort.get(port);
          return {
            port,
            region: regionLabelForPort(port),
            state: sig ? 'signed' : 'failed',
            signature: sig,
          };
        }),
      );
      setResult(approval);
    } catch {
      setSteps((prev) => prev.map((s) => ({ ...s, state: 'failed' })));
      setResult(null);
    } finally {
      setRequesting(false);
    }
  }, [requesting]);

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        minHeight: '100vh',
        background:
          'radial-gradient(circle at 20% 10%, rgba(139,92,246,0.08), transparent 45%), radial-gradient(circle at 80% 60%, rgba(59,130,246,0.08), transparent 45%), #050510',
        color: '#ffffff',
        fontFamily: "'Inter', sans-serif",
      }}
    >
      <MugenNavbar />

      <main
        style={{
          maxWidth: '80rem',
          margin: '0 auto',
          padding: '6rem 1.5rem 4rem',
          boxSizing: 'border-box',
        }}
      >
        {/* ───── Hero ───── */}
        <section style={{ textAlign: 'center', marginBottom: '2.5rem' }}>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.4rem',
              padding: '0.35rem 0.9rem',
              borderRadius: '999px',
              background: 'rgba(139,92,246,0.08)',
              border: '1px solid rgba(139,92,246,0.3)',
              marginBottom: '1.5rem',
            }}
          >
            <span
              style={{
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                background: '#a78bfa',
                boxShadow: '0 0 8px #a78bfa',
              }}
            />
            <span
              style={{
                color: '#c4b5fd',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '0.7rem',
                letterSpacing: '0.15em',
                textTransform: 'uppercase',
              }}
            >
              Devnet MVP
            </span>
          </div>

          <h1
            style={{
              fontFamily: "'Orbitron', sans-serif",
              fontSize: 'clamp(1.75rem, 4vw, 2.75rem)',
              fontWeight: 800,
              margin: '0 0 0.75rem 0',
              background: 'linear-gradient(135deg, #60a5fa 0%, #a78bfa 50%, #60a5fa 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              letterSpacing: '0.02em',
            }}
          >
            Demo: Threshold Relayer (FROST 2-of-3, MVP)
          </h1>
          <p
            style={{
              color: '#8888aa',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '0.85rem',
              margin: '0 auto 1.25rem',
              letterSpacing: '0.05em',
            }}
          >
            Layer 9 of the Privacy Stack — no single point of failure
          </p>
          <p
            style={{
              color: '#aaaacc',
              fontSize: '0.88rem',
              lineHeight: 1.65,
              maxWidth: '52rem',
              margin: '0 auto',
            }}
          >
            Real production uses FROST-Ed25519 math (off-chain aggregation into a single
            signature). This MVP demonstrates the architecture — three independent signers,
            2-of-3 threshold required, geographic distribution. The crypto math upgrade ships
            in Phase 2.
          </p>
        </section>

        {/* ───── Section 1: Signer network status ───── */}
        <GlassCard glow="blue" style={{ marginBottom: '1.5rem' }}>
          <header style={{ marginBottom: '1.25rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.35rem' }}>
              <div
                style={{
                  width: '2rem',
                  height: '2rem',
                  borderRadius: '10px',
                  background: 'linear-gradient(135deg, rgba(59,130,246,0.25), rgba(59,130,246,0.08))',
                  border: '1px solid rgba(59,130,246,0.3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Network size={15} style={{ color: '#93c5fd' }} />
              </div>
              <h2
                style={{
                  fontFamily: "'Orbitron', sans-serif",
                  fontSize: '1.1rem',
                  fontWeight: 700,
                  color: '#ffffff',
                  margin: 0,
                }}
              >
                1. Signer Network Status
              </h2>
              <span
                style={{
                  marginLeft: 'auto',
                  color: '#666688',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '0.7rem',
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                }}
              >
                {onlineCount}/{signers.length} online · polling 2s
              </span>
            </div>
            <p
              style={{
                color: '#8888aa',
                fontSize: '0.8rem',
                margin: '0 0 0 2.6rem',
              }}
            >
              Three independent signers, each with its own keypair, in different regions.
            </p>
          </header>

          {onlineCount === 0 && (
            <div
              style={{
                marginBottom: '1.25rem',
                padding: '0.85rem 1rem',
                background: 'rgba(239,68,68,0.06)',
                border: '1px solid rgba(239,68,68,0.25)',
                borderRadius: '12px',
                color: '#fca5a5',
                fontSize: '0.82rem',
                lineHeight: 1.55,
              }}
            >
              No signers reachable — start them locally with{' '}
              <code
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '0.78rem',
                  background: 'rgba(0,0,0,0.4)',
                  padding: '0.15rem 0.4rem',
                  borderRadius: '4px',
                  color: '#fef3c7',
                }}
              >
                pnpm --filter @protocol-01/frost-signer dev:all
              </code>{' '}
              (4001/4002/4003).
            </div>
          )}

          <div
            className="signer-grid"
            style={{
              display: 'grid',
              gap: '0.85rem',
              gridTemplateColumns: '1fr',
            }}
          >
            {signers.map((s) => (
              <SignerCard key={s.port} signer={s} />
            ))}
          </div>
        </GlassCard>

        {/* ───── Section 2: Request approval ───── */}
        <GlassCard glow="violet" style={{ marginBottom: '1.5rem' }}>
          <header style={{ marginBottom: '1.25rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.35rem' }}>
              <div
                style={{
                  width: '2rem',
                  height: '2rem',
                  borderRadius: '10px',
                  background: 'linear-gradient(135deg, rgba(139,92,246,0.25), rgba(139,92,246,0.08))',
                  border: '1px solid rgba(139,92,246,0.3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Zap size={15} style={{ color: '#c4b5fd' }} />
              </div>
              <h2
                style={{
                  fontFamily: "'Orbitron', sans-serif",
                  fontSize: '1.1rem',
                  fontWeight: 700,
                  color: '#ffffff',
                  margin: 0,
                }}
              >
                2. Request Threshold Approval
              </h2>
            </div>
            <p style={{ color: '#8888aa', fontSize: '0.8rem', margin: '0 0 0 2.6rem' }}>
              Generate a random tx hash and require {DEFAULT_THRESHOLD}-of-{signers.length}{' '}
              independent signatures.
            </p>
          </header>

          <button
            type="button"
            onClick={() => void handleRequest()}
            disabled={requesting}
            style={{
              width: '100%',
              padding: '0.9rem 1.25rem',
              borderRadius: '12px',
              border: '1px solid rgba(139,92,246,0.4)',
              background: requesting
                ? 'rgba(139,92,246,0.15)'
                : 'linear-gradient(135deg, rgba(139,92,246,0.25), rgba(59,130,246,0.2))',
              color: '#ffffff',
              fontFamily: "'Orbitron', sans-serif",
              fontSize: '0.82rem',
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              cursor: requesting ? 'not-allowed' : 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.6rem',
              transition: 'all 0.18s ease',
            }}
          >
            {requesting ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
            {requesting ? 'Requesting…' : 'Generate test tx hash + request approval'}
          </button>

          {txHashHex && (
            <div
              style={{
                marginTop: '1.1rem',
                padding: '0.75rem 0.9rem',
                background: 'rgba(0,0,0,0.35)',
                border: '1px solid rgba(255,255,255,0.06)',
                borderRadius: '10px',
              }}
            >
              <div
                style={{
                  color: '#666688',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '0.62rem',
                  letterSpacing: '0.15em',
                  textTransform: 'uppercase',
                  marginBottom: '0.3rem',
                }}
              >
                Tx hash (32 bytes)
              </div>
              <div
                style={{
                  color: '#a78bfa',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '0.72rem',
                  wordBreak: 'break-all',
                  lineHeight: 1.5,
                }}
              >
                {txHashHex}
              </div>
            </div>
          )}

          {steps.length > 0 && (
            <div style={{ marginTop: '1.1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <div
                style={{
                  color: '#8888aa',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '0.65rem',
                  letterSpacing: '0.15em',
                  textTransform: 'uppercase',
                  marginBottom: '0.2rem',
                }}
              >
                {requesting ? 'Sending request to 3 signers…' : 'Signer responses'}
              </div>
              {steps.map((row) => (
                <StepperRow key={row.port} row={row} />
              ))}
            </div>
          )}

          {result && (
            <div
              style={{
                marginTop: '1.1rem',
                padding: '0.95rem 1.05rem',
                background: result.thresholdReached
                  ? 'linear-gradient(135deg, rgba(34,197,94,0.1), rgba(34,197,94,0.04))'
                  : 'rgba(239,68,68,0.06)',
                border: `1px solid ${result.thresholdReached ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.3)'}`,
                borderRadius: '12px',
                display: 'flex',
                alignItems: 'center',
                gap: '0.6rem',
              }}
            >
              {result.thresholdReached ? (
                <CheckCircle2 size={18} style={{ color: '#86efac', flexShrink: 0 }} />
              ) : (
                <XCircle size={18} style={{ color: '#fca5a5', flexShrink: 0 }} />
              )}
              <span
                style={{
                  fontFamily: "'Orbitron', sans-serif",
                  fontSize: '0.85rem',
                  fontWeight: 700,
                  color: result.thresholdReached ? '#86efac' : '#fca5a5',
                  letterSpacing: '0.04em',
                }}
              >
                {result.thresholdReached
                  ? `Threshold reached (${result.signatures.length}/${result.totalSigners})`
                  : `Threshold NOT reached (${result.signatures.length}/${result.totalSigners}, need ${result.threshold})`}
              </span>
            </div>
          )}

          {result && result.signatures.length > 0 && (
            <div style={{ marginTop: '1rem' }}>
              <button
                type="button"
                onClick={() => setShowSignatures((v) => !v)}
                style={{
                  background: 'none',
                  border: '1px solid rgba(255,255,255,0.1)',
                  color: '#8888aa',
                  padding: '0.4rem 0.8rem',
                  borderRadius: '8px',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '0.7rem',
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                  cursor: 'pointer',
                }}
              >
                {showSignatures ? 'Hide' : 'Show'} {result.signatures.length} signature
                {result.signatures.length === 1 ? '' : 's'}
              </button>

              {showSignatures && (
                <div
                  style={{
                    marginTop: '0.75rem',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.6rem',
                  }}
                >
                  {result.signatures.map((sig) => (
                    <div
                      key={`${sig.port}-${sig.signedAt}`}
                      style={{
                        padding: '0.75rem 0.9rem',
                        background: 'rgba(0,0,0,0.35)',
                        border: '1px solid rgba(255,255,255,0.06)',
                        borderRadius: '10px',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          marginBottom: '0.4rem',
                          gap: '0.5rem',
                          flexWrap: 'wrap',
                        }}
                      >
                        <span
                          style={{
                            fontFamily: "'Orbitron', sans-serif",
                            fontSize: '0.75rem',
                            fontWeight: 700,
                            color: '#a78bfa',
                            letterSpacing: '0.05em',
                          }}
                        >
                          {sig.region} · :{sig.port}
                        </span>
                        <span
                          style={{
                            color: '#666688',
                            fontFamily: "'JetBrains Mono', monospace",
                            fontSize: '0.65rem',
                          }}
                        >
                          {new Date(sig.signedAt).toISOString()}
                        </span>
                      </div>
                      <div
                        style={{
                          color: '#666688',
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: '0.6rem',
                          letterSpacing: '0.12em',
                          textTransform: 'uppercase',
                          marginBottom: '0.2rem',
                        }}
                      >
                        Pubkey
                      </div>
                      <div
                        style={{
                          color: '#93c5fd',
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: '0.7rem',
                          wordBreak: 'break-all',
                          marginBottom: '0.55rem',
                        }}
                      >
                        {sig.signerPubkey}
                      </div>
                      <div
                        style={{
                          color: '#666688',
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: '0.6rem',
                          letterSpacing: '0.12em',
                          textTransform: 'uppercase',
                          marginBottom: '0.2rem',
                        }}
                      >
                        Signature
                      </div>
                      <div
                        style={{
                          color: '#aaaacc',
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: '0.7rem',
                          wordBreak: 'break-all',
                          lineHeight: 1.5,
                        }}
                      >
                        {sig.signature}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </GlassCard>

        {/* ───── Section 3: how it works ───── */}
        <GlassCard glow="violet">
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap' }}>
            <div
              style={{
                width: '2.5rem',
                height: '2.5rem',
                borderRadius: '12px',
                background: 'linear-gradient(135deg, rgba(139,92,246,0.25), rgba(59,130,246,0.2))',
                border: '1px solid rgba(139,92,246,0.3)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <ShieldCheck size={18} style={{ color: '#c4b5fd' }} />
            </div>
            <div style={{ flex: 1, minWidth: '260px' }}>
              <h3
                style={{
                  fontFamily: "'Orbitron', sans-serif",
                  fontSize: '1rem',
                  fontWeight: 700,
                  color: '#ffffff',
                  margin: '0 0 0.5rem 0',
                }}
              >
                How this works
              </h3>
              <p style={{ color: '#aaaacc', fontSize: '0.88rem', lineHeight: 1.65, margin: '0 0 0.9rem 0' }}>
                The relayer broadcasts an approval request to three independent signer nodes, each
                running in a different region with its own keypair. Any {DEFAULT_THRESHOLD} of the{' '}
                {signers.length} must approve before the transaction can settle. No single signer
                — including the operator — can move funds alone or censor a user. Phase 2 replaces
                the per-signer signatures with a single aggregated FROST-Ed25519 signature for
                on-chain efficiency.
              </p>
              <Link
                href="/how-it-works#layer-9"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  color: '#a78bfa',
                  textDecoration: 'none',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '0.75rem',
                  textTransform: 'uppercase',
                  letterSpacing: '0.12em',
                }}
              >
                <Layers size={12} />
                Layer 9 · Privacy Stack
                <ArrowRight size={12} />
              </Link>
            </div>
          </div>
        </GlassCard>
      </main>

      <style>{`
        @media (min-width: 768px) {
          .signer-grid {
            grid-template-columns: repeat(3, 1fr) !important;
          }
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .animate-spin {
          animation: spin 0.9s linear infinite;
        }
      `}</style>
    </div>
  );
}

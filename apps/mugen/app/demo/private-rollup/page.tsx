'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Cpu,
  Layers,
  Loader2,
  Lock,
  MessageSquare,
  ShieldCheck,
  Sparkles,
  Upload,
  Zap,
} from 'lucide-react';
import MugenNavbar from '@/components/MugenNavbar';
import { MAGICBLOCK_DEVNET_RPC, SOLANA_DEVNET_RPC, type PingResult } from '@/lib/magicblock';

// ═══════════════════════════════════════════════════════════════════════════
// GLASS CARD — matches /demo/threshold-relayer style
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
// TYPES + API
// ═══════════════════════════════════════════════════════════════════════════

interface PingResponse {
  results: PingResult[];
  measuredAt: number;
}

interface LaneSummary {
  endpoint: string;
  region: string;
  rounds: PingResult[];
  avgMs: number;
  ok: boolean;
  lastSlot: number;
}

const ROUNDS = 3;

const TEST_ENDPOINTS = [
  { url: SOLANA_DEVNET_RPC, region: 'solana-devnet', label: 'Solana Devnet' },
  { url: MAGICBLOCK_DEVNET_RPC.us, region: 'mb-us', label: 'MagicBlock US' },
  { url: MAGICBLOCK_DEVNET_RPC.eu, region: 'mb-eu', label: 'MagicBlock EU' },
  { url: MAGICBLOCK_DEVNET_RPC.asia, region: 'mb-asia', label: 'MagicBlock Asia' },
  { url: MAGICBLOCK_DEVNET_RPC.tee, region: 'mb-tee', label: 'MagicBlock TEE' },
] as const;

async function runPingRound(): Promise<PingResult[]> {
  const res = await fetch('/api/ephemeral/ping', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      endpoints: TEST_ENDPOINTS.map((e) => ({ url: e.url, region: e.region })),
    }),
  });
  if (!res.ok) throw new Error(`ping failed: HTTP ${res.status}`);
  const body = (await res.json()) as PingResponse;
  return body.results;
}

function summarise(endpoint: string, region: string, rounds: PingResult[]): LaneSummary {
  const okRounds = rounds.filter((r) => r.ok);
  const avgMs =
    okRounds.length > 0
      ? Math.round(okRounds.reduce((sum, r) => sum + r.latencyMs, 0) / okRounds.length)
      : 0;
  const lastSlot = rounds.length > 0 ? rounds[rounds.length - 1]!.slot : 0;
  return {
    endpoint,
    region,
    rounds,
    avgMs,
    ok: okRounds.length > 0,
    lastSlot,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// LATENCY LANE CARD
// ═══════════════════════════════════════════════════════════════════════════

function LaneCard({
  label,
  summary,
  tone,
  running,
}: {
  label: string;
  summary: LaneSummary | null;
  tone: 'slow' | 'fast';
  running: boolean;
}) {
  const borderColor =
    tone === 'fast' ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.35)';
  const glowColor =
    tone === 'fast' ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)';
  const accentColor = tone === 'fast' ? '#86efac' : '#fca5a5';

  return (
    <div
      style={{
        position: 'relative',
        background: `linear-gradient(135deg, ${glowColor}, rgba(255,255,255,0.02))`,
        border: `1px solid ${borderColor}`,
        borderRadius: '14px',
        padding: '1.25rem 1.35rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.85rem',
        minHeight: '190px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span
          style={{
            fontFamily: "'Orbitron', sans-serif",
            fontSize: '0.85rem',
            fontWeight: 700,
            color: '#ffffff',
            letterSpacing: '0.04em',
          }}
        >
          {label}
        </span>
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '0.6rem',
            color: accentColor,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
          }}
        >
          {tone === 'fast' ? 'Fast lane' : 'Slow lane'}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.4rem' }}>
        <Zap size={18} style={{ color: accentColor, flexShrink: 0, alignSelf: 'center' }} />
        {running && !summary ? (
          <Loader2 size={20} className="animate-spin" style={{ color: accentColor }} />
        ) : summary && summary.ok ? (
          <>
            <span
              style={{
                fontFamily: "'Orbitron', sans-serif",
                fontSize: '2rem',
                fontWeight: 800,
                color: '#ffffff',
                letterSpacing: '0.02em',
                lineHeight: 1,
              }}
            >
              {summary.avgMs}
            </span>
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '0.85rem',
                color: '#aaaacc',
              }}
            >
              ms avg
            </span>
          </>
        ) : summary ? (
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '0.85rem',
              color: '#fca5a5',
            }}
          >
            unreachable
          </span>
        ) : (
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '0.85rem',
              color: '#666688',
            }}
          >
            —
          </span>
        )}
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '0.3rem',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '0.7rem',
          color: '#8888aa',
        }}
      >
        <div>
          <span style={{ color: '#555577' }}>slot: </span>
          <span style={{ color: '#aaaacc' }}>
            {summary && summary.lastSlot > 0 ? summary.lastSlot.toLocaleString('en-US') : '—'}
          </span>
        </div>
        <div style={{ wordBreak: 'break-all' }}>
          <span style={{ color: '#555577' }}>rpc: </span>
          <span style={{ color: '#aaaacc' }}>
            {summary?.endpoint ?? TEST_ENDPOINTS.find((e) => e.label === label)?.url ?? '—'}
          </span>
        </div>
        {summary && summary.rounds.length > 0 && (
          <div>
            <span style={{ color: '#555577' }}>rounds: </span>
            <span style={{ color: '#aaaacc' }}>
              {summary.rounds.map((r) => (r.ok ? `${r.latencyMs}ms` : 'fail')).join(' · ')}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// HOW-IT-WORKS STEP
// ═══════════════════════════════════════════════════════════════════════════

function FlowStep({
  index,
  icon: Icon,
  title,
  desc,
}: {
  index: number;
  icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  title: string;
  desc: string;
}) {
  return (
    <div
      style={{
        position: 'relative',
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: '14px',
        padding: '1.1rem 1.2rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.6rem',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <div
          style={{
            width: '2rem',
            height: '2rem',
            borderRadius: '10px',
            background: 'linear-gradient(135deg, rgba(59,130,246,0.2), rgba(139,92,246,0.15))',
            border: '1px solid rgba(139,92,246,0.3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <Icon size={14} style={{ color: '#c4b5fd' }} />
        </div>
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '0.65rem',
            color: '#666688',
            letterSpacing: '0.15em',
            textTransform: 'uppercase',
          }}
        >
          Step {index}
        </span>
      </div>
      <div
        style={{
          fontFamily: "'Orbitron', sans-serif",
          fontSize: '0.85rem',
          fontWeight: 700,
          color: '#ffffff',
          letterSpacing: '0.03em',
        }}
      >
        {title}
      </div>
      <p style={{ color: '#aaaacc', fontSize: '0.8rem', lineHeight: 1.55, margin: 0 }}>{desc}</p>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// USE-CASE CARD
// ═══════════════════════════════════════════════════════════════════════════

function UseCaseCard({
  icon: Icon,
  title,
  desc,
}: {
  icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  title: string;
  desc: string;
}) {
  return (
    <div
      style={{
        position: 'relative',
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: '14px',
        padding: '1.1rem 1.2rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.55rem',
        minHeight: '150px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div
          style={{
            width: '2rem',
            height: '2rem',
            borderRadius: '10px',
            background: 'linear-gradient(135deg, rgba(59,130,246,0.22), rgba(59,130,246,0.06))',
            border: '1px solid rgba(59,130,246,0.3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon size={14} style={{ color: '#93c5fd' }} />
        </div>
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '0.55rem',
            color: '#a78bfa',
            background: 'rgba(139,92,246,0.1)',
            border: '1px solid rgba(139,92,246,0.3)',
            padding: '0.1rem 0.4rem',
            borderRadius: '4px',
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
          }}
        >
          Phase 2
        </span>
      </div>
      <div
        style={{
          fontFamily: "'Orbitron', sans-serif",
          fontSize: '0.85rem',
          fontWeight: 700,
          color: '#ffffff',
          letterSpacing: '0.03em',
        }}
      >
        {title}
      </div>
      <p style={{ color: '#8888aa', fontSize: '0.78rem', lineHeight: 1.55, margin: 0 }}>{desc}</p>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PAGE
// ═══════════════════════════════════════════════════════════════════════════

export default function PrivateRollupDemoPage() {
  const [running, setRunning] = useState(false);
  const [lanes, setLanes] = useState<Record<string, LaneSummary>>({});
  const [lastMeasuredAt, setLastMeasuredAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleRunTest = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setError(null);
    setLanes({});

    try {
      const accumulated: Record<string, PingResult[]> = {};
      for (let i = 0; i < ROUNDS; i++) {
        const round = await runPingRound();
        for (const res of round) {
          if (!accumulated[res.endpoint]) accumulated[res.endpoint] = [];
          accumulated[res.endpoint]!.push(res);
        }
      }
      const summaries: Record<string, LaneSummary> = {};
      for (const [endpoint, rounds] of Object.entries(accumulated)) {
        const first = rounds[0];
        if (!first) continue;
        summaries[endpoint] = summarise(endpoint, first.region, rounds);
      }
      setLanes(summaries);
      setLastMeasuredAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [running]);

  // Render every endpoint defined in TEST_ENDPOINTS so the user sees the full
  // multi-region picture (Solana devnet + MagicBlock US/EU/Asia/TEE).
  const orderedLanes = TEST_ENDPOINTS.map((e) => ({
    label: e.label,
    summary: lanes[e.url] ?? null,
    isSolana: e.url === SOLANA_DEVNET_RPC,
  }));

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
              background: 'rgba(59,130,246,0.08)',
              border: '1px solid rgba(59,130,246,0.3)',
              marginBottom: '1.5rem',
            }}
          >
            <span
              style={{
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                background: '#60a5fa',
                boxShadow: '0 0 8px #60a5fa',
              }}
            />
            <span
              style={{
                color: '#93c5fd',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '0.7rem',
                letterSpacing: '0.15em',
                textTransform: 'uppercase',
              }}
            >
              Devnet MVP · Latency demo only
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
            Demo: MagicBlock Private Ephemeral Rollup
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
            Layer 4 of the Privacy Stack — sub-50ms execution inside Intel TDX
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
            MagicBlock PERs run a Solana validator inside an Intel TDX hardware enclave. State
            changes are hidden from observers during the privacy window, then settled back to
            mainnet. This MVP demonstrates the latency differential — full account delegation
            requires a program deployment with <code style={{ fontFamily: "'JetBrains Mono', monospace", color: '#c4b5fd' }}>#[delegate]</code> hooks, shipping in Phase 2.
          </p>
        </section>

        {/* ───── Section 1: Latency comparison ───── */}
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
                <Zap size={15} style={{ color: '#93c5fd' }} />
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
                1. Mainnet vs PER Latency
              </h2>
              {lastMeasuredAt && (
                <span
                  style={{
                    marginLeft: 'auto',
                    color: '#666688',
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '0.68rem',
                    letterSpacing: '0.1em',
                    textTransform: 'uppercase',
                  }}
                >
                  measured {new Date(lastMeasuredAt).toLocaleTimeString()}
                </span>
              )}
            </div>
            <p style={{ color: '#8888aa', fontSize: '0.8rem', margin: '0 0 0 2.6rem' }}>
              Each round issues a <code style={{ fontFamily: "'JetBrains Mono', monospace", color: '#c4b5fd' }}>getSlot</code> JSON-RPC call and times the server-side round-trip.
            </p>
          </header>

          <button
            type="button"
            onClick={() => void handleRunTest()}
            disabled={running}
            style={{
              width: '100%',
              padding: '0.9rem 1.25rem',
              borderRadius: '12px',
              border: '1px solid rgba(59,130,246,0.4)',
              background: running
                ? 'rgba(59,130,246,0.15)'
                : 'linear-gradient(135deg, rgba(59,130,246,0.25), rgba(139,92,246,0.2))',
              color: '#ffffff',
              fontFamily: "'Orbitron', sans-serif",
              fontSize: '0.82rem',
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              cursor: running ? 'not-allowed' : 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.6rem',
              marginBottom: '1.25rem',
              transition: 'all 0.18s ease',
            }}
          >
            {running ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
            {running ? `Pinging… (${ROUNDS} rounds)` : `Run latency test (${ROUNDS} rounds)`}
          </button>

          <div
            className="lane-grid"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: '0.75rem',
            }}
          >
            {orderedLanes.map((lane) => (
              <LaneCard
                key={lane.label}
                label={lane.label}
                summary={lane.summary}
                tone={lane.isSolana ? 'slow' : 'fast'}
                running={running}
              />
            ))}
          </div>

          {error && (
            <div
              style={{
                marginTop: '1rem',
                padding: '0.75rem 0.9rem',
                background: 'rgba(239,68,68,0.06)',
                border: '1px solid rgba(239,68,68,0.25)',
                borderRadius: '10px',
                color: '#fca5a5',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '0.75rem',
              }}
            >
              {error}
            </div>
          )}

          <p
            style={{
              marginTop: '0.9rem',
              color: '#666688',
              fontSize: '0.72rem',
              lineHeight: 1.55,
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            PER returns from a cached slot via TDX-validated RPC; mainnet must round-trip to the
            validator network. Timings include the Next.js server-side fetch — expect ~50-150ms
            of shared overhead above the true RPC wire cost.
          </p>
        </GlassCard>

        {/* ───── Section 2: How it works ───── */}
        <GlassCard glow="violet" style={{ marginBottom: '1.5rem' }}>
          <header style={{ marginBottom: '1.25rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
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
                <Cpu size={15} style={{ color: '#c4b5fd' }} />
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
                2. How Private Ephemeral Rollups Work
              </h2>
            </div>
          </header>

          <div
            className="flow-grid"
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr',
              gap: '0.85rem',
            }}
          >
            <FlowStep
              index={1}
              icon={Lock}
              title="Account delegated to PER"
              desc="The state account is marked delegated on mainnet. Public RPC calls against it return the last committed snapshot — live changes during the window are hidden."
            />
            <FlowStep
              index={2}
              icon={Zap}
              title="Reads / writes inside TDX"
              desc="All subsequent reads and writes route to the PER validator, which executes inside an Intel TDX hardware enclave. Sub-50ms round-trip, TDX-attested output."
            />
            <FlowStep
              index={3}
              icon={Upload}
              title="Window closes → mainnet settlement"
              desc="When the privacy window ends (or on explicit undelegate), the final state is committed back to mainnet. Observers see only the net delta, not intermediate states."
            />
          </div>
        </GlassCard>

        {/* ───── Section 3: TDX attestation caveat ───── */}
        <GlassCard style={{ marginBottom: '1.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.85rem', flexWrap: 'wrap' }}>
            <div
              style={{
                width: '2.25rem',
                height: '2.25rem',
                borderRadius: '10px',
                background: 'rgba(251,191,36,0.1)',
                border: '1px solid rgba(251,191,36,0.25)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <AlertTriangle size={15} style={{ color: '#fbbf24' }} />
            </div>
            <div style={{ flex: 1, minWidth: '260px' }}>
              <h3
                style={{
                  fontFamily: "'Orbitron', sans-serif",
                  fontSize: '0.9rem',
                  fontWeight: 700,
                  color: '#ffffff',
                  margin: '0 0 0.5rem 0',
                }}
              >
                Honest disclaimer: TDX attestation
              </h3>
              <p style={{ color: '#aaaacc', fontSize: '0.82rem', lineHeight: 1.6, margin: 0 }}>
                PER validators run inside Intel TDX. Production attestation verification — binding
                the validator's TLS cert to a TDX quote signed by Intel's PCK root — requires
                either MagicBlock's verification API or partnering with a TDX-aware service like
                Marlin. This MVP trusts the endpoint at the TLS layer only.
              </p>
            </div>
          </div>
        </GlassCard>

        {/* ───── Section 4: Mugen use cases ───── */}
        <GlassCard glow="blue" style={{ marginBottom: '1.5rem' }}>
          <header style={{ marginBottom: '1.25rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
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
                <Sparkles size={15} style={{ color: '#93c5fd' }} />
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
                3. Where PER plugs into Mugen
              </h2>
            </div>
          </header>

          <div
            className="use-grid"
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr',
              gap: '0.85rem',
            }}
          >
            <UseCaseCard
              icon={ShieldCheck}
              title="Real-time order negotiation"
              desc="Counter-offers between buyer and seller happen in PER, hidden from chain until both sides agree — prevents front-running and leaked quotes."
            />
            <UseCaseCard
              icon={MessageSquare}
              title="Private chat during trade"
              desc="Encrypted messages routed via PER with sub-50ms delivery. No public transcript, no third-party chat server."
            />
            <UseCaseCard
              icon={CheckCircle2}
              title="Anonymous reputation updates"
              desc="Reputation score deltas are computed inside TDX; only the final aggregated value commits to mainnet — individual votes stay private."
            />
          </div>
        </GlassCard>

        {/* ───── Footer link ───── */}
        <div style={{ textAlign: 'center', marginTop: '1.5rem' }}>
          <Link
            href="/how-it-works"
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
            Layer 4 · Privacy Stack
            <ArrowRight size={12} />
          </Link>
        </div>
      </main>

      <style>{`
        @media (min-width: 768px) {
          .lane-grid { grid-template-columns: 1fr 1fr !important; }
          .flow-grid { grid-template-columns: repeat(3, 1fr) !important; }
          .use-grid  { grid-template-columns: repeat(3, 1fr) !important; }
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .animate-spin { animation: spin 0.9s linear infinite; }
      `}</style>
    </div>
  );
}

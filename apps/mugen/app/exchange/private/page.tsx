'use client';

import { useCallback, useState } from 'react';
import { Lock, Search, ShieldCheck, Brain, Network, Cpu, Sparkles } from 'lucide-react';
import MugenNavbar from '@/components/MugenNavbar';
import EncryptedOfferForm from '@/components/EncryptedOfferForm';
import BlindTakeForm from '@/components/BlindTakeForm';
import PrivateMatchesFeed from '@/components/PrivateMatchesFeed';
import MyOrdersPanel from '@/components/MyOrdersPanel';
import NoiseStatsCard from '@/components/NoiseStatsCard';

type PrivateTab = 'create' | 'match';

// ═══════════════════════════════════════════════════════════════════════════
// /exchange/private — production private-trade surface
// Tab-controlled: "Create private order" (maker) / "Find a match" (taker).
// ═══════════════════════════════════════════════════════════════════════════

function GlassCard({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        position: 'relative',
        background: 'rgba(255,255,255,0.03)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        border: '1px solid rgba(139,92,246,0.18)',
        borderRadius: '16px',
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
          background:
            'linear-gradient(90deg, transparent, rgba(139,92,246,0.45), transparent)',
        }}
      />
      {children}
    </div>
  );
}

// Dev-only flag — avoids touching the route in prod builds.
// MVP: the seeder populates the ephemeral server-side registry so a blind
// take is guaranteed to match. Production: no-op.
const IS_DEV = process.env.NODE_ENV !== 'production';

export default function PrivateExchangePage() {
  const [tab, setTab] = useState<PrivateTab>('create');
  const [seeding, setSeeding] = useState(false);
  const [seedInfo, setSeedInfo] = useState<string | null>(null);

  const onSeed = useCallback(async () => {
    setSeeding(true);
    setSeedInfo(null);
    try {
      const res = await fetch('/api/debug/seed-orders', { method: 'POST' });
      const json = (await res.json()) as { ok?: boolean; seeded?: number; error?: string };
      if (!res.ok || json.error) {
        setSeedInfo(`error: ${json.error ?? `HTTP ${res.status}`}`);
      } else {
        setSeedInfo(`seeded ${json.seeded ?? 0} sample orders`);
      }
    } catch (err) {
      setSeedInfo(`error: ${err instanceof Error ? err.message : 'network'}`);
    } finally {
      setSeeding(false);
    }
  }, []);

  return (
    <>
      <MugenNavbar />
      <main
        style={{
          position: 'relative',
          zIndex: 10,
          minHeight: '100vh',
          paddingTop: '5.5rem',
          paddingBottom: '4rem',
          paddingLeft: '1.5rem',
          paddingRight: '1.5rem',
          boxSizing: 'border-box',
        }}
      >
        <div style={{ maxWidth: '52rem', margin: '0 auto', width: '100%' }}>
          {/* Hero */}
          <div style={{ marginBottom: '2rem' }}>
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.5rem',
                marginBottom: '0.9rem',
              }}
            >
              <span
                style={{
                  padding: '0.2rem 0.6rem',
                  borderRadius: '999px',
                  background: 'rgba(139,92,246,0.12)',
                  border: '1px solid rgba(139,92,246,0.3)',
                  color: '#c4b5fd',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '0.62rem',
                  textTransform: 'uppercase',
                  letterSpacing: '0.16em',
                }}
              >
                Devnet
              </span>
              <span
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '0.7rem',
                  color: '#8888aa',
                }}
              >
                Fully encrypted orderbook — plaintext never leaves your browser
              </span>
            </div>
            <h1
              style={{
                fontFamily: "'Orbitron', sans-serif",
                fontSize: '2rem',
                fontWeight: 800,
                margin: 0,
                background:
                  'linear-gradient(135deg, #ffffff 0%, #c4b5fd 50%, #60a5fa 100%)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                letterSpacing: '0.02em',
              }}
            >
              Private P2P Trade
            </h1>
            <p
              style={{
                color: '#a5b4fc',
                fontSize: '0.88rem',
                fontFamily: "'Inter', sans-serif",
                marginTop: '0.55rem',
                maxWidth: '40rem',
                lineHeight: 1.55,
              }}
            >
              Your terms stay encrypted until a match is found. Powered by
              <strong style={{ color: '#c4b5fd' }}> Arcium MPC</strong> +
              <strong style={{ color: '#93c5fd' }}> FROST quorum</strong> +
              <strong style={{ color: '#60a5fa' }}> STARK post-quantum</strong>.
            </p>

            {/* Mini-badges row */}
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '0.4rem',
                marginTop: '1rem',
              }}
            >
              {[
                { icon: <Brain size={11} />, label: 'L8 · Arcium MPC', color: '#c4b5fd' },
                { icon: <Network size={11} />, label: 'L9 · FROST 2-of-3', color: '#93c5fd' },
                { icon: <Cpu size={11} />, label: 'L11 · Post-Quantum', color: '#60a5fa' },
                { icon: <ShieldCheck size={11} />, label: 'L1 · Natural variance fiat', color: '#eab308' },
              ].map((b) => (
                <span
                  key={b.label}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.3rem',
                    padding: '0.25rem 0.55rem',
                    borderRadius: '999px',
                    background: `${b.color}10`,
                    border: `1px solid ${b.color}30`,
                    color: b.color,
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '0.62rem',
                    textTransform: 'uppercase',
                    letterSpacing: '0.1em',
                  }}
                >
                  {b.icon}
                  {b.label}
                </span>
              ))}
            </div>
          </div>

          {/* Tabs */}
          <div style={{ display: 'flex', marginBottom: '1.2rem' }}>
            <GlassCard
              style={{
                display: 'inline-flex',
                padding: '0.3rem',
                borderRadius: '14px',
                gap: '0.25rem',
              }}
            >
              {(
                [
                  { key: 'create' as const, label: 'Create private order', icon: <Lock size={13} /> },
                  { key: 'match' as const, label: 'Find a match', icon: <Search size={13} /> },
                ]
              ).map((t) => (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.4rem',
                    padding: '0.6rem 1.2rem',
                    border: 'none',
                    borderRadius: '10px',
                    cursor: 'pointer',
                    fontFamily: "'Orbitron', sans-serif",
                    fontSize: '0.74rem',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                    background:
                      tab === t.key
                        ? 'linear-gradient(135deg, #3b82f6, #7c3aed)'
                        : 'transparent',
                    color: tab === t.key ? '#ffffff' : '#8888aa',
                    transition: 'all 0.2s ease',
                  }}
                >
                  {t.icon}
                  {t.label}
                </button>
              ))}
            </GlassCard>
          </div>

          {/* Active form */}
          <GlassCard style={{ padding: '1.6rem 1.6rem 1.8rem' }}>
            <div style={{ marginBottom: '1.2rem' }}>
              <h2
                style={{
                  margin: 0,
                  fontFamily: "'Orbitron', sans-serif",
                  fontSize: '1rem',
                  fontWeight: 700,
                  color: '#ffffff',
                  letterSpacing: '0.04em',
                }}
              >
                {tab === 'create'
                  ? 'Encrypted maker offer'
                  : 'Blind match attempt'}
              </h2>
              <p
                style={{
                  margin: '0.3rem 0 0',
                  fontFamily: "'Inter', sans-serif",
                  fontSize: '0.8rem',
                  color: '#8888aa',
                  lineHeight: 1.5,
                }}
              >
                {tab === 'create'
                  ? 'Amounts and payment methods are encrypted locally and submitted to the Arcium MPC network. The relayer signature is gated behind a 2-of-3 FROST quorum.'
                  : 'Your desired amount and max fiat are matched against encrypted orders inside MPC. If nothing compatible exists, nothing is revealed.'}
              </p>
            </div>

            {tab === 'create' ? <EncryptedOfferForm /> : <BlindTakeForm />}
          </GlassCard>

          {/* Onchain activity — live private matches feed */}
          <div style={{ marginTop: '1.6rem' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                marginBottom: '0.55rem',
                paddingLeft: '0.25rem',
              }}
            >
              <span
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '0.62rem',
                  color: '#8888aa',
                  textTransform: 'uppercase',
                  letterSpacing: '0.16em',
                }}
              >
                Onchain activity
              </span>
              <span
                style={{
                  flex: 1,
                  height: '1px',
                  background:
                    'linear-gradient(90deg, rgba(139,92,246,0.28), transparent)',
                }}
              />
            </div>
            <GlassCard
              style={{
                boxShadow:
                  '0 8px 32px rgba(139,92,246,0.12), 0 0 60px rgba(139,92,246,0.04)',
              }}
            >
              <PrivateMatchesFeed />
            </GlassCard>
          </div>

          {/* Layer 3 — Distributed Noise live counters */}
          <section style={{ marginTop: '1.6rem' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                marginBottom: '0.55rem',
                paddingLeft: '0.25rem',
              }}
            >
              <span
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '0.62rem',
                  color: '#8888aa',
                  textTransform: 'uppercase',
                  letterSpacing: '0.16em',
                }}
              >
                Noise pool
              </span>
              <span
                style={{
                  flex: 1,
                  height: '1px',
                  background:
                    'linear-gradient(90deg, rgba(14,165,233,0.28), transparent)',
                }}
              />
            </div>
            <GlassCard
              style={{
                boxShadow:
                  '0 8px 32px rgba(14,165,233,0.1), 0 0 60px rgba(14,165,233,0.04)',
              }}
            >
              <NoiseStatsCard />
            </GlassCard>
          </section>

          {/* Manage — lookup by nonce + cancel encrypted order */}
          <section style={{ marginTop: '1.6rem' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                marginBottom: '0.55rem',
                paddingLeft: '0.25rem',
              }}
            >
              <span
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '0.62rem',
                  color: '#8888aa',
                  textTransform: 'uppercase',
                  letterSpacing: '0.16em',
                }}
              >
                Manage
              </span>
              <span
                style={{
                  flex: 1,
                  height: '1px',
                  background:
                    'linear-gradient(90deg, rgba(139,92,246,0.28), transparent)',
                }}
              />
            </div>
            <GlassCard
              style={{
                boxShadow:
                  '0 8px 32px rgba(139,92,246,0.12), 0 0 60px rgba(139,92,246,0.04)',
              }}
            >
              <MyOrdersPanel />
            </GlassCard>
          </section>

          {/* Dev-only seeder */}
          {IS_DEV && (
            <div
              style={{
                marginTop: '1.2rem',
                display: 'flex',
                gap: '0.6rem',
                alignItems: 'center',
                justifyContent: 'center',
                flexWrap: 'wrap',
              }}
            >
              <button
                type="button"
                onClick={onSeed}
                disabled={seeding}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  padding: '0.45rem 0.85rem',
                  borderRadius: '999px',
                  border: '1px dashed rgba(139,92,246,0.35)',
                  background: 'rgba(139,92,246,0.06)',
                  color: seeding ? '#8888aa' : '#c4b5fd',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '0.66rem',
                  textTransform: 'uppercase',
                  letterSpacing: '0.12em',
                  cursor: seeding ? 'not-allowed' : 'pointer',
                  opacity: seeding ? 0.6 : 1,
                }}
              >
                <Sparkles size={11} />
                {seeding ? 'Seeding…' : 'Seed 3 demo orders (dev)'}
              </button>
              {seedInfo && (
                <span
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '0.66rem',
                    color: seedInfo.startsWith('error') ? '#fca5a5' : '#86efac',
                  }}
                >
                  {seedInfo}
                </span>
              )}
            </div>
          )}

          {/* Footer hint */}
          <p
            style={{
              marginTop: '1.4rem',
              textAlign: 'center',
              color: '#555570',
              fontSize: '0.72rem',
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            Prefer a public orderbook? See the{' '}
            <a
              href="/exchange"
              style={{ color: '#93c5fd', textDecoration: 'none' }}
            >
              standard exchange →
            </a>
          </p>
        </div>
      </main>
    </>
  );
}

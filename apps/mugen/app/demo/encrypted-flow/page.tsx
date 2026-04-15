'use client';

import Link from 'next/link';
import { ArrowRight, Layers, Lock, Search, ShieldCheck } from 'lucide-react';
import MugenNavbar from '@/components/MugenNavbar';
import EncryptedOfferForm from '@/components/EncryptedOfferForm';
import BlindTakeForm from '@/components/BlindTakeForm';

// ═══════════════════════════════════════════════════════════════════════════
// GLASS CARD — matches how-it-works style
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
// PAGE
// ═══════════════════════════════════════════════════════════════════════════

export default function EncryptedFlowDemoPage() {
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
        <section style={{ textAlign: 'center', marginBottom: '3rem' }}>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.4rem',
              padding: '0.35rem 0.9rem',
              borderRadius: '999px',
              background: 'rgba(239,68,68,0.08)',
              border: '1px solid rgba(239,68,68,0.3)',
              marginBottom: '1.5rem',
            }}
          >
            <span
              style={{
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                background: '#ef4444',
                boxShadow: '0 0 8px #ef4444',
              }}
            />
            <span
              style={{
                color: '#fca5a5',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '0.7rem',
                letterSpacing: '0.15em',
                textTransform: 'uppercase',
              }}
            >
              Devnet only
            </span>
          </div>

          <h1
            style={{
              fontFamily: "'Orbitron', sans-serif",
              fontSize: 'clamp(1.75rem, 4vw, 2.75rem)',
              fontWeight: 800,
              margin: '0 0 0.75rem 0',
              background:
                'linear-gradient(135deg, #60a5fa 0%, #a78bfa 50%, #60a5fa 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              letterSpacing: '0.02em',
            }}
          >
            Demo: Arcium MPC Encrypted Order Flow
          </h1>
          <p
            style={{
              color: '#8888aa',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '0.85rem',
              margin: 0,
              letterSpacing: '0.05em',
            }}
          >
            Layer 8 of the Privacy Stack — blind matching via multi-party computation
          </p>
        </section>

        {/* ───── L8 ⟷ L9 Quorum Gate Banner ───── */}
        <section style={{ marginBottom: '2rem' }}>
          <GlassCard glow="violet">
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '0.9rem',
                flexWrap: 'wrap',
              }}
            >
              <div
                style={{
                  width: '2.25rem',
                  height: '2.25rem',
                  borderRadius: '10px',
                  background:
                    'linear-gradient(135deg, rgba(139,92,246,0.25), rgba(139,92,246,0.08))',
                  border: '1px solid rgba(139,92,246,0.4)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <ShieldCheck size={16} style={{ color: '#c4b5fd' }} />
              </div>
              <div style={{ flex: 1, minWidth: '260px' }}>
                <div
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '0.65rem',
                    letterSpacing: '0.15em',
                    textTransform: 'uppercase',
                    color: '#a78bfa',
                    marginBottom: '0.3rem',
                  }}
                >
                  L8 ⟷ L9 · Wired
                </div>
                <p
                  style={{
                    color: '#d8d8f0',
                    fontSize: '0.85rem',
                    lineHeight: 1.6,
                    margin: 0,
                    fontFamily: "'Inter', sans-serif",
                  }}
                >
                  Each MPC submission is gated by a <strong style={{ color: '#c4b5fd' }}>2-of-3 FROST
                  threshold quorum</strong>. The relayer will not sign the Arcium tx without distributed
                  approval — compromising the single relayer key alone is not enough.
                </p>
              </div>
            </div>
          </GlassCard>
        </section>

        {/* ───── Sections 1 + 2 ───── */}
        <section
          style={{
            display: 'grid',
            gap: '1.5rem',
            gridTemplateColumns: '1fr',
            marginBottom: '2rem',
          }}
          className="demo-grid"
        >
          {/* Section 1 */}
          <GlassCard glow="violet">
            <header style={{ marginBottom: '1.25rem' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.6rem',
                  marginBottom: '0.35rem',
                }}
              >
                <div
                  style={{
                    width: '2rem',
                    height: '2rem',
                    borderRadius: '10px',
                    background:
                      'linear-gradient(135deg, rgba(139,92,246,0.25), rgba(139,92,246,0.08))',
                    border: '1px solid rgba(139,92,246,0.3)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Lock size={15} style={{ color: '#c4b5fd' }} />
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
                  1. Submit encrypted offer
                </h2>
              </div>
              <p
                style={{
                  color: '#8888aa',
                  fontSize: '0.8rem',
                  margin: '0 0 0 2.6rem',
                  fontFamily: "'Inter', sans-serif",
                }}
              >
                Amounts and payment methods are encrypted before leaving your browser.
              </p>
            </header>
            <EncryptedOfferForm />
          </GlassCard>

          {/* Section 2 */}
          <GlassCard glow="blue">
            <header style={{ marginBottom: '1.25rem' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.6rem',
                  marginBottom: '0.35rem',
                }}
              >
                <div
                  style={{
                    width: '2rem',
                    height: '2rem',
                    borderRadius: '10px',
                    background:
                      'linear-gradient(135deg, rgba(59,130,246,0.25), rgba(59,130,246,0.08))',
                    border: '1px solid rgba(59,130,246,0.3)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Search size={15} style={{ color: '#93c5fd' }} />
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
                  2. Blind take
                </h2>
              </div>
              <p
                style={{
                  color: '#8888aa',
                  fontSize: '0.8rem',
                  margin: '0 0 0 2.6rem',
                  fontFamily: "'Inter', sans-serif",
                }}
              >
                Probe the encrypted book. The MPC cluster matches on secret shares.
              </p>
            </header>
            <BlindTakeForm />
          </GlassCard>
        </section>

        {/* ───── Section 3: how it works ───── */}
        <GlassCard glow="violet">
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: '1rem',
              flexWrap: 'wrap',
            }}
          >
            <div
              style={{
                width: '2.5rem',
                height: '2.5rem',
                borderRadius: '12px',
                background:
                  'linear-gradient(135deg, rgba(139,92,246,0.25), rgba(59,130,246,0.2))',
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
              <p
                style={{
                  color: '#aaaacc',
                  fontSize: '0.88rem',
                  lineHeight: 1.65,
                  margin: '0 0 0.9rem 0',
                }}
              >
                Your encrypted offer is sent to the Arcium MPC network. The matching circuit runs
                over encrypted data — no node, including ours, sees your amounts or payment
                methods until a match is confirmed. When a match happens, only the maker and taker
                learn the details, via their nonces.
              </p>
              <Link
                href="/how-it-works#layer-8"
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
                Layer 8 · Privacy Stack
                <ArrowRight size={12} />
              </Link>
            </div>
          </div>
        </GlassCard>
      </main>

      <style>{`
        @media (min-width: 768px) {
          .demo-grid {
            grid-template-columns: 1fr 1fr !important;
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

import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ArrowRight,
  ArrowUpRight,
  Lock,
  Send,
  CheckCircle,
  Coins,
  ShieldCheck,
  Layers,
  ExternalLink,
} from 'lucide-react';
import MugenNavbar from '@/components/MugenNavbar';

// ═══════════════════════════════════════════════════════════════════════════
// METADATA
// ═══════════════════════════════════════════════════════════════════════════

export const metadata: Metadata = {
  title: 'Live Demo | Mugen Exchange, a real on-chain P2P escrow trade',
  description:
    'Walk through a real wSOL P2P escrow trade settled live on Solana devnet: create, confirm, and release, every step backed by an on-chain transaction you can open in the explorer.',
};

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS - real devnet artifacts (verified live)
// ═══════════════════════════════════════════════════════════════════════════

const PROGRAM_ID = 'EURLevwgmunRQU5piF7QLB1ithMPfxYFXp6jp6eGEAJN';
const ESCROW_PDA = '725DbYYxy5EywCaL9ySo1WF2PEtMpw19ZR7PmWnPhbcb';
const ARCIUM_PROGRAM = 'FH1JiQRUhKP1ARqWw6P5aXsqhLt9DPfbg89gqLV2TLPT';

const tx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const addr = (a: string) => `https://explorer.solana.com/address/${a}?cluster=devnet`;

const STEPS = [
  {
    n: '01',
    icon: Lock,
    color: '#3b82f6',
    glow: 'blue' as const,
    ix: 'create_order + take_order',
    title: 'wSOL locked in the escrow vault',
    desc: 'The seller posts an order and a buyer takes it. 0.01 SOL is wrapped and moved into a PDA-owned escrow vault. Neither party, nor Mugen, can move it out of band.',
    sig: '2WJSANyYYVtVxEzFgwrq6oCN46Cm5tXPrquaZgwnpnXoeh9wXSZiwYf7kfYvBnxizozbfhvDcUbYCHk35NKnvxtj',
  },
  {
    n: '02',
    icon: Send,
    color: '#8b5cf6',
    glow: 'violet' as const,
    ix: 'confirm_payment',
    title: 'Buyer marks fiat sent',
    desc: 'The buyer pays the seller off-chain (Revolut, SEPA, Wise) and flips the order to confirmed on-chain. The escrow stays locked until the seller acknowledges.',
    sig: '1fQya9y1866tDtEWzEEFwjxoEV1ptxvHRQx1kfVuYtsNm2Vb6VRdATdr2btiruRZf3kRgwKY63knrQdsNYpDaqT',
  },
  {
    n: '03',
    icon: CheckCircle,
    color: '#60a5fa',
    glow: 'blue' as const,
    ix: 'release_escrow',
    title: 'wSOL released to the buyer',
    desc: 'The escrow releases to the buyer minus a 50 bps protocol fee, split four ways (p01, mugen, treasury, noise). The buyer received 9,950,000 lamports out of 10,000,000.',
    sig: '4xH1Yhdmv7XpburTzRtdtfPtmKjYHAAjjiC1L2NeUVmWziw7CMAbA2dqNPPLmzrMqEfJasq5DWeiqWeZLspqwnNf',
  },
];

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
// MONOSPACE PILL (clickable address / id)
// ═══════════════════════════════════════════════════════════════════════════

function MonoLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.35rem',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: '0.72rem',
        color: '#93c5fd',
        textDecoration: 'none',
        wordBreak: 'break-all',
      }}
    >
      {children}
      <ExternalLink size={11} style={{ flexShrink: 0 }} />
    </a>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PAGE
// ═══════════════════════════════════════════════════════════════════════════

export default function DemoPage() {
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
          maxWidth: '64rem',
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
              background: 'rgba(34,197,94,0.08)',
              border: '1px solid rgba(34,197,94,0.3)',
              marginBottom: '1.5rem',
            }}
          >
            <span
              style={{
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                background: '#22c55e',
                boxShadow: '0 0 8px #22c55e',
              }}
            />
            <span
              style={{
                color: '#86efac',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '0.7rem',
                letterSpacing: '0.15em',
                textTransform: 'uppercase',
              }}
            >
              Live on Solana devnet
            </span>
          </div>

          <h1
            style={{
              fontFamily: "'Orbitron', sans-serif",
              fontSize: 'clamp(1.9rem, 4.5vw, 3rem)',
              fontWeight: 800,
              margin: '0 0 0.9rem 0',
              background: 'linear-gradient(135deg, #60a5fa 0%, #a78bfa 50%, #60a5fa 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              letterSpacing: '0.01em',
              lineHeight: 1.1,
            }}
          >
            A real on-chain P2P trade
          </h1>
          <p
            style={{
              color: '#9a9ac0',
              fontSize: '1rem',
              lineHeight: 1.7,
              maxWidth: '40rem',
              margin: '0 auto',
            }}
          >
            This is not a mockup. Below is one full wSOL escrow lifecycle, settled live on Solana
            devnet. Every step links to its real transaction. No KYC, post-quantum key exchange
            (ML-KEM-768), and a hash-based STARK proof system back the wallet that holds your funds.
          </p>
        </section>

        {/* ───── Trade summary bar ───── */}
        <section style={{ marginBottom: '2.5rem' }}>
          <GlassCard glow="blue" style={{ padding: '1.5rem 2rem' }}>
            <div
              className="demo-stats"
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(2, 1fr)',
                gap: '1.5rem',
                textAlign: 'center',
              }}
            >
              {[
                { icon: Coins, value: '0.01 SOL', label: 'Trade size', color: '#3b82f6' },
                { icon: ArrowUpRight, value: '9,950,000', label: 'Lamports to buyer', color: '#60a5fa' },
                { icon: Coins, value: '50 bps', label: 'Protocol fee', color: '#8b5cf6' },
                { icon: ShieldCheck, value: 'PDA vault', label: 'Escrow custody', color: '#7c3aed' },
              ].map((s, i) => (
                <div
                  key={i}
                  style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.3rem' }}
                >
                  <s.icon size={16} style={{ color: s.color, marginBottom: '0.2rem' }} />
                  <span
                    style={{
                      fontFamily: "'Orbitron', sans-serif",
                      fontSize: '1.15rem',
                      fontWeight: 800,
                      color: 'white',
                    }}
                  >
                    {s.value}
                  </span>
                  <span
                    style={{
                      fontSize: '0.62rem',
                      color: '#666688',
                      fontFamily: "'JetBrains Mono', monospace",
                      textTransform: 'uppercase',
                      letterSpacing: '0.1em',
                    }}
                  >
                    {s.label}
                  </span>
                </div>
              ))}
            </div>
          </GlassCard>
        </section>

        {/* ───── Lifecycle steps ───── */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', marginBottom: '2.5rem' }}>
          {STEPS.map((step) => (
            <GlassCard key={step.n} glow={step.glow}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '1.2rem', flexWrap: 'wrap' }}>
                {/* Icon + step number */}
                <div
                  style={{
                    width: '3rem',
                    height: '3rem',
                    borderRadius: '14px',
                    flexShrink: 0,
                    background: `linear-gradient(135deg, ${step.color}25, ${step.color}08)`,
                    border: `1px solid ${step.color}30`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <step.icon size={20} style={{ color: step.color }} />
                </div>

                <div style={{ flex: 1, minWidth: '260px' }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.6rem',
                      marginBottom: '0.35rem',
                      flexWrap: 'wrap',
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "'Orbitron', sans-serif",
                        fontSize: '0.7rem',
                        color: step.color,
                        letterSpacing: '0.2em',
                      }}
                    >
                      {step.n}
                    </span>
                    <code
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: '0.72rem',
                        color: '#c4b5fd',
                        background: 'rgba(139,92,246,0.08)',
                        border: '1px solid rgba(139,92,246,0.18)',
                        borderRadius: '6px',
                        padding: '0.15rem 0.5rem',
                      }}
                    >
                      {step.ix}
                    </code>
                  </div>

                  <h2
                    style={{
                      fontFamily: "'Orbitron', sans-serif",
                      fontSize: '1.05rem',
                      fontWeight: 700,
                      color: '#ffffff',
                      margin: '0 0 0.5rem 0',
                    }}
                  >
                    {step.title}
                  </h2>
                  <p style={{ color: '#9a9ac0', fontSize: '0.88rem', lineHeight: 1.65, margin: '0 0 1rem 0' }}>
                    {step.desc}
                  </p>

                  <a
                    href={tx(step.sig)}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.4rem',
                      padding: '0.5rem 1rem',
                      borderRadius: '10px',
                      background: `linear-gradient(135deg, ${step.color}20, ${step.color}08)`,
                      border: `1px solid ${step.color}30`,
                      color: '#cfe0ff',
                      textDecoration: 'none',
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: '0.72rem',
                      letterSpacing: '0.05em',
                    }}
                  >
                    View transaction on explorer
                    <ArrowUpRight size={13} />
                  </a>
                  <div style={{ marginTop: '0.6rem' }}>
                    <span
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: '0.65rem',
                        color: '#555570',
                        wordBreak: 'break-all',
                      }}
                    >
                      {step.sig}
                    </span>
                  </div>
                </div>
              </div>
            </GlassCard>
          ))}
        </section>

        {/* ───── On-chain references ───── */}
        <section style={{ marginBottom: '2.5rem' }}>
          <GlassCard glow="violet">
            <h3
              style={{
                fontFamily: "'Orbitron', sans-serif",
                fontSize: '1rem',
                fontWeight: 700,
                color: '#ffffff',
                margin: '0 0 1.25rem 0',
              }}
            >
              On-chain references
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
              {[
                { label: 'Escrow vault PDA', value: ESCROW_PDA, href: addr(ESCROW_PDA) },
                { label: 'Mugen escrow program', value: PROGRAM_ID, href: addr(PROGRAM_ID) },
                { label: 'Arcium MPC program', value: ARCIUM_PROGRAM, href: addr(ARCIUM_PROGRAM) },
              ].map((r) => (
                <div
                  key={r.value}
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'baseline',
                    gap: '0.5rem 1rem',
                    paddingBottom: '0.9rem',
                    borderBottom: '1px solid rgba(255,255,255,0.04)',
                  }}
                >
                  <span
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: '0.62rem',
                      color: '#666688',
                      textTransform: 'uppercase',
                      letterSpacing: '0.1em',
                      minWidth: '11rem',
                    }}
                  >
                    {r.label}
                  </span>
                  <MonoLink href={r.href}>{r.value}</MonoLink>
                </div>
              ))}
            </div>
          </GlassCard>
        </section>

        {/* ───── Honest note ───── */}
        <section style={{ marginBottom: '3rem' }}>
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
                <Layers size={18} style={{ color: '#c4b5fd' }} />
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
                  What is real today, and what is still in progress
                </h3>
                <p style={{ color: '#aaaacc', fontSize: '0.88rem', lineHeight: 1.65, margin: '0 0 0.9rem 0' }}>
                  The escrow settlement shown above is fully on-chain and real: lock, confirm, and
                  release all executed on devnet and you can verify each one. The blind-matching
                  layer (Arcium MPC) is still in progress. Order matching in the live app currently
                  runs through a server-side registry, so for now treat the matching step as a
                  centralized convenience rather than a trustless one.
                </p>
                <p style={{ color: '#aaaacc', fontSize: '0.88rem', lineHeight: 1.65, margin: '0 0 0.9rem 0' }}>
                  Progress is concrete: the Arcium MPC circuits (18 of them) build and the{' '}
                  <MonoLink href={addr(ARCIUM_PROGRAM)}>p01_arcium</MonoLink> program is deployed on
                  devnet. Wiring blind matching into the live trade flow is the next milestone.
                </p>
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
                  See the full privacy stack
                  <ArrowRight size={12} />
                </Link>
              </div>
            </div>
          </GlassCard>
        </section>

        {/* ───── CTA back ───── */}
        <section style={{ textAlign: 'center' }}>
          <Link
            href="/"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.5rem',
              color: '#8888aa',
              textDecoration: 'none',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '0.78rem',
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
            }}
          >
            Back to home
          </Link>
        </section>
      </main>

      <style>{`
        @media (min-width: 640px) {
          .demo-stats {
            grid-template-columns: repeat(4, 1fr) !important;
          }
        }
      `}</style>
    </div>
  );
}

'use client';

import Link from 'next/link';
import {
  Shield,
  Search,
  Lock,
  Send,
  CheckCircle,
  Eye,
  ArrowRight,
  Clock,
  AlertTriangle,
  HelpCircle,
  Infinity,
  Building2,
  Layers,
  Sparkles,
  Coins,
} from 'lucide-react';
import MugenNavbar from '@/components/MugenNavbar';
import PrivacyLayersGrid from '@/components/PrivacyLayersGrid';

// ═══════════════════════════════════════════════════════════════════════════
// GLASS CARD
// ═══════════════════════════════════════════════════════════════════════════

function GlassCard({
  children,
  style,
  glow,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
  glow?: 'blue' | 'violet';
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
// FLOW NODE — compact circle/square node for horizontal diagrams
// ═══════════════════════════════════════════════════════════════════════════

function FlowNode({
  label,
  color,
  shape = 'square',
  icon: Icon,
  emoji,
  minWidth = '100px',
}: {
  label: string;
  color: string;
  shape?: 'square' | 'circle';
  icon?: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  emoji?: string;
  minWidth?: string;
}) {
  return (
    <div style={{ textAlign: 'center', minWidth }}>
      <div
        style={{
          width: '3.5rem',
          height: '3.5rem',
          borderRadius: shape === 'circle' ? '50%' : '16px',
          background: `linear-gradient(135deg, ${color}20, ${color}08)`,
          border: `1px solid ${color}40`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          margin: '0 auto 0.5rem',
        }}
      >
        {Icon ? <Icon size={22} style={{ color }} /> : <span style={{ fontSize: '1.4rem' }}>{emoji}</span>}
      </div>
      <span
        style={{
          fontFamily: "'Orbitron',sans-serif",
          fontSize: '0.6rem',
          color,
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
        }}
      >
        {label}
      </span>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// LABELED ARROW — small label above an arrow, used in horizontal diagrams
// ═══════════════════════════════════════════════════════════════════════════

function LabeledArrow({ label, color }: { label: string; color: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0 0.5rem' }}>
      <span
        style={{
          fontSize: '0.55rem',
          color: '#555570',
          fontFamily: "'JetBrains Mono',monospace",
          marginBottom: '0.2rem',
        }}
      >
        {label}
      </span>
      <ArrowRight size={20} style={{ color }} />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// FLOW STEP — vertical timeline node
// ═══════════════════════════════════════════════════════════════════════════

function FlowStep({
  number,
  title,
  description,
  detail,
  icon: Icon,
  color,
  isLast,
}: {
  number: string;
  title: string;
  description: string;
  detail: string;
  icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  color: string;
  isLast?: boolean;
}) {
  return (
    <div style={{ display: 'flex', gap: '1.5rem', position: 'relative' }}>
      {/* Timeline line + node */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          flexShrink: 0,
          width: '3.5rem',
        }}
      >
        <div
          style={{
            width: '3.5rem',
            height: '3.5rem',
            borderRadius: '16px',
            background: `linear-gradient(135deg, ${color}25, ${color}08)`,
            border: `1px solid ${color}40`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: `0 0 20px ${color}15`,
            flexShrink: 0,
          }}
        >
          <Icon size={22} style={{ color }} />
        </div>
        {!isLast && (
          <div
            style={{
              flex: 1,
              width: '2px',
              minHeight: '2rem',
              background: `linear-gradient(to bottom, ${color}40, ${color}10)`,
              margin: '0.5rem 0',
            }}
          />
        )}
      </div>

      {/* Content */}
      <div style={{ paddingBottom: isLast ? 0 : '2.5rem', flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
          <span
            style={{
              fontFamily: "'Orbitron',sans-serif",
              fontSize: '0.6rem',
              color,
              letterSpacing: '0.2em',
              textTransform: 'uppercase',
            }}
          >
            Step {number}
          </span>
        </div>
        <h3
          style={{
            fontFamily: "'Orbitron',sans-serif",
            fontSize: '1.15rem',
            fontWeight: 700,
            color: 'white',
            marginBottom: '0.5rem',
          }}
        >
          {title}
        </h3>
        <p style={{ fontSize: '0.9rem', color: '#b0b0cc', lineHeight: 1.7, marginBottom: '0.5rem' }}>
          {description}
        </p>
        <p
          style={{
            fontSize: '0.75rem',
            color: '#555570',
            fontFamily: "'JetBrains Mono',monospace",
            lineHeight: 1.6,
          }}
        >
          {detail}
        </p>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════════════

export default function HowItWorksPage() {
  return (
    <>
      <MugenNavbar />

      <style
        dangerouslySetInnerHTML={{
          __html: `
        @keyframes fade-in-up { from{opacity:0;transform:translateY(20px)} to{opacity:1;transform:translateY(0)} }
        @media(prefers-reduced-motion:reduce){*{animation:none!important}}
        @media (max-width: 768px) {
          .two-col { grid-template-columns: 1fr !important; }
          .three-col { grid-template-columns: 1fr !important; }
        }
      `,
        }}
      />

      <main style={{ position: 'relative', zIndex: 10 }}>
        {/* ═══ HERO ═══ */}
        <section
          style={{
            padding: '8rem 1.5rem 4rem',
            textAlign: 'center',
            animation: 'fade-in-up 0.6s ease-out both',
          }}
        >
          <div style={{ maxWidth: '50rem', margin: '0 auto' }}>
            {/* Live banner */}
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.5rem',
                padding: '0.35rem 0.85rem',
                marginBottom: '1.25rem',
                background: 'linear-gradient(135deg, rgba(34,197,94,0.1), rgba(59,130,246,0.08))',
                border: '1px solid rgba(34,197,94,0.25)',
                borderRadius: '999px',
                fontFamily: "'JetBrains Mono',monospace",
                fontSize: '0.65rem',
                color: '#22c55e',
                letterSpacing: '0.15em',
                textTransform: 'uppercase',
              }}
            >
              <Sparkles size={12} style={{ color: '#22c55e' }} />
              Layer 1 now live — pay any amount
            </div>

            <div>
              <span
                style={{
                  fontSize: '0.65rem',
                  color: '#3b82f6',
                  fontFamily: "'JetBrains Mono',monospace",
                  textTransform: 'uppercase',
                  letterSpacing: '0.3em',
                }}
              >
                How it works
              </span>
            </div>
            <h1
              style={{
                fontFamily: "'Orbitron',sans-serif",
                fontSize: 'clamp(1.8rem, 4vw, 3rem)',
                fontWeight: 900,
                color: 'white',
                marginTop: '0.75rem',
                marginBottom: '1rem',
                lineHeight: 1.15,
              }}
            >
              Buy crypto.{' '}
              <span
                style={{
                  background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                }}
              >
                Stay invisible.
              </span>
            </h1>
            <p
              style={{
                fontSize: '1.1rem',
                color: '#b0b0cc',
                lineHeight: 1.6,
                maxWidth: '36rem',
                margin: '0 auto 0.75rem',
                fontWeight: 500,
              }}
            >
              Two ways to buy. Both private. Both yours.
            </p>
            <p style={{ fontSize: '0.95rem', color: '#8888aa', lineHeight: 1.7, maxWidth: '38rem', margin: '0 auto' }}>
              Mugen offers <strong style={{ color: '#3b82f6' }}>P2P mode</strong> — fiat direct between users,
              zero KYC, on-chain escrow — and <strong style={{ color: '#8b5cf6' }}>Gateway mode</strong> — a regulated
              on-ramp routed through our 12-layer privacy stack so clean SOL lands in your stealth wallet.
            </p>
          </div>
        </section>

        {/* ═══ VISUAL SCHEMA — The Big Picture ═══ */}
        <section style={{ padding: '2rem 1.5rem 5rem' }}>
          <div style={{ maxWidth: '52rem', margin: '0 auto' }}>
            <GlassCard glow="blue" style={{ padding: '2.5rem 2rem' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.5rem',
                  flexWrap: 'wrap',
                  textAlign: 'center',
                }}
              >
                <FlowNode label="You" color="#3b82f6" shape="circle" emoji="👤" />
                <LabeledArrow label="fiat" color="#3b82f6" />
                <FlowNode label="Seller" color="#8b5cf6" shape="circle" emoji="👤" />
                <LabeledArrow label="confirms" color="#8b5cf6" />
                <FlowNode label="Smart Contract" color="#60a5fa" icon={Lock} minWidth="120px" />
                <LabeledArrow label="crypto" color="#22c55e" />
                <FlowNode label="Stealth Address" color="#22c55e" shape="circle" icon={Eye} minWidth="120px" />
              </div>

              {/* Mode label: P2P */}
              <p
                style={{
                  textAlign: 'center',
                  marginTop: '1.25rem',
                  fontSize: '0.65rem',
                  color: '#3b82f6',
                  fontFamily: "'JetBrains Mono',monospace",
                  letterSpacing: '0.2em',
                  textTransform: 'uppercase',
                }}
              >
                Mode 1 — P2P
              </p>
              <p
                style={{
                  textAlign: 'center',
                  fontSize: '0.75rem',
                  color: '#555570',
                  fontFamily: "'JetBrains Mono',monospace",
                }}
              >
                Fiat goes directly between users. Crypto is held by a smart contract, not Mugen.
              </p>

              {/* Divider */}
              <div
                style={{
                  height: '1px',
                  background: 'linear-gradient(90deg, transparent, rgba(139,92,246,0.25), transparent)',
                  margin: '2rem 0 1.75rem',
                }}
              />

              {/* Mode label: Gateway */}
              <p
                style={{
                  textAlign: 'center',
                  fontSize: '0.65rem',
                  color: '#8b5cf6',
                  fontFamily: "'JetBrains Mono',monospace",
                  letterSpacing: '0.2em',
                  textTransform: 'uppercase',
                  marginBottom: '1.25rem',
                }}
              >
                Mode 2 — Gateway (new)
              </p>

              {/* Gateway flow row */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.35rem',
                  flexWrap: 'wrap',
                  textAlign: 'center',
                }}
              >
                <FlowNode label="You" color="#3b82f6" shape="circle" emoji="👤" minWidth="90px" />
                <ArrowRight size={16} style={{ color: '#3b82f6' }} />
                <FlowNode label="MoonPay" color="#60a5fa" icon={Building2} minWidth="90px" />
                <ArrowRight size={16} style={{ color: '#60a5fa' }} />
                <FlowNode label="Treasury" color="#8b5cf6" icon={Coins} />
                <ArrowRight size={16} style={{ color: '#8b5cf6' }} />
                <FlowNode label="12 Layers" color="#a78bfa" icon={Layers} />
                <ArrowRight size={16} style={{ color: '#22c55e' }} />
                <FlowNode label="Stealth" color="#22c55e" shape="circle" icon={Eye} />
              </div>

              <p
                style={{
                  textAlign: 'center',
                  marginTop: '1.5rem',
                  fontSize: '0.75rem',
                  color: '#555570',
                  fontFamily: "'JetBrains Mono',monospace",
                }}
              >
                Regulated fiat on-ramp in. 12 privacy layers between. Clean SOL out.
              </p>
            </GlassCard>
          </div>
        </section>

        {/* ═══ STEP BY STEP ═══ */}
        <section style={{ padding: '4rem 1.5rem 6rem' }}>
          <div style={{ maxWidth: '42rem', margin: '0 auto' }}>
            <div style={{ textAlign: 'center', marginBottom: '3rem' }}>
              <span
                style={{
                  fontSize: '0.65rem',
                  color: '#8b5cf6',
                  fontFamily: "'JetBrains Mono',monospace",
                  textTransform: 'uppercase',
                  letterSpacing: '0.3em',
                }}
              >
                Buyer flow
              </span>
              <h2
                style={{
                  fontFamily: "'Orbitron',sans-serif",
                  fontSize: '1.8rem',
                  fontWeight: 800,
                  color: 'white',
                  marginTop: '0.5rem',
                }}
              >
                5 steps.{' '}
                <span style={{ color: '#3b82f6' }}>Zero identity.</span>
              </h2>
            </div>

            <FlowStep
              number="01"
              icon={Search}
              color="#3b82f6"
              title="Browse offers"
              description="Open the P2P Exchange. You'll see a list of sell orders with prices, payment methods (Revolut, SEPA, Wise), and seller reputation scores."
              detail="No account needed. No email. No sign-up. Just connect your Solana wallet."
            />
            <FlowStep
              number="02"
              icon={Lock}
              color="#8b5cf6"
              title="Take an order"
              description="Pick an offer and click 'Buy'. The seller's crypto is instantly locked in an on-chain escrow — a smart contract that neither you, the seller, nor Mugen can manipulate."
              detail="The escrow is a PDA-owned vault on Solana. Funds can only move via the program's rules."
            />
            <FlowStep
              number="03"
              icon={Send}
              color="#60a5fa"
              title="Send fiat"
              description="Transfer the fiat amount to the seller using the payment method you chose. Include the reference code shown on screen so the seller can identify your payment."
              detail="Example: send 82.00 EUR to a Revolut account with reference MG-7x8k2f. The transfer is direct — Mugen never touches your money."
            />
            <FlowStep
              number="04"
              icon={CheckCircle}
              color="#22c55e"
              title="Payment confirmed"
              description="Once the seller verifies the fiat arrived, the escrow releases automatically. The crypto is sent to your wallet — or to a stealth address that only you can access."
              detail="Timeout protection: if the seller doesn't confirm within 1 hour, you can dispute. If no action, the escrow refunds automatically."
            />
            <FlowStep
              number="05"
              icon={Eye}
              color="#7c3aed"
              title="Receive privately"
              description="With stealth addresses enabled, your crypto arrives at a one-time address derived from your public key. Nobody — not the seller, not the blockchain — can link it to you."
              detail="Powered by ECDH + ML-KEM-768 (post-quantum). Even future quantum computers can't de-anonymize your transactions."
              isLast
            />
          </div>
        </section>

        {/* ═══ GATEWAY FLOW — Layer 1 Natural Variance Fiat ═══ */}
        <section style={{ padding: '2rem 1.5rem 5rem' }}>
          <div style={{ maxWidth: '52rem', margin: '0 auto' }}>
            <div style={{ textAlign: 'center', marginBottom: '3rem' }}>
              <span
                style={{
                  fontSize: '0.65rem',
                  color: '#8b5cf6',
                  fontFamily: "'JetBrains Mono',monospace",
                  textTransform: 'uppercase',
                  letterSpacing: '0.3em',
                }}
              >
                Gateway flow
              </span>
              <h2
                style={{
                  fontFamily: "'Orbitron',sans-serif",
                  fontSize: '1.8rem',
                  fontWeight: 800,
                  color: 'white',
                  marginTop: '0.5rem',
                }}
              >
                Pay what you <span style={{ color: '#8b5cf6' }}>want</span>.
              </h2>
              <p
                style={{
                  marginTop: '1rem',
                  color: '#8888aa',
                  fontSize: '0.95rem',
                  lineHeight: 1.7,
                  maxWidth: '36rem',
                  marginLeft: 'auto',
                  marginRight: 'auto',
                }}
              >
                You no longer need to remember &quot;round numbers&quot; to stay private. Pay the exact amount you want —
                €847.32, $123.45, anything. Our system converts it into canonical denominations internally, so your bank
                sees a natural human amount and the blockchain sees a perfectly uniform pool entry.
              </p>
            </div>

            <GlassCard glow="violet" style={{ padding: '2.25rem 2rem' }}>
              <div
                style={{
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: '0.85rem',
                  color: '#b0b0cc',
                  lineHeight: 2,
                }}
              >
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'max-content 1fr',
                    columnGap: '1.25rem',
                    rowGap: '0.2rem',
                    alignItems: 'baseline',
                  }}
                >
                  <span style={{ color: '#555570' }}>What you pay:</span>
                  <span style={{ color: 'white', fontWeight: 600 }}>€847.32</span>

                  <span style={{ color: '#555570' }}>Routed privately:</span>
                  <span style={{ color: '#3b82f6' }}>10 SOL + 1 SOL + 9× 0.1 SOL</span>

                  <span style={{ color: '#555570' }}>Pool entry:</span>
                  <span style={{ color: '#a78bfa' }}>= 11.9 SOL into uniform pool</span>

                  <span style={{ color: '#555570' }}>Tracked residual:</span>
                  <span style={{ color: '#eab308' }}>€1.23 (0.15%)</span>
                </div>

                <div
                  style={{
                    height: '1px',
                    background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.08), transparent)',
                    margin: '1.25rem 0',
                  }}
                />

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'max-content 1fr',
                    columnGap: '1.25rem',
                    rowGap: '0.2rem',
                    alignItems: 'baseline',
                  }}
                >
                  <span style={{ color: '#555570' }}>Bank sees:</span>
                  <span style={{ color: '#22c55e' }}>€847.32 — no pattern</span>

                  <span style={{ color: '#555570' }}>Chain sees:</span>
                  <span style={{ color: '#22c55e' }}>11.9 SOL — uniform</span>
                </div>
              </div>
            </GlassCard>

            <p
              style={{
                textAlign: 'center',
                marginTop: '1.5rem',
                fontSize: '0.75rem',
                color: '#555570',
                fontFamily: "'JetBrains Mono',monospace",
              }}
            >
              Layer 1 defeats banking structuring detection. The uniform pool defeats chain-analysis clustering.
            </p>

            {/* Privacy receipt sub-block */}
            <div style={{ marginTop: '3rem' }}>
              <div style={{ textAlign: 'center', marginBottom: '1.25rem' }}>
                <span
                  style={{
                    fontSize: '0.6rem',
                    color: '#22c55e',
                    fontFamily: "'JetBrains Mono',monospace",
                    textTransform: 'uppercase',
                    letterSpacing: '0.3em',
                  }}
                >
                  Live composition
                </span>
                <h3
                  style={{
                    fontFamily: "'Orbitron',sans-serif",
                    fontSize: '1.2rem',
                    fontWeight: 700,
                    color: 'white',
                    marginTop: '0.5rem',
                  }}
                >
                  Your trade&apos;s <span style={{ color: '#22c55e' }}>privacy receipt</span>
                </h3>
              </div>
              <GlassCard glow="blue" style={{ padding: '1.75rem 2rem' }}>
                <p
                  style={{
                    fontSize: '0.85rem',
                    color: '#b0b0cc',
                    lineHeight: 1.8,
                    margin: 0,
                  }}
                >
                  Every private trade composes four live layers into a single cryptographic receipt:{' '}
                  <strong style={{ color: '#3b82f6' }}>L1</strong> (natural-variance fiat denomination),{' '}
                  <strong style={{ color: '#8b5cf6' }}>L8</strong> (Arcium MPC blind matching — three circuits on
                  devnet),{' '}
                  <strong style={{ color: '#22c55e' }}>L9</strong> (FROST 3-of-3 threshold approval gating every MPC
                  submit), and <strong style={{ color: '#a78bfa' }}>L11</strong> (STARK + ML-KEM-768 post-quantum
                  primitives). The match is committed on-chain as a{' '}
                  <code style={{ color: '#eab308', fontFamily: "'JetBrains Mono',monospace" }}>MugenReputation</code>{' '}
                  PDA — a verifiable, auditable receipt of the trade, without ever revealing its contents.
                </p>
                <div style={{ marginTop: '1.25rem', textAlign: 'center' }}>
                  <Link
                    href="/exchange/private"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      padding: '0.6rem 1.25rem',
                      background: 'linear-gradient(135deg, rgba(34,197,94,0.15), rgba(59,130,246,0.15))',
                      border: '1px solid rgba(34,197,94,0.3)',
                      color: '#22c55e',
                      fontFamily: "'Orbitron',sans-serif",
                      fontWeight: 600,
                      fontSize: '0.75rem',
                      textDecoration: 'none',
                      borderRadius: '10px',
                      textTransform: 'uppercase',
                      letterSpacing: '0.1em',
                    }}
                  >
                    See it live at /exchange/private
                    <ArrowRight size={14} />
                  </Link>
                </div>
              </GlassCard>
            </div>
          </div>
        </section>

        {/* ═══ 12-LAYER PRIVACY STACK ═══ */}
        <section style={{ padding: '2rem 1.5rem 6rem' }}>
          <div style={{ maxWidth: '64rem', margin: '0 auto' }}>
            <div style={{ textAlign: 'center', marginBottom: '3rem' }}>
              <span
                style={{
                  fontSize: '0.65rem',
                  color: '#3b82f6',
                  fontFamily: "'JetBrains Mono',monospace",
                  textTransform: 'uppercase',
                  letterSpacing: '0.3em',
                }}
              >
                The stack
              </span>
              <h2
                style={{
                  fontFamily: "'Orbitron',sans-serif",
                  fontSize: '1.8rem',
                  fontWeight: 800,
                  color: 'white',
                  marginTop: '0.5rem',
                }}
              >
                12 layers of <span style={{ color: '#3b82f6' }}>privacy</span>.
              </h2>
              <p
                style={{
                  marginTop: '1rem',
                  color: '#8888aa',
                  fontSize: '0.95rem',
                  lineHeight: 1.7,
                  maxWidth: '36rem',
                  marginLeft: 'auto',
                  marginRight: 'auto',
                }}
              >
                Every Gateway transaction passes through this stack. Defence in depth: break one layer, eleven more stand.
              </p>
            </div>

            <PrivacyLayersGrid />

            <p
              style={{
                textAlign: 'center',
                marginTop: '2rem',
                fontSize: '0.75rem',
                color: '#555570',
                fontFamily: "'JetBrains Mono',monospace",
              }}
            >
              Layer 0, Layer 1, Layer 2, Layer 3, Layer 4, Layer 8, Layer 9, and Layer 11 are live today. Layers 5–7 and Layer 10 roll out progressively over the coming months.
            </p>
          </div>
        </section>

        {/* ═══ TRUST / SECURITY ═══ */}
        <section style={{ padding: '4rem 1.5rem 6rem' }}>
          <div style={{ maxWidth: '64rem', margin: '0 auto' }}>
            <div style={{ textAlign: 'center', marginBottom: '3rem' }}>
              <span
                style={{
                  fontSize: '0.65rem',
                  color: '#3b82f6',
                  fontFamily: "'JetBrains Mono',monospace",
                  textTransform: 'uppercase',
                  letterSpacing: '0.3em',
                }}
              >
                Security
              </span>
              <h2
                style={{
                  fontFamily: "'Orbitron',sans-serif",
                  fontSize: '1.8rem',
                  fontWeight: 800,
                  color: 'white',
                  marginTop: '0.5rem',
                }}
              >
                Why you can <span style={{ color: '#3b82f6' }}>trust</span> it
              </h2>
            </div>

            <div
              className="three-col"
              style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1.5rem' }}
            >
              {[
                {
                  icon: Lock,
                  title: 'Non-custodial',
                  desc: 'Mugen never holds your crypto or your fiat. The escrow is a smart contract on Solana — code, not a company. You stay in control at every step.',
                  color: '#3b82f6',
                },
                {
                  icon: Clock,
                  title: 'Timeout protection',
                  desc: "Escrows expire automatically after 1 hour. If a seller disappears, your funds aren't stuck — the smart contract refunds them. No human intervention needed.",
                  color: '#8b5cf6',
                },
                {
                  icon: Shield,
                  title: 'ZK Compliance',
                  desc: 'Optional: generate a zero-knowledge proof that you are not on a sanctions list — without revealing your name, address, or any personal data. Valid 90 days.',
                  color: '#60a5fa',
                },
                {
                  icon: Eye,
                  title: 'No data stored',
                  desc: "Mugen doesn't have a database of users. No emails. No phone numbers. No transaction history on our servers. Everything is on-chain and pseudonymous.",
                  color: '#22c55e',
                },
                {
                  icon: AlertTriangle,
                  title: 'Dispute resolution',
                  desc: 'If something goes wrong, either party can open a dispute. An arbitrator reviews the evidence and resolves it. Disputed funds stay locked until resolution.',
                  color: '#eab308',
                },
                {
                  icon: Infinity,
                  title: 'Quantum-resistant',
                  desc: 'Stealth addresses use ML-KEM-768 (post-quantum cryptography) alongside classical ECDH. Your privacy is protected against both current and future threats.',
                  color: '#7c3aed',
                },
                {
                  icon: Coins,
                  title: 'Pay any amount',
                  desc: 'Gateway mode accepts arbitrary fiat amounts — €847.32, $123.45, anything. No round-number structuring. We split it into canonical denominations internally so the pool stays uniform.',
                  color: '#22c55e',
                },
              ].map((item, i) => (
                <GlassCard key={i} glow={i < 3 ? 'blue' : 'violet'} style={{ padding: '1.5rem' }}>
                  <item.icon size={24} style={{ color: item.color, marginBottom: '0.75rem' }} />
                  <h3
                    style={{
                      fontFamily: "'Orbitron',sans-serif",
                      fontSize: '0.85rem',
                      fontWeight: 700,
                      color: 'white',
                      marginBottom: '0.5rem',
                    }}
                  >
                    {item.title}
                  </h3>
                  <p style={{ fontSize: '0.8rem', color: '#8888aa', lineHeight: 1.7 }}>{item.desc}</p>
                </GlassCard>
              ))}
            </div>
          </div>
        </section>

        {/* ═══ FAQ ═══ */}
        <section style={{ padding: '4rem 1.5rem 6rem' }}>
          <div style={{ maxWidth: '42rem', margin: '0 auto' }}>
            <div style={{ textAlign: 'center', marginBottom: '3rem' }}>
              <span
                style={{
                  fontSize: '0.65rem',
                  color: '#8b5cf6',
                  fontFamily: "'JetBrains Mono',monospace",
                  textTransform: 'uppercase',
                  letterSpacing: '0.3em',
                }}
              >
                FAQ
              </span>
              <h2
                style={{
                  fontFamily: "'Orbitron',sans-serif",
                  fontSize: '1.8rem',
                  fontWeight: 800,
                  color: 'white',
                  marginTop: '0.5rem',
                }}
              >
                Common questions
              </h2>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {[
                {
                  q: 'Do I need to pay a round number?',
                  a: 'No. Pay anything — €847.32, $123.45, whatever you want. Layer 1 (Natural Variance Fiat) splits your payment into canonical SOL denominations internally (0.1, 1, 10, 100 SOL). Your bank sees a natural human-looking amount, and the blockchain sees a perfectly uniform pool entry. Leftover fiat (typically under 0.5%) is tracked in a residual sub-wallet.',
                },
                {
                  q: 'What if MoonPay KYCs me?',
                  a: 'Gateway mode routes regulated on-ramps (like MoonPay) through our Treasury Buffer so the provider never sees your final destination wallet. Today, Layer 1 ships live — it already defeats banking structuring detection via natural-variance fiat amounts. The full Treasury Buffer and upstream layers (L2–L11) ship progressively over the coming months. If maximum privacy is critical right now, prefer P2P mode — no KYC at all.',
                },
                {
                  q: 'What if the seller takes my money and never releases?',
                  a: 'The escrow has a 1-hour timeout. If the seller does not confirm, you can open a dispute. If no resolution occurs, the smart contract automatically refunds the crypto. Your fiat transfer is between you and the seller via standard banking — Mugen provides dispute arbitration for the crypto side.',
                },
                {
                  q: 'Do I need to create an account?',
                  a: 'No. You only need a Solana wallet (Protocol 01 extension or any compatible wallet). No email, no phone number, no personal information of any kind.',
                },
                {
                  q: 'Is this legal?',
                  a: 'Mugen is a peer-to-peer matching platform. It does not hold funds, process payments, or act as a money transmitter. Fiat transfers happen directly between users through standard banking channels. Users are responsible for compliance with their local regulations.',
                },
                {
                  q: 'What is the ZK Compliance proof?',
                  a: 'An optional zero-knowledge proof that demonstrates you are not on international sanctions lists — without revealing your identity. The proof is generated locally on your device using Groth16 ZK-SNARKs and verified on-chain. It is valid for 90 days.',
                },
                {
                  q: 'What are stealth addresses?',
                  a: "A one-time address derived from your public key. When enabled, the crypto you receive can't be linked to your main wallet by anyone — not the seller, not blockchain analysts, not even Mugen. It uses ECDH combined with ML-KEM-768 for quantum resistance.",
                },
                {
                  q: 'What fees does Mugen charge?',
                  a: 'The protocol fee is below 0.5% per trade, split between Protocol 01 infrastructure, Mugen operations, and a community treasury. There are no hidden fees. The exact fee is shown before you confirm any trade.',
                },
                {
                  q: 'Can I sell crypto too?',
                  a: 'Yes. Go to the P2P Exchange, switch to "Sell Crypto", and create an order. You set your price, accepted payment methods, and trade limits. When a buyer takes your order, your crypto is locked in escrow until you confirm receiving the fiat.',
                },
                {
                  q: 'Where can I see this working today?',
                  a: '/exchange/private is the live production surface. Create a private order or find a match — every submit is cryptographically receipted on Solana devnet. Browse the on-chain activity feed at the bottom of that page.',
                },
              ].map((item, i) => (
                <GlassCard key={i} style={{ padding: '1.25rem 1.5rem' }}>
                  <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
                    <HelpCircle
                      size={18}
                      style={{ color: '#3b82f6', flexShrink: 0, marginTop: '0.15rem' }}
                    />
                    <div>
                      <h4
                        style={{
                          fontFamily: "'Orbitron',sans-serif",
                          fontSize: '0.8rem',
                          fontWeight: 700,
                          color: 'white',
                          marginBottom: '0.5rem',
                        }}
                      >
                        {item.q}
                      </h4>
                      <p style={{ fontSize: '0.8rem', color: '#8888aa', lineHeight: 1.7 }}>{item.a}</p>
                    </div>
                  </div>
                </GlassCard>
              ))}
            </div>
          </div>
        </section>

        {/* ═══ CTA ═══ */}
        <section style={{ padding: '4rem 1.5rem 6rem', textAlign: 'center' }}>
          <div style={{ maxWidth: '36rem', margin: '0 auto' }}>
            <GlassCard glow="violet" style={{ padding: '3.5rem 2.5rem', textAlign: 'center' }}>
              <h2
                style={{
                  fontFamily: "'Orbitron',sans-serif",
                  fontSize: '1.6rem',
                  fontWeight: 800,
                  color: 'white',
                  marginBottom: '1rem',
                }}
              >
                Ready to <span style={{ color: '#3b82f6' }}>trade</span>?
              </h2>
              <p style={{ color: '#8888aa', fontSize: '0.9rem', lineHeight: 1.7, marginBottom: '2rem' }}>
                No sign-up. No KYC. Connect your wallet and start in 30 seconds.
              </p>
              <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center', flexWrap: 'wrap' }}>
                <Link
                  href="/pay"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    padding: '0.9rem 2rem',
                    background: 'linear-gradient(135deg, #3b82f6, #7c3aed)',
                    color: 'white',
                    fontFamily: "'Orbitron',sans-serif",
                    fontWeight: 700,
                    fontSize: '0.85rem',
                    textDecoration: 'none',
                    borderRadius: '12px',
                    textTransform: 'uppercase',
                    boxShadow: '0 4px 20px rgba(59,130,246,0.3)',
                  }}
                >
                  Buy Crypto
                  <ArrowRight size={16} />
                </Link>
                <Link
                  href="/exchange"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    padding: '0.9rem 2rem',
                    background: 'rgba(255,255,255,0.03)',
                    backdropFilter: 'blur(12px)',
                    border: '1px solid rgba(139,92,246,0.2)',
                    color: '#a78bfa',
                    fontFamily: "'Orbitron',sans-serif",
                    fontWeight: 600,
                    fontSize: '0.85rem',
                    textDecoration: 'none',
                    borderRadius: '12px',
                    textTransform: 'uppercase',
                  }}
                >
                  P2P Exchange
                </Link>
              </div>
            </GlassCard>
          </div>
        </section>

        {/* ═══ FOOTER ═══ */}
        <footer style={{ borderTop: '1px solid rgba(255,255,255,0.04)', padding: '2rem 1.5rem' }}>
          <div
            style={{
              maxWidth: '72rem',
              margin: '0 auto',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: '1rem',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <img src="/mugen-icon.png" alt="Mugen" style={{ width: '1.4rem', height: '1.4rem', objectFit: 'contain' }} />
              <span style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '0.85rem', fontWeight: 700, color: '#3b82f6' }}>
                MUGEN
              </span>
              <span style={{ color: '#555570', fontSize: '0.7rem' }}>無限</span>
            </div>
            <p style={{ color: '#555570', fontSize: '0.7rem', fontFamily: "'JetBrains Mono',monospace" }}>
              Powered by Protocol 01 — Privacy Layer for Solana
            </p>
          </div>
        </footer>
      </main>
    </>
  );
}

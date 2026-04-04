'use client';

import { memo } from 'react';
import Link from 'next/link';
import { Shield, ArrowRight, Infinity, TrendingUp, Users, Lock, Zap, ExternalLink } from 'lucide-react';
import MugenNavbar from '@/components/MugenNavbar';

// ═══════════════════════════════════════════════════════════════════════════
// AMBIENT ORB BACKGROUND — Floating neon color meshes
// ═══════════════════════════════════════════════════════════════════════════

const AmbientOrbs = memo(function AmbientOrbs() {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 0, overflow: 'hidden', pointerEvents: 'none' }}>
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes orb-drift-1 { 0%,100%{transform:translate(0,0) scale(1)} 33%{transform:translate(80px,-60px) scale(1.1)} 66%{transform:translate(-40px,40px) scale(0.95)} }
        @keyframes orb-drift-2 { 0%,100%{transform:translate(0,0) scale(1)} 25%{transform:translate(-60px,80px) scale(1.05)} 50%{transform:translate(50px,20px) scale(0.9)} 75%{transform:translate(-20px,-50px) scale(1.1)} }
        @keyframes orb-drift-3 { 0%,100%{transform:translate(0,0) scale(0.9)} 40%{transform:translate(100px,-40px) scale(1.15)} 80%{transform:translate(-60px,60px) scale(0.85)} }
        @keyframes float-3d { 0%,100%{transform:translateY(0) rotateX(0)} 50%{transform:translateY(-15px) rotateX(2deg)} }
        @keyframes glow-breathe { 0%,100%{opacity:0.6;filter:blur(0px)} 50%{opacity:1;filter:blur(1px)} }
        @keyframes card-shine { 0%{background-position:-200% 0} 100%{background-position:200% 0} }
        @keyframes gradient-border { 0%{background-position:0% 50%} 50%{background-position:100% 50%} 100%{background-position:0% 50%} }
        @keyframes fade-in-up-hero { from{opacity:0;transform:translateY(30px)} to{opacity:1;transform:translateY(0)} }
        @keyframes pulse-ring { 0%{transform:scale(0.8);opacity:0.5} 50%{transform:scale(1.2);opacity:0.2} 100%{transform:scale(0.8);opacity:0.5} }
        @media(prefers-reduced-motion:reduce){*{animation:none!important}}

        /* ── Responsive breakpoints ── */
        @media (max-width: 768px) {
          .hero-grid { grid-template-columns: 1fr !important; }
          .hero-right { display: none !important; }
          .stats-grid { grid-template-columns: repeat(2, 1fr) !important; }
          .steps-grid { grid-template-columns: 1fr !important; }
          .features-grid { grid-template-columns: 1fr !important; }
        }
        @media (min-width: 769px) and (max-width: 1024px) {
          .steps-grid { grid-template-columns: repeat(2, 1fr) !important; }
        }
      `}} />

      {/* Orb 1 — Blue (Gojo cursed energy) */}
      <div style={{
        position: 'absolute', left: '15%', top: '20%',
        width: '500px', height: '500px', borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(59,130,246,0.15) 0%, rgba(59,130,246,0.05) 40%, transparent 70%)',
        filter: 'blur(60px)',
        animation: 'orb-drift-1 20s ease-in-out infinite',
      }} />

      {/* Orb 2 — Violet (Infinity barrier) */}
      <div style={{
        position: 'absolute', right: '10%', top: '10%',
        width: '400px', height: '400px', borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(139,92,246,0.12) 0%, rgba(139,92,246,0.04) 40%, transparent 70%)',
        filter: 'blur(50px)',
        animation: 'orb-drift-2 25s ease-in-out infinite',
      }} />

      {/* Orb 3 — Cyan accent */}
      <div style={{
        position: 'absolute', left: '50%', bottom: '15%',
        width: '350px', height: '350px', borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(96,165,250,0.1) 0%, transparent 60%)',
        filter: 'blur(40px)',
        animation: 'orb-drift-3 18s ease-in-out infinite',
      }} />

      {/* Subtle grid */}
      <div style={{
        position: 'absolute', inset: 0,
        backgroundImage: 'linear-gradient(rgba(59,130,246,0.02) 1px, transparent 1px), linear-gradient(90deg, rgba(139,92,246,0.015) 1px, transparent 1px)',
        backgroundSize: '80px 80px',
      }} />
    </div>
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// GLASS CARD COMPONENT
// ═══════════════════════════════════════════════════════════════════════════

function GlassCard({ children, style, hover, glow }: {
  children: React.ReactNode;
  style?: React.CSSProperties;
  hover?: boolean;
  glow?: 'blue' | 'violet' | 'none';
}) {
  const glowShadow = glow === 'blue'
    ? '0 8px 32px rgba(59,130,246,0.15), 0 0 60px rgba(59,130,246,0.05)'
    : glow === 'violet'
    ? '0 8px 32px rgba(139,92,246,0.15), 0 0 60px rgba(139,92,246,0.05)'
    : '0 8px 32px rgba(0,0,0,0.3)';

  return (
    <div style={{
      position: 'relative',
      background: 'rgba(255,255,255,0.03)',
      backdropFilter: 'blur(16px)',
      WebkitBackdropFilter: 'blur(16px)',
      border: '1px solid rgba(255,255,255,0.06)',
      borderRadius: '20px',
      padding: '1.5rem',
      boxShadow: glowShadow,
      transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
      overflow: 'hidden',
      ...style,
    }}>
      {/* Inner highlight gradient */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: '1px',
        background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent)',
      }} />
      {children}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// 3D FLOATING INFINITY SPHERE
// ═══════════════════════════════════════════════════════════════════════════

const InfinitySphere = memo(function InfinitySphere() {
  return (
    <div style={{
      position: 'relative',
      width: '340px', height: '340px',
      animation: 'float-3d 6s ease-in-out infinite',
    }}>
      {/* Outer glow ring */}
      <div style={{
        position: 'absolute', inset: '-20px',
        borderRadius: '50%',
        background: 'conic-gradient(from 0deg, rgba(59,130,246,0.2), rgba(139,92,246,0.15), rgba(96,165,250,0.1), rgba(59,130,246,0.2))',
        filter: 'blur(30px)',
        animation: 'pulse-ring 4s ease-in-out infinite',
      }} />

      {/* Glass sphere */}
      <div style={{
        position: 'absolute', inset: '20px',
        borderRadius: '50%',
        background: 'radial-gradient(circle at 35% 30%, rgba(96,165,250,0.15), rgba(59,130,246,0.05) 40%, rgba(139,92,246,0.03) 70%, transparent)',
        border: '1px solid rgba(255,255,255,0.08)',
        backdropFilter: 'blur(12px)',
        boxShadow: 'inset 0 0 60px rgba(59,130,246,0.08), 0 20px 60px rgba(0,0,0,0.3)',
      }}>
        {/* Specular highlight */}
        <div style={{
          position: 'absolute', top: '15%', left: '20%',
          width: '80px', height: '40px', borderRadius: '50%',
          background: 'radial-gradient(ellipse, rgba(255,255,255,0.15), transparent)',
          transform: 'rotate(-20deg)',
        }} />
      </div>

      {/* Orbit rings */}
      {[0, 60, 120].map((rot, i) => (
        <div key={i} style={{
          position: 'absolute', inset: '10px',
          borderRadius: '50%',
          border: `1px solid rgba(${i === 0 ? '59,130,246' : i === 1 ? '139,92,246' : '96,165,250'},0.12)`,
          transform: `rotateX(${60 + i * 10}deg) rotateY(${rot}deg)`,
        }} />
      ))}

      {/* Center infinity */}
      <div style={{
        position: 'absolute', inset: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Infinity
          size={60}
          strokeWidth={1.2}
          style={{
            color: '#60a5fa',
            filter: 'drop-shadow(0 0 15px rgba(59,130,246,0.5)) drop-shadow(0 0 30px rgba(139,92,246,0.3))',
            animation: 'glow-breathe 3s ease-in-out infinite',
          }}
        />
      </div>

      {/* Floating kanji */}
      <div style={{
        position: 'absolute', top: '-10px', right: '10px',
        fontSize: '3rem', color: 'rgba(139,92,246,0.12)', fontWeight: 100,
        animation: 'float-3d 8s ease-in-out infinite',
      }}>無</div>
      <div style={{
        position: 'absolute', bottom: '0', left: '10px',
        fontSize: '2.5rem', color: 'rgba(59,130,246,0.1)', fontWeight: 100,
        animation: 'float-3d 7s ease-in-out infinite', animationDelay: '2s',
      }}>限</div>
    </div>
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════════════

export default function LandingPage() {
  return (
    <>
      <AmbientOrbs />
      <MugenNavbar />

      <main style={{ position: 'relative', zIndex: 10 }}>

        {/* ═══ HERO ═══ */}
        <section style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          padding: '6rem 1.5rem 4rem',
          boxSizing: 'border-box',
        }}>
          <div className="hero-grid" style={{
            maxWidth: '80rem', margin: '0 auto', width: '100%',
            display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4rem', alignItems: 'center',
          }}>
            {/* Left — Content */}
            <div>
              {/* Badge */}
              <div style={{
                display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
                padding: '0.4rem 1rem',
                background: 'rgba(59,130,246,0.08)',
                border: '1px solid rgba(59,130,246,0.2)',
                borderRadius: '100px',
                marginBottom: '1.5rem',
                animation: 'fade-in-up-hero 0.6s ease-out both',
              }}>
                <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 8px rgba(34,197,94,0.5)' }} />
                <span style={{ fontSize: '0.7rem', color: '#60a5fa', fontFamily: "'JetBrains Mono',monospace", textTransform: 'uppercase', letterSpacing: '0.15em' }}>
                  Powered by Protocol 01
                </span>
              </div>

              {/* Title */}
              <h1 style={{
                fontFamily: "'Orbitron',sans-serif",
                fontSize: 'clamp(2.5rem, 5vw, 4.5rem)',
                fontWeight: 900,
                lineHeight: 1.05,
                marginBottom: '0.5rem',
                animation: 'fade-in-up-hero 0.6s ease-out 0.1s both',
              }}>
                <span style={{ background: 'linear-gradient(135deg, #3b82f6 0%, #8b5cf6 50%, #60a5fa 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                  MUGEN
                </span>
                <br />
                <span style={{ color: 'rgba(240,240,255,0.9)', fontSize: '0.5em', fontWeight: 600, letterSpacing: '0.1em' }}>
                  EXCHANGE 無限
                </span>
              </h1>

              {/* Subtitle */}
              <p style={{
                fontSize: '1.1rem', color: '#8888aa',
                fontFamily: "'Inter',sans-serif", lineHeight: 1.7,
                maxWidth: '480px', marginBottom: '2.5rem',
                animation: 'fade-in-up-hero 0.6s ease-out 0.2s both',
              }}>
                The zero-knowledge payment system behind{' '}
                <a href="https://protocol-01.vercel.app" target="_blank" rel="noopener noreferrer" style={{ color: '#3b82f6', fontWeight: 600, textDecoration: 'none' }}>Protocol 01</a>.
                Peer-to-peer. No KYC. No identity stored. Crypto arrives at an address only you control.
              </p>

              {/* CTA */}
              <div style={{
                display: 'flex', gap: '1rem', flexWrap: 'wrap',
                animation: 'fade-in-up-hero 0.6s ease-out 0.3s both',
              }}>
                <Link href="/how-it-works" style={{
                  display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
                  padding: '0.9rem 2rem',
                  background: 'linear-gradient(135deg, #3b82f6, #7c3aed)',
                  color: 'white', fontFamily: "'Orbitron',sans-serif", fontWeight: 700,
                  fontSize: '0.85rem', textDecoration: 'none', borderRadius: '12px',
                  textTransform: 'uppercase', letterSpacing: '0.05em',
                  boxShadow: '0 4px 20px rgba(59,130,246,0.3), 0 0 40px rgba(139,92,246,0.1)',
                  transition: 'all 0.3s',
                }}>
                  How it works
                  <ArrowRight size={16} />
                </Link>
                <a
                  href="https://protocol-01.vercel.app"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
                    padding: '0.9rem 2rem',
                    background: 'rgba(255,255,255,0.03)',
                    backdropFilter: 'blur(12px)',
                    border: '1px solid rgba(139,92,246,0.2)',
                    color: '#a78bfa', fontFamily: "'Orbitron',sans-serif", fontWeight: 600,
                    fontSize: '0.85rem', borderRadius: '12px',
                    textTransform: 'uppercase', letterSpacing: '0.05em',
                    textDecoration: 'none',
                    transition: 'all 0.3s',
                  }}
                >
                  <ExternalLink size={14} />
                  Protocol 01
                </a>
              </div>
            </div>

            {/* Right — 3D Sphere */}
            <div className="hero-right" style={{
              display: 'flex', justifyContent: 'center', alignItems: 'center',
              animation: 'fade-in-up-hero 1s ease-out 0.3s both',
            }}>
              <InfinitySphere />
            </div>
          </div>
        </section>

        {/* ═══ STATS BAR ═══ */}
        <section style={{ padding: '0 1.5rem 4rem' }}>
          <div style={{ maxWidth: '80rem', margin: '0 auto' }}>
            <GlassCard style={{ padding: '2rem 3rem', borderRadius: '16px' }} glow="blue">
              <div className="stats-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '2rem', textAlign: 'center' }}>
                {[
                  { value: '0%', label: 'KYC Required', icon: Shield, color: '#3b82f6' },
                  { value: '<0.5%', label: 'Protocol Fee', icon: TrendingUp, color: '#8b5cf6' },
                  { value: '∞', label: 'Privacy Level', icon: Lock, color: '#60a5fa' },
                  { value: 'P-Q', label: 'Proof System', icon: Zap, color: '#7c3aed' },
                ].map((s, i) => (
                  <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.3rem' }}>
                    <s.icon size={18} style={{ color: s.color, marginBottom: '0.3rem' }} />
                    <span style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1.5rem', fontWeight: 800, color: 'white' }}>{s.value}</span>
                    <span style={{ fontSize: '0.65rem', color: '#555570', fontFamily: "'JetBrains Mono',monospace", textTransform: 'uppercase', letterSpacing: '0.1em' }}>{s.label}</span>
                  </div>
                ))}
              </div>
            </GlassCard>
          </div>
        </section>

        {/* ═══ HOW IT WORKS ═══ */}
        <section style={{ padding: '6rem 1.5rem' }}>
          <div style={{ maxWidth: '64rem', margin: '0 auto' }}>
            <div style={{ textAlign: 'center', marginBottom: '4rem' }}>
              <span style={{ fontSize: '0.65rem', color: '#3b82f6', fontFamily: "'JetBrains Mono',monospace", textTransform: 'uppercase', letterSpacing: '0.3em' }}>PROTOCOL</span>
              <h2 style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '2.2rem', fontWeight: 800, color: 'white', marginTop: '0.5rem' }}>
                How <span style={{ color: '#3b82f6' }}>Mugen</span> works
              </h2>
            </div>

            <div className="steps-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1.5rem' }}>
              {[
                { step: '01', title: 'P2P Matching', desc: 'The system matches buyers and sellers automatically. No middleman. No account needed.', color: '#3b82f6', icon: Users },
                { step: '02', title: 'On-Chain Escrow', desc: 'Crypto is locked in a Solana smart contract. Neither party — nor Mugen — can touch it.', color: '#8b5cf6', icon: Lock },
                { step: '03', title: 'Direct Fiat', desc: 'Fiat is sent directly between users via standard banking (Revolut, SEPA, Wise). Mugen never handles money.', color: '#60a5fa', icon: TrendingUp },
                { step: '04', title: 'Stealth Delivery', desc: 'Crypto arrives at a one-time stealth address. Untraceable, even with quantum computers.', color: '#7c3aed', icon: Zap },
              ].map((item, i) => (
                <GlassCard key={i} glow={i % 2 === 0 ? 'blue' : 'violet'} style={{ padding: '2rem 1.5rem', textAlign: 'center' }}>
                  <div style={{
                    width: '3rem', height: '3rem', borderRadius: '14px', margin: '0 auto 1rem',
                    background: `linear-gradient(135deg, ${item.color}20, ${item.color}08)`,
                    border: `1px solid ${item.color}30`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <item.icon size={20} style={{ color: item.color }} />
                  </div>
                  <span style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '0.65rem', color: item.color, letterSpacing: '0.2em' }}>{item.step}</span>
                  <h3 style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1rem', fontWeight: 700, color: 'white', margin: '0.5rem 0' }}>{item.title}</h3>
                  <p style={{ fontSize: '0.8rem', color: '#8888aa', lineHeight: 1.6 }}>{item.desc}</p>
                </GlassCard>
              ))}
            </div>
          </div>
        </section>

        {/* ═══ FEATURES ═══ */}
        <section style={{ padding: '6rem 1.5rem' }}>
          <div style={{ maxWidth: '72rem', margin: '0 auto' }}>
            <div style={{ textAlign: 'center', marginBottom: '4rem' }}>
              <span style={{ fontSize: '0.65rem', color: '#8b5cf6', fontFamily: "'JetBrains Mono',monospace", textTransform: 'uppercase', letterSpacing: '0.3em' }}>CAPABILITIES</span>
              <h2 style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '2.2rem', fontWeight: 800, color: 'white', marginTop: '0.5rem' }}>
                Built <span style={{ color: '#8b5cf6' }}>different</span>
              </h2>
            </div>

            <div className="features-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '1.5rem' }}>
              {[
                { icon: Shield, title: 'Zero-Knowledge Compliance', desc: 'Sanctions innocence proofs replace KYC. Prove compliance without revealing your identity, wallet, or any personal data.', color: '#3b82f6' },
                { icon: Lock, title: 'Quantum-Proof Security', desc: 'ML-KEM-768 stealth addresses + STARK verification. Resistant to both classical and quantum adversaries.', color: '#8b5cf6' },
                { icon: Users, title: 'Anonymous Reputation', desc: 'Poseidon commitment-based reputation. Your track record follows you, but nobody knows who you are.', color: '#60a5fa' },
                { icon: Zap, title: 'On-Chain Escrow', desc: 'Crypto locked in a PDA-owned vault. Automatic timeout refunds. No intermediary. Just code.', color: '#7c3aed' },
              ].map((f, i) => (
                <GlassCard key={i} glow={i < 2 ? 'blue' : 'violet'} style={{ padding: '2rem' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '1.2rem' }}>
                    <div style={{
                      width: '3rem', height: '3rem', borderRadius: '14px', flexShrink: 0,
                      background: `linear-gradient(135deg, ${f.color}15, ${f.color}05)`,
                      border: `1px solid ${f.color}25`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <f.icon size={20} style={{ color: f.color }} />
                    </div>
                    <div>
                      <h3 style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '0.95rem', fontWeight: 700, color: 'white', marginBottom: '0.5rem' }}>{f.title}</h3>
                      <p style={{ fontSize: '0.85rem', color: '#8888aa', lineHeight: 1.7 }}>{f.desc}</p>
                    </div>
                  </div>
                </GlassCard>
              ))}
            </div>
          </div>
        </section>

        {/* ═══ CTA ═══ */}
        <section style={{ padding: '6rem 1.5rem', textAlign: 'center' }}>
          <div style={{ maxWidth: '40rem', margin: '0 auto' }}>
            <GlassCard glow="violet" style={{ padding: '4rem 3rem', textAlign: 'center' }}>
              <div style={{
                width: '4rem', height: '4rem', borderRadius: '50%', margin: '0 auto 1.5rem',
                background: 'linear-gradient(135deg, rgba(59,130,246,0.15), rgba(139,92,246,0.1))',
                border: '1px solid rgba(255,255,255,0.06)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Infinity size={28} style={{ color: '#60a5fa' }} />
              </div>
              <h2 style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '2rem', fontWeight: 800, color: 'white', marginBottom: '1rem' }}>
                Built into <span style={{ color: '#3b82f6' }}>Protocol 01</span>
              </h2>
              <p style={{ color: '#8888aa', fontSize: '0.95rem', lineHeight: 1.7, marginBottom: '2rem' }}>
                Mugen is integrated directly into the Protocol 01 mobile app and browser extension. Buy crypto privately, right where you manage your wallet.
              </p>
              <a
                href="https://protocol-01.vercel.app"
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
                  padding: '1rem 2.5rem',
                  background: 'linear-gradient(135deg, #3b82f6, #7c3aed)',
                  color: 'white', fontFamily: "'Orbitron',sans-serif", fontWeight: 700,
                  fontSize: '0.9rem', textDecoration: 'none', borderRadius: '14px',
                  textTransform: 'uppercase',
                  boxShadow: '0 4px 30px rgba(59,130,246,0.35), 0 0 60px rgba(139,92,246,0.15)',
                }}
              >
                Discover Protocol 01
                <ExternalLink size={16} />
              </a>
            </GlassCard>
          </div>
        </section>

        {/* ═══ FOOTER ═══ */}
        <footer style={{ borderTop: '1px solid rgba(255,255,255,0.04)', padding: '2rem 1.5rem' }}>
          <div style={{ maxWidth: '72rem', margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <img src="/mugen-icon.png" alt="Mugen" style={{ width: '1.4rem', height: '1.4rem', objectFit: 'contain' }} />
              <span style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '0.85rem', fontWeight: 700, color: '#3b82f6' }}>MUGEN</span>
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

'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Menu, X, HelpCircle, ExternalLink, Lock, Network, Zap, Waves } from 'lucide-react';

export default function MugenNavbar() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <nav
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 50,
        backdropFilter: 'blur(12px)',
        background: 'rgba(5, 5, 16, 0.85)',
        borderBottom: '1px solid rgba(139, 92, 246, 0.1)',
      }}
    >
      <div
        style={{
          maxWidth: '80rem',
          margin: '0 auto',
          padding: '0 1.5rem',
          height: '4rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
          boxSizing: 'border-box',
        }}
      >
        {/* Logo */}
        <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', textDecoration: 'none' }}>
          <img
            src="/mugen-icon.png"
            alt="Mugen"
            style={{
              width: '2rem',
              height: '2rem',
              borderRadius: '50%',
              objectFit: 'cover',
              filter: 'drop-shadow(0 0 8px rgba(59, 130, 246, 0.4))',
            }}
          />
          <span style={{ fontFamily: "'Orbitron', sans-serif", fontSize: '1.1rem', fontWeight: 700, background: 'linear-gradient(135deg, #3b82f6, #8b5cf6, #60a5fa)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            MUGEN
          </span>
          <span style={{ color: '#555570', fontSize: '0.7rem', fontFamily: "'JetBrains Mono', monospace" }}>無限</span>
        </Link>

        {/* Desktop Nav */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '2rem' }} className="hidden md:flex">
          <Link href="/how-it-works" style={{ fontSize: '0.8rem', color: '#8888aa', textDecoration: 'none', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', letterSpacing: '0.1em', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
            <HelpCircle size={12} />
            How it works
          </Link>
          <Link href="/exchange/private" style={{ fontSize: '0.8rem', color: '#a78bfa', textDecoration: 'none', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', letterSpacing: '0.1em', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
            <Lock size={12} />
            Private Trade
          </Link>
          <Link href="/demo/nym-mixnet" style={{ fontSize: '0.8rem', color: '#60a5fa', textDecoration: 'none', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', letterSpacing: '0.1em', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
            <Waves size={12} />
            Mixnet
          </Link>
          <Link href="/demo/threshold-relayer" style={{ fontSize: '0.8rem', color: '#93c5fd', textDecoration: 'none', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', letterSpacing: '0.1em', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
            <Network size={12} />
            Threshold
          </Link>
          <Link href="/demo/private-rollup" style={{ fontSize: '0.8rem', color: '#60a5fa', textDecoration: 'none', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', letterSpacing: '0.1em', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
            <Zap size={12} />
            Private Rollup
          </Link>
          <a
            href="https://protocol-01.dev"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: '0.8rem',
              color: '#60a5fa',
              textDecoration: 'none',
              fontFamily: "'Orbitron', sans-serif",
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              display: 'flex',
              alignItems: 'center',
              gap: '0.3rem',
            }}
          >
            Protocol 01
            <ExternalLink size={11} />
          </a>
        </div>

        {/* Mobile toggle */}
        <button
          className="md:hidden"
          onClick={() => setMobileOpen(!mobileOpen)}
          style={{ background: 'none', border: 'none', color: '#8888aa', cursor: 'pointer' }}
        >
          {mobileOpen ? <X size={24} /> : <Menu size={24} />}
        </button>
      </div>

      {/* Mobile Menu */}
      {mobileOpen && (
        <div
          style={{
            background: '#0a0a1a',
            borderTop: '1px solid rgba(139, 92, 246, 0.1)',
            padding: '1rem 1.5rem',
          }}
          className="md:hidden"
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <Link href="/how-it-works" onClick={() => setMobileOpen(false)} style={{ color: '#8888aa', textDecoration: 'none', fontSize: '0.9rem', fontFamily: "'JetBrains Mono', monospace" }}>
              How it works
            </Link>
            <Link href="/exchange/private" onClick={() => setMobileOpen(false)} style={{ color: '#a78bfa', textDecoration: 'none', fontSize: '0.9rem', fontFamily: "'JetBrains Mono', monospace" }}>
              Private Trade
            </Link>
            <Link href="/demo/nym-mixnet" onClick={() => setMobileOpen(false)} style={{ color: '#60a5fa', textDecoration: 'none', fontSize: '0.9rem', fontFamily: "'JetBrains Mono', monospace" }}>
              Mixnet
            </Link>
            <Link href="/demo/threshold-relayer" onClick={() => setMobileOpen(false)} style={{ color: '#93c5fd', textDecoration: 'none', fontSize: '0.9rem', fontFamily: "'JetBrains Mono', monospace" }}>
              Threshold
            </Link>
            <Link href="/demo/private-rollup" onClick={() => setMobileOpen(false)} style={{ color: '#60a5fa', textDecoration: 'none', fontSize: '0.9rem', fontFamily: "'JetBrains Mono', monospace" }}>
              Private Rollup
            </Link>
            <a
              href="https://protocol-01.dev"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setMobileOpen(false)}
              style={{ color: '#60a5fa', textDecoration: 'none', fontSize: '0.9rem', fontFamily: "'Orbitron', sans-serif", fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.3rem' }}
            >
              Protocol 01 <ExternalLink size={12} />
            </a>
          </div>
        </div>
      )}
    </nav>
  );
}

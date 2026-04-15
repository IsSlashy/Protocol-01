'use client';

import { useEffect, useState } from 'react';
import { Waves } from 'lucide-react';

// ═══════════════════════════════════════════════════════════════════════════
// NoiseStatsCard — Layer 3 Distributed Noise live counters
// Polls /api/noise/stats every 10s. Honest about MVP scope in the footnote.
// ═══════════════════════════════════════════════════════════════════════════

interface NoiseStatsShape {
  walletCount: number;
  totalDecoysSubmitted: number;
  totalDecoysFailed: number;
  lastDecoyAt: number | null;
  scheduledPending: number;
}

const POLL_INTERVAL_MS = 10_000;

export default function NoiseStatsCard() {
  const [stats, setStats] = useState<NoiseStatsShape | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchStats = async () => {
      try {
        const res = await fetch('/api/noise/stats', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as NoiseStatsShape;
        if (!cancelled) {
          setStats(json);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'network error');
        }
      }
    };
    void fetchStats();
    const timer = setInterval(() => {
      void fetchStats();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const metricStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
    padding: '0.8rem 0.9rem',
    background: 'rgba(14,165,233,0.04)',
    border: '1px solid rgba(14,165,233,0.15)',
    borderRadius: '10px',
    minWidth: 0,
  };

  return (
    <div style={{ padding: '1.2rem 1.4rem 1.3rem', display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem' }}>
        <div
          style={{
            width: '2rem',
            height: '2rem',
            borderRadius: '10px',
            background: 'linear-gradient(135deg, rgba(14,165,233,0.25), rgba(14,165,233,0.08))',
            border: '1px solid rgba(14,165,233,0.4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Waves size={15} style={{ color: '#38bdf8' }} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
          <span
            style={{
              fontFamily: "'Orbitron', sans-serif",
              fontSize: '0.85rem',
              fontWeight: 700,
              color: '#ffffff',
              letterSpacing: '0.04em',
            }}
          >
            Layer 3 · Distributed Noise
          </span>
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '0.62rem',
              color: '#38bdf8',
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
            }}
          >
            Live · noise pool
          </span>
        </div>
      </div>

      {error && !stats && (
        <div
          style={{
            padding: '0.7rem 0.9rem',
            borderRadius: '10px',
            background: 'rgba(239,68,68,0.08)',
            border: '1px solid rgba(239,68,68,0.25)',
            color: '#fca5a5',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '0.72rem',
          }}
        >
          stats unavailable · {error}
        </div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: '0.55rem',
        }}
      >
        <div style={metricStyle}>
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '0.6rem',
              color: '#8888aa',
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
            }}
          >
            Submitted
          </span>
          <span
            style={{
              fontFamily: "'Orbitron', sans-serif",
              fontSize: '1.05rem',
              fontWeight: 700,
              color: '#38bdf8',
            }}
          >
            {stats ? stats.totalDecoysSubmitted : '—'}
          </span>
        </div>
        <div style={metricStyle}>
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '0.6rem',
              color: '#8888aa',
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
            }}
          >
            Pending
          </span>
          <span
            style={{
              fontFamily: "'Orbitron', sans-serif",
              fontSize: '1.05rem',
              fontWeight: 700,
              color: '#c4b5fd',
            }}
          >
            {stats ? stats.scheduledPending : '—'}
          </span>
        </div>
        <div style={metricStyle}>
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '0.6rem',
              color: '#8888aa',
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
            }}
          >
            Wallets
          </span>
          <span
            style={{
              fontFamily: "'Orbitron', sans-serif",
              fontSize: '1.05rem',
              fontWeight: 700,
              color: '#86efac',
            }}
          >
            {stats ? stats.walletCount : '—'}
          </span>
        </div>
      </div>

      <p
        style={{
          margin: 0,
          fontFamily: "'Inter', sans-serif",
          fontSize: '0.74rem',
          color: '#8888aa',
          lineHeight: 1.55,
        }}
      >
        Decoys are <strong style={{ color: '#c4b5fd' }}>real encrypted MPC submissions</strong> fired
        from dedicated noise wallets. They are cryptographically indistinguishable from organic traffic
        (same program, same instruction, same ciphertext size, same FROST gate).
      </p>

      <p
        style={{
          margin: 0,
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '0.66rem',
          color: '#555570',
          lineHeight: 1.55,
          borderTop: '1px dashed rgba(136,136,170,0.18)',
          paddingTop: '0.6rem',
        }}
      >
        MVP · server-side noise pool of {stats ? stats.walletCount : 5} wallets. Phase 2 swaps this
        for a distributed opt-in network with per-user rewards for participation (true k-anonymity).
      </p>

      {stats && stats.totalDecoysFailed > 0 && (
        <div
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '0.62rem',
            color: '#fcd34d',
          }}
        >
          {stats.totalDecoysFailed} decoy{stats.totalDecoysFailed === 1 ? '' : 's'} failed (see server logs)
        </div>
      )}
    </div>
  );
}

'use client';

/**
 * RelayerHealthBadge — discrete fixed traffic-light for the privacy relayers.
 * Polls /api/relayer-health (server-side proxy) every 60s. Hover/click for detail.
 * Green = a relayer is healthy, Orange = degraded/slow, Red = all down.
 */
import { useEffect, useState } from 'react';

type Relayer = {
  label: string;
  state: 'healthy' | 'degraded' | 'down';
  reachable: boolean;
  lastError: string | null;
  lastPollAgeMs: number | null;
};
type Health = { status: 'green' | 'orange' | 'red'; relayers: Relayer[]; checkedAt: number };

const COLOR: Record<string, string> = { green: '#39c5bb', orange: '#f5a623', red: '#ff3b3b', unknown: '#555560' };
const LABEL: Record<string, string> = {
  green: 'Privacy relay: healthy',
  orange: 'Privacy relay: degraded',
  red: 'Privacy relay: down',
  unknown: 'Privacy relay: checking…',
};

export default function RelayerHealthBadge() {
  const [health, setHealth] = useState<Health | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let mounted = true;
    const run = () =>
      fetch('/api/relayer-health', { cache: 'no-store' })
        .then((r) => r.json())
        .then((h) => { if (mounted) setHealth(h); })
        .catch(() => {});
    run();
    const id = setInterval(run, 60_000);
    return () => { mounted = false; clearInterval(id); };
  }, []);

  const lvl = health?.status ?? 'unknown';
  const color = COLOR[lvl];

  return (
    <div
      style={{ position: 'fixed', bottom: 14, left: 14, zIndex: 50 }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={`Privacy relay status: ${lvl}`}
        style={{
          display: 'flex', alignItems: 'center', gap: 7,
          padding: '5px 10px', borderRadius: 999,
          background: 'rgba(10,10,15,0.65)', border: '1px solid rgba(255,255,255,0.08)',
          backdropFilter: 'blur(8px)', cursor: 'pointer',
        }}
      >
        <span style={{ width: 8, height: 8, borderRadius: 4, background: color, boxShadow: `0 0 6px ${color}` }} />
        <span style={{ fontSize: 11, letterSpacing: 1, color: 'rgba(255,255,255,0.55)', fontFamily: 'var(--font-jetbrains-mono), monospace' }}>
          relay
        </span>
      </button>

      {open && health && (
        <div
          style={{
            position: 'absolute', bottom: 36, left: 0, minWidth: 210,
            padding: '10px 12px', borderRadius: 10,
            background: 'rgba(12,12,18,0.96)', border: '1px solid rgba(255,255,255,0.1)',
            fontSize: 12, lineHeight: 1.5,
          }}
        >
          <div style={{ color, fontWeight: 600, marginBottom: 6 }}>{LABEL[lvl]}</div>
          {health.relayers.map((r, i) => (
            <div key={i} style={{ color: 'rgba(255,255,255,0.7)' }}>
              <span style={{ color: COLOR[r.state === 'healthy' ? 'green' : r.state === 'degraded' ? 'orange' : 'red'] }}>●</span>{' '}
              {r.label}: {r.state}
              {r.lastPollAgeMs != null ? ` · ${Math.round(r.lastPollAgeMs / 1000)}s ago` : ''}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

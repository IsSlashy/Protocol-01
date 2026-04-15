'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ExternalLink, RefreshCw } from 'lucide-react';

// ═══════════════════════════════════════════════════════════════════════════
// PrivateMatchesFeed — live on-chain activity feed of MugenReputation PDAs
// Polls /api/activity/private-matches every 15s.
// ═══════════════════════════════════════════════════════════════════════════

type MatchReceipt = {
  pda: string;
  commitmentPrefix: string;
  tradesCompleted: number;
  totalVolume: string;
  lamports: number;
  firstTradeAt: number;
  lastTradeAt: number;
};

type ActivityResponse = {
  count: number;
  programId: string;
  rpc: string;
  receipts: MatchReceipt[];
  fetchedAt: number;
};

const POLL_INTERVAL_MS = 15_000;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_ROWS = 15;

function truncatePda(pda: string): string {
  if (pda.length <= 12) return pda;
  return `${pda.slice(0, 6)}…${pda.slice(-5)}`;
}

function formatRelative(unixSeconds: number, nowMs: number): string {
  if (unixSeconds <= 0) return '';
  const deltaSec = Math.max(0, Math.floor(nowMs / 1000) - unixSeconds);
  if (deltaSec < 60) return `${deltaSec}s ago`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  if (deltaSec < 86_400) return `${Math.floor(deltaSec / 3600)}h ago`;
  return `${Math.floor(deltaSec / 86_400)}d ago`;
}

export default function PrivateMatchesFeed() {
  const [data, setData] = useState<ActivityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const abortRef = useRef<AbortController | null>(null);

  const fetchFeed = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const timeoutId = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    setLoading(true);
    try {
      const res = await fetch('/api/activity/private-matches', {
        signal: ctrl.signal,
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as ActivityResponse;
      setData(json);
      setError(null);
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'network');
    } finally {
      clearTimeout(timeoutId);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchFeed();
    const poll = setInterval(() => {
      void fetchFeed();
    }, POLL_INTERVAL_MS);
    const tick = setInterval(() => setNowMs(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
      abortRef.current?.abort();
    };
  }, [fetchFeed]);

  const receipts = (data?.receipts ?? []).slice(0, MAX_ROWS);
  const lastRefreshedSec = data
    ? Math.max(0, Math.floor((nowMs - data.fetchedAt) / 1000))
    : null;

  return (
    <div style={{ padding: '1.4rem 1.6rem 1.6rem' }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '0.6rem',
          marginBottom: '1rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem' }}>
          <Activity size={14} color="#c4b5fd" />
          <h3
            style={{
              margin: 0,
              fontFamily: "'Orbitron', sans-serif",
              fontSize: '0.92rem',
              fontWeight: 700,
              color: '#ffffff',
              letterSpacing: '0.05em',
            }}
          >
            Live private matches on devnet
          </h3>
          {data && (
            <span
              style={{
                padding: '0.15rem 0.5rem',
                borderRadius: '999px',
                background: 'rgba(139,92,246,0.14)',
                border: '1px solid rgba(139,92,246,0.32)',
                color: '#c4b5fd',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '0.6rem',
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
              }}
            >
              {data.count} on-chain
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {lastRefreshedSec !== null && (
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '0.62rem',
                color: '#8888aa',
              }}
            >
              last refreshed {lastRefreshedSec}s ago
            </span>
          )}
          <button
            type="button"
            onClick={() => void fetchFeed()}
            disabled={loading}
            aria-label="Refresh private matches feed"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '26px',
              height: '26px',
              border: '1px solid rgba(139,92,246,0.25)',
              borderRadius: '999px',
              background: 'rgba(139,92,246,0.08)',
              color: '#c4b5fd',
              cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.6 : 1,
              padding: 0,
            }}
          >
            <RefreshCw
              size={12}
              style={{
                animation: loading ? 'mugen-spin 0.9s linear infinite' : 'none',
              }}
            />
          </button>
        </div>
      </div>

      {/* Error state */}
      {error && !data && (
        <p
          style={{
            margin: 0,
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '0.72rem',
            color: '#fca5a5',
          }}
        >
          couldn&apos;t reach devnet
        </p>
      )}

      {/* Empty state */}
      {!error && data && receipts.length === 0 && (
        <p
          style={{
            margin: 0,
            fontFamily: "'Inter', sans-serif",
            fontSize: '0.8rem',
            color: '#8888aa',
            lineHeight: 1.5,
          }}
        >
          No private matches on devnet yet — be the first.
        </p>
      )}

      {/* List */}
      {receipts.length > 0 && (
        <div
          style={{
            maxHeight: '400px',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.45rem',
            paddingRight: '0.3rem',
          }}
        >
          {receipts.map((r) => {
            const rel = formatRelative(r.lastTradeAt, nowMs);
            return (
              <div
                key={r.pda}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: '0.55rem',
                  padding: '0.55rem 0.75rem',
                  borderRadius: '10px',
                  background: 'rgba(139,92,246,0.04)',
                  border: '1px solid rgba(139,92,246,0.12)',
                }}
              >
                <span
                  style={{
                    padding: '0.15rem 0.45rem',
                    borderRadius: '6px',
                    background: 'rgba(96,165,250,0.1)',
                    border: '1px solid rgba(96,165,250,0.25)',
                    color: '#93c5fd',
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '0.66rem',
                  }}
                  title={`commitment prefix: ${r.commitmentPrefix}`}
                >
                  {r.commitmentPrefix.slice(0, 8)}
                </span>

                <span
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '0.7rem',
                    color: '#c4b5fd',
                  }}
                  title={r.pda}
                >
                  {truncatePda(r.pda)}
                </span>

                <span
                  style={{
                    padding: '0.1rem 0.45rem',
                    borderRadius: '999px',
                    background: 'rgba(139,92,246,0.12)',
                    border: '1px solid rgba(139,92,246,0.28)',
                    color: '#c4b5fd',
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '0.62rem',
                    letterSpacing: '0.04em',
                  }}
                >
                  {r.tradesCompleted} trade{r.tradesCompleted === 1 ? '' : 's'}
                </span>

                {rel && (
                  <span
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: '0.62rem',
                      color: '#8888aa',
                    }}
                  >
                    {rel}
                  </span>
                )}

                <a
                  href={`https://explorer.solana.com/address/${r.pda}?cluster=devnet`}
                  target="_blank"
                  rel="noreferrer noopener"
                  style={{
                    marginLeft: 'auto',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.25rem',
                    color: '#93c5fd',
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '0.62rem',
                    textDecoration: 'none',
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                  }}
                  aria-label={`view ${r.pda} on Solana explorer`}
                >
                  explorer
                  <ExternalLink size={11} />
                </a>
              </div>
            );
          })}
        </div>
      )}

      <style>{`
        @keyframes mugen-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

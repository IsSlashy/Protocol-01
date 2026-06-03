/**
 * Relayer health — probes the privacy relayers' /health endpoints and rolls them
 * up into a single traffic-light status for the UI.
 *
 * Why this exists: a relayer can be "active" on-chain (heartbeating) yet have its
 * job-scan wedged, so it silently stops landing jobs (observed 2026-06-03, Helius
 * devnet "replayed bad version of slot"). /health exposes lastError + lastPollAt,
 * which is the real liveness signal. The on-chain registry only stores an
 * endpoint_hash (not the URL), so the URLs are configured here.
 */
import { useEffect, useState } from 'react';

export type RelayerStatusLevel = 'green' | 'orange' | 'red';

export interface RelayerNodeHealth {
  label: string;
  url: string;
  reachable: boolean;
  ok: boolean;
  lastError: string | null;
  lastPollAgeMs: number | null;
  state: 'healthy' | 'degraded' | 'down';
}

export interface RelayerHealth {
  status: RelayerStatusLevel;
  relayers: RelayerNodeHealth[];
  checkedAt: number;
}

/** Known relayer /health hosts (operator → URL; on-chain stores only a hash). */
const RELAYERS: { label: string; url: string }[] = [
  { label: 'Railway', url: 'https://p01-relayer-node-production.up.railway.app' },
  { label: 'Fly', url: 'https://p01-relayer-r2-fra.fly.dev' },
];

/** lastPollAt older than this ⇒ the poll loop is likely stuck (degraded). */
const FRESH_MS = 60_000;
const PROBE_TIMEOUT_MS = 6_000;

async function probe(r: { label: string; url: string }): Promise<RelayerNodeHealth> {
  const base: Omit<RelayerNodeHealth, 'reachable' | 'ok' | 'lastError' | 'lastPollAgeMs' | 'state'> = {
    label: r.label,
    url: r.url,
  };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    const res = await fetch(`${r.url}/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) {
      return { ...base, reachable: true, ok: false, lastError: `HTTP ${res.status}`, lastPollAgeMs: null, state: 'down' };
    }
    const h: any = await res.json();
    const ok = h?.ok === true;
    const lastError: string | null = h?.lastError ?? null;
    const lastPollAgeMs = h?.lastPollAt ? Date.now() - new Date(h.lastPollAt).getTime() : null;
    const stale = lastPollAgeMs != null && lastPollAgeMs > FRESH_MS;
    const state: RelayerNodeHealth['state'] = !ok ? 'down' : lastError != null || stale ? 'degraded' : 'healthy';
    return { ...base, reachable: true, ok, lastError, lastPollAgeMs, state };
  } catch (e: any) {
    return { ...base, reachable: false, ok: false, lastError: e?.message ?? 'unreachable', lastPollAgeMs: null, state: 'down' };
  }
}

/** Probe all relayers and roll up: green (≥1 healthy), orange (reachable but degraded), red (all down). */
export async function fetchRelayerHealth(): Promise<RelayerHealth> {
  const relayers = await Promise.all(RELAYERS.map(probe));
  const healthy = relayers.filter((r) => r.state === 'healthy').length;
  const reachable = relayers.filter((r) => r.reachable).length;
  const status: RelayerStatusLevel = healthy >= 1 ? 'green' : reachable >= 1 ? 'orange' : 'red';
  return { status, relayers, checkedAt: Date.now() };
}

/** Poll relayer health on an interval. Returns null until the first probe resolves. */
export function useRelayerHealth(intervalMs = 60_000): RelayerHealth | null {
  const [health, setHealth] = useState<RelayerHealth | null>(null);
  useEffect(() => {
    let mounted = true;
    const run = () =>
      fetchRelayerHealth()
        .then((h) => { if (mounted) setHealth(h); })
        .catch(() => {});
    run();
    const id = setInterval(run, intervalMs);
    return () => { mounted = false; clearInterval(id); };
  }, [intervalMs]);
  return health;
}

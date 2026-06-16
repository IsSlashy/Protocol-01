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

/**
 * The web app already proxies + rolls up relayer /health server-side at
 * `/api/relayer-health`. Mobile reads that SAME endpoint so the in-app dot
 * matches the website by construction (was diverging: device-direct probes to
 * the relayer hosts could fail on some networks → false "red" while the site
 * showed green). Bonus: the device no longer hits relayer infra directly, so it
 * doesn't leak its IP to the operators just for a health check. Falls back to
 * direct probing if the proxy is unreachable (e.g. web origin down / offline).
 */
const WEB_ORIGIN = (process.env.EXPO_PUBLIC_WEB_ORIGIN ?? 'https://protocol-01.dev').replace(/\/$/, '');
const PROXY_HEALTH_URL = `${WEB_ORIGIN}/api/relayer-health`;

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

/** Roll up per-node states into a single traffic-light: green (≥1 healthy), orange (reachable but degraded), red (all down). */
function rollup(relayers: RelayerNodeHealth[]): RelayerStatusLevel {
  const healthy = relayers.filter((r) => r.state === 'healthy').length;
  const reachable = relayers.filter((r) => r.reachable).length;
  return healthy >= 1 ? 'green' : reachable >= 1 ? 'orange' : 'red';
}

/** Read the web app's server-side rollup. Throws on any failure so the caller can fall back to direct probing. */
async function fetchViaProxy(): Promise<RelayerHealth> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(PROXY_HEALTH_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`proxy HTTP ${res.status}`);
    const j: any = await res.json();
    if (!Array.isArray(j?.relayers) || typeof j?.status !== 'string') throw new Error('proxy bad shape');
    // Re-attach the host URL by label (the proxy omits it) so the breakdown UI stays complete.
    const urlByLabel = new Map(RELAYERS.map((r) => [r.label, r.url]));
    const relayers: RelayerNodeHealth[] = j.relayers.map((r: any) => ({
      label: String(r.label ?? ''),
      url: urlByLabel.get(r.label) ?? '',
      reachable: r.reachable === true,
      ok: r.ok === true,
      lastError: r.lastError ?? null,
      lastPollAgeMs: typeof r.lastPollAgeMs === 'number' ? r.lastPollAgeMs : null,
      state: r.state === 'healthy' || r.state === 'degraded' ? r.state : 'down',
    }));
    return { status: rollup(relayers), relayers, checkedAt: Date.now() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve relayer health for the UI. Prefers the web proxy (so the in-app dot
 * matches the website exactly); falls back to direct per-relayer probing if the
 * proxy can't be reached.
 */
export async function fetchRelayerHealth(): Promise<RelayerHealth> {
  try {
    return await fetchViaProxy();
  } catch {
    const relayers = await Promise.all(RELAYERS.map(probe));
    return { status: rollup(relayers), relayers, checkedAt: Date.now() };
  }
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

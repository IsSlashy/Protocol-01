import { NextResponse } from 'next/server';

// Server-side probe of the privacy relayers' /health (the relayer /health has no
// CORS header, so the browser can't read it directly — we proxy + roll up here).
export const dynamic = 'force-dynamic';
export const revalidate = 0;

type Level = 'green' | 'orange' | 'red';

const RELAYERS: { label: string; url: string }[] = [
  { label: 'Railway', url: 'https://p01-relayer-node-production.up.railway.app' },
  { label: 'Fly', url: 'https://p01-relayer-r2-fra.fly.dev' },
];

const FRESH_MS = 60_000;

async function probe(r: { label: string; url: string }) {
  try {
    const res = await fetch(`${r.url}/health`, { signal: AbortSignal.timeout(6000), cache: 'no-store' });
    if (!res.ok) {
      return { label: r.label, reachable: true, ok: false, lastError: `HTTP ${res.status}`, lastPollAgeMs: null, state: 'down' as const };
    }
    const h: any = await res.json();
    const ok = h?.ok === true;
    const lastError: string | null = h?.lastError ?? null;
    const lastPollAgeMs = h?.lastPollAt ? Date.now() - new Date(h.lastPollAt).getTime() : null;
    const stale = lastPollAgeMs != null && lastPollAgeMs > FRESH_MS;
    const state = !ok ? 'down' : lastError != null || stale ? 'degraded' : 'healthy';
    return { label: r.label, reachable: true, ok, lastError, lastPollAgeMs, state };
  } catch (e: any) {
    return { label: r.label, reachable: false, ok: false, lastError: e?.message ?? 'unreachable', lastPollAgeMs: null, state: 'down' as const };
  }
}

export async function GET() {
  const relayers = await Promise.all(RELAYERS.map(probe));
  const healthy = relayers.filter((r) => r.state === 'healthy').length;
  const reachable = relayers.filter((r) => r.reachable).length;
  const status: Level = healthy >= 1 ? 'green' : reachable >= 1 ? 'orange' : 'red';
  return NextResponse.json(
    { status, relayers, checkedAt: Date.now() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

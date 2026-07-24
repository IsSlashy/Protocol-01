import { NextRequest, NextResponse } from 'next/server';
import { pairRateLimitExceeded, pairSet, pairTake } from '@/lib/pairStore';

// Phone→extension pairing relay. The phone POSTs an encrypted `p01pair1:` blob
// (its seed, sealed to a one-time code); the extension GETs it back once and
// decrypts with the code. The relay holds only ciphertext. See lib/pairStore.ts.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TTL_SEC = 180; // matches pairCrypto DEFAULT_TTL_SEC
const MAX_BLOB = 4096;

// Per-IP per-minute caps. A pairing does one POST; the extension polls GET
// every 2.5s (~24/min), so 60 leaves headroom for a retry or two devices.
const POST_PER_MIN = 10;
const GET_PER_MIN = 60;

/** First hop of the forwarding chain; falls back to a stable sentinel. */
function clientIp(req: NextRequest): string {
  const real = req.headers.get('x-real-ip');
  if (real) return real.trim();
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return 'unknown';
}

// The extension calls this from a chrome-extension:// origin, and the mobile
// app from a native fetch — both are cross-origin, so allow any origin. Safe:
// the payload is end-to-end encrypted and the channel id is single-use + TTL'd.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
};

// Channel id is a base32 token (pairCrypto code alphabet), 16–32 chars.
const validId = (id: string) => /^[A-Z2-7]{16,32}$/.test(id);

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!validId(id)) return NextResponse.json({ error: 'bad channel id' }, { status: 400, headers: CORS });

  if (await pairRateLimitExceeded('set', clientIp(req), POST_PER_MIN)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: CORS });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad json' }, { status: 400, headers: CORS });
  }
  const blob = (body as { blob?: unknown })?.blob;
  if (typeof blob !== 'string' || !blob.startsWith('p01pair1:') || blob.length > MAX_BLOB) {
    return NextResponse.json({ error: 'bad blob' }, { status: 400, headers: CORS });
  }

  const stored = await pairSet(id, blob, TTL_SEC);
  if (!stored) {
    // In-memory dev store at capacity (the KV backend never reports full).
    return NextResponse.json({ error: 'relay busy' }, { status: 503, headers: CORS });
  }
  return NextResponse.json({ ok: true }, { headers: CORS });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!validId(id)) return NextResponse.json({ error: 'bad channel id' }, { status: 400, headers: CORS });

  if (await pairRateLimitExceeded('take', clientIp(req), GET_PER_MIN)) {
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { ...CORS, 'Cache-Control': 'no-store' } },
    );
  }

  const blob = await pairTake(id);
  return NextResponse.json({ blob: blob ?? null }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
}

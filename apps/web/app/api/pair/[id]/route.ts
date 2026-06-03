import { NextRequest, NextResponse } from 'next/server';
import { pairSet, pairTake } from '@/lib/pairStore';

// Phone→extension pairing relay. The phone POSTs an encrypted `p01pair1:` blob
// (its seed, sealed to a one-time code); the extension GETs it back once and
// decrypts with the code. The relay holds only ciphertext. See lib/pairStore.ts.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TTL_SEC = 180; // matches pairCrypto DEFAULT_TTL_SEC
const MAX_BLOB = 4096;

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

  await pairSet(id, blob, TTL_SEC);
  return NextResponse.json({ ok: true }, { headers: CORS });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!validId(id)) return NextResponse.json({ error: 'bad channel id' }, { status: 400, headers: CORS });

  const blob = await pairTake(id);
  return NextResponse.json({ blob: blob ?? null }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
}

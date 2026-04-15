import { NextRequest, NextResponse } from 'next/server';
import { getByMakerNonce } from '@/lib/encrypted-order-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/orders/mine
 *
 * Lookup a single encrypted order by its maker nonce pubkey. Returns the
 * registry entry (or 404 if absent). This is a privacy-preserving alternative
 * to a "list all orders" endpoint — the caller must already know the nonce
 * they submitted, giving no information about other users' orders.
 */

interface MineBody {
  makerNoncePubkey: string;
}

function validate(body: Partial<MineBody>): string | null {
  if (
    typeof body.makerNoncePubkey !== 'string' ||
    body.makerNoncePubkey.length < 32
  ) {
    return 'makerNoncePubkey must be a base58-encoded pubkey string';
  }
  return null;
}

export async function POST(request: NextRequest) {
  let body: Partial<MineBody>;
  try {
    body = (await request.json()) as Partial<MineBody>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const invalid = validate(body);
  if (invalid) {
    return NextResponse.json({ error: invalid }, { status: 400 });
  }
  const validated = body as MineBody;

  const entry = await getByMakerNonce(validated.makerNoncePubkey);
  if (!entry) {
    return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  }

  return NextResponse.json({ ok: true, entry });
}

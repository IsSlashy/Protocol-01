import { NextRequest, NextResponse } from 'next/server';
import { isTokenShape, tokenHash } from '@/lib/waitlist/validate';
import {
  getStore,
  emailForToken,
  deleteRecord,
  deleteTokenIndex,
  removeEmailFromSet,
  incrUnsubscribed,
} from '@/lib/waitlist/store';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token');
  const invalid = () => NextResponse.redirect(new URL('/waitlist/invalid', req.url), 302);
  const removed = () => NextResponse.redirect(new URL('/waitlist/removed', req.url), 302);

  if (!isTokenShape(token)) return invalid();

  const kv = getStore();
  if (!kv) return invalid();

  try {
    const hash = tokenHash(token);
    const email = await emailForToken(kv, hash);
    if (!email) return invalid();

    // Privacy brand: actually delete the record and its indexes, do not tombstone.
    await deleteRecord(kv, email);
    await deleteTokenIndex(kv, hash);
    await removeEmailFromSet(kv, email);
    await incrUnsubscribed(kv);

    return removed();
  } catch (err) {
    console.error('[waitlist] unsubscribe error:', err);
    return invalid();
  }
}

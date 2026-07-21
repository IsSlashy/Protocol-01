import { NextRequest, NextResponse } from 'next/server';
import { isTokenShape, tokenHash } from '@/lib/waitlist/validate';
import {
  getStore,
  emailForToken,
  readRecord,
  writeRecord,
  recordConfirmCounters,
  type WaitlistRecord,
} from '@/lib/waitlist/store';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token');
  const invalid = () => NextResponse.redirect(new URL('/waitlist/invalid', req.url), 302);
  const confirmed = () => NextResponse.redirect(new URL('/waitlist/confirmed', req.url), 302);

  if (!isTokenShape(token)) return invalid();

  const kv = getStore();
  if (!kv) return invalid();

  try {
    const email = await emailForToken(kv, tokenHash(token));
    if (!email) return invalid();

    const record = await readRecord(kv, email);
    if (!record) return invalid();

    // Idempotent: a second click on an already-confirmed link still succeeds.
    if (record.status === 'confirmed') return confirmed();

    const confirmedAt = new Date().toISOString();
    const updated: WaitlistRecord = { ...record, status: 'confirmed', confirmedAt };
    // Keep the token index alive; the same link doubles as the unsubscribe link.
    await writeRecord(kv, updated);
    await recordConfirmCounters(kv, confirmedAt);

    return confirmed();
  } catch (err) {
    console.error('[waitlist] confirm error:', err);
    return invalid();
  }
}

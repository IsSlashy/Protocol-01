import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { checkAdminAuth } from '@/lib/waitlist/auth';
import { tokenHash } from '@/lib/waitlist/validate';
import {
  getStore,
  generateToken,
  collectAllRecords,
  writeRecord,
  deleteRecord,
  deleteTokenIndex,
  setTokenIndex,
  removeEmailFromSet,
  incrUnsubscribed,
  incrMailFailures,
  type WaitlistRecord,
} from '@/lib/waitlist/store';
import { sendReminderEmail } from '@/lib/waitlist/email';

/**
 * Daily maintenance pass over pending signups (Vercel Cron, 10:00 UTC):
 *   1. One reminder email, ever, to signups still pending after the delay
 *      (default 24h, env-tunable) and younger than the reminder window.
 *   2. Hard-delete pending signups older than PURGE_DAYS. Privacy stance:
 *      an address that never confirmed does not get archived, it gets erased.
 *      The unsubscribed counter absorbs them so the derived pending total
 *      stays honest.
 *
 * Auth: Vercel Cron's `Authorization: Bearer ${CRON_SECRET}` or the regular
 * admin credentials (manual runs). `?dryRun=1` reports without acting.
 */
export const dynamic = 'force-dynamic';

const HOUR_MS = 60 * 60 * 1000;
const REMIND_WINDOW_DAYS = 7; // never remind a record older than this
const PURGE_DAYS = 30;
const BATCH_CAP = 50; // per run; Resend rate limits and lambda duration

function reminderDelayHours(): number {
  const n = Number(process.env.WAITLIST_REMINDER_DELAY_HOURS);
  return Number.isFinite(n) && n > 0 ? n : 24;
}

function isCronCall(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const authz = req.headers.get('authorization');
  const bearer = authz?.startsWith('Bearer ') ? authz.slice(7) : null;
  if (!bearer) return false;
  const a = Buffer.from(bearer);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(req: NextRequest) {
  if (!isCronCall(req)) {
    const auth = checkAdminAuth(req);
    if (!auth.ok) {
      return NextResponse.json(
        { ok: false, error: auth.status === 503 ? 'not_configured' : 'unauthorized' },
        { status: auth.status },
      );
    }
  }

  const kv = getStore();
  if (!kv) {
    return NextResponse.json({ ok: false, error: 'not_configured' }, { status: 503 });
  }

  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1';
  const now = Date.now();
  const delayMs = reminderDelayHours() * HOUR_MS;

  const records = await collectAllRecords(kv);
  const pending = records.filter((r) => r.status === 'pending');

  const toRemind = pending
    .filter((r) => {
      if (r.remindedAt) return false;
      const age = now - Date.parse(r.createdAt);
      return age >= delayMs && age <= REMIND_WINDOW_DAYS * 24 * HOUR_MS;
    })
    .slice(0, BATCH_CAP);

  const toPurge = pending.filter(
    (r) => now - Date.parse(r.createdAt) > PURGE_DAYS * 24 * HOUR_MS,
  );

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      wouldRemind: toRemind.map((r) => r.email),
      wouldPurge: toPurge.map((r) => r.email),
    });
  }

  let reminded = 0;
  let mailFailures = 0;
  for (const record of toRemind) {
    // Rotate the token: only its hash is stored, so a fresh link is the only
    // way to put a working confirm URL in the reminder.
    const token = generateToken();
    const newHash = tokenHash(token);
    const sent = await sendReminderEmail({ email: record.email, token, locale: record.locale });
    if (!sent) {
      // Leave the record untouched; tomorrow's run retries within the window.
      await incrMailFailures(kv);
      mailFailures++;
      continue;
    }
    await deleteTokenIndex(kv, record.tokenHash);
    await setTokenIndex(kv, newHash, record.email);
    const nowIso = new Date(now).toISOString();
    const updated: WaitlistRecord = {
      ...record,
      tokenHash: newHash,
      lastSentAt: nowIso,
      remindedAt: nowIso,
      resendCount: record.resendCount + 1,
    };
    await writeRecord(kv, updated);
    reminded++;
  }

  let purged = 0;
  for (const record of toPurge) {
    await deleteRecord(kv, record.email);
    await deleteTokenIndex(kv, record.tokenHash);
    await removeEmailFromSet(kv, record.email);
    await incrUnsubscribed(kv);
    purged++;
  }

  return NextResponse.json({ ok: true, reminded, mailFailures, purged, pending: pending.length });
}

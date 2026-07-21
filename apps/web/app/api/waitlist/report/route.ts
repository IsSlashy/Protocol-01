import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { checkAdminAuth } from '@/lib/waitlist/auth';
import { getStore, collectStats, collectAllRecords } from '@/lib/waitlist/store';
import { sendReportEmail } from '@/lib/waitlist/email';
import { buildReport } from '@/lib/waitlist/report';

/**
 * Recurring waitlist digest, emailed to the operator.
 *
 * The Hobby plan only fires a cron once a day, so this runs daily and gates
 * itself on a "last sent" anchor in KV: the digest actually goes out every
 * WAITLIST_REPORT_INTERVAL_DAYS (default 14). A missed or failed run therefore
 * self-heals on the next day instead of skipping a whole cycle.
 *
 * `?dryRun=1` renders the email to the browser without sending or moving the
 * anchor. `?force=1` sends now and resets the clock.
 */
export const dynamic = 'force-dynamic';

const ANCHOR_KEY = 'wl:report:lastSentAt';
const DAY_MS = 24 * 60 * 60 * 1000;

function intervalDays(): number {
  const n = Number(process.env.WAITLIST_REPORT_INTERVAL_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 14;
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

  const to = process.env.REPORT_EMAIL_TO;
  if (!to) {
    return NextResponse.json({ ok: false, error: 'no_recipient' }, { status: 503 });
  }

  const kv = getStore();
  if (!kv) {
    return NextResponse.json({ ok: false, error: 'not_configured' }, { status: 503 });
  }

  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1';
  const force = req.nextUrl.searchParams.get('force') === '1';
  const days = intervalDays();
  const now = Date.now();

  const lastSentAt = await kv.get<string>(ANCHOR_KEY);
  if (!force && !dryRun && lastSentAt) {
    const elapsed = now - Date.parse(lastSentAt);
    if (Number.isFinite(elapsed) && elapsed < days * DAY_MS) {
      return NextResponse.json({
        ok: true,
        skipped: 'not_due',
        lastSentAt,
        nextDueAt: new Date(Date.parse(lastSentAt) + days * DAY_MS).toISOString(),
      });
    }
  }

  const siteUrl = process.env.SITE_URL ?? 'https://protocol-01.dev';
  const [stats, records] = await Promise.all([collectStats(kv), collectAllRecords(kv)]);
  const report = buildReport(stats, records, {
    days,
    dashboardUrl: `${siteUrl}/admin/waitlist`,
  });

  if (dryRun) {
    return new NextResponse(report.html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  const sent = await sendReportEmail({ to, ...report });
  if (sent) {
    await kv.set(ANCHOR_KEY, new Date(now).toISOString());
  }

  return NextResponse.json({
    ok: sent,
    sentTo: sent ? to : undefined,
    error: sent ? undefined : 'send_failed',
    period: report.period,
  });
}

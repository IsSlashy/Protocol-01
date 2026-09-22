import { checkAdminAuth } from '@/lib/waitlist/auth';
import { getStore, collectAllRecords } from '@/lib/waitlist/store';
import type { WaitlistRecord } from '@/lib/waitlist/store';
import { logFailure } from '@/lib/server/logSafely';

export const dynamic = 'force-dynamic';

const HEADER = 'email,status,interest,locale,source,country,createdAt,confirmedAt';

/** Quote a field only when it contains a comma, quote, or newline. */
function csvField(value: string | undefined): string {
  const s = value ?? '';
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(req: Request) {
  const auth = checkAdminAuth(req);
  if (!auth.ok) {
    return new Response(
      JSON.stringify({ ok: false, error: auth.status === 503 ? 'not_configured' : 'unauthorized' }),
      { status: auth.status, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // A STORE ERROR MUST NOT LEAVE THIS HANDLER. What leaves a handler is logged
  // by the framework (`console.error(err)`), and the store words a refused
  // request as `<error>, command was: [...]`. `collectAllRecords` reads every
  // subscriber in one auto-pipelined round trip, so that single line is
  // `["get","wl:sub:<email>"]` for the whole list, in the Vercel runtime log.
  // Fixed words out, and only the error's class name in the log. Pinned by
  // `__tests__/api/waitlistExportLogHygiene.test.ts`.
  let records: WaitlistRecord[];
  try {
    records = await collectAllRecords(getStore());
  } catch (err) {
    logFailure('[waitlist] export', err);
    return new Response(JSON.stringify({ ok: false, error: 'server_error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  // ?format=json feeds the /admin/waitlist dashboard; tokenHash stays private.
  const { searchParams } = new URL(req.url);
  if (searchParams.get('format') === 'json') {
    const safe = records.map((r) => ({
      email: r.email,
      status: r.status,
      interest: r.interest ?? null,
      locale: r.locale,
      source: r.source ?? null,
      country: r.country ?? null,
      createdAt: r.createdAt,
      confirmedAt: r.confirmedAt ?? null,
    }));
    return new Response(JSON.stringify({ ok: true, records: safe }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  const rows = records.map((r) =>
    [r.email, r.status, r.interest, r.locale, r.source, r.country, r.createdAt, r.confirmedAt]
      .map(csvField)
      .join(','),
  );
  const csv = [HEADER, ...rows].join('\r\n');

  const date = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="waitlist-export-${date}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}

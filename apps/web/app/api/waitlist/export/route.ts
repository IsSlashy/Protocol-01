import { checkAdminAuth } from '@/lib/waitlist/auth';
import { getStore, collectAllRecords } from '@/lib/waitlist/store';

export const dynamic = 'force-dynamic';

const HEADER = 'email,status,interest,locale,source,createdAt,confirmedAt';

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

  const records = await collectAllRecords(getStore());

  // ?format=json feeds the /admin/waitlist dashboard; tokenHash stays private.
  const { searchParams } = new URL(req.url);
  if (searchParams.get('format') === 'json') {
    const safe = records.map((r) => ({
      email: r.email,
      status: r.status,
      interest: r.interest ?? null,
      locale: r.locale,
      source: r.source ?? null,
      createdAt: r.createdAt,
      confirmedAt: r.confirmedAt ?? null,
    }));
    return new Response(JSON.stringify({ ok: true, records: safe }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  const rows = records.map((r) =>
    [r.email, r.status, r.interest, r.locale, r.source, r.createdAt, r.confirmedAt]
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

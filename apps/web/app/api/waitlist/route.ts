import { NextRequest, NextResponse } from 'next/server';
import {
  normalizeEmail,
  sanitizeCountry,
  sanitizeInterest,
  sanitizeLocale,
  sanitizeSource,
  tokenHash,
} from '@/lib/waitlist/validate';
import {
  getStore,
  generateToken,
  readRecord,
  writeRecord,
  setTokenIndex,
  deleteTokenIndex,
  addEmailToSet,
  recordSignupCounters,
  incrMailFailures,
  rateLimitExceeded,
  type WaitlistRecord,
} from '@/lib/waitlist/store';
import { sendConfirmationEmail } from '@/lib/waitlist/email';

const RESEND_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_RESENDS = 5;

/** First hop of the forwarding chain; falls back to a stable sentinel. */
function clientIp(req: NextRequest): string {
  const real = req.headers.get('x-real-ip');
  if (real) return real.trim();
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return 'unknown';
}

export async function POST(req: NextRequest) {
  try {
    const parsed: unknown = await req.json().catch(() => null);
    if (!parsed || typeof parsed !== 'object') {
      return NextResponse.json({ ok: false, error: 'invalid_email' }, { status: 400 });
    }
    const body = parsed as Record<string, unknown>;

    // Honeypot: a filled `website` field means a bot. Look successful, store nothing.
    if (typeof body.website === 'string' && body.website.trim() !== '') {
      return NextResponse.json({ ok: true });
    }

    const kv = getStore();
    if (!kv) {
      return NextResponse.json({ ok: false, error: 'not_configured' }, { status: 503 });
    }

    // Per-IP hourly cap before touching the record or sending mail.
    const salt = process.env.WAITLIST_STATS_TOKEN ?? 'salt';
    if (await rateLimitExceeded(kv, clientIp(req), salt)) {
      return NextResponse.json({ ok: false, error: 'rate_limited' }, { status: 429 });
    }

    const email = normalizeEmail(body.email);
    if (!email) {
      return NextResponse.json({ ok: false, error: 'invalid_email' }, { status: 400 });
    }

    const interest = sanitizeInterest(body.interest);
    const locale = sanitizeLocale(body.locale);
    const source = sanitizeSource(body.source);
    // Vercel sets this at the edge from the client IP; the IP itself is never stored.
    const country = sanitizeCountry(req.headers.get('x-vercel-ip-country'));

    const existing = await readRecord(kv, email);
    const now = new Date().toISOString();

    // Already confirmed: nothing to do, and no signal that reveals membership.
    if (existing?.status === 'confirmed') {
      return NextResponse.json({ ok: true });
    }

    // Pending: resend the confirmation, but only within the cooldown and cap.
    if (existing) {
      const lastSent = Date.parse(existing.lastSentAt);
      const cooled = Date.now() - (Number.isFinite(lastSent) ? lastSent : 0) >= RESEND_INTERVAL_MS;
      if (cooled && existing.resendCount < MAX_RESENDS) {
        const newToken = generateToken();
        const newHash = tokenHash(newToken);
        await deleteTokenIndex(kv, existing.tokenHash);
        await setTokenIndex(kv, newHash, email);
        const updated: WaitlistRecord = {
          ...existing,
          tokenHash: newHash,
          lastSentAt: now,
          resendCount: existing.resendCount + 1,
        };
        await writeRecord(kv, updated);
        const sent = await sendConfirmationEmail({
          email,
          token: newToken,
          locale: existing.locale,
        });
        if (!sent) await incrMailFailures(kv);
      }
      return NextResponse.json({ ok: true });
    }

    // New signup: store first so a mail failure never loses the lead.
    const token = generateToken();
    const record: WaitlistRecord = {
      email,
      status: 'pending',
      tokenHash: tokenHash(token),
      interest,
      locale,
      source,
      country,
      createdAt: now,
      lastSentAt: now,
      resendCount: 0,
    };
    await writeRecord(kv, record);
    await setTokenIndex(kv, record.tokenHash, email);
    await addEmailToSet(kv, email);
    await recordSignupCounters(kv, record);

    const sent = await sendConfirmationEmail({ email, token, locale });
    if (!sent) await incrMailFailures(kv);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[waitlist] POST error:', err);
    return NextResponse.json({ ok: false, error: 'server_error' }, { status: 500 });
  }
}

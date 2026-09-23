import { after, NextRequest, NextResponse } from 'next/server';
import {
  normalizeEmail,
  sanitizeCountry,
  sanitizeInterest,
  sanitizeLocale,
  sanitizeSource,
  tokenHash,
  storedUnsubscribeHash,
  unsubscribeHashFor,
  type UnsubscribeIndexed,
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
import { clientIp } from '@/lib/net/clientIp';
import { logFailure } from '@/lib/server/logSafely';

const RESEND_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_RESENDS = 5;

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

    // [SWEEP round 1 of run logs8, server lens] EVERYTHING BELOW THIS LINE RUNS
    // AFTER THE ANSWER.
    //
    // The status and the bytes were already the same for everyone. The WORK was
    // not: a confirmed address answered after the three store commands above and
    // no mail, a pending one past its cooldown after six and a mail, an unknown
    // one after nine to twelve and a mail. Each is a network round trip, so one
    // request told anyone holding a candidate address whether a record exists,
    // and a second one ten minutes later whether it was confirmed. Now every
    // branch answers after the same rate-limit write and the same record read,
    // and the branch itself runs in `after()`
    // (`__tests__/api/waitlistMembershipWork.test.ts`, "same answer, same store
    // commands and no mail before it, in all five worlds").
    //
    // What it costs: a store failure while signing up is no longer a 500 to the
    // visitor, because the answer has left. It is logged, by event and class
    // only (`logFailure`), and the visitor can submit again. A failure of the
    // READ above is still a 500.
    const work = async (): Promise<void> => {
      try {
        // Already confirmed: nothing to do.
        if (existing?.status === 'confirmed') return;

        // Pending: resend the confirmation, but only within the cooldown and cap.
        if (existing) {
          const lastSent = Date.parse(existing.lastSentAt);
          const cooled = Date.now() - (Number.isFinite(lastSent) ? lastSent : 0) >= RESEND_INTERVAL_MS;
          if (cooled && existing.resendCount < MAX_RESENDS) {
            const newToken = generateToken();
            const newHash = tokenHash(newToken);
            // The new mail's unsubscribe link has its own index row (audit v1
            // F41). The record names it, and the previous mail's two rows are
            // deleted once the record points at the new ones (close-v1 verify
            // r1): an index row holds the email, so none may outlive the
            // record, and only the latest mail's links work.
            const newUnsub = unsubscribeHashFor(newToken);
            const oldUnsub = storedUnsubscribeHash(existing);
            await setTokenIndex(kv, newHash, email);
            await setTokenIndex(kv, newUnsub, email);
            const updated: WaitlistRecord & UnsubscribeIndexed = {
              ...existing,
              tokenHash: newHash,
              unsubscribeHash: newUnsub,
              lastSentAt: now,
              resendCount: existing.resendCount + 1,
            };
            await writeRecord(kv, updated);
            if (existing.tokenHash !== newHash) await deleteTokenIndex(kv, existing.tokenHash);
            if (oldUnsub && oldUnsub !== newUnsub) await deleteTokenIndex(kv, oldUnsub);
            const sent = await sendConfirmationEmail({
              email,
              token: newToken,
              locale: existing.locale,
            });
            if (!sent) await incrMailFailures(kv);
          }
          return;
        }

        // New signup: store first so a mail failure never loses the lead.
        const token = generateToken();
        // The unsubscribe link has its own token and index row (audit v1
        // F41); the record names that row so its removal deletes it.
        const unsub = unsubscribeHashFor(token);
        const record: WaitlistRecord & UnsubscribeIndexed = {
          email,
          status: 'pending',
          tokenHash: tokenHash(token),
          unsubscribeHash: unsub,
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
        await setTokenIndex(kv, unsub, email);
        await addEmailToSet(kv, email);
        await recordSignupCounters(kv, record);

        const sent = await sendConfirmationEmail({ email, token, locale });
        if (!sent) await incrMailFailures(kv);
      } catch (err) {
        // Caught HERE: a rejection that escapes an `after()` task is written by
        // Next's own logger, raw, and a store error carries the record.
        logFailure('[waitlist] POST (after the answer)', err);
      }
    };

    try {
      after(work);
    } catch {
      // Outside a request scope `after()` throws. Losing the signup would be
      // worse than the timing, so the work is done before the answer there
      // ("outside a request scope `after()` throws: the signup is done before
      // the answer instead of being lost"). A deployed route handler is always
      // inside one.
      await work();
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    logFailure('[waitlist] POST', err);
    return NextResponse.json({ ok: false, error: 'server_error' }, { status: 500 });
  }
}

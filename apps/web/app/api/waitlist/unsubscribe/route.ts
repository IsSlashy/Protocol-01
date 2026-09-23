import { NextRequest, NextResponse } from 'next/server';
import {
  isTokenShape,
  storedUnsubscribeHash,
  tokenHash,
  unsubscribeHashFor,
  unsubscribeTokenHash,
} from '@/lib/waitlist/validate';
import {
  getStore,
  emailForToken,
  readRecord,
  deleteRecord,
  deleteTokenIndex,
  removeEmailFromSet,
  incrUnsubscribed,
} from '@/lib/waitlist/store';
import { logFailure } from '@/lib/server/logSafely';

export const dynamic = 'force-dynamic';

/**
 * ⛔ A GET NEVER UNSUBSCRIBES (audit v1 round 2, F41).
 *
 * This route used to delete the subscriber on a GET, with the same token the
 * confirm link carried. Mail gateways and link previews fetch every link in a
 * mail, so the mail that asked the reader to confirm also removed them
 * (`audit-v1-opus/r2-server/probes/p6-waitlist-oneclick.probe.test.ts`).
 *
 * Now:
 *   - the link carries its own token (`unsubscribeToken`, lib/waitlist/validate.ts);
 *   - a GET only leads to a page with one button (the redirect keeps the old
 *     "the route answers a redirect" shape; the page is `?step=confirm`);
 *   - the removal is a POST: the page's button, or a mail client's RFC 8058
 *     one-click POST to the `List-Unsubscribe` URL (the mail carries the header).
 *
 * ⚠️ MAILS SENT BEFORE THIS CHANGE carry the confirmation token in their
 * unsubscribe link, and that link is the only way out their reader has. So a
 * POST (never a GET) with a token found under the confirmation index removes
 * the record too. A crawler does not POST, and whoever holds that mail holds
 * both of its links anyway. Drop `LEGACY_CONFIRM_TOKEN_UNSUBSCRIBES` once every
 * live subscriber has been sent a mail with the new link.
 *
 * Pinned by `__tests__/api/closeV1L3Waitlist.test.ts`, "F41".
 */
const LEGACY_CONFIRM_TOKEN_UNSUBSCRIBES = true;

const PAGE_COPY = {
  en: {
    lang: 'en',
    title: 'Leave the Protocol 01 waitlist?',
    body: 'Press the button to remove this address from the waitlist. Opening this page changed nothing.',
    button: 'Unsubscribe',
  },
  fr: {
    lang: 'fr',
    title: 'Quitter la liste d’attente Protocol 01 ?',
    body: 'Appuyez sur le bouton pour retirer cette adresse de la liste d’attente. Ouvrir cette page n’a rien changé.',
    button: 'Se désinscrire',
  },
} as const;

function confirmPage(token: string, lang: 'en' | 'fr'): Response {
  const copy = PAGE_COPY[lang];
  // `token` is 64 lowercase hex (checked by the caller), so it needs no escaping.
  const action = `/api/waitlist/unsubscribe?token=${token}&lang=${lang}`;
  const html = `<!doctype html>
<html lang="${copy.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${copy.title}</title>
<style>
  body { margin: 0; background: #060608; color: #e6e6ea; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
  main { max-width: 480px; margin: 0 auto; padding: 64px 16px; }
  h1 { font-size: 22px; font-weight: 700; margin: 0 0 12px; }
  p { color: #b8b8c0; line-height: 1.6; margin: 0 0 28px; }
  button { background: #ff2d7a; color: #0a0a0c; border: 0; padding: 14px 28px; font-weight: 800; font-size: 14px; cursor: pointer; }
</style>
</head>
<body>
<main>
<h1>${copy.title}</h1>
<p>${copy.body}</p>
<form method="post" action="${action}">
<input type="hidden" name="List-Unsubscribe" value="One-Click">
<button type="submit">${copy.button}</button>
</form>
</main>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex',
    },
  });
}

function langOf(req: NextRequest): 'en' | 'fr' {
  return req.nextUrl.searchParams.get('lang') === 'fr' ? 'fr' : 'en';
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token');
  if (!isTokenShape(token)) {
    return NextResponse.redirect(new URL('/waitlist/invalid', req.url), 302);
  }
  const lang = langOf(req);
  if (req.nextUrl.searchParams.get('step') !== 'confirm') {
    // No store command on the way: the page itself names nobody.
    const next = new URL('/api/waitlist/unsubscribe', req.url);
    next.searchParams.set('token', token);
    next.searchParams.set('lang', lang);
    next.searchParams.set('step', 'confirm');
    return NextResponse.redirect(next, 302);
  }
  return confirmPage(token, lang);
}

export async function POST(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token');
  const invalid = () => NextResponse.redirect(new URL('/waitlist/invalid', req.url), 303);
  const removed = () => NextResponse.redirect(new URL('/waitlist/removed', req.url), 303);

  if (!isTokenShape(token)) return invalid();

  const kv = getStore();
  if (!kv) return invalid();

  try {
    let indexHash = unsubscribeTokenHash(token);
    let email = await emailForToken(kv, indexHash);
    let legacy = false;
    if (!email && LEGACY_CONFIRM_TOKEN_UNSUBSCRIBES) {
      indexHash = tokenHash(token);
      email = await emailForToken(kv, indexHash);
      legacy = true;
    }
    if (!email) return invalid();

    const record = await readRecord(kv, email);
    // Privacy brand: actually delete the record and its indexes, do not tombstone.
    // Every index row holds the email in plaintext, so every one the record or
    // the presented token names goes (close-v1 verify r1, F41 follow-up): the
    // row the token was found under, the record's confirmation row, the
    // record's unsubscribe row, and, when a confirmation token was presented,
    // the unsubscribe row derived from it.
    await deleteRecord(kv, email);
    const rows = new Set<string>([indexHash]);
    if (record?.tokenHash) rows.add(record.tokenHash);
    const recordUnsub = storedUnsubscribeHash(record);
    if (recordUnsub) rows.add(recordUnsub);
    if (legacy) rows.add(unsubscribeHashFor(token));
    for (const row of rows) await deleteTokenIndex(kv, row);
    await removeEmailFromSet(kv, email);
    if (record) await incrUnsubscribed(kv);

    return removed();
  } catch (err) {
    logFailure('[waitlist] unsubscribe', err);
    return invalid();
  }
}

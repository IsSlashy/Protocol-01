import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { kv } from '@vercel/kv';
import { Resend } from 'resend';
import { logFailure } from '@/lib/server/logSafely';
import { checkAdminAuth } from '@/lib/waitlist/auth';
import { rateLimitExceeded, type KvLike } from '@/lib/waitlist/store';
import { clientIp } from '@/lib/net/clientIp';

// Keys for KV storage
const WHITELIST_KEY = 'whitelist:data';

/**
 * ⛔ EVERY STORED VALUE IS TEXT WHEN IT REACHES A MAIL (audit v1 round 4).
 *
 * The public POST below is anonymous, and the approval mail is sent from this
 * deployment's own sender (`EMAIL_FROM`) to the address the request named. The
 * mail used to interpolate `wallet` and `projectName` raw, so one approve click
 * sent a stranger's markup (a heading, a link to a look-alike page) under the
 * project's name. Measured: scratchpad audit-v1-opus/r4-server/p3-head.log.
 * Pinned by `__tests__/api/whitelistApprovalMail.test.ts`.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * What a public request may store. Checked BEFORE the row exists, so an
 * operator never sees, and never approves, a row that is markup.
 *
 *   - wallet: letters and digits only, at most 64 characters, which every
 *     Solana address is and no markup can be (the length floor is left to the
 *     admin: the existing suite files short placeholder wallets);
 *   - email: optional, ONE address, no whitespace or separators, so it cannot
 *     name a second recipient or smuggle a header;
 *   - projectName: optional, at most 100 characters, no angle brackets and no
 *     control characters.
 */
const WALLET_SHAPE = /^[A-Za-z0-9]{1,64}$/;
const EMAIL_SHAPE = /^[^\s@,;<>()"'\\]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const PROJECT_NAME_MAX = 100;

function isEmailAddress(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && EMAIL_SHAPE.test(value);
}

function publicRequestProblem(body: {
  wallet?: unknown;
  email?: unknown;
  projectName?: unknown;
}): string | null {
  if (typeof body.wallet !== 'string' || !WALLET_SHAPE.test(body.wallet.trim())) {
    return 'wallet must be a Solana address (letters and digits only)';
  }
  if (body.email !== undefined && body.email !== null && body.email !== '' && !isEmailAddress(body.email)) {
    return 'email must be one email address';
  }
  if (body.projectName !== undefined && body.projectName !== null && body.projectName !== '') {
    if (
      typeof body.projectName !== 'string' ||
      body.projectName.length > PROJECT_NAME_MAX ||
      /[<>\u0000-\u001f\u007f]/.test(body.projectName)
    ) {
      return `projectName must be plain text of at most ${PROJECT_NAME_MAX} characters`;
    }
  }
  return null;
}

// Lazy initialize Resend (avoid build-time errors)
let resend: Resend | null = null;
function getResend() {
  if (!resend && process.env.RESEND_API_KEY) {
    resend = new Resend(process.env.RESEND_API_KEY);
  }
  return resend;
}

/**
 * ⛔ THE APPROVAL MAIL GOES TO THE OPERATOR, NEVER TO AN ADDRESS A REQUEST
 * NAMED (audit v1 round 4, F75).
 *
 * The public POST is anonymous, and it used to store an `email` that the
 * approval mail was then sent to, from this deployment's own sender. So an
 * anonymous caller chose who received a mail under the project's name, and one
 * approve click delivered it (`audit-v1-opus/r4-verify1/probe-whitelist-recipient.test.ts`).
 * Escaping the values (round 4) removed the markup, not the choice of recipient.
 *
 * The recipient is now fixed by the deployment: `WHITELIST_APPROVAL_MAIL_TO`,
 * else `REPORT_EMAIL_TO` (the operator address the waitlist digest already
 * uses). Neither set, or not one address: no mail. The contact the requester
 * typed is shown inside the operator's copy, as escaped text, so the operator
 * can reach them by hand; nothing is sent to it. Pinned by
 * `__tests__/api/closeV1L3Whitelist.test.ts`, "F75".
 */
function approvalMailRecipient(): string | null {
  const to = process.env.WHITELIST_APPROVAL_MAIL_TO || process.env.REPORT_EMAIL_TO || '';
  return isEmailAddress(to) ? to : null;
}

// Send the approval notice to the operator.
async function sendApprovalEmail(rawWallet: string, rawProjectName?: string, rawRequesterEmail?: string) {
  if (!process.env.RESEND_API_KEY || process.env.RESEND_API_KEY === 're_YOUR_API_KEY_HERE') {
    return;
  }
  const to = approvalMailRecipient();
  if (!to) return;
  const wallet = escapeHtml(String(rawWallet));
  const projectName = rawProjectName ? escapeHtml(String(rawProjectName)) : undefined;
  const requesterEmail = rawRequesterEmail ? escapeHtml(String(rawRequesterEmail)) : undefined;

  const resendClient = getResend();
  if (!resendClient) return;

  try {
    await resendClient.emails.send({
      from: process.env.EMAIL_FROM || 'Protocol 01 <onboarding@resend.dev>',
      to,
      subject: 'Protocol 01 - developer access approved (operator copy)',
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; background: #0a0a0c; color: #ffffff;">
          <div style="text-align: center; margin-bottom: 32px;">
            <h1 style="color: #39c5bb; font-size: 28px; margin: 0;">Protocol 01</h1>
            <p style="color: #888; margin-top: 8px;">Developer access, operator copy</p>
          </div>

          <div style="background: #151518; border: 1px solid #2a2a30; border-radius: 12px; padding: 24px; margin-bottom: 24px;">
            <h2 style="color: #39c5bb; font-size: 20px; margin: 0 0 16px 0;">A wallet was approved</h2>
            <p style="color: #ccc; line-height: 1.6; margin: 0 0 16px 0;">
              This copy goes to the operator address only. No mail was sent to the requester:
              the contact below was typed into an anonymous form, so reach them yourself if you
              know it is theirs.
            </p>

            <div style="background: #0a0a0c; border: 1px solid #39c5bb33; border-radius: 8px; padding: 16px; margin-top: 16px;">
              <p style="color: #888; font-size: 12px; margin: 0 0 4px 0;">Approved Wallet</p>
              <p style="color: #39c5bb; font-family: monospace; font-size: 14px; margin: 0; word-break: break-all;">${wallet}</p>
            </div>

            ${projectName ? `
            <div style="background: #0a0a0c; border: 1px solid #2a2a30; border-radius: 8px; padding: 16px; margin-top: 12px;">
              <p style="color: #888; font-size: 12px; margin: 0 0 4px 0;">Project</p>
              <p style="color: #fff; font-size: 14px; margin: 0;">${projectName}</p>
            </div>
            ` : ''}

            ${requesterEmail ? `
            <div style="background: #0a0a0c; border: 1px solid #2a2a30; border-radius: 8px; padding: 16px; margin-top: 12px;">
              <p style="color: #888; font-size: 12px; margin: 0 0 4px 0;">Contact given in the request (not mailed)</p>
              <p style="color: #fff; font-size: 14px; margin: 0;">${requesterEmail}</p>
            </div>
            ` : ''}
          </div>
        </div>
      `,
    });
  } catch (error) {
    logFailure('[whitelist] approval email', error);
  }
}

// Send Discord notification for approval
async function sendApprovalDiscord(wallet: string, email?: string, projectName?: string) {
  const webhookUrl = process.env.DISCORD_WEBHOOK;
  if (!webhookUrl) {
    return;
  }

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // Stored text is the requester's: it must never ping anyone.
        allowed_mentions: { parse: [] },
        embeds: [{
          title: '✅ Developer Access Approved',
          color: 0x39c5bb,
          fields: [
            { name: 'Wallet', value: `\`${wallet}\``, inline: false },
            { name: 'Email', value: email || 'N/A', inline: true },
            { name: 'Project', value: projectName || 'N/A', inline: true },
          ],
          footer: { text: 'Protocol 01 Admin' },
          timestamp: new Date().toISOString(),
        }],
      }),
    });
  } catch (error) {
    logFailure('[whitelist] Discord notification', error);
  }
}

interface WhitelistEntry {
  wallet: string;
  email?: string;
  projectName?: string;
  approvedAt: string;
  approvedBy: string;
}

interface WhitelistData {
  approved: WhitelistEntry[];
  pending: WhitelistEntry[];
}

/**
 * ⛔ A READ THAT FAILED IS NOT AN EMPTY LIST (audit v1 round 2, F42).
 *
 * `readWhitelist` used to answer a store error with `{ approved: [], pending: [] }`,
 * and every writer then wrote that emptiness back: one transient KV error and
 * one anonymous request erased every approved developer
 * (`audit-v1-opus/r2-server/probes/p5-whitelist.probe.test.ts` (a)). A missing
 * row (`null`, nothing stored yet) is still an empty list; an error, or a row
 * that is not two arrays, throws this, and every handler answers 503 without
 * writing. Pinned by `__tests__/api/closeV1L3Whitelist.test.ts`, "F42".
 */
class WhitelistUnavailable extends Error {
  constructor() {
    super('whitelist store unavailable');
    this.name = 'WhitelistUnavailable';
  }
}

function unavailable(): NextResponse {
  return NextResponse.json(
    { error: 'The whitelist store is unavailable. Nothing was changed; retry shortly.' },
    { status: 503 },
  );
}

// Read whitelist from KV.
//
// ⛔ THE ERROR IS NEVER LOGGED AS AN OBJECT. The store's message carries the
// command it was sent — here the whole `whitelist:data` value, every approved
// and pending developer's wallet, email and project name. `logFailure` writes a
// fixed tag and the error's class only (lib/server/logSafely.ts), and
// `__tests__/api/serverLogHygiene.test.ts` fails these two calls to check it.
async function readWhitelist(): Promise<WhitelistData> {
  let data: unknown;
  try {
    data = await kv.get<WhitelistData>(WHITELIST_KEY);
  } catch (error) {
    logFailure('[whitelist] KV read', error);
    throw new WhitelistUnavailable();
  }
  if (data === null || data === undefined) return { approved: [], pending: [] };
  const row = data as Partial<WhitelistData>;
  if (typeof data !== 'object' || !Array.isArray(row.approved) || !Array.isArray(row.pending)) {
    throw new WhitelistUnavailable();
  }
  return { approved: row.approved, pending: row.pending };
}

// Write whitelist to KV
async function writeWhitelist(data: WhitelistData): Promise<void> {
  try {
    await kv.set(WHITELIST_KEY, data);
  } catch (error) {
    logFailure('[whitelist] KV write', error);
    throw error;
  }
}

/**
 * ⛔ ONE WRITER AT A TIME (audit v1 round 1, F13).
 *
 * Every write is read-modify-write of the whole `whitelist:data` row, so two
 * requests at once both read the old list and the second write erased the
 * first request (`closeV1L3Whitelist.test.ts`, "two requests at the same moment
 * are both kept"). Each writer now holds `whitelist:lock` for the whole
 * read-modify-write.
 *
 * ⛔ THE LOCK IS TAKEN WITH ITS TTL IN ONE COMMAND, AND NOBODY BUT ITS HOLDER
 * TOUCHES IT (close-v1 verify r1). The first version took it with `incr` and
 * gave it a TTL in a second command, and every waiter re-armed that TTL on each
 * retry so a key left without one would heal. The re-arming is what broke it: a
 * holder killed between taking the lock and releasing it (a function timeout,
 * whose `finally` never runs) left a key that steady traffic kept alive, and
 * every write answered 503 until traffic paused for a whole TTL
 * (`closeV1L3Whitelist.test.ts`, "a lock left behind by a killed holder expires
 * even while requests keep arriving"). Now:
 *   - acquire is `SET whitelist:lock <owner> NX EX 10`: atomic, and the key can
 *     never exist without its TTL;
 *   - a waiter only retries; it never extends the key;
 *   - release deletes the key only while it still holds this holder's random
 *     owner value, so a holder that outlived its TTL does not delete the lock a
 *     later writer has taken (`closeV1L3Whitelist.test.ts`, "a holder that
 *     outlived its TTL does not release the lock a later writer took"). (The
 *     value check and the `del` are two commands; the window between them is
 *     one round trip, after a TTL that already ran out. `whitelist:data` is still written whole, so the worst case is the
 *     lost-update this lock exists to prevent, once, not a wedge.)
 */
const LOCK_KEY = 'whitelist:lock';
const LOCK_TTL_SECONDS = 10;
const LOCK_TRIES = 40;
const LOCK_WAIT_MS = 50;

class WhitelistBusy extends Error {
  constructor() {
    super('whitelist busy');
    this.name = 'WhitelistBusy';
  }
}

async function withWhitelistLock<T>(fn: () => Promise<T>): Promise<T> {
  const owner = randomBytes(16).toString('hex');
  for (let attempt = 0; attempt < LOCK_TRIES; attempt++) {
    const taken = await kv.set(LOCK_KEY, owner, { nx: true, ex: LOCK_TTL_SECONDS });
    if (taken !== null && taken !== undefined) {
      try {
        return await fn();
      } finally {
        try {
          if ((await kv.get<string>(LOCK_KEY)) === owner) await kv.del(LOCK_KEY);
        } catch {
          // The TTL releases it.
        }
      }
    }
    // Held by someone else: wait and retry, never extend their key.
    await new Promise((r) => setTimeout(r, LOCK_WAIT_MS + Math.floor(Math.random() * LOCK_WAIT_MS)));
  }
  throw new WhitelistBusy();
}

/**
 * Limits on the anonymous request (audit v1 round 1, F13): a body larger than
 * this is refused unread; one address may file this many requests per UTC hour
 * (`rateLimitExceeded`, the waitlist's own limiter and bucket formula); and the
 * pending list stops growing at `MAX_PENDING` until an operator works through it.
 */
const MAX_BODY_BYTES = 4096;
const PUBLIC_REQUESTS_PER_HOUR = 5;
const MAX_PENDING = 1000;
const RATE_SALT = 'p01:whitelist:v1';

/**
 * The two store commands `rateLimitExceeded` uses, on this route's KV. The
 * waitlist `KvLike` names more commands than the limiter touches; only these
 * two are ever called.
 */
const limiterStore = {
  incr: (key: string) => kv.incr(key),
  expire: async (key: string, seconds: number) => {
    await kv.expire(key, seconds);
  },
} as unknown as KvLike;

async function readBody(request: NextRequest): Promise<{ body: Record<string, unknown> } | NextResponse> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Request body too large' }, { status: 413 });
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Request body too large' }, { status: 413 });
  }
  let parsed: unknown;
  try {
    parsed = text === '' ? {} : JSON.parse(text);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  return { body: parsed as Record<string, unknown> };
}

async function adminRefusal(request: NextRequest): Promise<NextResponse | null> {
  const auth = await checkAdminAuth(request, kv, { statsToken: false });
  if (auth.ok) return null;
  if (auth.status === 429) {
    return NextResponse.json({ error: 'Too many failed attempts. Try again later.' }, { status: 429 });
  }
  if (auth.status === 503) {
    return NextResponse.json({ error: 'Admin access is unavailable.' }, { status: 503 });
  }
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

function sameWallet(a: unknown, b: string): boolean {
  return typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
}

// GET - Check if wallet is whitelisted or get all entries (admin)
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  /**
   * ⛔ A HEADER, NEVER THE QUERY STRING (SWEEP4 round 1, item 15).
   *
   * A URL is what every layer in front of this deployment writes down: Vercel's
   * request log, an edge cache key, a proxy, a referrer. `?wallet=<address>` put
   * a developer's Solana address in all of them, and the whitelist is a small
   * set — one line names a person and says they build here. A header is not
   * recorded that way, and the check needs nothing else.
   *
   * The old query form is REFUSED rather than accepted as a fallback: a
   * fallback leaves the leak reachable for as long as one caller remembers it.
   * `?admin=true` stays in the URL deliberately — it names nobody and it is what
   * selects the view. Pinned by `__tests__/api/whitelist.test.ts`, "the wallet
   * never travels in the request line".
   */
  if (searchParams.get('wallet')) {
    return NextResponse.json(
      { error: 'Send the wallet in the x-p01-wallet header, not in the query string' },
      { status: 400 },
    );
  }
  const wallet = request.headers.get('x-p01-wallet');
  const admin = searchParams.get('admin');

  // Admin: get all entries. The credential is checked (and counted) before the
  // store is read.
  if (!wallet && admin === 'true') {
    const refused = await adminRefusal(request);
    if (refused) return refused;
  }

  let whitelist: WhitelistData;
  try {
    whitelist = await readWhitelist();
  } catch {
    return unavailable();
  }

  // Check single wallet
  if (wallet) {
    const isApproved = whitelist.approved.some((entry) => sameWallet(entry.wallet, wallet));
    return NextResponse.json({ approved: isApproved });
  }

  if (admin === 'true') {
    return NextResponse.json(whitelist);
  }

  // ⛔ NO PUBLIC LIST. This used to answer, to anyone, with
  // `whitelist.approved.map(e => e.wallet)` -- every approved developer's Solana
  // address, from one unauthenticated GET, needing no wallet, no chain access
  // and no special network position. It had ZERO callers: the admin page reads
  // `?admin=true` behind the password, and everything else asks about a single
  // wallet.
  //
  // ⚠️ The `?wallet=` form above remains a membership ORACLE -- anyone can
  // test an address they already have -- and that is a real residue. What this
  // removes is the free candidate list that made the oracle trivial to aim.
  // Closing the oracle itself needs a signature over a challenge, the way
  // `claim-for-payment` does it, and that is a client change.
  return NextResponse.json(
    { error: 'This endpoint answers about one wallet at a time.' },
    { status: 400 },
  );
}

// POST - Add to whitelist
export async function POST(request: NextRequest) {
  try {
    const read = await readBody(request);
    if (read instanceof NextResponse) return read;
    const { body } = read;
    const { wallet, email, projectName, action } = body as {
      wallet?: unknown;
      email?: unknown;
      projectName?: unknown;
      action?: unknown;
    };

    if (!wallet || typeof wallet !== 'string') {
      return NextResponse.json({ error: 'Wallet address required' }, { status: 400 });
    }

    // Admin actions require password
    if (action === 'approve') {
      const refused = await adminRefusal(request);
      if (refused) return refused;

      const notify = await withWhitelistLock(async () => {
        const whitelist = await readWhitelist();
        if (whitelist.approved.some((e) => sameWallet(e.wallet, wallet))) return null;
        const pendingEntry = whitelist.pending.find((e) => sameWallet(e.wallet, wallet));
        const developerEmail = (typeof email === 'string' && email) || pendingEntry?.email;
        const developerProject = (typeof projectName === 'string' && projectName) || pendingEntry?.projectName;

        whitelist.approved.push({
          wallet: wallet.trim(),
          email: developerEmail || undefined,
          projectName: developerProject || undefined,
          approvedAt: new Date().toISOString(),
          approvedBy: 'admin',
        });
        whitelist.pending = whitelist.pending.filter((e) => !sameWallet(e.wallet, wallet));
        await writeWhitelist(whitelist);
        return { developerEmail, developerProject };
      });

      if (notify) {
        // Send notifications: the mail to the operator (F75), Discord as before.
        sendApprovalEmail(wallet.trim(), notify.developerProject, notify.developerEmail);
        sendApprovalDiscord(wallet.trim(), notify.developerEmail, notify.developerProject);
      }

      return NextResponse.json({ success: true, message: 'Wallet approved' });
    }

    if (action === 'reject' || action === 'revoke') {
      const refused = await adminRefusal(request);
      if (refused) return refused;

      await withWhitelistLock(async () => {
        const whitelist = await readWhitelist();
        whitelist.approved = whitelist.approved.filter((e) => !sameWallet(e.wallet, wallet));
        whitelist.pending = whitelist.pending.filter((e) => !sameWallet(e.wallet, wallet));
        await writeWhitelist(whitelist);
      });

      return NextResponse.json({ success: true, message: 'Wallet removed' });
    }

    // Default: add to pending (public access)
    const problem = publicRequestProblem(body);
    if (problem) {
      return NextResponse.json({ error: problem }, { status: 400 });
    }
    if (await rateLimitExceeded(limiterStore, clientIp(request), RATE_SALT, PUBLIC_REQUESTS_PER_HOUR)) {
      return NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429 });
    }

    const full = await withWhitelistLock(async () => {
      const whitelist = await readWhitelist();
      const existsInPending = whitelist.pending.some((e) => sameWallet(e.wallet, wallet));
      const existsInApproved = whitelist.approved.some((e) => sameWallet(e.wallet, wallet));
      if (existsInPending || existsInApproved) return false;
      if (whitelist.pending.length >= MAX_PENDING) return true;
      whitelist.pending.push({
        wallet: wallet.trim(),
        email: (typeof email === 'string' && email) || undefined,
        projectName: (typeof projectName === 'string' && projectName) || undefined,
        approvedAt: new Date().toISOString(),
        approvedBy: '',
      });
      await writeWhitelist(whitelist);
      return false;
    });
    if (full) {
      return NextResponse.json(
        { error: 'The request queue is full. Try again later.' },
        { status: 503 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof WhitelistUnavailable) return unavailable();
    if (error instanceof WhitelistBusy) {
      return NextResponse.json({ error: 'The whitelist is busy. Retry shortly.' }, { status: 503 });
    }
    logFailure('[whitelist] request', error);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

// DELETE - Remove from whitelist (admin only)
export async function DELETE(request: NextRequest) {
  try {
    const refused = await adminRefusal(request);
    if (refused) return refused;

    // ⛔ THE BODY, NEVER THE QUERY STRING (SWEEP4 round 1, item 15). Same reason
    // as the GET above: a URL is written down by every layer in front of this
    // deployment, and the address of a developer being REVOKED is exactly the
    // line worth not writing. The old form is refused rather than accepted as a
    // fallback. Pinned by `__tests__/api/whitelist.test.ts`, "refuses a removal
    // that names the wallet in the query string".
    if (new URL(request.url).searchParams.get('wallet')) {
      return NextResponse.json(
        { error: 'Send { wallet } in the request body, not in the query string' },
        { status: 400 },
      );
    }
    let wallet = '';
    const read = await readBody(request);
    if (!(read instanceof NextResponse) && typeof read.body.wallet === 'string') {
      wallet = read.body.wallet;
    }

    if (!wallet) {
      return NextResponse.json({ error: 'Wallet address required' }, { status: 400 });
    }

    await withWhitelistLock(async () => {
      const whitelist = await readWhitelist();
      whitelist.approved = whitelist.approved.filter((e) => !sameWallet(e.wallet, wallet));
      whitelist.pending = whitelist.pending.filter((e) => !sameWallet(e.wallet, wallet));
      await writeWhitelist(whitelist);
    });

    return NextResponse.json({ success: true, message: 'Wallet removed' });
  } catch (error) {
    if (error instanceof WhitelistUnavailable) return unavailable();
    if (error instanceof WhitelistBusy) {
      return NextResponse.json({ error: 'The whitelist is busy. Retry shortly.' }, { status: 503 });
    }
    logFailure('[whitelist] request', error);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

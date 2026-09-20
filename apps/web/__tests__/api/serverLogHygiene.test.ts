/**
 * What the waitlist and whitelist routes write to the server log when a store
 * call fails.
 *
 * Run: cd apps/web && pnpm test -- --run __tests__/api/serverLogHygiene.test.ts
 *
 * WHY THIS SUITE EXISTS
 * ─────────────────────
 * The store client words a failed request as
 * `${error}, command was: ${JSON.stringify(commands)}`
 * (node_modules/@upstash/redis/nodejs.js), and with auto-pipelining that list
 * holds every command batched into the same round trip. So an error object
 * passed to `console.error` is not a symptom, it is a transcript: the
 * subscriber record it was writing (email, country, interest, locale, token
 * hash), the whole developer whitelist on the other route, and — because the
 * waitlist and the pay routes share one module-level client — whatever a sale
 * batched alongside it: a redeemable claim code and a payment signature.
 *
 * The pay routes already refuse to log or echo store text
 * (`app/api/issue-note/route.ts`, `bad`). These two routes bypassed that by
 * logging the object itself, and the unsubscribe route wrote the email of the
 * person asking to be deleted into the runtime log while deleting the record.
 *
 * The rule these cases pin: a failure is logged as a FIXED tag plus, at most,
 * the error's class name. Never the message, never the stack, never the object.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── What a real Upstash failure carries ──────────────────────────────────
//
// Taken from the shape measured in scratchpad/web-run/logs4/sweep1-logs/
// probe-waitlist-log.log: one pipeline holding a sale and a signup.
const SUBSCRIBER = 'alice@example.com';
const SALE_CODE = 'CODE-SALE-123456';
const PAYMENT_SIG = '5Qv9SigAAAA';
const WALLET = 'ApprovedWallet123';
const DEV_EMAIL = 'dev@example.com';

function upstashFailure(): Error {
  const err = new Error(
    'ERR max daily request limit exceeded, command was: ' +
      `[["set","p01:note:claim-minted:${SALE_CODE}","payment:${PAYMENT_SIG}"],` +
      `["set","wl:sub:${SUBSCRIBER}","{\\"email\\":\\"${SUBSCRIBER}\\",\\"country\\":\\"FR\\",\\"interest\\":\\"sdk\\"}"]]`,
  );
  err.name = 'UpstashError';
  return err;
}

function whitelistFailure(): Error {
  const err = new Error(
    'ERR quota, command was: ' +
      `[["set","whitelist:data",{"approved":[{"wallet":"${WALLET}","email":"${DEV_EMAIL}",` +
      '"projectName":"Nightshade"}],"pending":[]}]]',
  );
  err.name = 'UpstashError';
  return err;
}

/** Every line the route wrote, rendered the way a log writer renders it. */
let logged: string[] = [];

function captureConsole() {
  logged = [];
  const render = (a: unknown): string =>
    a instanceof Error ? `${a.name}: ${a.message}\n${a.stack ?? ''}` : String(a);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(render).join(' '));
  });
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(render).join(' '));
  });
}

/** The one assertion every case makes about the log it produced. */
function expectNoTranscript(where: string) {
  const text = logged.join('\n');
  expect(text, `${where}: nothing was logged at all`).not.toBe('');
  expect(text, `${where} logged the store command`).not.toMatch(/command was/);
  expect(text, `${where} logged a subscriber email`).not.toMatch(/alice@example\.com/);
  expect(text, `${where} logged a sale's claim code`).not.toMatch(/CODE-SALE-123456/);
  expect(text, `${where} logged a payment signature`).not.toMatch(/5Qv9SigAAAA/);
  expect(text, `${where} logged a developer wallet`).not.toMatch(/ApprovedWallet123/);
  expect(text, `${where} logged a developer email`).not.toMatch(/dev@example\.com/);
  expect(text, `${where} logged a project name`).not.toMatch(/Nightshade/);
}

// ── The waitlist routes ──────────────────────────────────────────────────

const store = {
  getStore: vi.fn(),
  rateLimitExceeded: vi.fn(),
  readRecord: vi.fn(),
  writeRecord: vi.fn(),
  setTokenIndex: vi.fn(),
  deleteTokenIndex: vi.fn(),
  addEmailToSet: vi.fn(),
  removeEmailFromSet: vi.fn(),
  recordSignupCounters: vi.fn(),
  recordConfirmCounters: vi.fn(),
  incrMailFailures: vi.fn(),
  incrUnsubscribed: vi.fn(),
  emailForToken: vi.fn(),
  deleteRecord: vi.fn(),
  generateToken: vi.fn(),
};

vi.mock('@/lib/waitlist/store', () => ({
  getStore: (...a: unknown[]) => store.getStore(...a),
  rateLimitExceeded: (...a: unknown[]) => store.rateLimitExceeded(...a),
  readRecord: (...a: unknown[]) => store.readRecord(...a),
  writeRecord: (...a: unknown[]) => store.writeRecord(...a),
  setTokenIndex: (...a: unknown[]) => store.setTokenIndex(...a),
  deleteTokenIndex: (...a: unknown[]) => store.deleteTokenIndex(...a),
  addEmailToSet: (...a: unknown[]) => store.addEmailToSet(...a),
  removeEmailFromSet: (...a: unknown[]) => store.removeEmailFromSet(...a),
  recordSignupCounters: (...a: unknown[]) => store.recordSignupCounters(...a),
  recordConfirmCounters: (...a: unknown[]) => store.recordConfirmCounters(...a),
  incrMailFailures: (...a: unknown[]) => store.incrMailFailures(...a),
  incrUnsubscribed: (...a: unknown[]) => store.incrUnsubscribed(...a),
  emailForToken: (...a: unknown[]) => store.emailForToken(...a),
  deleteRecord: (...a: unknown[]) => store.deleteRecord(...a),
  generateToken: () => 'a'.repeat(64),
}));

vi.mock('@/lib/waitlist/email', () => ({
  sendConfirmationEmail: vi.fn().mockResolvedValue(true),
}));

const mockKvGet = vi.fn();
const mockKvSet = vi.fn();
vi.mock('@vercel/kv', () => ({
  kv: {
    get: (...a: unknown[]) => mockKvGet(...a),
    set: (...a: unknown[]) => mockKvSet(...a),
  },
}));

vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: { send: vi.fn().mockResolvedValue({ id: 'mock' }) },
  })),
}));

import { POST as waitlistPost } from '@/app/api/waitlist/route';
import { GET as confirmGet } from '@/app/api/waitlist/confirm/route';
import { GET as unsubscribeGet } from '@/app/api/waitlist/unsubscribe/route';
import { POST as whitelistPost, DELETE as whitelistDelete } from '@/app/api/whitelist/route';

const TOKEN = 'b'.repeat(64);

beforeEach(() => {
  vi.clearAllMocks();
  captureConsole();
  store.getStore.mockReturnValue({ incr: vi.fn(), expire: vi.fn() });
  store.rateLimitExceeded.mockResolvedValue(false);
  mockKvGet.mockResolvedValue({ approved: [], pending: [] });
  mockKvSet.mockResolvedValue('OK');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a waitlist route whose store fails', () => {
  it('logs that the signup failed, not the record the store was carrying', async () => {
    store.readRecord.mockRejectedValue(upstashFailure());
    const res = await waitlistPost(
      new NextRequest('http://localhost:3000/api/waitlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.7' },
        body: JSON.stringify({ email: SUBSCRIBER, interest: 'sdk', locale: 'en' }),
      } as unknown as ConstructorParameters<typeof NextRequest>[1]),
    );

    expect(res.status, 'the route stopped answering 500').toBe(500);
    expect((await res.json()).error).toBe('server_error');
    expectNoTranscript('the signup');
  });

  it('logs that a confirmation failed, not the token index it was reading', async () => {
    store.emailForToken.mockRejectedValue(upstashFailure());
    const res = await confirmGet(
      new NextRequest(`http://localhost:3000/api/waitlist/confirm?token=${TOKEN}`),
    );

    expect(res.status, 'the route stopped redirecting').toBe(302);
    expectNoTranscript('the confirmation');
  });

  it('deletes without writing the email of the person asking to be deleted', async () => {
    // The route's own rule is "actually delete the record, do not tombstone".
    // A failure that logs the address undoes that in the one place a deletion
    // request must not leave a trace.
    store.emailForToken.mockResolvedValue(SUBSCRIBER);
    store.deleteRecord.mockRejectedValue(upstashFailure());
    const res = await unsubscribeGet(
      new NextRequest(`http://localhost:3000/api/waitlist/unsubscribe?token=${TOKEN}`),
    );

    expect(res.status, 'the route stopped redirecting').toBe(302);
    expectNoTranscript('the unsubscribe');
  });
});

describe('a whitelist route whose store fails', () => {
  it('logs that the write failed, not the developer list it was writing', async () => {
    mockKvSet.mockRejectedValue(whitelistFailure());
    const res = await whitelistPost(
      new NextRequest('http://localhost:3000/api/whitelist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ wallet: WALLET, email: DEV_EMAIL, projectName: 'Nightshade' }),
      } as unknown as ConstructorParameters<typeof NextRequest>[1]),
    );

    expect(res.status, 'the route stopped answering 500').toBe(500);
    expectNoTranscript('the whitelist write');
  });

  it('logs that the read failed, not the list the read was asking for', async () => {
    mockKvGet.mockRejectedValue(whitelistFailure());
    vi.stubEnv('ADMIN_PASSWORD', 'test-admin-password');
    const res = await whitelistDelete(
      // ⚠️ THE WALLET MOVED OUT OF THE URL in the r1 gate repair (SWEEP4
      // item 15): a request line is written down by Vercel's log, an edge
      // cache key, a proxy and a referrer. The subject of this case is what
      // the route LOGS, which is unchanged; only how the wallet reaches it.
      new NextRequest('http://localhost:3000/api/whitelist', {
        method: 'DELETE',
        headers: {
          'x-admin-password': 'test-admin-password',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ wallet: WALLET }),
      } as unknown as ConstructorParameters<typeof NextRequest>[1]),
    );

    expect(res.status, 'the route stopped answering').toBe(200);
    expectNoTranscript('the whitelist read');
    vi.unstubAllEnvs();
  });
});

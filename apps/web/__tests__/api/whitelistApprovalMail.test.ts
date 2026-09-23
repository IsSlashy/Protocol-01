/**
 * THE APPROVAL MAIL CARRIES NO MARKUP A STRANGER WROTE.
 *
 * Audit v1 round 4 (server axis), finding "an anonymous whitelist request picks
 * the recipient of the approval mail and puts raw HTML into it". The public
 * POST stored `wallet`, `email` and `projectName` as given, and
 * `sendApprovalEmail` interpolated `wallet` and `projectName` unescaped into
 * the HTML it sends from the deployment's own sender. One approve click sent
 * the attacker's markup (a heading, a link to a look-alike page) to the
 * address the attacker chose, under the project's name.
 * Measured at HEAD 6de4c8c3: scratchpad audit-v1-opus/r4-server/p3-head.log.
 *
 * Two rules, pinned separately:
 *   - the public POST refuses a wallet that is not address-shaped, an email
 *     that is not one address, and an oversized or non-text project name, so
 *     the row never exists;
 *   - a row already stored before that rule (or written by an admin) is still
 *     ESCAPED into the mail, so no stored value becomes markup.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const store = new Map<string, unknown>();
vi.mock('@vercel/kv', () => ({
  kv: {
    get: async (k: string) => store.get(k) ?? null,
    // Answers like Upstash: 'OK', or null when `nx` finds the key taken (the
    // route's write lock, close-v1 F13).
    set: async (k: string, v: unknown, opts?: { nx?: boolean }) => {
      if (opts?.nx && store.has(k)) return null;
      store.set(k, JSON.parse(JSON.stringify(v)));
      return 'OK';
    },
    // close-v1 (audit v1 F13, F64): the route's limiter and attempt counters
    // (the write lock is the `set` above). Counters live in the same map, which every case empties.
    incr: async (k: string) => {
      const n = Number(store.get(k) ?? 0) + 1;
      store.set(k, n);
      return n;
    },
    expire: async () => 1,
    del: async (k: string) => {
      store.delete(k);
      return 1;
    },
  },
}));

const sent: Array<{ from: string; to: string; subject: string; html: string }> = [];
vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: {
      send: vi.fn(async (m: { from: string; to: string; subject: string; html: string }) => {
        sent.push(m);
        return { id: 'mock' };
      }),
    },
  })),
}));

import { POST } from '@/app/api/whitelist/route';

const ADMIN = 'test-admin-password';
const MARKUP_PROJECT =
  '</p></div><h1 style="color:#fff">Action required</h1><p>Your SDK allowance expires today. ' +
  '<a href="https://attacker.example/claim">Re-verify your wallet</a></p><div><p>';
const MARKUP_WALLET = '<img src="https://attacker.example/pixel.png">';

function post(body: unknown, admin = false) {
  return POST(request(body, admin));
}

function request(body: unknown, admin: boolean) {
  return new NextRequest('http://localhost:3000/api/whitelist', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(admin ? { 'x-admin-password': ADMIN } : {}) },
    body: JSON.stringify(body),
  } as unknown as ConstructorParameters<typeof NextRequest>[1]);
}

beforeEach(() => {
  store.clear();
  sent.length = 0;
  vi.stubEnv('ADMIN_PASSWORD', ADMIN);
  vi.stubEnv('RESEND_API_KEY', 're_test_key_not_real');
  vi.stubEnv('EMAIL_FROM', 'Protocol 01 <team@example.test>');
  vi.stubEnv('DISCORD_WEBHOOK', '');
  // close-v1 (audit v1 F75): the approval mail goes to the operator address,
  // never to one a request named. Its content is what this file pins.
  vi.stubEnv('WHITELIST_APPROVAL_MAIL_TO', 'operator@example.test');
});

describe('the public request stores only what an approval mail can carry', () => {
  it('refuses a wallet that is markup rather than an address', async () => {
    const res = await post({ wallet: MARKUP_WALLET, email: 'victim@example.org', projectName: 'App' });
    expect(res.status).toBe(400);
    expect(store.get('whitelist:data')).toBeUndefined();
  });

  it('refuses a project name that carries markup-length payloads', async () => {
    const res = await post({
      wallet: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
      email: 'victim@example.org',
      projectName: MARKUP_PROJECT.repeat(2),
    });
    expect(res.status).toBe(400);
    expect(store.get('whitelist:data')).toBeUndefined();
  });

  it('refuses an email field that is not one address', async () => {
    for (const email of ['not-an-email', 'a@b.example\r\nBcc: c@d.example', 'a@b.example, c@d.example', 42]) {
      const res = await post({ wallet: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', email, projectName: 'App' });
      expect(res.status, `accepted ${JSON.stringify(email)}`).toBe(400);
    }
    expect(store.get('whitelist:data')).toBeUndefined();
  });

  it('control: an ordinary request is still accepted', async () => {
    const res = await post({
      wallet: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
      email: 'dev@example.com',
      projectName: 'My DeFi App',
    });
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });
});

describe('the approval mail escapes every stored value', () => {
  it('a legacy pending row holding markup reaches the mail as text, not as HTML', async () => {
    // A row written before the public POST validated anything.
    store.set('whitelist:data', {
      approved: [],
      pending: [
        {
          wallet: MARKUP_WALLET,
          email: 'victim@example.org',
          projectName: MARKUP_PROJECT,
          approvedAt: '2026-09-22T00:00:00.000Z',
          approvedBy: '',
        },
      ],
    });
    // The admin page approves by sending the row's own values back.
    const res = await post(
      { wallet: MARKUP_WALLET, email: 'victim@example.org', projectName: MARKUP_PROJECT, action: 'approve' },
      true,
    );
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    const { html } = sent[0];
    expect(html, 'the project name reached the mail as markup').not.toContain('<h1 style="color:#fff">');
    expect(html, 'the project name reached the mail as a link').not.toContain('<a href="https://attacker.example');
    expect(html, 'the wallet reached the mail as markup').not.toContain('<img');
    // Positive control: the text is there, escaped.
    expect(html).toContain('&lt;h1 style=&quot;color:#fff&quot;&gt;Action required&lt;/h1&gt;');
    expect(html).toContain('&lt;img src=&quot;https://attacker.example/pixel.png&quot;&gt;');
  });
});

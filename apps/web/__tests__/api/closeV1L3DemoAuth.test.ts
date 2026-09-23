/**
 * close-v1, lane L3, audit v1 F14: the demo QR sign-in callback
 * (`app/api/demo/auth/callback/route.ts`).
 *
 * THE FLAW. The POST stored `{ status: 'completed', wallet }` under whatever
 * `sessionId` a caller named, checking only that four fields were present and a
 * timestamp was recent: no signature was verified, and the in-memory Map it
 * wrote to had no bound. Anyone could mark any session "completed" for any
 * wallet, and grow the instance's memory without limit.
 *
 * WHAT IS PINNED. A callback is accepted only for a session this server issued
 * (`GET ?issue=1`, stateless, HMAC-bound, five minutes) and only with a valid
 * ed25519 signature by the wallet over the P01-AUTH message
 * (`P01-AUTH:<service>:<session>:<challenge>:<timestamp>`, the mobile app's
 * format). The store is capped and expires its entries.
 *
 * Run: cd apps/web && npx vitest run __tests__/api/closeV1L3DemoAuth.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

import * as route from '@/app/api/demo/auth/callback/route';

const URL_BASE = 'http://localhost:3000/api/demo/auth/callback';

function post(body: unknown): Promise<Response> {
  return route.POST(
    new NextRequest(URL_BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    } as unknown as ConstructorParameters<typeof NextRequest>[1]),
  );
}

async function status(sessionId: string): Promise<{ status: string; wallet?: string }> {
  const res = await route.GET(new NextRequest(`${URL_BASE}?session=${sessionId}`));
  return res.json();
}

async function issue(): Promise<{ sessionId: string; challenge: string; service: string }> {
  const res = await route.GET(new NextRequest(`${URL_BASE}?issue=1`));
  expect(res.status, 'the server does not issue sessions').toBe(200);
  return res.json();
}

function signed(
  s: { sessionId: string; challenge: string; service: string },
  kp = nacl.sign.keyPair(),
  timestamp = Date.now(),
) {
  const message = `P01-AUTH:${s.service}:${s.sessionId}:${s.challenge}:${timestamp}`;
  const signature = bs58.encode(nacl.sign.detached(new Uint8Array(Buffer.from(message, 'utf8')), kp.secretKey));
  const publicKey = bs58.encode(kp.publicKey);
  return { sessionId: s.sessionId, wallet: publicKey, publicKey, signature, timestamp };
}

describe('F14: the demo auth callback accepts only what the demo issued and a wallet signed', () => {
  it('an unsigned callback for a session nobody issued is refused and changes nothing', async () => {
    const sessionId = 'a'.repeat(32);
    const res = await post({
      sessionId,
      wallet: '7nxQB4Hy9LmPdTJ3kYfPq8WvNs2jKmRt4xFc6dZe8fKm',
      signature: 'not-a-signature',
      publicKey: '7nxQB4Hy9LmPdTJ3kYfPq8WvNs2jKmRt4xFc6dZe8fKm',
      timestamp: Date.now(),
    });
    expect(res.status, 'an unsigned callback was accepted').toBeGreaterThanOrEqual(400);
    expect((await status(sessionId)).status).toBe('pending');
  });

  it('an issued session with a forged signature is refused', async () => {
    const s = await issue();
    const body = signed(s);
    body.signature = bs58.encode(nacl.sign.detached(new Uint8Array(Buffer.from('something else', 'utf8')), nacl.sign.keyPair().secretKey));
    const res = await post(body);
    expect(res.status).toBe(401);
    expect((await status(s.sessionId)).status).toBe('pending');
  });

  it('a signature for another wallet than the one named is refused', async () => {
    const s = await issue();
    const body = signed(s);
    body.wallet = bs58.encode(nacl.sign.keyPair().publicKey);
    expect((await post(body)).status).toBe(401);
  });

  it('a session id the server did not issue is refused even when signed', async () => {
    const forged = { sessionId: 'b'.repeat(32), challenge: 'c'.repeat(64), service: 'styx-demo' };
    expect((await post(signed(forged))).status).toBe(401);
  });

  it('control: an issued session signed by the wallet completes', async () => {
    const s = await issue();
    const kp = nacl.sign.keyPair();
    const res = await post(signed(s, kp));
    expect(res.status).toBe(200);
    expect(await status(s.sessionId)).toMatchObject({ status: 'completed', wallet: bs58.encode(kp.publicKey) });
  });

  it('the store is bounded: completing more sessions than the cap evicts the oldest', async () => {
    const first = await issue();
    expect((await post(signed(first))).status).toBe(200);
    for (let i = 0; i < 510; i++) {
      const s = await issue();
      expect((await post(signed(s))).status).toBe(200);
    }
    expect((await status(first.sessionId)).status).toBe('pending');
  }, 60_000);

  it('an issued session expires', async () => {
    const s = await issue();
    const t0 = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(t0 + 6 * 60_000);
    try {
      expect((await post(signed(s, nacl.sign.keyPair(), t0 + 6 * 60_000))).status).toBe(401);
    } finally {
      spy.mockRestore();
    }
  });

  it('an error never echoes its internal message', async () => {
    const res = await route.POST(
      new NextRequest(URL_BASE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      } as unknown as ConstructorParameters<typeof NextRequest>[1]),
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toMatch(/JSON|position|token/i);
  });
});

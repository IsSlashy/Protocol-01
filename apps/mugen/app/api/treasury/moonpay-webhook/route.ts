/**
 * POST /api/treasury/moonpay-webhook
 *
 * MoonPay calls this when a buy transaction transitions state. We use it to
 * reconcile incoming funds against pending routes immediately, instead of
 * waiting for the cron-driven chain scan to spot the deposit.
 *
 * Payload (MoonPay v3, abridged):
 *   {
 *     "data": {
 *       "id": "<moonpay tx id>",
 *       "status": "pending|waitingPayment|completed|failed",
 *       "externalTransactionId": "<we set this = destStealthAddress>",
 *       "cryptoTransactionId": "<solana tx signature once on-chain>",
 *       "walletAddress": "<bufferAddress>",
 *       "baseCurrencyAmount": 100.0,
 *       "quoteCurrencyAmount": 0.95,
 *       ...
 *     },
 *     "type": "transaction_updated",
 *     "environment": "live|sandbox"
 *   }
 *
 * Auth: Header `Moonpay-Signature-V2: t=<unix>,s=<hex hmac>` where
 *   hmac_sha256(`${t}.${rawBody}`, MOONPAY_WEBHOOK_SECRET) === s
 *
 * If MOONPAY_WEBHOOK_SECRET is unset we reject ALL requests in production
 * (env LIVE-ish) but accept unsigned in sandbox/dev so devnet smoke tests
 * keep working.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import {
  findPendingRouteByStealth,
  markRouteFundedFromWebhook,
} from '@/lib/treasury-buffer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface MoonPayWebhookData {
  id?: string;
  status?: string;
  externalTransactionId?: string;
  cryptoTransactionId?: string;
  walletAddress?: string;
}

interface MoonPayWebhookBody {
  type?: string;
  environment?: string;
  data?: MoonPayWebhookData;
}

const SIGNATURE_HEADER = 'moonpay-signature-v2';
// Tolerate moderate clock skew between MoonPay and our edge.
const TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

function verifySignature(
  rawBody: string,
  header: string | null,
  secret: string | undefined,
): { ok: true } | { ok: false; reason: string } {
  if (!secret) {
    if (isProduction()) {
      return { ok: false, reason: 'MOONPAY_WEBHOOK_SECRET not configured' };
    }
    // Dev/sandbox bypass — clearly logged so it can't be missed.
    console.warn(
      '[moonpay-webhook] MOONPAY_WEBHOOK_SECRET unset; accepting unsigned webhook (dev only)',
    );
    return { ok: true };
  }
  if (!header) return { ok: false, reason: 'missing signature header' };
  // Header format: "t=<unix>,s=<hex>"
  const parts: Record<string, string> = {};
  for (const seg of header.split(',')) {
    const eq = seg.indexOf('=');
    if (eq < 0) continue;
    parts[seg.slice(0, eq).trim()] = seg.slice(eq + 1).trim();
  }
  const t = parts.t;
  const s = parts.s;
  if (!t || !s) return { ok: false, reason: 'malformed signature header' };
  const tsMs = Number.parseInt(t, 10) * 1000;
  if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > TIMESTAMP_SKEW_MS) {
    return { ok: false, reason: 'signature timestamp out of range' };
  }
  const expected = createHmac('sha256', secret)
    .update(`${t}.${rawBody}`)
    .digest('hex');
  if (expected.length !== s.length) {
    return { ok: false, reason: 'signature length mismatch' };
  }
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(s, 'utf8');
  if (!timingSafeEqual(a, b)) {
    return { ok: false, reason: 'signature mismatch' };
  }
  return { ok: true };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const rawBody = await request.text();
  const sigCheck = verifySignature(
    rawBody,
    request.headers.get(SIGNATURE_HEADER),
    process.env.MOONPAY_WEBHOOK_SECRET,
  );
  if (!sigCheck.ok) {
    return NextResponse.json({ error: sigCheck.reason }, { status: 401 });
  }

  let body: MoonPayWebhookBody;
  try {
    body = JSON.parse(rawBody) as MoonPayWebhookBody;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const data = body.data;
  if (!data) {
    return NextResponse.json({ error: 'missing data field' }, { status: 400 });
  }
  // Only act on the terminal "completed" state — pending/waitingPayment
  // transitions are noise and could mark a route funded before MoonPay has
  // actually broadcast the on-chain payout.
  if (data.status !== 'completed') {
    return NextResponse.json({ ok: true, ignored: data.status ?? 'unknown' });
  }
  const stealth = data.externalTransactionId;
  const onchainTx = data.cryptoTransactionId;
  if (!stealth || !onchainTx) {
    return NextResponse.json(
      { error: 'externalTransactionId and cryptoTransactionId required' },
      { status: 400 },
    );
  }
  const route = await findPendingRouteByStealth(stealth);
  if (!route) {
    // Not necessarily an error — the cron scan may have already promoted
    // this route to funded, or the user paid into a stealth we don't know
    // about (treasury buffer was bypassed). Return 200 so MoonPay doesn't
    // retry indefinitely.
    return NextResponse.json({ ok: true, matched: false });
  }
  const updated = await markRouteFundedFromWebhook(route.id, onchainTx);
  return NextResponse.json({
    ok: true,
    matched: true,
    routeId: route.id,
    status: updated?.status ?? 'unknown',
  });
}

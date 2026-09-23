import { NextRequest, NextResponse } from 'next/server';
import { createHmac, randomBytes } from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { logFailure } from '@/lib/server/logSafely';

/**
 * P01 Auth Demo Callback Endpoint
 *
 * Receives the signed confirmation the P01 mobile app sends after the user
 * approves a QR sign-in (`apps/mobile/services/auth/p01Auth.ts`, `sendAuthCallback`).
 *
 * ⛔ NOTHING IS STORED THAT THIS SERVER DID NOT ISSUE AND THE WALLET DID NOT
 * SIGN (audit v1 round 1, F14). This route used to store
 * `{ status: 'completed', wallet }` under any `sessionId` a caller named, with no
 * signature checked (the check was a comment), into a Map with no bound: anyone
 * could mark any session signed in for any wallet, and grow the instance's
 * memory for free. Now:
 *
 *   1. `GET ?issue=1` issues a session: 16 bytes (6 of issue time, 10 random)
 *      and its challenge, HMAC-SHA256 of the session id under a server key. It
 *      is stateless: nothing is stored until a valid callback arrives.
 *   2. `POST` accepts a callback only for a session this key issued, less than
 *      five minutes old, with a recent timestamp, and an ed25519 signature by
 *      `publicKey` (which must be `wallet`) over
 *      `P01-AUTH:<service>:<session>:<challenge>:<timestamp>`, the mobile app's
 *      message (`signAuthChallenge`).
 *   3. The store holds at most `MAX_SESSIONS` entries, each for `SESSION_TTL_MS`,
 *      oldest evicted first.
 *
 * The key is `P01_DEMO_AUTH_KEY` (32 characters or more). Without it the key is
 * random per server instance, so a session issued by one instance and completed
 * on another is refused: the demo fails closed, it never accepts more.
 *
 * ⚠️ The demo page (`app/demo/auth/page.tsx`) still builds its session in the
 * browser and never calls this route; to use the real callback it must take its
 * session and challenge from `GET ?issue=1`. Pinned by
 * `__tests__/api/closeV1L3DemoAuth.test.ts`.
 */

const SERVICE_ID = 'styx-demo';
const SESSION_TTL_MS = 5 * 60 * 1000;
const TIMESTAMP_WINDOW_MS = 60_000;
const MAX_SESSIONS = 500;
const SESSION_ID_RE = /^[0-9a-f]{32}$/;
const CHALLENGE_DOMAIN = 'p01:demo-auth:challenge:v1';

const processKey = randomBytes(32);

function serverKey(): Buffer {
  const configured = process.env.P01_DEMO_AUTH_KEY?.trim() ?? '';
  return configured.length >= 32 ? Buffer.from(configured, 'utf8') : processKey;
}

function challengeFor(sessionId: string): string {
  return createHmac('sha256', serverKey()).update(`${CHALLENGE_DOMAIN}\u0000${sessionId}`).digest('hex');
}

function issuedAt(sessionId: string): number {
  return parseInt(sessionId.slice(0, 12), 16);
}

function issueSession(now: number): { sessionId: string; challenge: string; exp: number } {
  const stamp = Math.max(0, Math.floor(now)).toString(16).padStart(12, '0').slice(-12);
  const sessionId = stamp + randomBytes(10).toString('hex');
  return { sessionId, challenge: challengeFor(sessionId), exp: issuedAt(sessionId) + SESSION_TTL_MS };
}

interface CompletedSession {
  status: 'completed';
  wallet: string;
  completedAt: number;
}

// In-memory, per instance, bounded (see above). Insertion order = age.
const sessions = new Map<string, CompletedSession>();

function prune(now: number): void {
  for (const [id, s] of sessions) {
    if (now - s.completedAt > SESSION_TTL_MS) sessions.delete(id);
  }
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
}

function refuse(status: number, error: string): NextResponse {
  return NextResponse.json({ success: false, error }, { status });
}

function decodeKey(value: string, length: number): Uint8Array | null {
  try {
    const bytes = bs58.decode(value);
    return bytes.length === length ? new Uint8Array(bytes) : null;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > 4096) return refuse(413, 'Request body too large');
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return refuse(400, 'Invalid request body');
    body = parsed as Record<string, unknown>;
  } catch {
    return refuse(400, 'Invalid request body');
  }

  try {
    const { sessionId, wallet, signature, publicKey, timestamp } = body;
    if (
      typeof sessionId !== 'string' ||
      typeof wallet !== 'string' ||
      typeof signature !== 'string' ||
      typeof publicKey !== 'string' ||
      typeof timestamp !== 'number' ||
      !Number.isFinite(timestamp)
    ) {
      return refuse(400, 'Missing required fields');
    }

    const now = Date.now();
    if (Math.abs(now - timestamp) > TIMESTAMP_WINDOW_MS) return refuse(400, 'Timestamp too old');

    // A session this server issued, and still young.
    if (!SESSION_ID_RE.test(sessionId)) return refuse(401, 'Unknown session');
    const born = issuedAt(sessionId);
    if (!(born <= now + 5_000 && now - born <= SESSION_TTL_MS)) return refuse(401, 'Unknown or expired session');
    const challenge = challengeFor(sessionId);

    // Signed by the wallet it names.
    if (wallet !== publicKey) return refuse(401, 'Signature does not match the wallet');
    const key = decodeKey(publicKey, 32);
    const sig = decodeKey(signature, 64);
    if (!key || !sig) return refuse(401, 'Invalid signature');
    // Copied into this realm's Uint8Array: tweetnacl refuses any other.
    const message = new Uint8Array(
      Buffer.from(`P01-AUTH:${SERVICE_ID}:${sessionId}:${challenge}:${timestamp}`, 'utf8'),
    );
    if (!nacl.sign.detached.verify(message, sig, key)) return refuse(401, 'Invalid signature');

    const existing = sessions.get(sessionId);
    if (existing && existing.wallet !== wallet) return refuse(409, 'Session already completed');

    prune(now);
    sessions.delete(sessionId);
    sessions.set(sessionId, { status: 'completed', wallet, completedAt: now });

    return NextResponse.json({
      success: true,
      message: 'Authentication successful',
      wallet,
    });
  } catch (error) {
    logFailure('[demo-auth] callback', error);
    return refuse(500, 'Internal server error');
  }
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);

  if (url.searchParams.get('issue') === '1') {
    const issued = issueSession(Date.now());
    return NextResponse.json(
      { success: true, service: SERVICE_ID, ...issued },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const sessionId = url.searchParams.get('session');
  if (!sessionId) {
    return NextResponse.json(
      { success: false, error: 'Session ID required' },
      { status: 400 },
    );
  }

  const session = sessions.get(sessionId);
  if (!session || Date.now() - session.completedAt > SESSION_TTL_MS) {
    return NextResponse.json({
      success: true,
      status: 'pending',
    });
  }

  return NextResponse.json({
    success: true,
    status: session.status,
    wallet: session.wallet,
  });
}


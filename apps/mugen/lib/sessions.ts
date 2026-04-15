/**
 * Auth QR session store, backed by {@link getStorage}.
 *
 * Uses Redis (Upstash / Vercel KV) in production and the in-memory shim for
 * local dev. TTL-based expiry is handled by Redis — the old in-memory
 * setInterval cleanup loop is no longer needed.
 *
 * Key scheme: `mugen:session:{sessionId}` — TTL derived from expiresAt.
 */
import { getStorage } from './storage';

export interface AuthSession {
  sessionId: string;
  challenge: string;
  status: 'pending' | 'completed' | 'expired';
  createdAt: number;
  expiresAt: number;
  walletAddress?: string;
  signature?: string;
  publicKey?: string;
  completedAt?: number;
}

const KEY = (id: string) => `mugen:session:${id}`;

/** 5-minute grace after expiresAt so a freshly-expired session is still observable. */
const GRACE_MS = 60_000;
const DEFAULT_TTL_FLOOR_SECONDS = 300; // 5min floor

function ttlSecondsFromExpiresAt(expiresAt: number): number {
  const remainingMs = expiresAt + GRACE_MS - Date.now();
  const remainingSec = Math.ceil(remainingMs / 1000);
  return Math.max(DEFAULT_TTL_FLOOR_SECONDS, remainingSec);
}

export async function createSession(
  sessionId: string,
  challenge: string,
  expiresAt: number,
): Promise<AuthSession> {
  const storage = getStorage();
  const session: AuthSession = {
    sessionId,
    challenge,
    status: 'pending',
    createdAt: Date.now(),
    expiresAt,
  };
  await storage.set(KEY(sessionId), session, {
    ttlSeconds: ttlSecondsFromExpiresAt(expiresAt),
  });
  return session;
}

export async function getSession(sessionId: string): Promise<AuthSession | undefined> {
  const storage = getStorage();
  const session = await storage.get<AuthSession>(KEY(sessionId));
  return session ?? undefined;
}

export async function completeSession(
  sessionId: string,
  walletAddress: string,
  signature: string,
  publicKey: string,
): Promise<AuthSession | undefined> {
  const storage = getStorage();
  const session = await storage.get<AuthSession>(KEY(sessionId));
  if (!session) return undefined;
  if (session.status !== 'pending') return undefined;

  session.status = 'completed';
  session.walletAddress = walletAddress;
  session.signature = signature;
  session.publicKey = publicKey;
  session.completedAt = Date.now();

  await storage.set(KEY(sessionId), session, {
    ttlSeconds: ttlSecondsFromExpiresAt(session.expiresAt),
  });
  return session;
}

export async function deleteSession(sessionId: string): Promise<void> {
  const storage = getStorage();
  await storage.del(KEY(sessionId));
}

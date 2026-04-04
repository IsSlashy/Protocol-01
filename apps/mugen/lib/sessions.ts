/**
 * In-memory session store for auth QR sessions.
 * In production, replace with Redis or a database.
 */

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

const sessions = new Map<string, AuthSession>();

// Auto-cleanup expired sessions every 60s
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now > session.expiresAt + 60000) {
        sessions.delete(id);
      }
    }
  }, 60000);
}

export function createSession(sessionId: string, challenge: string, expiresAt: number): AuthSession {
  const session: AuthSession = {
    sessionId,
    challenge,
    status: 'pending',
    createdAt: Date.now(),
    expiresAt,
  };
  sessions.set(sessionId, session);
  return session;
}

export function getSession(sessionId: string): AuthSession | undefined {
  return sessions.get(sessionId);
}

export function completeSession(
  sessionId: string,
  walletAddress: string,
  signature: string,
  publicKey: string,
): AuthSession | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  if (session.status !== 'pending') return undefined;

  session.status = 'completed';
  session.walletAddress = walletAddress;
  session.signature = signature;
  session.publicKey = publicKey;
  session.completedAt = Date.now();

  sessions.set(sessionId, session);
  return session;
}

export function deleteSession(sessionId: string): void {
  sessions.delete(sessionId);
}

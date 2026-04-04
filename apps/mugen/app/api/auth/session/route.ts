import { NextRequest, NextResponse } from 'next/server';
import { createSession, getSession } from '@/lib/sessions';

/**
 * POST /api/auth/session — Create a new auth session (called by frontend)
 * GET  /api/auth/session?id=xxx — Poll session status (called by frontend)
 */

export async function POST(request: NextRequest) {
  try {
    const { sessionId, challenge, expiresAt } = await request.json();

    if (!sessionId || !challenge || !expiresAt) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
    }

    const session = createSession(sessionId, challenge, expiresAt);
    return NextResponse.json({ success: true, session });
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get('id');
  if (!sessionId) {
    return NextResponse.json({ error: 'Missing session id' }, { status: 400 });
  }

  const session = getSession(sessionId);
  if (!session) {
    return NextResponse.json({ status: 'not_found' }, { status: 404 });
  }

  // Check expiration
  if (Date.now() > session.expiresAt && session.status === 'pending') {
    return NextResponse.json({
      status: 'expired',
      sessionId: session.sessionId,
    });
  }

  return NextResponse.json({
    status: session.status,
    sessionId: session.sessionId,
    walletAddress: session.walletAddress || null,
    completedAt: session.completedAt || null,
  });
}

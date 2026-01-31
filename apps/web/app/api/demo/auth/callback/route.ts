import { NextRequest, NextResponse } from 'next/server';

/**
 * P01 Auth Demo Callback Endpoint
 *
 * This endpoint receives authentication confirmations from the P01 mobile app.
 * In production, you would:
 * 1. Verify the signature
 * 2. Verify subscription on-chain if required
 * 3. Create a user session
 * 4. Notify the frontend via WebSocket
 */

// In-memory session store (use Redis/database in production)
const sessions = new Map<string, any>();

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { sessionId, wallet, signature, publicKey, timestamp, subscriptionProof } = body;

    // Basic validation
    if (!sessionId || !wallet || !signature || !publicKey) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields' },
        { status: 400 }
      );
    }

    // Verify timestamp is recent (within 60 seconds)
    const now = Date.now();
    if (Math.abs(now - timestamp) > 60000) {
      return NextResponse.json(
        { success: false, error: 'Timestamp too old' },
        { status: 400 }
      );
    }

    // In production: verify signature using tweetnacl
    // const isValid = nacl.sign.detached.verify(message, signature, publicKey);

    // In production: verify subscription on-chain if required
    // const hasSubscription = await verifySubscription(wallet, subscriptionMint);

    // Store successful auth (in production, update database)
    sessions.set(sessionId, {
      status: 'completed',
      wallet,
      signature,
      completedAt: now,
    });

    // In production: notify frontend via WebSocket
    // wsServer.emit(`session:${sessionId}`, { status: 'completed', wallet });

    return NextResponse.json({
      success: true,
      message: 'Authentication successful',
      wallet,
    });
  } catch (error: any) {
    console.error('[P01 Auth Callback Error]', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get('session');

  if (!sessionId) {
    return NextResponse.json(
      { success: false, error: 'Session ID required' },
      { status: 400 }
    );
  }

  const session = sessions.get(sessionId);
  if (!session) {
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

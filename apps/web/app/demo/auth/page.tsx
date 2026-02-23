'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import QRCode from 'react-qr-code';

// Protocol constants
const PROTOCOL_VERSION = 1;
const PROTOCOL_ID = 'p01-auth';

interface AuthSession {
  sessionId: string;
  challenge: string;
  status: 'pending' | 'scanned' | 'confirmed' | 'completed' | 'expired' | 'failed';
  createdAt: number;
  expiresAt: number;
  wallet?: string;
}

interface AuthPayload {
  v: number;
  protocol: string;
  service: string;
  session: string;
  challenge: string;
  callback: string;
  exp: number;
  name: string;
  logo?: string;
  mint?: string;
}

// Generate random hex string
function randomHex(bytes: number): string {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return Array.from(array)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// Encode payload to base64url
function encodePayload(payload: AuthPayload): string {
  const json = JSON.stringify(payload);
  return btoa(json)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

export default function AuthDemoPage() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [deepLink, setDeepLink] = useState<string>('');
  const [logs, setLogs] = useState<string[]>([]);
  const [requireSubscription, setRequireSubscription] = useState(false);
  const [serviceName, setServiceName] = useState('Netflix Demo');

  // Add log
  const log = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs(prev => [...prev, `[${timestamp}] ${message}`]);
  }, []);

  // Create new session
  const createSession = useCallback(() => {
    const sessionId = randomHex(16);
    const challenge = randomHex(32);
    const now = Date.now();
    const expiresAt = now + 5 * 60 * 1000; // 5 minutes

    const newSession: AuthSession = {
      sessionId,
      challenge,
      status: 'pending',
      createdAt: now,
      expiresAt,
    };

    // Create payload
    const payload: AuthPayload = {
      v: PROTOCOL_VERSION,
      protocol: PROTOCOL_ID,
      service: 'netflix-demo',
      session: sessionId,
      challenge,
      callback: `${window.location.origin}/api/demo/auth/callback`,
      exp: expiresAt,
      name: serviceName,
    };

    if (requireSubscription) {
      payload.mint = 'NFLXsubscriptionDemoMint1111111111111111';
    }

    const encoded = encodePayload(payload);
    const link = `p01://auth?payload=${encoded}`;

    setSession(newSession);
    setDeepLink(link);
    log(`Session created: ${sessionId.slice(0, 8)}...`);
    log(`Challenge: ${challenge.slice(0, 16)}...`);
    log(`Expires in 5 minutes`);

    // Store session for callback (in real app, use server-side storage)
    if (typeof window !== 'undefined') {
      sessionStorage.setItem(`auth_session_${sessionId}`, JSON.stringify(newSession));
    }

    return newSession;
  }, [log, serviceName, requireSubscription]);

  // Poll for session updates (simulating WebSocket)
  useEffect(() => {
    if (!session || session.status === 'completed' || session.status === 'expired') {
      return;
    }

    const interval = setInterval(() => {
      // Check if expired
      if (Date.now() > session.expiresAt) {
        setSession(prev => prev ? { ...prev, status: 'expired' } : null);
        log('Session expired');
        return;
      }

      // Check for updates (in real app, this would be from server)
      const stored = sessionStorage.getItem(`auth_session_${session.sessionId}`);
      if (stored) {
        const updated = JSON.parse(stored);
        if (updated.status !== session.status) {
          setSession(updated);
          if (updated.status === 'completed') {
            log(`AUTH SUCCESS`);
            log(`Wallet: ${updated.wallet}`);
          } else if (updated.status === 'scanned') {
            log('QR Code scanned...');
          } else if (updated.status === 'confirmed') {
            log('Biometric confirmed...');
          }
        }
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [session, log]);

  // Simulate callback (for demo purposes)
  const simulateCallback = useCallback((wallet: string) => {
    if (!session) return;

    const updated = { ...session, status: 'completed' as const, wallet };
    sessionStorage.setItem(`auth_session_${session.sessionId}`, JSON.stringify(updated));
    setSession(updated);
    log(`Callback received - Wallet: ${wallet.slice(0, 8)}...`);
  }, [session, log]);

  return (
    <div className="min-h-screen bg-[#0a0a0c] text-white">
      {/* Header */}
      <header className="sticky top-0 z-50 backdrop-blur-lg border-b border-[#2a2a30]" style={{ backgroundColor: '#0a0a0ccc' }}>
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link
              href="/"
              className="flex items-center gap-2 text-sm text-[#888892] hover:text-white transition-colors"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
              <span className="hidden sm:inline font-mono">Back</span>
            </Link>
            <div className="h-6 w-px bg-[#2a2a30]" />
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 flex items-center justify-center border border-[#39c5bb]/40" style={{ backgroundColor: '#39c5bb15' }}>
                <span className="font-mono font-bold text-xs text-[#39c5bb]">P01</span>
              </div>
              <h1 className="text-lg font-bold font-display tracking-wider">AUTH DEMO</h1>
            </div>
          </div>
          <Link
            href="/docs"
            className="text-xs font-mono uppercase tracking-wider text-[#888892] hover:text-white transition-colors"
          >
            Docs
          </Link>
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 pt-16 pb-8 text-center">
        <p className="text-xs font-mono tracking-[0.2em] text-[#39c5bb] mb-4">
          {"> PROTOCOL 01 // QR AUTH"}
        </p>
        <h2 className="text-3xl sm:text-4xl font-bold font-display tracking-wide mb-4">
          Login with Protocol 01
        </h2>
        <p className="text-base max-w-2xl mx-auto text-[#888892]">
          Scan a QR code with the P01 mobile app to authenticate. No passwords, no email — just your wallet.
        </p>
      </section>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 pb-24">
        <div className="grid md:grid-cols-2 gap-6">
          {/* Left: Service Config */}
          <div className="space-y-6">
            <div className="bg-[#151518] p-6 border border-[#2a2a30]">
              <h2 className="text-lg font-semibold mb-4 flex items-center gap-3 font-display">
                <div className="w-8 h-8 bg-[#ff77a8]/10 border border-[#ff77a8]/30 flex items-center justify-center">
                  <svg className="w-4 h-4 text-[#ff77a8]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="15" rx="2" ry="2" /><polyline points="17 2 12 7 7 2" /></svg>
                </div>
                Service Configuration
              </h2>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm text-[#888892] mb-2 font-mono">
                    Service Name
                  </label>
                  <input
                    type="text"
                    value={serviceName}
                    onChange={(e) => setServiceName(e.target.value)}
                    className="w-full bg-[#0a0a0c] border border-[#2a2a30] px-4 py-2.5 text-white font-mono text-sm focus:border-[#39c5bb] focus:outline-none transition-colors"
                  />
                </div>

                <div className="flex items-center justify-between py-2">
                  <div>
                    <p className="font-medium text-sm">Verify Subscription</p>
                    <p className="text-xs text-[#555560] font-mono">
                      Requires active SPL token
                    </p>
                  </div>
                  <button
                    onClick={() => setRequireSubscription(!requireSubscription)}
                    className="w-12 h-6 transition-colors relative"
                    style={{ backgroundColor: requireSubscription ? '#39c5bb' : '#2a2a30' }}
                  >
                    <div
                      className="w-5 h-5 bg-white transition-transform absolute top-0.5"
                      style={{ left: requireSubscription ? '26px' : '2px' }}
                    />
                  </button>
                </div>

                <button
                  onClick={createSession}
                  className="w-full bg-[#39c5bb] text-[#0a0a0c] font-bold py-3 font-display uppercase tracking-wider text-sm hover:bg-[#39c5bb]/90 transition-colors"
                >
                  Generate QR Code
                </button>
              </div>
            </div>

            {/* Logs */}
            <div className="bg-[#151518] p-6 border border-[#2a2a30]">
              <h3 className="text-[10px] font-mono text-[#555560] uppercase tracking-[0.3em] mb-3">
                Event Log
              </h3>
              <div className="bg-[#0a0a0c] p-4 h-48 overflow-y-auto font-mono text-xs space-y-1 border border-[#2a2a30]/50">
                {logs.length === 0 ? (
                  <p className="text-[#555560]">Waiting for session...</p>
                ) : (
                  logs.map((logEntry, i) => (
                    <p key={i} className="text-[#888892]">
                      {logEntry}
                    </p>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Right: QR Code */}
          <div className="space-y-6">
            {/* QR Display */}
            <div className="bg-[#151518] p-6 border border-[#2a2a30]">
              <h2 className="text-sm font-mono text-center mb-4 uppercase tracking-wider">
                {session?.status === 'completed'
                  ? (<span className="text-[#39c5bb]">AUTHENTICATED</span>)
                  : session?.status === 'expired'
                  ? (<span className="text-[#ff3366]">SESSION EXPIRED</span>)
                  : (<span className="text-[#888892]">SCAN TO CONNECT</span>)}
              </h2>

              <div className="flex justify-center mb-6">
                {!session ? (
                  <div className="w-64 h-64 bg-[#0a0a0c] border border-[#2a2a30] flex items-center justify-center">
                    <p className="text-[#555560] text-center px-4 font-mono text-xs">
                      Click &quot;Generate QR Code&quot; to start
                    </p>
                  </div>
                ) : session.status === 'completed' ? (
                  <div className="w-64 h-64 bg-[#39c5bb]/10 border border-[#39c5bb]/30 flex flex-col items-center justify-center">
                    <div className="w-16 h-16 border border-[#39c5bb]/40 flex items-center justify-center mb-4" style={{ backgroundColor: '#39c5bb20' }}>
                      <svg className="w-8 h-8 text-[#39c5bb]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg>
                    </div>
                    <p className="text-[#39c5bb] font-bold font-display tracking-wider">Authenticated</p>
                    <p className="text-xs text-[#888892] mt-2 font-mono">
                      {session.wallet?.slice(0, 8)}...{session.wallet?.slice(-8)}
                    </p>
                  </div>
                ) : session.status === 'expired' ? (
                  <div className="w-64 h-64 bg-[#ff3366]/10 border border-[#ff3366]/30 flex flex-col items-center justify-center">
                    <div className="w-16 h-16 border border-[#ff3366]/40 flex items-center justify-center mb-4" style={{ backgroundColor: '#ff336620' }}>
                      <svg className="w-8 h-8 text-[#ff3366]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
                    </div>
                    <p className="text-[#ff3366] font-bold font-display tracking-wider">Session Expired</p>
                    <button
                      onClick={createSession}
                      className="mt-4 text-sm text-[#39c5bb] hover:text-[#39c5bb]/80 font-mono transition-colors"
                    >
                      Generate new QR
                    </button>
                  </div>
                ) : (
                  <div className="bg-white p-4">
                    <QRCode
                      value={deepLink}
                      size={224}
                      level="M"
                      bgColor="#ffffff"
                      fgColor="#000000"
                    />
                  </div>
                )}
              </div>

              {session && session.status === 'pending' && (
                <div className="text-center">
                  <p className="text-sm text-[#888892] mb-2 font-mono">
                    Scan with Protocol 01 app
                  </p>
                  <div className="flex items-center justify-center gap-2 text-xs text-[#555560]">
                    <div className="w-2 h-2 bg-[#39c5bb] animate-pulse" />
                    <span className="font-mono">Waiting for connection...</span>
                  </div>
                </div>
              )}
            </div>

            {/* Debug Info */}
            {session && session.status === 'pending' && (
              <div className="bg-[#151518] p-6 border border-[#2a2a30]">
                <h3 className="text-[10px] font-mono text-[#555560] uppercase tracking-[0.3em] mb-3">
                  Debug — Simulate Callback
                </h3>
                <p className="text-xs text-[#555560] mb-4 font-mono">
                  To test without the mobile app, simulate a callback:
                </p>
                <button
                  onClick={() =>
                    simulateCallback('7nxQB4Hy9LmPdTJ3kYfPq8WvNs2jKmRt4xFc6dZe8fKm')
                  }
                  className="w-full bg-[#1f1f24] border border-[#2a2a30] hover:border-[#39c5bb]/50 text-white py-2.5 text-sm font-mono transition-colors"
                >
                  Simulate Auth Success
                </button>
              </div>
            )}

            {/* Deep Link */}
            {deepLink && session?.status === 'pending' && (
              <div className="bg-[#151518] p-6 border border-[#2a2a30]">
                <h3 className="text-[10px] font-mono text-[#555560] uppercase tracking-[0.3em] mb-3">
                  Deep Link
                </h3>
                <div className="bg-[#0a0a0c] p-3 overflow-x-auto border border-[#2a2a30]/50">
                  <code className="text-xs text-[#39c5bb] break-all font-mono">
                    {deepLink}
                  </code>
                </div>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(deepLink);
                    log('Deep link copied');
                  }}
                  className="mt-3 text-sm text-[#39c5bb] hover:text-[#39c5bb]/80 font-mono transition-colors"
                >
                  Copy
                </button>
              </div>
            )}
          </div>
        </div>

        {/* How it works */}
        <div className="mt-12 bg-[#151518] p-8 border border-[#2a2a30]">
          <h2 className="text-xl font-bold mb-8 font-display tracking-wider text-center">How It Works</h2>
          <div className="grid md:grid-cols-4 gap-6">
            {[
              {
                icon: (
                  <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2" /><line x1="12" y1="18" x2="12.01" y2="18" /></svg>
                ),
                color: '#39c5bb',
                title: '1. Scan',
                desc: 'User scans the QR code with the P01 app',
              },
              {
                icon: (
                  <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
                ),
                color: '#ff77a8',
                title: '2. Verify',
                desc: 'The app verifies subscription status on-chain',
              },
              {
                icon: (
                  <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
                ),
                color: '#00ffe5',
                title: '3. Confirm',
                desc: 'User confirms with biometric authentication',
              },
              {
                icon: (
                  <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg>
                ),
                color: '#ffcc00',
                title: '4. Connected',
                desc: 'Service receives the signature and authenticates',
              },
            ].map((step, i) => (
              <div key={i} className="text-center">
                <div
                  className="w-14 h-14 mx-auto mb-4 flex items-center justify-center border"
                  style={{
                    color: step.color,
                    borderColor: `${step.color}40`,
                    backgroundColor: `${step.color}10`,
                  }}
                >
                  {step.icon}
                </div>
                <h3 className="font-semibold mb-1 font-display tracking-wider text-sm">{step.title}</h3>
                <p className="text-sm text-[#888892]">{step.desc}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Code Example */}
        <div className="mt-6 bg-[#151518] p-8 border border-[#2a2a30]">
          <h2 className="text-xl font-bold mb-4 font-display tracking-wider">SDK Integration</h2>
          <div className="bg-[#0a0a0c] p-4 overflow-x-auto border border-[#2a2a30]/50">
            <pre>
              <code className="text-sm text-[#888892] font-mono whitespace-pre">{`import { P01AuthClient } from '@p01/auth-sdk';

const auth = new P01AuthClient({
  serviceId: 'my-service',
  serviceName: 'My Service',
  callbackUrl: 'https://myservice.com/auth/callback',
  subscriptionMint: 'TOKEN_MINT_ADDRESS', // optional
});

// Create a session
const { qrCodeSvg, sessionId } = await auth.createSession();

// Display the QR code
document.getElementById('qr').innerHTML = qrCodeSvg;

// Wait for completion
const result = await auth.waitForCompletion(sessionId);
if (result.success) {
  console.log('Authenticated:', result.wallet);
}`}</code>
            </pre>
          </div>
        </div>
      </main>

      {/* Bottom glow line */}
      <div className="h-px" style={{ background: 'linear-gradient(to right, transparent, #39c5bb80, transparent)' }} />
    </div>
  );
}

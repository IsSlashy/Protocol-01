'use client';

import { useState, useEffect, useCallback } from 'react';
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
    log(`Session créée: ${sessionId.slice(0, 8)}...`);
    log(`Challenge: ${challenge.slice(0, 16)}...`);
    log(`Expire dans 5 minutes`);

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
        log('Session expirée');
        return;
      }

      // Check for updates (in real app, this would be from server)
      const stored = sessionStorage.getItem(`auth_session_${session.sessionId}`);
      if (stored) {
        const updated = JSON.parse(stored);
        if (updated.status !== session.status) {
          setSession(updated);
          if (updated.status === 'completed') {
            log(`✅ Authentification réussie!`);
            log(`Wallet: ${updated.wallet}`);
          } else if (updated.status === 'scanned') {
            log('📱 QR Code scanné...');
          } else if (updated.status === 'confirmed') {
            log('👆 Biométrie confirmée...');
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
    log(`✅ Callback reçu - Wallet: ${wallet.slice(0, 8)}...`);
  }, [session, log]);

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      {/* Header */}
      <header className="border-b border-white/10 px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-gradient-to-br from-cyan-400 to-pink-500 rounded-lg" />
            <div>
              <h1 className="font-bold">P01 Auth Demo</h1>
              <p className="text-xs text-gray-400">Login with Protocol 01</p>
            </div>
          </div>
          <a
            href="/"
            className="text-sm text-gray-400 hover:text-white transition"
          >
            ← Retour
          </a>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-12">
        <div className="grid md:grid-cols-2 gap-8">
          {/* Left: Service Config */}
          <div className="space-y-6">
            <div className="bg-white/5 rounded-2xl p-6 border border-white/10">
              <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <span className="text-2xl">🎬</span>
                Configuration Service
              </h2>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm text-gray-400 mb-2">
                    Nom du service
                  </label>
                  <input
                    type="text"
                    value={serviceName}
                    onChange={(e) => setServiceName(e.target.value)}
                    className="w-full bg-black/50 border border-white/10 rounded-lg px-4 py-2 text-white"
                  />
                </div>

                <div className="flex items-center justify-between py-2">
                  <div>
                    <p className="font-medium">Vérifier abonnement</p>
                    <p className="text-sm text-gray-400">
                      Requiert un token SPL actif
                    </p>
                  </div>
                  <button
                    onClick={() => setRequireSubscription(!requireSubscription)}
                    className={`w-12 h-6 rounded-full transition ${
                      requireSubscription ? 'bg-cyan-500' : 'bg-gray-600'
                    }`}
                  >
                    <div
                      className={`w-5 h-5 bg-white rounded-full transition transform ${
                        requireSubscription ? 'translate-x-6' : 'translate-x-0.5'
                      }`}
                    />
                  </button>
                </div>

                <button
                  onClick={createSession}
                  className="w-full bg-gradient-to-r from-cyan-500 to-cyan-400 text-black font-semibold py-3 rounded-xl hover:opacity-90 transition"
                >
                  Générer QR Code
                </button>
              </div>
            </div>

            {/* Logs */}
            <div className="bg-white/5 rounded-2xl p-6 border border-white/10">
              <h3 className="text-sm font-semibold text-gray-400 mb-3">
                LOGS
              </h3>
              <div className="bg-black/50 rounded-lg p-4 h-48 overflow-y-auto font-mono text-xs space-y-1">
                {logs.length === 0 ? (
                  <p className="text-gray-500">En attente...</p>
                ) : (
                  logs.map((log, i) => (
                    <p key={i} className="text-gray-300">
                      {log}
                    </p>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Right: QR Code */}
          <div className="space-y-6">
            {/* QR Display */}
            <div className="bg-white/5 rounded-2xl p-6 border border-white/10">
              <h2 className="text-lg font-semibold mb-4 text-center">
                {session?.status === 'completed'
                  ? '✅ Connecté!'
                  : session?.status === 'expired'
                  ? '⏰ Expiré'
                  : 'Scannez pour vous connecter'}
              </h2>

              <div className="flex justify-center mb-6">
                {!session ? (
                  <div className="w-64 h-64 bg-white/10 rounded-xl flex items-center justify-center">
                    <p className="text-gray-500 text-center px-4">
                      Cliquez sur "Générer QR Code" pour commencer
                    </p>
                  </div>
                ) : session.status === 'completed' ? (
                  <div className="w-64 h-64 bg-green-500/20 rounded-xl flex flex-col items-center justify-center">
                    <span className="text-6xl mb-4">✓</span>
                    <p className="text-green-400 font-semibold">Authentifié!</p>
                    <p className="text-xs text-gray-400 mt-2 font-mono">
                      {session.wallet?.slice(0, 8)}...{session.wallet?.slice(-8)}
                    </p>
                  </div>
                ) : session.status === 'expired' ? (
                  <div className="w-64 h-64 bg-red-500/20 rounded-xl flex flex-col items-center justify-center">
                    <span className="text-6xl mb-4">⏰</span>
                    <p className="text-red-400 font-semibold">Session expirée</p>
                    <button
                      onClick={createSession}
                      className="mt-4 text-sm text-cyan-400 hover:underline"
                    >
                      Générer un nouveau QR
                    </button>
                  </div>
                ) : (
                  <div className="bg-white p-4 rounded-xl">
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
                  <p className="text-sm text-gray-400 mb-2">
                    Scannez avec l'app Protocol 01
                  </p>
                  <div className="flex items-center justify-center gap-2 text-xs text-gray-500">
                    <div className="w-2 h-2 bg-cyan-400 rounded-full animate-pulse" />
                    En attente de connexion...
                  </div>
                </div>
              )}
            </div>

            {/* Debug Info */}
            {session && session.status === 'pending' && (
              <div className="bg-white/5 rounded-2xl p-6 border border-white/10">
                <h3 className="text-sm font-semibold text-gray-400 mb-3">
                  DEBUG - Simuler Callback
                </h3>
                <p className="text-xs text-gray-500 mb-4">
                  Pour tester sans l'app mobile, simulez un callback:
                </p>
                <button
                  onClick={() =>
                    simulateCallback('7nxQB4Hy9LmPdTJ3kYfPq8WvNs2jKmRt4xFc6dZe8fKm')
                  }
                  className="w-full bg-white/10 hover:bg-white/20 text-white py-2 rounded-lg text-sm transition"
                >
                  Simuler Auth Réussie
                </button>
              </div>
            )}

            {/* Deep Link */}
            {deepLink && session?.status === 'pending' && (
              <div className="bg-white/5 rounded-2xl p-6 border border-white/10">
                <h3 className="text-sm font-semibold text-gray-400 mb-3">
                  DEEP LINK
                </h3>
                <div className="bg-black/50 rounded-lg p-3 overflow-x-auto">
                  <code className="text-xs text-cyan-400 break-all">
                    {deepLink}
                  </code>
                </div>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(deepLink);
                    log('Deep link copié!');
                  }}
                  className="mt-3 text-sm text-cyan-400 hover:underline"
                >
                  📋 Copier
                </button>
              </div>
            )}
          </div>
        </div>

        {/* How it works */}
        <div className="mt-12 bg-white/5 rounded-2xl p-8 border border-white/10">
          <h2 className="text-xl font-bold mb-6">Comment ça marche?</h2>
          <div className="grid md:grid-cols-4 gap-6">
            {[
              {
                icon: '📱',
                title: '1. Scanner',
                desc: "L'utilisateur scanne le QR code avec l'app P01",
              },
              {
                icon: '🔍',
                title: '2. Vérifier',
                desc: "L'app vérifie le statut d'abonnement on-chain",
              },
              {
                icon: '👆',
                title: '3. Confirmer',
                desc: "L'utilisateur confirme avec sa biométrie",
              },
              {
                icon: '✅',
                title: '4. Connecté',
                desc: 'Le service reçoit la signature et connecte',
              },
            ].map((step, i) => (
              <div key={i} className="text-center">
                <div className="text-4xl mb-3">{step.icon}</div>
                <h3 className="font-semibold mb-1">{step.title}</h3>
                <p className="text-sm text-gray-400">{step.desc}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Code Example */}
        <div className="mt-8 bg-white/5 rounded-2xl p-8 border border-white/10">
          <h2 className="text-xl font-bold mb-4">Intégration SDK</h2>
          <pre className="bg-black/50 rounded-lg p-4 overflow-x-auto text-sm">
            <code className="text-gray-300">{`import { P01AuthClient } from '@p01/auth-sdk';

const auth = new P01AuthClient({
  serviceId: 'my-service',
  serviceName: 'Mon Service',
  callbackUrl: 'https://monservice.com/auth/callback',
  subscriptionMint: 'TOKEN_MINT_ADDRESS', // optionnel
});

// Créer une session
const { qrCodeSvg, sessionId } = await auth.createSession();

// Afficher le QR code
document.getElementById('qr').innerHTML = qrCodeSvg;

// Attendre la complétion
const result = await auth.waitForCompletion(sessionId);
if (result.success) {
}`}</code>
          </pre>
        </div>
      </main>
    </div>
  );
}

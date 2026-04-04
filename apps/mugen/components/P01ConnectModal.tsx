'use client';

import { useEffect, useState, useCallback } from 'react';
import { X, Smartphone, Monitor, ExternalLink, RefreshCw, Shield } from 'lucide-react';
import { useP01Wallet } from './WalletProvider';

// Poll session status every 2s to detect mobile app completion
function useSessionPolling(
  sessionId: string | null,
  active: boolean,
  onComplete: (walletAddress: string) => void,
) {
  useEffect(() => {
    if (!sessionId || !active) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/auth/session?id=${sessionId}`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.status === 'completed' && data.walletAddress) {
          onComplete(data.walletAddress);
        }
      } catch { /* polling error, ignore */ }
    }, 2000);

    return () => clearInterval(interval);
  }, [sessionId, active, onComplete]);
}

/**
 * P01 Native Connect Modal — glassmorphism design with real QR code.
 *
 * Connection methods:
 * 1. P01 Browser Extension → direct connect via window.protocol01
 * 2. P01 Mobile App → scan QR code (p01:// deep link with auth payload)
 */

async function generateSession() {
  const sid = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const challenge = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const expiresAt = Date.now() + 5 * 60 * 1000;

  const payload = {
    v: 1,
    protocol: 'p01-auth',
    service: 'mugen-exchange',
    session: sid,
    challenge,
    callback: typeof window !== 'undefined' ? `${window.location.origin}/api/auth/callback` : '',
    exp: expiresAt,
    name: 'Mugen Exchange',
    logo: typeof window !== 'undefined' ? `${window.location.origin}/mugen-icon.png` : '',
  };

  const encoded = btoa(JSON.stringify(payload));
  const deepLink = `p01://auth?payload=${encoded}`;

  // Register session on server
  try {
    await fetch('/api/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, challenge, expiresAt }),
    });
  } catch { /* non-critical */ }

  return { sessionId: sid, deepLink, expiresAt };
}

function qrCodeUrl(data: string, size: number = 200): string {
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(data)}&bgcolor=0a0a1a&color=60a5fa&format=png&margin=8`;
}

export default function P01ConnectModal() {
  const { showConnectModal, setShowConnectModal, connect, connectViaQR, extensionDetected } = useP01Wallet();
  const [session, setSession] = useState<{ sessionId: string; deepLink: string; expiresAt: number } | null>(null);
  const [showQR, setShowQR] = useState(false);
  const [countdown, setCountdown] = useState(300);
  const [qrLoaded, setQrLoaded] = useState(false);

  const refreshSession = useCallback(async () => {
    const s = await generateSession();
    setSession(s);
    setCountdown(300);
    setQrLoaded(false);
  }, []);

  // Auto-generate session when modal opens
  useEffect(() => {
    if (showConnectModal) {
      refreshSession();
      setShowQR(!extensionDetected);
    }
  }, [showConnectModal, extensionDetected, refreshSession]);

  // Countdown timer
  useEffect(() => {
    if (!showConnectModal || !showQR) return;
    const interval = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          refreshSession();
          return 300;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [showConnectModal, showQR, refreshSession]);

  // Poll session status — auto-connect when mobile approves
  useSessionPolling(
    session?.sessionId ?? null,
    showConnectModal && showQR,
    connectViaQR,
  );

  if (!showConnectModal) return null;

  const minutes = Math.floor(countdown / 60);
  const seconds = countdown % 60;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(5, 5, 16, 0.92)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
      }}
      onClick={() => setShowConnectModal(false)}
    >
      <div
        style={{
          background: 'rgba(255,255,255,0.03)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: '24px',
          maxWidth: '400px',
          width: '90%',
          padding: '2rem',
          position: 'relative',
          overflow: 'hidden',
          boxShadow: '0 8px 60px rgba(59, 130, 246, 0.12), 0 0 120px rgba(139, 92, 246, 0.06)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top highlight */}
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '1px', background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent)' }} />

        {/* Close */}
        <button
          onClick={() => setShowConnectModal(false)}
          style={{
            position: 'absolute', top: '1rem', right: '1rem',
            background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: '10px', width: '2rem', height: '2rem',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#555570', cursor: 'pointer',
          }}
        >
          <X size={16} />
        </button>

        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
          <img
            src="/mugen-icon.png"
            alt="Mugen"
            style={{
              width: '3.5rem', height: '3.5rem',
              objectFit: 'contain', margin: '0 auto 1rem',
              display: 'block',
              filter: 'drop-shadow(0 0 15px rgba(59, 130, 246, 0.4))',
            }}
          />
          <h2 style={{ fontFamily: "'Orbitron', sans-serif", fontSize: '1.15rem', fontWeight: 700, color: 'white', margin: '0 0 0.3rem' }}>
            Connect to Mugen
          </h2>
          <p style={{ color: '#8888aa', fontSize: '0.75rem', fontFamily: "'JetBrains Mono', monospace", margin: 0 }}>
            Protocol 01 Wallet
          </p>
        </div>

        {/* Connection options */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', marginBottom: showQR ? '0' : '0' }}>
          {/* Extension */}
          <button
            onClick={async () => {
              if (extensionDetected) {
                await connect();
              } else {
                window.open('https://protocol01.app', '_blank');
              }
            }}
            style={{
              display: 'flex', alignItems: 'center', gap: '0.8rem',
              padding: '0.9rem 1rem', borderRadius: '14px',
              background: extensionDetected ? 'rgba(59,130,246,0.08)' : 'rgba(255,255,255,0.02)',
              border: extensionDetected ? '1px solid rgba(59,130,246,0.2)' : '1px solid rgba(255,255,255,0.05)',
              cursor: 'pointer', width: '100%', textAlign: 'left', transition: 'all 0.2s',
            }}
          >
            <div style={{
              width: '2.2rem', height: '2.2rem', borderRadius: '10px',
              background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.15)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Monitor size={16} style={{ color: '#3b82f6' }} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: "'Orbitron', sans-serif", fontSize: '0.8rem', fontWeight: 600, color: 'white' }}>
                P01 Extension
              </div>
              <div style={{ fontSize: '0.65rem', color: '#555570', fontFamily: "'JetBrains Mono', monospace", marginTop: '0.15rem' }}>
                {extensionDetected ? 'Detected — Click to connect' : 'Not installed — Download'}
              </div>
            </div>
            {extensionDetected ? (
              <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 8px rgba(34,197,94,0.5)' }} />
            ) : (
              <ExternalLink size={13} style={{ color: '#555570' }} />
            )}
          </button>

          {/* Mobile App */}
          <button
            onClick={() => { setShowQR(true); refreshSession(); }}
            style={{
              display: 'flex', alignItems: 'center', gap: '0.8rem',
              padding: '0.9rem 1rem', borderRadius: '14px',
              background: showQR ? 'rgba(139,92,246,0.08)' : 'rgba(255,255,255,0.02)',
              border: showQR ? '1px solid rgba(139,92,246,0.2)' : '1px solid rgba(255,255,255,0.05)',
              cursor: 'pointer', width: '100%', textAlign: 'left', transition: 'all 0.2s',
            }}
          >
            <div style={{
              width: '2.2rem', height: '2.2rem', borderRadius: '10px',
              background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.15)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Smartphone size={16} style={{ color: '#8b5cf6' }} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: "'Orbitron', sans-serif", fontSize: '0.8rem', fontWeight: 600, color: 'white' }}>
                P01 Mobile App
              </div>
              <div style={{ fontSize: '0.65rem', color: '#555570', fontFamily: "'JetBrains Mono', monospace", marginTop: '0.15rem' }}>
                Scan QR code to connect
              </div>
            </div>
          </button>
        </div>

        {/* QR Code */}
        {showQR && session && (
          <div style={{ marginTop: '1.5rem', textAlign: 'center' }}>
            {/* QR container with glass effect */}
            <div style={{
              display: 'inline-block', padding: '1rem',
              background: 'rgba(255,255,255,0.04)',
              borderRadius: '16px',
              border: '1px solid rgba(255,255,255,0.06)',
              position: 'relative',
            }}>
              {/* Loading state */}
              {!qrLoaded && (
                <div style={{
                  width: '200px', height: '200px',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  position: 'absolute', inset: '1rem',
                  background: 'rgba(10,10,26,0.8)', borderRadius: '12px', zIndex: 1,
                }}>
                  <RefreshCw size={24} style={{ color: '#3b82f6', animation: 'spin 1s linear infinite' }} />
                  <style dangerouslySetInnerHTML={{ __html: '@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}' }} />
                </div>
              )}

              {/* Real QR code via API */}
              <img
                src={qrCodeUrl(session.deepLink, 200)}
                alt="Scan with P01 App"
                width={200}
                height={200}
                onLoad={() => setQrLoaded(true)}
                onError={() => setQrLoaded(true)}
                style={{
                  borderRadius: '12px',
                  display: 'block',
                  opacity: qrLoaded ? 1 : 0.3,
                  transition: 'opacity 0.3s',
                }}
              />

              {/* Mugen icon overlay in center of QR */}
              <div style={{
                position: 'absolute',
                top: '50%', left: '50%',
                transform: 'translate(-50%, -50%)',
                width: '2.5rem', height: '2.5rem',
                borderRadius: '10px',
                background: '#0a0a1a',
                border: '2px solid rgba(59,130,246,0.3)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 0 12px rgba(59,130,246,0.3)',
              }}>
                <img src="/mugen-icon.png" alt="" style={{ width: '1.6rem', height: '1.6rem', objectFit: 'contain' }} />
              </div>
            </div>

            {/* Session info */}
            <div style={{ marginTop: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '1rem' }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: '0.3rem',
                padding: '0.3rem 0.6rem', borderRadius: '8px',
                background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.15)',
              }}>
                <Shield size={10} style={{ color: '#3b82f6' }} />
                <span style={{ fontSize: '0.6rem', color: '#60a5fa', fontFamily: "'JetBrains Mono',monospace" }}>
                  {session.sessionId.slice(0, 8)}...{session.sessionId.slice(-4)}
                </span>
              </div>
              <div style={{
                display: 'flex', alignItems: 'center', gap: '0.3rem',
                padding: '0.3rem 0.6rem', borderRadius: '8px',
                background: countdown < 60 ? 'rgba(239,68,68,0.08)' : 'rgba(255,255,255,0.03)',
                border: `1px solid ${countdown < 60 ? 'rgba(239,68,68,0.15)' : 'rgba(255,255,255,0.05)'}`,
              }}>
                <span style={{
                  fontSize: '0.6rem', fontFamily: "'JetBrains Mono',monospace",
                  color: countdown < 60 ? '#ef4444' : '#555570',
                }}>
                  {minutes}:{seconds.toString().padStart(2, '0')}
                </span>
              </div>
              <button
                onClick={refreshSession}
                style={{
                  background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)',
                  borderRadius: '8px', padding: '0.3rem', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                <RefreshCw size={12} style={{ color: '#555570' }} />
              </button>
            </div>

            {/* Instructions */}
            <div style={{
              marginTop: '1rem',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
            }}>
              {['Open P01 App', 'Scan QR', 'Approve'].map((step, i) => (
                <div key={step} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                  <span style={{
                    width: '1rem', height: '1rem', borderRadius: '50%',
                    background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(59,130,246,0.2)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '0.55rem', color: '#3b82f6', fontFamily: "'Orbitron',sans-serif", fontWeight: 700,
                  }}>
                    {i + 1}
                  </span>
                  <span style={{ fontSize: '0.6rem', color: '#8888aa', fontFamily: "'JetBrains Mono',monospace" }}>
                    {step}
                  </span>
                  {i < 2 && <span style={{ color: '#333', fontSize: '0.5rem' }}>→</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Footer */}
        <div style={{
          marginTop: '1.5rem', textAlign: 'center',
          borderTop: '1px solid rgba(255,255,255,0.04)', paddingTop: '1rem',
        }}>
          <p style={{ color: '#555570', fontSize: '0.6rem', fontFamily: "'JetBrains Mono', monospace", margin: 0 }}>
            Powered by Protocol 01 — Privacy Layer for Solana
          </p>
        </div>
      </div>
    </div>
  );
}

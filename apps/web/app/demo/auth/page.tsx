'use client';

import { useState, useEffect, useCallback, type CSSProperties } from 'react';
import Link from 'next/link';
import QRCode from 'react-qr-code';
import StyxShell from '../../_styx/StyxShell';
import Reveal from '../../_styx/Reveal';

// Protocol constants
const PROTOCOL_VERSION = 1;
const PROTOCOL_ID = 'p01-auth';

/**
 * Three states, and only three. A phone would move a real session through
 * scanned and confirmed as well, but neither can be observed from this tab: the
 * only writers of this session are the Generate button, the five-minute clock
 * and the local simulation button. The union stays honest about that.
 */
interface AuthSession {
  sessionId: string;
  challenge: string;
  status: 'pending' | 'completed' | 'expired';
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

/* ---------------------------------------------------------------------------
   Presentation-only shapes.

   styx.css has no switch, no fixed-height console and no white QR plate, so
   these compose the existing tokens instead of inventing a page-local palette.
   Nothing below carries a colour that is not already a Styx token, with one
   documented exception: the QR plate. A QR needs a true white quiet zone, and
   ink-on-ink does not scan.
   --------------------------------------------------------------------------- */

const QR_FRAME: CSSProperties = {
  width: '16rem',
  height: '16rem',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.7rem',
  padding: '1.5rem',
  textAlign: 'center',
  border: '1px solid var(--styx-rule)',
  background: 'var(--styx-panel-2)',
};

const QR_PLATE: CSSProperties = {
  display: 'inline-flex',
  padding: '1rem',
  background: '#ffffff',
};

const CONSOLE_BOX: CSSProperties = {
  height: '12rem',
  overflowY: 'auto',
  padding: '1rem',
  border: '1px solid var(--styx-rule)',
  background: 'var(--styx-panel-2)',
};

const TWO_UP: CSSProperties = {
  display: 'grid',
  gap: '1.5rem',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(20rem, 100%), 1fr))',
  alignItems: 'start',
};

const SWITCH_TRACK: CSSProperties = {
  position: 'relative',
  flex: 'none',
  width: '3rem',
  height: '1.5rem',
  padding: 0,
  border: '1px solid var(--styx-rule)',
  borderRadius: 0,
  background: 'var(--styx-panel-2)',
  cursor: 'pointer',
};

const CENTER_ROW: CSSProperties = {
  display: 'flex',
  justifyContent: 'center',
};

export default function AuthDemoPage() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [deepLink, setDeepLink] = useState<string>('');
  const [logs, setLogs] = useState<string[]>([]);
  const [requireSubscription, setRequireSubscription] = useState(false);
  const [serviceName, setServiceName] = useState('Demo Service');

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
      service: 'styx-demo',
      session: sessionId,
      challenge,
      callback: `${window.location.origin}/api/demo/auth/callback`,
      exp: expiresAt,
      name: serviceName,
    };

    if (requireSubscription) {
      // Not a real mint, and not a real brand either. A service would put its
      // own subscription mint here.
      payload.mint = 'StyxDemoSubscriptionMint1111111111111111';
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

  // Watch the session. Two jobs, both local: run the five-minute clock out, and
  // re-read the stored session in case something else in this tab replaced it.
  // No server is polled, and no status arrives from outside this tab, so there
  // is nothing here to announce beyond the expiry.
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

      const stored = sessionStorage.getItem(`auth_session_${session.sessionId}`);
      if (!stored) return;

      const updated = JSON.parse(stored) as AuthSession;
      if (updated.status !== session.status) {
        setSession(updated);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [session, log]);

  // Write a completed session locally. This is not a callback: nothing is sent,
  // received or verified.
  const simulateCallback = useCallback((wallet: string) => {
    if (!session) return;

    const updated = { ...session, status: 'completed' as const, wallet };
    sessionStorage.setItem(`auth_session_${session.sessionId}`, JSON.stringify(updated));
    setSession(updated);
    log(`Completed session written locally: ${wallet.slice(0, 8)}...`);
    log('Nothing was signed and nothing was verified');
  }, [session, log]);

  return (
    <StyxShell>
      {/* ── Hero ───────────────────────────────────────────────────────── */}
      <section className="styx-container styx-hero">
        <p className="styx-overline">
          Styx Protocol &middot; Demo &middot; QR sign-in
        </p>
        <h1 className="styx-h1">
          Sign in with <em className="styx-em styx-gleam-strong">Styx</em>.
        </h1>
        <div className="styx-hero-rule" aria-hidden="true" />
        <div className="styx-hero-body">
          <p className="styx-lede">
            This screen builds a <code>p01://auth</code> deep link, draws it as a
            QR code, and runs one sign-in session through the three states it can
            reach without a phone: pending, completed, expired.{' '}
            <strong>Everything you see happens in this browser tab.</strong>
          </p>
          <div className="styx-btn-row">
            <Link className="styx-btn-ghost" href="/docs">
              Read the docs
            </Link>
            <Link className="styx-btn-ghost" href="/">
              Back to the site
            </Link>
          </div>
        </div>

        <div className="styx-admission" style={{ marginTop: '2.5rem' }}>
          <p className="styx-admission-title">What this screen is</p>
          <p className="styx-admission-body">
            A mock. No signature is verified, nothing reaches a chain, and the
            session lives only in this tab&apos;s <code>sessionStorage</code>.
            Styx runs on Solana devnet, has not been audited, and has no mainnet
            deployment.
          </p>
        </div>
      </section>

      {/* ── 01 · Session ───────────────────────────────────────────────── */}
      <section className="styx-section styx-section-alt">
        <div className="styx-container styx-section-grid">
          <div className="styx-section-label">
            <span className="styx-numeral" aria-hidden="true">
              01
            </span>
            <p className="styx-index">Session</p>
            <h2 className="styx-h2">Configure the request.</h2>
          </div>

          <div style={TWO_UP}>
            {/* Left: what goes into the payload */}
            <div className="styx-panel">
              <div className="styx-panel-head">
                <p className="styx-overline">Service configuration</p>
              </div>
              <div className="styx-panel-body">
                <div className="styx-stack">
                  <div className="styx-field">
                    <label className="styx-label" htmlFor="demo-auth-service-name">
                      Service name
                    </label>
                    <input
                      id="demo-auth-service-name"
                      type="text"
                      value={serviceName}
                      onChange={(e) => setServiceName(e.target.value)}
                      className="styx-input"
                    />
                  </div>

                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      justifyContent: 'space-between',
                      gap: '1.5rem',
                    }}
                  >
                    <div>
                      <p style={{ margin: 0, fontSize: '0.9375rem' }}>
                        Verify subscription
                      </p>
                      <p className="styx-note" style={{ marginTop: '0.3rem' }}>
                        A real integration would require an active SPL token.
                        Here it only adds a placeholder mint to the payload.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setRequireSubscription(!requireSubscription)}
                      style={SWITCH_TRACK}
                      aria-pressed={requireSubscription}
                      aria-label={`${requireSubscription ? 'Disable' : 'Enable'} subscription requirement`}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          position: 'absolute',
                          top: '2px',
                          bottom: '2px',
                          width: '1.25rem',
                          left: requireSubscription
                            ? 'calc(100% - 1.25rem - 2px)'
                            : '2px',
                          background: requireSubscription
                            ? 'var(--styx-paper)'
                            : 'var(--styx-faint)',
                          transition: 'left 0.25s ease, background 0.25s ease',
                        }}
                      />
                    </button>
                  </div>

                  <div className="styx-btn-row">
                    <button
                      type="button"
                      className="styx-btn"
                      onClick={createSession}
                    >
                      Generate QR code
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Right: the code and the state it is in */}
            <div className="styx-panel styx-sweep">
              <div className="styx-panel-head">
                {session?.status === 'completed' ? (
                  <p className="styx-form-ok">
                    <span className="styx-check" aria-hidden="true">
                      &#10003;
                    </span>
                    Authenticated (simulated)
                  </p>
                ) : session?.status === 'expired' ? (
                  <p className="styx-form-error">Session expired</p>
                ) : (
                  <span className="styx-chip">
                    <span className="styx-dot" aria-hidden="true" />
                    Scan to connect
                  </span>
                )}
              </div>

              <div className="styx-panel-body">
                <div style={CENTER_ROW}>
                  {!session ? (
                    <div style={QR_FRAME}>
                      <p className="styx-note" style={{ margin: 0 }}>
                        Generate a code to begin.
                      </p>
                    </div>
                  ) : session.status === 'completed' ? (
                    <div style={QR_FRAME}>
                      <span
                        className="styx-check"
                        aria-hidden="true"
                        style={{ margin: 0, fontSize: '1.6rem' }}
                      >
                        &#10003;
                      </span>
                      <p className="styx-card-value" style={{ margin: 0 }}>
                        Authenticated
                      </p>
                      <p className="styx-mono" style={{ margin: 0 }}>
                        {session.wallet?.slice(0, 8)}...
                        {session.wallet?.slice(-8)}
                      </p>
                      <p className="styx-note" style={{ margin: 0 }}>
                        Simulated in this tab. Nothing was signed.
                      </p>
                    </div>
                  ) : session.status === 'expired' ? (
                    <div style={QR_FRAME}>
                      <p className="styx-form-error">
                        This session passed its five-minute window.
                      </p>
                      <button
                        type="button"
                        className="styx-btn-ghost"
                        onClick={createSession}
                      >
                        Generate a new code
                      </button>
                    </div>
                  ) : (
                    <div style={QR_PLATE}>
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
                  <div
                    style={{
                      marginTop: '1.5rem',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: '0.75rem',
                    }}
                  >
                    <p
                      className="styx-note"
                      style={{ textAlign: 'center', maxWidth: '36ch' }}
                    >
                      Nothing is being polled on a server. This tab reads its own{' '}
                      <code>sessionStorage</code> once a second, and gives up on
                      the session after five minutes.
                    </p>
                    <span className="styx-chip">
                      <span className="styx-dot" aria-hidden="true" />
                      Pending
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── 02 · Evidence ──────────────────────────────────────────────── */}
      <section className="styx-section">
        <div className="styx-container styx-section-grid">
          <div className="styx-section-label">
            <span className="styx-numeral" aria-hidden="true">
              02
            </span>
            <p className="styx-index">Evidence</p>
            <h2 className="styx-h2">What the page actually did.</h2>
          </div>

          <div className="styx-stack-lg">
            {deepLink && session?.status === 'pending' && (
              <div className="styx-code-panel">
                <div className="styx-code-head">
                  <span>Deep link</span>
                  <span>p01://auth</span>
                </div>
                <pre
                  className="styx-code"
                  style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
                >
                  <code>{deepLink}</code>
                </pre>
                <div style={{ padding: '0 1.5rem 1.5rem' }}>
                  <button
                    type="button"
                    className="styx-btn-ghost"
                    onClick={() => {
                      navigator.clipboard.writeText(deepLink);
                      log('Deep link copied');
                    }}
                  >
                    Copy
                  </button>
                </div>
              </div>
            )}

            {session && session.status === 'pending' && (
              <div className="styx-panel">
                <div className="styx-panel-head">
                  <p className="styx-overline">Local simulation</p>
                </div>
                <div className="styx-panel-body">
                  <div className="styx-stack">
                    <p className="styx-note">
                      This does not call{' '}
                      <code>/api/demo/auth/callback</code>. It writes a completed
                      session, with a fixed demo wallet address, into this
                      tab&apos;s <code>sessionStorage</code> and switches the
                      panel above in the same click. No signature is produced and
                      none is checked.
                    </p>
                    <div className="styx-btn-row">
                      <button
                        type="button"
                        className="styx-btn-ghost"
                        onClick={() =>
                          simulateCallback('7nxQB4Hy9LmPdTJ3kYfPq8WvNs2jKmRt4xFc6dZe8fKm')
                        }
                      >
                        Fake a completed session
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div className="styx-panel">
              <div className="styx-panel-head">
                <p className="styx-overline">Event log</p>
              </div>
              <div className="styx-panel-body">
                <div style={CONSOLE_BOX}>
                  {logs.length === 0 ? (
                    <p className="styx-note">Waiting for a session.</p>
                  ) : (
                    logs.map((logEntry, i) => (
                      <p key={i} className="styx-mono" style={{ margin: 0 }}>
                        {logEntry}
                      </p>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── 03 · How it works ──────────────────────────────────────────── */}
      <section className="styx-section styx-section-alt">
        <div className="styx-container styx-section-grid">
          <div className="styx-section-label">
            <span className="styx-numeral" aria-hidden="true">
              03
            </span>
            <p className="styx-index">How it works</p>
            <h2 className="styx-h2">Four moves, all of them elsewhere.</h2>
          </div>

          <div>
            <div className="styx-prose">
              <p>
                What belongs to this page happens before move one: minting a
                payload and drawing it. The four below are described as what the
                mobile app and a real service would do, because none of it can be
                observed from a browser tab.
              </p>
            </div>

            <ul className="styx-steps">
              <Reveal as="li" className="styx-step styx-reveal">
                <span className="styx-step-index">01</span>
                <div>
                  <h3 className="styx-h3">Read</h3>
                  <p className="styx-step-body">
                    The mobile app decodes the payload and compares two fields
                    against its own constants: the protocol id and the version.
                    It also reads the expiry and refuses a session that has
                    already lapsed. Nothing else is validated at scan time: the
                    session id, the challenge and the callback URL are taken as
                    they arrive.
                  </p>
                </div>
              </Reveal>
              <Reveal as="li" className="styx-step styx-reveal" delay={80}>
                <span className="styx-step-index">02</span>
                <div>
                  <h3 className="styx-h3">Check the entitlement</h3>
                  <p className="styx-step-body">
                    A real integration would name a subscription mint and ask the
                    chain whether the wallet is current. The toggle above names a
                    placeholder mint instead, and no RPC call leaves this page.
                  </p>
                </div>
              </Reveal>
              <Reveal as="li" className="styx-step styx-reveal" delay={160}>
                <span className="styx-step-index">03</span>
                <div>
                  <h3 className="styx-h3">Confirm</h3>
                  <p className="styx-step-body">
                    Confirmation happens inside the app, behind the device&apos;s
                    own biometric prompt, with the passcode left as a fallback,
                    and only then does the app sign the challenge with the wallet
                    key. Signatures on Solana are Ed25519 and stay classical.
                  </p>
                </div>
              </Reveal>
              <Reveal as="li" className="styx-step styx-reveal" delay={240}>
                <span className="styx-step-index">04</span>
                <div>
                  <h3 className="styx-h3">Hand back</h3>
                  <p className="styx-step-body">
                    A service would receive the signed challenge at its callback
                    URL and verify it before opening a session. The app matches
                    that URL&apos;s host against its own allow-list only here, at
                    the last step, after the challenge has already been signed.
                    The demo route in this repository checks that the fields are
                    present and the timestamp recent, never the signature, and
                    keeps its result in an in-memory map that is lost on the next
                    cold start, which is the second reason this screen polls
                    itself instead.
                  </p>
                </div>
              </Reveal>
            </ul>
          </div>
        </div>
      </section>

      {/* ── 04 · SDK ───────────────────────────────────────────────────── */}
      <section className="styx-section">
        <div className="styx-container styx-section-grid">
          <div className="styx-section-label">
            <span className="styx-numeral" aria-hidden="true">
              04
            </span>
            <p className="styx-index">SDK</p>
            <h2 className="styx-h2">The same flow from a merchant&apos;s side.</h2>
          </div>

          <div>
            <div className="styx-gleam-rule" aria-hidden="true" />

            <div className="styx-prose" style={{ marginTop: '2rem' }}>
              <p>
                The screen above is hand-rolled so its state machine is visible.
                A service would not write any of it: the client exposes the same
                three moves, and the QR is a string it hands you.
              </p>
            </div>

            <Reveal className="styx-code-panel styx-reveal">
              <div className="styx-code-head">
                <span>@protocol-01/auth-sdk &middot; MIT</span>
                <span>devnet</span>
              </div>
              <pre className="styx-code">
                <code>
                  {"import { "}
                  <span className="styx-code-name">P01AuthClient</span>
                  {" } from '@protocol-01/auth-sdk';\n\nconst auth = new "}
                  <span className="styx-code-name">P01AuthClient</span>
                  {"({\n  serviceId: 'my-service',\n  serviceName: 'My Service',\n  callbackUrl: 'https://myservice.com/auth/callback',\n  subscriptionMint: 'TOKEN_MINT_ADDRESS', "}
                  <span className="styx-code-comment">{'// optional'}</span>
                  {'\n});\n\n'}
                  <span className="styx-code-comment">
                    {'// Create a session'}
                  </span>
                  {'\nconst { qrCodeSvg, sessionId } = await auth.'}
                  <span className="styx-code-name">createSession</span>
                  {'();\n\n'}
                  <span className="styx-code-comment">
                    {'// Display the QR code'}
                  </span>
                  {"\ndocument.getElementById('qr').innerHTML = qrCodeSvg;\n\n"}
                  <span className="styx-code-comment">
                    {'// Wait for completion'}
                  </span>
                  {'\nconst result = await auth.'}
                  <span className="styx-code-name">waitForCompletion</span>
                  {"(sessionId);\nif (result.success) {\n  console.log('Authenticated:', result.wallet);\n}"}
                </code>
              </pre>
            </Reveal>

            <p className="styx-note" style={{ marginTop: '1rem' }}>
              Checkable: <code>P01AuthClient</code>, <code>createSession()</code>{' '}
              and <code>waitForCompletion()</code> all exist in{' '}
              <code>packages/auth-sdk/src/client.ts</code> in this repository.
              The sample mirrors that file. Whether the package is published to
              npm under that name is not something this page claims.
            </p>
          </div>
        </div>
      </section>
    </StyxShell>
  );
}

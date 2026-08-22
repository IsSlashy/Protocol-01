/**
 * ConnectPhone — the reverse of LinkPhone: the phone holds the wallet and
 * hands it to this extension over a one-time encrypted channel.
 *
 * 🎯 UI PASS. This screen carried the extension's old house style at full
 * strength: `CONNECT WITH PHONE`, `SCAN FROM YOUR PHONE`, `WALLET RECEIVED`,
 * `START OVER`, `CONNECT WALLET` — five mono-capitals headlines on one flow —
 * plus a whole paragraph of security copy set in uppercase mono, which is the
 * least readable way to present the one sentence that explains why this is
 * safe. It reads in sentence case now, in Newsreader, once.
 *
 * ⚠️ THE TWO PASSWORD INPUTS HAD NO VISIBLE LABELS, only placeholders and an
 * `aria-label`. A placeholder disappears the moment you type, which on a
 * confirm-password pair is exactly when you need to know which box you are in.
 *
 * ⛔ Business logic is untouched: the channel, the poll, the TTL and
 * `importWallet` are the same calls with the same arguments.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { Loader2, Eye, EyeOff, RefreshCw } from 'lucide-react';
import { useWalletStore } from '@/shared/store/wallet';
import { generatePairingCode, formatCodeForDisplay, decryptPairing, DEFAULT_TTL_SEC } from '@/shared/services/pairCrypto';
import { makeConnectToken } from '@/shared/services/connectPair';
import { Button, Eyebrow, Field, Panel, Screen } from '@/popup/ui';

// Where the phone uploads its (encrypted) seed and where this extension polls it
// back. Any host serving /api/pair/:id works — both the durable apps/web
// (Vercel + Upstash) and the relayer's in-memory channel expose the same path.
// Default = the live relayer (works out of the box, single-process in-memory);
// set VITE_PAIR_API_BASE to your apps/web origin for the durable production path.
const API_BASE = ((import.meta.env.VITE_PAIR_API_BASE as string | undefined) || 'https://p01-relayer-node-production.up.railway.app').replace(/\/$/, '');

const POLL_MS = 2500;

type Step = 'waiting' | 'password';

export default function ConnectPhone() {
  const navigate = useNavigate();
  const { importWallet, isLoading } = useWalletStore();

  // Generated ONCE per mount: a public channel id + a secret 80-bit code.
  const channelRef = useRef(generatePairingCode());
  const codeRef = useRef(generatePairingCode());
  const tokenRef = useRef(makeConnectToken(API_BASE, channelRef.current));

  const [step, setStep] = useState<Step>('waiting');
  const [secondsLeft, setSecondsLeft] = useState(DEFAULT_TTL_SEC);
  const [error, setError] = useState('');
  const [mnemonic, setMnemonic] = useState('');

  // password step
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const stoppedRef = useRef(false);

  const regenerate = useCallback(() => {
    channelRef.current = generatePairingCode();
    codeRef.current = generatePairingCode();
    tokenRef.current = makeConnectToken(API_BASE, channelRef.current);
    stoppedRef.current = false;
    setError('');
    setSecondsLeft(DEFAULT_TTL_SEC);
    setStep('waiting');
  }, []);

  // Countdown — expire the channel client-side too.
  useEffect(() => {
    if (step !== 'waiting') return;
    setSecondsLeft(DEFAULT_TTL_SEC);
    const iv = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          stoppedRef.current = true;
          setError('This pairing code expired. Start over to generate a fresh one.');
          clearInterval(iv);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(iv);
  }, [step, tokenRef.current]);

  // Poll the relay for the phone's encrypted blob.
  useEffect(() => {
    if (step !== 'waiting') return;
    stoppedRef.current = false;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      if (stoppedRef.current) return;
      try {
        const res = await fetch(`${API_BASE}/api/pair/${channelRef.current}`, { cache: 'no-store' });
        if (res.ok) {
          const { blob } = (await res.json()) as { blob: string | null };
          if (blob) {
            try {
              const mn = await decryptPairing(blob, codeRef.current);
              stoppedRef.current = true;
              setMnemonic(mn);
              setError('');
              setStep('password');
              return;
            } catch {
              // Wrong code typed on the phone, or a tampered blob — the same blob
              // will keep failing, so stop and let the user start over.
              stoppedRef.current = true;
              setError('The code entered on your phone didn’t match. Start over and re-enter the code shown here.');
              return;
            }
          }
        }
      } catch {
        // network blip — keep polling
      }
      timer = setTimeout(poll, POLL_MS);
    };

    timer = setTimeout(poll, POLL_MS);
    return () => clearTimeout(timer);
  }, [step, tokenRef.current]);

  const handleImport = async () => {
    setError('');
    if (password.length < 8) { setError('Password must be at least 8 characters'); return; }
    if (password !== confirmPassword) { setError('Passwords do not match'); return; }
    try {
      await importWallet(mnemonic.trim().split(/\s+/), password);
      navigate('/');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  /**
   * ⚠️ Presentation only. `handleImport` owns these strings; this decides which
   * field each one sits under. An error from `importWallet` belongs to neither
   * box and falls through to the form-level line above the action.
   */
  const stalled = Boolean(error) || secondsLeft === 0;
  const passwordFieldError = error === 'Password must be at least 8 characters' ? error : undefined;
  const confirmFieldError = error === 'Passwords do not match' ? error : undefined;
  const importError = error && !passwordFieldError && !confirmFieldError ? error : '';

  return (
    <Screen
      title={step === 'waiting' ? 'Connect with phone' : 'Set a password'}
      onBack={() => (step === 'password' ? regenerate() : navigate('/welcome'))}
      footer={
        step === 'password' ? (
          <Button
            full
            size="lg"
            loading={isLoading}
            disabled={!password || !confirmPassword}
            onClick={handleImport}
          >
            Connect wallet
          </Button>
        ) : stalled ? (
          <Button variant="secondary" full size="lg" icon={RefreshCw} onClick={regenerate}>
            Start over
          </Button>
        ) : undefined
      }
    >
      {step === 'waiting' && (
        <div className="flex animate-fadeIn flex-col items-center gap-4">
          <p className="text-sm text-p01-text-muted">
            In the P01 app, open <span className="text-p01-text">Settings, Connect to extension</span>,
            scan this, then type the code below.
          </p>

          <div className="rounded-xl bg-p01-text p-3">
            <QRCodeSVG
              value={tokenRef.current}
              size={200}
              level="M"
              includeMargin={false}
              bgColor="#eae7df"
              fgColor="#070709"
            />
          </div>

          <div className="w-full text-center">
            <Eyebrow>Pairing code, type it on the phone</Eyebrow>
            <p className="mt-1 select-all font-mono text-xl tracking-[0.2em] text-p01-cyan">
              {formatCodeForDisplay(codeRef.current)}
            </p>
          </div>

          {error ? (
            <p role="alert" className="text-center text-tiny text-p01-red">
              {error}
            </p>
          ) : (
            <p className="flex items-center gap-2 text-tiny tabular text-p01-text-dim">
              {secondsLeft > 0 && (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              )}
              {secondsLeft > 0 ? `Waiting for your phone, expires in ${secondsLeft}s` : 'Expired'}
            </p>
          )}

          <Panel tone="quiet" className="w-full">
            <p className="text-tiny text-p01-text-muted">
              Your seed is encrypted on the phone, to this one-time code, before it leaves the
              device. The relay only ever sees ciphertext.
            </p>
          </Panel>
        </div>
      )}

      {step === 'password' && (
        <div className="flex animate-fadeIn flex-col gap-4">
          <p className="text-sm text-p01-text-muted">
            The wallet arrived. Choose a password to unlock it on this device.
          </p>

          <Field
            label="Password"
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 8 characters"
            error={passwordFieldError}
            autoFocus
            suffix={
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="flex h-11 w-11 items-center justify-center rounded-lg text-p01-text-dim outline-none transition-colors duration-exit hover:text-p01-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-p01-cyan"
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Eye className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            }
          />

          <Field
            label="Confirm password"
            type={showPassword ? 'text' : 'password'}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Type it again"
            error={confirmFieldError}
          />

          {importError && (
            <p role="alert" className="text-tiny text-p01-red">
              {importError}
            </p>
          )}
        </div>
      )}
    </Screen>
  );
}

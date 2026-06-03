import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { QRCodeSVG } from 'qrcode.react';
import { ArrowLeft, AlertCircle, Loader2, Smartphone, Shield, Eye, EyeOff, RefreshCw } from 'lucide-react';
import { useWalletStore } from '@/shared/store/wallet';
import { generatePairingCode, formatCodeForDisplay, decryptPairing, DEFAULT_TTL_SEC } from '@/shared/services/pairCrypto';
import { makeConnectToken } from '@/shared/services/connectPair';
import { cn } from '@/shared/utils';

// Where the phone uploads its (encrypted) seed and where this extension polls it
// back. MUST be the deployed apps/web origin that hosts /api/pair/:id. Set
// VITE_PAIR_API_BASE to your web deployment URL.
const API_BASE = ((import.meta.env.VITE_PAIR_API_BASE as string | undefined) || 'https://protocol01.app').replace(/\/$/, '');

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

  return (
    <div className="flex flex-col h-full bg-p01-void">
      {/* Header */}
      <div className="flex items-center gap-3 p-3 border-b border-p01-border bg-p01-surface">
        <button
          onClick={() => (step === 'password' ? regenerate() : navigate('/welcome'))}
          className="p-2 -ml-2 hover:bg-p01-border transition-colors"
          aria-label="Go back"
        >
          <ArrowLeft className="w-4 h-4 text-p01-chrome" />
        </button>
        <h1 className="text-sm font-mono font-bold text-white tracking-wider">
          {step === 'waiting' ? 'CONNECT WITH PHONE' : 'SET PASSWORD'}
        </h1>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {step === 'waiting' && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
            <div className="text-center mb-2">
              <div className="w-14 h-14 mx-auto mb-3 bg-p01-cyan/10 border border-p01-cyan/30 flex items-center justify-center">
                <Smartphone className="w-7 h-7 text-p01-cyan" />
              </div>
              <h2 className="text-base font-display font-bold text-white tracking-wider">SCAN FROM YOUR PHONE</h2>
              <p className="text-[11px] text-p01-chrome/60 mt-2 font-mono">
                In the P01 app: <span className="text-p01-cyan">Settings → Connect to extension</span>, scan this, then type the code below.
              </p>
            </div>

            {/* QR */}
            <div className="flex justify-center">
              <div className="p-3 bg-white">
                <QRCodeSVG value={tokenRef.current} size={208} level="M" includeMargin={false} bgColor="#ffffff" fgColor="#0a0a0f" />
              </div>
            </div>

            {/* Code */}
            <div className="bg-p01-surface border border-p01-border p-3 text-center">
              <p className="text-[10px] text-p01-chrome/60 font-mono tracking-wider mb-1">PAIRING CODE (TYPE ON PHONE)</p>
              <p className="text-lg font-mono font-bold text-p01-cyan tracking-[2px]">{formatCodeForDisplay(codeRef.current)}</p>
            </div>

            <div className="flex items-center justify-center gap-2 text-p01-chrome/60">
              {secondsLeft > 0 && !error && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              <span className="text-[11px] font-mono">
                {error ? ' ' : secondsLeft > 0 ? `Waiting for phone… expires in ${secondsLeft}s` : 'Expired'}
              </span>
            </div>

            {error && (
              <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/30 text-red-400" role="alert">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span className="text-xs font-mono">{error}</span>
              </div>
            )}

            {(error || secondsLeft === 0) && (
              <button
                onClick={regenerate}
                className="w-full py-3 bg-p01-surface text-p01-chrome font-display font-medium text-sm tracking-wider border border-p01-border flex items-center justify-center gap-2 hover:text-white hover:border-p01-cyan/30 transition-colors"
              >
                <RefreshCw className="w-4 h-4" /> START OVER
              </button>
            )}

            <div className="bg-p01-surface border border-p01-border p-3">
              <p className="text-[10px] text-p01-chrome/60 font-mono tracking-wider leading-relaxed">
                YOUR SEED IS ENCRYPTED ON YOUR PHONE TO THIS ONE-TIME CODE BEFORE IT LEAVES THE DEVICE. THE RELAY ONLY EVER SEES CIPHERTEXT.
              </p>
            </div>
          </motion.div>
        )}

        {step === 'password' && (
          <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} className="space-y-4">
            <div className="text-center mb-4">
              <div className="w-14 h-14 mx-auto mb-4 bg-p01-cyan/10 border border-p01-cyan/30 flex items-center justify-center">
                <Shield className="w-7 h-7 text-p01-cyan" />
              </div>
              <h2 className="text-base font-display font-bold text-white tracking-wider">WALLET RECEIVED</h2>
              <p className="text-[11px] text-p01-chrome/60 mt-2 font-mono">
                Set a password to unlock this wallet on this device.
              </p>
            </div>

            <div className="space-y-3">
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  placeholder="Enter password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-label="Password"
                  className="w-full px-4 py-3 bg-p01-surface border border-p01-border text-white font-mono text-sm focus:outline-none focus:border-p01-cyan transition-colors"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-p01-chrome/60 hover:text-white"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <input
                type={showPassword ? 'text' : 'password'}
                placeholder="Confirm password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                aria-label="Confirm password"
                className="w-full px-4 py-3 bg-p01-surface border border-p01-border text-white font-mono text-sm focus:outline-none focus:border-p01-cyan transition-colors"
              />
            </div>

            {error && (
              <div className="p-3 bg-red-500/10 border border-red-500/30 text-red-400 text-xs font-mono" role="alert">
                {error}
              </div>
            )}

            <button
              onClick={handleImport}
              disabled={isLoading || !password || !confirmPassword}
              className={cn(
                'w-full py-4 font-display font-bold text-sm tracking-wider transition-colors flex items-center justify-center gap-2',
                isLoading || !password || !confirmPassword
                  ? 'bg-p01-border text-p01-chrome/40 cursor-not-allowed'
                  : 'bg-p01-cyan text-p01-void hover:bg-p01-cyan-dim',
              )}
            >
              {isLoading ? (<><Loader2 className="w-4 h-4 animate-spin" /> CONNECTING…</>) : 'CONNECT WALLET'}
            </button>
          </motion.div>
        )}
      </div>
    </div>
  );
}

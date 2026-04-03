import { useState, useRef, useEffect } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Download, Mail, ChevronDown, ChevronUp, ArrowLeft, Loader2, AlertCircle, Smartphone, QrCode } from 'lucide-react';
import GlitchLogo from '../components/GlitchLogo';
import { useLoginWithEmail, usePrivy } from '../../shared/providers/PrivyProvider';
import { cn } from '@/shared/utils';
import { useWalletStore } from '@/shared/store/wallet';

// Check if Privy is available (has valid app ID)
const PRIVY_ENABLED = Boolean(import.meta.env.VITE_PRIVY_APP_ID);

type LoginStep = 'welcome' | 'email' | 'otp' | 'qr';

// QR code URL generator
function qrCodeUrl(data: string, size: number = 180): string {
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(data)}&bgcolor=0a0a0c&color=39c5bb&format=png&margin=8`;
}

export default function Welcome() {
  const navigate = useNavigate();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [step, setStep] = useState<LoginStep>('welcome');
  const [email, setEmail] = useState('');
  const [otpCode, setOtpCode] = useState(['', '', '', '', '', '']);
  const [error, setError] = useState('');
  const otpRefs = useRef<(HTMLInputElement | null)[]>([]);

  const { authenticated, login } = usePrivy();
  const { sendCode, loginWithCode, state: emailState } = useLoginWithEmail();

  // QR connection state
  const [qrSessionId, setQrSessionId] = useState('');
  const [qrDeepLink, setQrDeepLink] = useState('');
  const [qrPolling, setQrPolling] = useState(false);
  const [qrConnected, setQrConnected] = useState(false);

  // Generate QR session
  const generateQrSession = () => {
    const sid = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    const challenge = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map(b => b.toString(16).padStart(2, '0')).join('');

    const payload = {
      v: 1,
      protocol: 'p01-auth',
      service: 'p01-extension',
      session: sid,
      challenge,
      callback: 'https://mugen-exchange.vercel.app/api/auth/callback',
      exp: Date.now() + 5 * 60 * 1000,
      name: 'P01 Extension',
    };

    const encoded = btoa(JSON.stringify(payload));
    setQrSessionId(sid);
    setQrDeepLink(`p01://auth?payload=${encoded}`);

    // Register session on Mugen API
    fetch('https://mugen-exchange.vercel.app/api/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, challenge, expiresAt: payload.exp }),
    }).catch(() => {});

    setStep('qr');
    setQrPolling(true);
  };

  // Poll for QR auth completion
  useEffect(() => {
    if (!qrPolling || !qrSessionId) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`https://mugen-exchange.vercel.app/api/auth/session?id=${qrSessionId}`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.status === 'completed' && data.walletAddress) {
          setQrPolling(false);
          setQrConnected(true);

          // Initialize wallet with the received address
          const { initializeWithPrivy } = useWalletStore.getState();
          initializeWithPrivy(data.walletAddress);

          // Wait for Zustand persist to flush to chrome.storage, then notify background
          setTimeout(() => {
            chrome.runtime.sendMessage({ type: 'WALLET_SETUP_COMPLETE' }).catch(() => {});
          }, 500);

          setTimeout(() => navigate('/', { replace: true }), 1500);
        }
      } catch {}
    }, 2000);
    return () => clearInterval(interval);
  }, [qrPolling, qrSessionId, navigate]);

  const isSending = emailState.status === 'sending-code';
  const isVerifying = emailState.status === 'submitting-code';

  // Handle email submission — send OTP
  const handleSendCode = async () => {
    if (!email || !email.includes('@')) {
      setError('Enter a valid email address');
      return;
    }
    setError('');
    try {
      await sendCode({ email });
      setStep('otp');
      // Focus first OTP input
      setTimeout(() => otpRefs.current[0]?.focus(), 100);
    } catch (e: any) {
      setError(e?.message || 'Failed to send code');
    }
  };

  // Handle OTP input
  const handleOtpChange = (index: number, value: string) => {
    if (value.length > 1) {
      // Handle paste
      const digits = value.replace(/\D/g, '').slice(0, 6).split('');
      const newOtp = [...otpCode];
      digits.forEach((d, i) => {
        if (index + i < 6) newOtp[index + i] = d;
      });
      setOtpCode(newOtp);
      const nextIdx = Math.min(index + digits.length, 5);
      otpRefs.current[nextIdx]?.focus();
      // Auto-submit if all filled
      if (newOtp.every(d => d !== '')) {
        handleVerifyCode(newOtp.join(''));
      }
      return;
    }

    const digit = value.replace(/\D/g, '');
    const newOtp = [...otpCode];
    newOtp[index] = digit;
    setOtpCode(newOtp);

    if (digit && index < 5) {
      otpRefs.current[index + 1]?.focus();
    }

    // Auto-submit when all 6 digits entered
    if (digit && newOtp.every(d => d !== '')) {
      handleVerifyCode(newOtp.join(''));
    }
  };

  const handleOtpKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !otpCode[index] && index > 0) {
      otpRefs.current[index - 1]?.focus();
    }
    if (e.key === 'Enter') {
      const code = otpCode.join('');
      if (code.length === 6) handleVerifyCode(code);
    }
  };

  // Handle OTP verification
  const handleVerifyCode = async (code: string) => {
    setError('');
    try {
      await loginWithCode({ code });
      // PrivyBridge handles the rest (wallet init, navigation via App.tsx)
    } catch (e: any) {
      setError(e?.message || 'Invalid code. Try again.');
      setOtpCode(['', '', '', '', '', '']);
      otpRefs.current[0]?.focus();
    }
  };

  // If already authenticated, redirect to home
  if (authenticated) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="flex flex-col h-full bg-p01-void">
      <AnimatePresence mode="wait">
        {/* ── STEP: EMAIL INPUT ── */}
        {step === 'email' && PRIVY_ENABLED && (
          <motion.div
            key="email"
            initial={{ opacity: 0, x: 30 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -30 }}
            className="flex flex-col h-full"
          >
            {/* Back button */}
            <div className="px-4 pt-4">
              <button
                onClick={() => { setStep('welcome'); setError(''); setEmail(''); }}
                className="p-2 -ml-2 text-p01-chrome hover:text-white transition-colors"
                aria-label="Go back"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 flex flex-col items-center justify-center px-6">
              <GlitchLogo size={60} showText={false} animated={false} />
              <h2 className="mt-4 text-white font-display font-bold text-base tracking-wider">
                ENTER YOUR EMAIL
              </h2>
              <p className="mt-1 text-[10px] text-[#555560] font-mono tracking-wider">
                WE'LL SEND A VERIFICATION CODE
              </p>

              <div className="w-full mt-8 space-y-4">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); setError(''); }}
                  onKeyDown={(e) => e.key === 'Enter' && handleSendCode()}
                  placeholder="your@email.com"
                  autoFocus
                  aria-label="Email address"
                  className="w-full px-4 py-3 bg-p01-surface border border-p01-border text-white font-mono text-sm placeholder:text-p01-chrome/30 focus:outline-none focus:border-p01-cyan transition-colors"
                />

                {error && (
                  <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/30 text-red-400" role="alert" aria-live="polite">
                    <AlertCircle className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
                    <span className="text-xs font-mono">{error}</span>
                  </div>
                )}

                <button
                  onClick={handleSendCode}
                  disabled={isSending || !email}
                  className={cn(
                    'w-full py-3 font-display font-bold text-sm tracking-wider transition-colors flex items-center justify-center gap-2',
                    isSending || !email
                      ? 'bg-p01-border text-p01-chrome/40 cursor-not-allowed'
                      : 'bg-p01-cyan text-p01-void hover:bg-p01-cyan-dim'
                  )}
                >
                  {isSending ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      SENDING CODE...
                    </>
                  ) : (
                    'SEND CODE'
                  )}
                </button>
              </div>
            </div>
          </motion.div>
        )}

        {/* ── STEP: QR CODE CONNECTION ── */}
        {step === 'qr' && (
          <motion.div
            key="qr"
            initial={{ opacity: 0, x: 30 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -30 }}
            className="flex-1 flex flex-col items-center p-6"
          >
            <button
              onClick={() => { setStep('welcome'); setQrPolling(false); }}
              className="self-start p-2 text-p01-chrome hover:text-white transition-colors mb-4"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>

            <div className="text-center mb-4">
              <h2 className="text-white font-display font-bold text-base tracking-wider mb-1">
                SCAN WITH P01 APP
              </h2>
              <p className="text-[#555560] text-[10px] font-mono tracking-wider">
                Open your P01 mobile app → Scan QR
              </p>
            </div>

            {/* QR Code */}
            <div className="relative p-3 rounded-2xl border border-p01-cyan/20 bg-p01-surface mb-4">
              {qrConnected ? (
                <div className="w-[180px] h-[180px] flex flex-col items-center justify-center gap-2">
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    className="w-12 h-12 rounded-full bg-green-500/20 flex items-center justify-center"
                  >
                    <svg className="w-6 h-6 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </motion.div>
                  <p className="text-green-400 text-xs font-mono">Connected!</p>
                </div>
              ) : (
                <>
                  <img
                    src={qrCodeUrl(qrDeepLink)}
                    alt="Scan with P01 App"
                    width={180}
                    height={180}
                    className="rounded-xl"
                  />
                  {/* P01 icon overlay */}
                  <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 rounded-lg bg-p01-void border border-p01-cyan/30 flex items-center justify-center">
                    <img src="/01-miku.png" className="w-5 h-5 rounded" alt="" />
                  </div>
                </>
              )}
            </div>

            {!qrConnected && (
              <>
                {/* Status */}
                <div className="flex items-center gap-2 mb-4">
                  <div className="w-2 h-2 rounded-full bg-p01-cyan animate-pulse" />
                  <p className="text-p01-chrome text-[10px] font-mono tracking-wider">
                    WAITING FOR SCAN...
                  </p>
                </div>

                {/* Steps */}
                <div className="w-full space-y-2">
                  {['Open P01 app on your phone', 'Go to Wallet → Scan', 'Scan this QR code'].map((text, i) => (
                    <div key={i} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-p01-dark border border-p01-border">
                      <span className="w-5 h-5 rounded-full bg-p01-cyan/10 border border-p01-cyan/20 flex items-center justify-center text-[9px] text-p01-cyan font-mono font-bold">
                        {i + 1}
                      </span>
                      <span className="text-p01-chrome text-[11px]">{text}</span>
                    </div>
                  ))}
                </div>

                {/* Refresh */}
                <button
                  onClick={generateQrSession}
                  className="mt-4 text-[10px] text-p01-chrome/50 font-mono hover:text-p01-chrome transition-colors"
                >
                  QR expired? Click to refresh
                </button>
              </>
            )}
          </motion.div>
        )}

        {/* ── STEP: OTP VERIFICATION ── */}
        {step === 'otp' && PRIVY_ENABLED && (
          <motion.div
            key="otp"
            initial={{ opacity: 0, x: 30 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -30 }}
            className="flex flex-col h-full"
          >
            {/* Back button */}
            <div className="px-4 pt-4">
              <button
                onClick={() => { setStep('email'); setError(''); setOtpCode(['', '', '', '', '', '']); }}
                className="p-2 -ml-2 text-p01-chrome hover:text-white transition-colors"
                aria-label="Go back"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 flex flex-col items-center justify-center px-6">
              <GlitchLogo size={60} showText={false} animated={false} />
              <h2 className="mt-4 text-white font-display font-bold text-base tracking-wider">
                ENTER CODE
              </h2>
              <p className="mt-1 text-[10px] text-[#555560] font-mono tracking-wider text-center">
                SENT TO {email.toUpperCase()}
              </p>

              {/* OTP Input */}
              <div className="flex gap-2 mt-8">
                {otpCode.map((digit, i) => (
                  <input
                    key={i}
                    ref={(el) => { otpRefs.current[i] = el; }}
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    value={digit}
                    onChange={(e) => handleOtpChange(i, e.target.value)}
                    onKeyDown={(e) => handleOtpKeyDown(i, e)}
                    aria-label={`Digit ${i + 1} of 6`}
                    className={cn(
                      'w-10 h-12 text-center text-white font-mono text-lg bg-p01-surface border transition-colors focus:outline-none',
                      digit ? 'border-p01-cyan' : 'border-p01-border focus:border-p01-cyan'
                    )}
                  />
                ))}
              </div>

              {error && (
                <div className="flex items-center gap-2 p-3 mt-4 bg-red-500/10 border border-red-500/30 text-red-400 w-full" role="alert" aria-live="polite">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
                  <span className="text-xs font-mono">{error}</span>
                </div>
              )}

              {isVerifying && (
                <div className="flex items-center gap-2 mt-4 text-p01-cyan" aria-live="polite">
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                  <span className="text-xs font-mono tracking-wider">VERIFYING...</span>
                </div>
              )}

              <button
                onClick={() => {
                  setError('');
                  setOtpCode(['', '', '', '', '', '']);
                  sendCode({ email });
                }}
                className="mt-6 text-[10px] text-[#555560] hover:text-p01-cyan transition-colors font-mono tracking-wider"
              >
                RESEND CODE
              </button>
            </div>
          </motion.div>
        )}

        {/* ── STEP: WELCOME (MAIN) ── */}
        {step === 'welcome' && (
          <motion.div
            key="welcome"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex flex-col h-full"
          >
            {/* Logo Section */}
            <div className="flex-1 flex flex-col items-center justify-center">
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.5 }}
              >
                <GlitchLogo size={140} showText={true} animated={true} />
              </motion.div>

              {/* Tagline */}
              <motion.p
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3, duration: 0.4 }}
                className="mt-6 text-[11px] text-[#555560] tracking-[3px] uppercase font-mono"
              >
                Total Invisibility
              </motion.p>
            </div>

            {/* Actions */}
            <div className="p-6 space-y-3">
              {/* Quick Login with Privy (if enabled) */}
              {PRIVY_ENABLED && (
                <>
                  {/* Connect with Mobile — QR code scan */}
                  <motion.button
                    initial={{ y: 20, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ delay: 0.35 }}
                    onClick={generateQrSession}
                    className="w-full py-4 bg-p01-cyan text-p01-void font-display font-bold text-sm tracking-wider flex items-center justify-center gap-2 hover:bg-p01-cyan-dim transition-colors"
                  >
                    <Smartphone className="w-4 h-4" />
                    CONNECT WITH P01 MOBILE
                  </motion.button>

                  {/* Email OTP */}
                  <motion.button
                    initial={{ y: 20, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ delay: 0.4 }}
                    onClick={() => setStep('email')}
                    className="w-full py-3 bg-p01-surface text-p01-chrome font-display font-bold text-xs tracking-wider flex items-center justify-center gap-2 hover:bg-p01-elevated border border-p01-border transition-colors"
                  >
                    <Mail className="w-3.5 h-3.5" />
                    CONTINUE WITH EMAIL
                  </motion.button>

                  {/* Divider */}
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.5 }}
                    className="flex items-center gap-3 py-2"
                  >
                    <div className="flex-1 h-px bg-p01-border" />
                    <button
                      onClick={() => setShowAdvanced(!showAdvanced)}
                      className="text-[10px] text-[#555560] font-mono tracking-wider flex items-center gap-1 hover:text-p01-chrome transition-colors"
                    >
                      ADVANCED
                      {showAdvanced ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    </button>
                    <div className="flex-1 h-px bg-p01-border" />
                  </motion.div>
                </>
              )}

              {/* Legacy Options - Always visible if Privy disabled, expandable if enabled */}
              {(!PRIVY_ENABLED || showAdvanced) && (
                <>
                  {/* Create Wallet - Primary (or secondary if Privy enabled) */}
                  <motion.button
                    initial={{ y: 20, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ delay: PRIVY_ENABLED ? 0.55 : 0.4 }}
                    onClick={() => navigate('/create-wallet')}
                    className={`w-full py-4 font-display font-bold text-sm tracking-wider flex items-center justify-center gap-2 transition-colors ${
                      PRIVY_ENABLED
                        ? 'bg-p01-surface text-p01-chrome border border-p01-border hover:text-white hover:border-p01-cyan/30'
                        : 'bg-p01-cyan text-p01-void hover:bg-p01-cyan-dim'
                    }`}
                  >
                    <Plus className="w-4 h-4" />
                    CREATE NEW WALLET
                  </motion.button>

                  {/* Import Wallet */}
                  <motion.button
                    initial={{ y: 20, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ delay: PRIVY_ENABLED ? 0.6 : 0.5 }}
                    onClick={() => navigate('/import-wallet')}
                    className="w-full py-4 bg-p01-surface text-p01-chrome font-display font-medium text-sm tracking-wider border border-p01-border flex items-center justify-center gap-2 hover:text-white hover:border-p01-cyan/30 transition-colors"
                  >
                    <Download className="w-4 h-4" />
                    IMPORT SEED PHRASE
                  </motion.button>
                </>
              )}

              {/* Version */}
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.7 }}
                className="text-center text-[10px] text-[#555560] font-mono mt-4 tracking-wider"
              >
                PROTOCOL v0.1.0 • DEVNET
              </motion.p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * LinkPhone — show a password-protected QR that the P01 mobile app scans to
 * import THIS wallet (same seed) onto the phone.
 *
 * Security model (see shared/services/pairCrypto.ts):
 *   1. The user re-enters their wallet password to reveal the seed (existing
 *      backup-reveal path) — proves it is them, and decrypts the mnemonic.
 *   2. We generate a FRESH 80-bit pairing CODE (not the wallet password) and
 *      encrypt the mnemonic to it. The QR carries only the ciphertext + a 180s
 *      expiry; the CODE is shown separately for the user to type on the phone.
 *   3. A filmed QR is useless without the code, and useless after 180s.
 * The QR encodes the recovery phrase — treat it like the seed itself.
 */
import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { QRCodeSVG } from 'qrcode.react';
import { ArrowLeft, ShieldAlert, RefreshCw, Smartphone, Eye, EyeOff } from 'lucide-react';
import { useWalletStore } from '@/shared/store/wallet';
import { decrypt, verifyPassword } from '@/shared/services/crypto';
import {
  generatePairingCode,
  encryptPairing,
  formatCodeForDisplay,
  DEFAULT_TTL_SEC,
} from '@/shared/services/pairCrypto';

export default function LinkPhone() {
  const navigate = useNavigate();
  const { encryptedSeedPhrase, passwordHash } = useWalletStore();

  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState<string>('');
  const [expiresAt, setExpiresAt] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(0);

  // Countdown; when the QR expires, drop it so the user must regenerate.
  useEffect(() => {
    if (!qr) return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left <= 0) {
        setQr(null);
        setCode('');
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [qr, expiresAt]);

  const generate = useCallback(async () => {
    if (!encryptedSeedPhrase || !passwordHash) {
      setError('No wallet seed is available to link.');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const ok = await verifyPassword(password, passwordHash);
      if (!ok) {
        setError('Incorrect password.');
        setLoading(false);
        return;
      }
      // Reveal the mnemonic, re-encrypt it to a fresh pairing code, then drop it.
      let mnemonic: string | null = await decrypt(encryptedSeedPhrase, password);
      const pairCode = generatePairingCode();
      const qrStr = await encryptPairing(mnemonic, pairCode);
      mnemonic = null; // best-effort: release the reference (JS strings aren't scrubbable)

      setCode(pairCode);
      setQr(qrStr);
      setExpiresAt(Date.now() + DEFAULT_TTL_SEC * 1000);
      setPassword('');
    } catch (e: any) {
      setError(e?.message || 'Failed to build the pairing QR.');
    } finally {
      setLoading(false);
    }
  }, [encryptedSeedPhrase, passwordHash, password]);

  return (
    <div className="min-h-full bg-[#0a0a0f] text-white flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-white/10">
        <button onClick={() => navigate(-1)} aria-label="Back" className="p-1.5 rounded-lg hover:bg-white/5">
          <ArrowLeft size={20} />
        </button>
        <h1 className="font-display font-bold text-lg flex items-center gap-2">
          <Smartphone size={18} className="text-p01-cyan" /> Link a phone
        </h1>
      </div>

      <div className="flex-1 px-5 py-4 flex flex-col">
        {!qr ? (
          /* ---- Password gate ---- */
          <div className="flex flex-col gap-4">
            <p className="text-sm text-white/60 leading-relaxed">
              Show a one-time QR so the P01 app on your phone can import this wallet.
              Enter your wallet password to continue.
            </p>

            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => { setPassword(e.target.value); setError(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter' && password) generate(); }}
                placeholder="Wallet password"
                className="w-full bg-[#13131a] border border-white/10 rounded-xl px-4 py-3 pr-10 text-sm outline-none focus:border-p01-cyan/60"
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 hover:text-white/70"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>

            {error && <p className="text-sm text-red-400">{error}</p>}

            <button
              onClick={generate}
              disabled={!password || loading}
              className="w-full bg-p01-cyan text-black font-semibold rounded-xl py-3 text-sm disabled:opacity-40"
            >
              {loading ? 'Preparing…' : 'Show pairing QR'}
            </button>

            <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/20 rounded-xl p-3 mt-1">
              <ShieldAlert size={16} className="text-amber-400 mt-0.5 shrink-0" />
              <p className="text-xs text-amber-200/80 leading-relaxed">
                The QR encodes your recovery phrase. Don't screenshot it or scan it on a
                phone you don't trust — anyone with the photo <span className="font-semibold">and</span> the
                code below could import your wallet.
              </p>
            </div>
          </div>
        ) : (
          /* ---- QR + code ---- */
          <motion.div
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex flex-col items-center gap-4"
          >
            <div className="bg-white p-4 rounded-xl border-4 border-p01-cyan shadow-lg shadow-p01-cyan/20">
              <QRCodeSVG value={qr} size={232} level="M" includeMargin={false} bgColor="#ffffff" fgColor="#0a0a0f" />
            </div>

            <div className="w-full text-center">
              <p className="text-xs uppercase tracking-widest text-white/40 mb-1">Pairing code — type on phone</p>
              <p className="font-mono text-xl font-bold tracking-[0.2em] text-p01-cyan select-all">
                {formatCodeForDisplay(code)}
              </p>
            </div>

            <p className="text-sm text-white/50">
              Expires in <span className="font-semibold text-white/80">{secondsLeft}s</span>
            </p>

            <button
              onClick={generate}
              disabled={loading}
              className="flex items-center gap-2 text-sm text-white/70 hover:text-white border border-white/10 rounded-xl px-4 py-2.5 disabled:opacity-40"
            >
              <RefreshCw size={15} /> Generate a fresh QR
            </button>

            <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/20 rounded-xl p-3">
              <ShieldAlert size={16} className="text-amber-400 mt-0.5 shrink-0" />
              <p className="text-xs text-amber-200/80 leading-relaxed">
                On the phone: open the P01 app → <span className="font-semibold">Scan to connect</span>, scan this QR,
                then type the code above. Do not screenshot this screen.
              </p>
            </div>
          </motion.div>
        )}
      </div>
    </div>
  );
}

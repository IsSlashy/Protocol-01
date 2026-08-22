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
 *
 * 🎯 UI PASS. This screen was the last one still painting its own colours:
 * `bg-[#0a0a0f]`, `border-p01-border/10`, `text-p01-text/60`, `bg-[#13131a]`, plus
 * `amber-500` and `red-400` straight from Tailwind's default ramp. None of
 * those are in the token file, and `text-black` on the primary button was the
 * only pure black in the extension. It is now `Screen` / `Field` / `Button` /
 * `Panel`, and the cyan glow around the QR is gone — the site has no shadows.
 *
 * ⚠️ THE ACTION MOVED TO THE FOOTER. Both states have exactly one thing to do,
 * and in the QR state it used to sit between the countdown and a warning
 * paragraph, i.e. below the fold on a short window.
 */
import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { ShieldAlert, RefreshCw, Eye, EyeOff } from 'lucide-react';
import { useWalletStore } from '@/shared/store/wallet';
import { decrypt, verifyPassword } from '@/shared/services/crypto';
import {
  generatePairingCode,
  encryptPairing,
  formatCodeForDisplay,
  DEFAULT_TTL_SEC,
} from '@/shared/services/pairCrypto';
import { Button, Eyebrow, Field, Panel, Screen } from '@/popup/ui';

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
    <Screen
      title="Link a phone"
      onBack={() => navigate(-1)}
      footer={
        !qr ? (
          <Button
            full
            size="lg"
            loading={loading}
            disabled={!password}
            onClick={() => void generate()}
          >
            Show pairing QR
          </Button>
        ) : (
          <Button
            variant="secondary"
            full
            size="lg"
            icon={RefreshCw}
            loading={loading}
            onClick={() => void generate()}
          >
            Generate a fresh QR
          </Button>
        )
      }
    >
      {!qr ? (
        /* ── Password gate ── */
        <div className="flex flex-col gap-4">
          <p className="text-sm text-p01-text-muted">
            Show a one-time QR so the P01 app on your phone can import this wallet.
          </p>

          <Field
            label="Wallet password"
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && password) void generate();
            }}
            placeholder="Your password"
            error={error || undefined}
            autoFocus
            suffix={
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
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

          <Panel tone="warn">
            <div className="flex items-start gap-2">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-p01-amber" aria-hidden="true" />
              <p className="text-tiny text-p01-amber">
                The QR encodes your recovery phrase. Anyone holding a photo of it{' '}
                <em>and</em> the code shown with it can import your wallet, so do not screenshot it
                and do not scan it on a phone you do not trust.
              </p>
            </div>
          </Panel>
        </div>
      ) : (
        /* ── QR + code ── */
        <div className="flex animate-fadeIn flex-col items-center gap-4">
          <div className="rounded-xl bg-p01-text p-3">
            <QRCodeSVG
              value={qr}
              size={216}
              level="M"
              includeMargin={false}
              bgColor="#eae7df"
              fgColor="#070709"
            />
          </div>

          <div className="w-full text-center">
            <Eyebrow>Pairing code, type it on the phone</Eyebrow>
            <p className="mt-1 select-all font-mono text-xl tracking-[0.2em] text-p01-cyan">
              {formatCodeForDisplay(code)}
            </p>
            <p className="mt-1 text-tiny tabular text-p01-text-dim">Expires in {secondsLeft}s</p>
          </div>

          <Panel tone="warn" className="w-full">
            <div className="flex items-start gap-2">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-p01-amber" aria-hidden="true" />
              <p className="text-tiny text-p01-amber">
                On the phone: open the P01 app, choose Scan to connect, scan this, then type the
                code above. Do not screenshot this screen.
              </p>
            </div>
          </Panel>
        </div>
      )}
    </Screen>
  );
}

/**
 * PairDevice — link another device (extension ⇄ mobile), BIDIRECTIONAL.
 *
 * Moves the wallet's BIP39 mnemonic between this device and another over a 2-QR,
 * no-network handshake (docs/pairing-ledger-spec.md §1A / §3 Stage S2). This page
 * opens in a DEDICATED TAB (popup.html#/pair-device via chrome.tabs.create), so it
 * survives focus loss and gives the camera/QR room — a toolbar popup would die.
 *
 * POSTURE (Finding #10): the extension has NO QR DECODER dependency, so the
 * primary cross-device channel here is COPY-PASTE. This device shows its QR and
 * the user pastes the other device's QR back. On the paste path the 6-digit SAS is
 * FORCED (the user must TYPE the digits the other device shows) — a one-tap confirm
 * is NOT enough (Finding #1). The receiver confirms the imported PUBLIC KEY BEFORE
 * the seed is ever persisted (Finding #5).
 *
 * Two roles:
 *   RECEIVE (this device is empty / importing): shows QR#1, pastes the sender's
 *     QR#2, forces SAS, confirms the derived address, then imports.
 *   SEND (this device has the wallet): pastes the receiver's QR#1, shows QR#2 +
 *     the SAS to read aloud / type on the other device.
 *
 * The mnemonic is NEVER logged and NEVER copied to the clipboard by this page.
 */

import { useState, useMemo, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import {
  ArrowLeft,
  Smartphone,
  Download,
  Upload,
  Copy,
  Check,
  AlertTriangle,
  ShieldCheck,
  Loader2,
  KeyRound,
} from 'lucide-react';
import { cn, copyToClipboard, truncateAddress } from '@/shared/utils';
import { useWalletStore } from '@/shared/store/wallet';
import { deriveKeypairFromMnemonic } from '@/shared/services/wallet';
import {
  startAsReceiver,
  senderConsumeQr1,
  senderBuildQr2,
  receiverConsumeQr2,
  type ReceiverSession,
} from '@/shared/services/pairing';

type Mode = 'choose' | 'receive' | 'send';

export default function PairDevice() {
  const navigate = useNavigate();
  const { isInitialized, encryptedSeedPhrase, importWallet } = useWalletStore();
  const hasWallet = isInitialized && !!encryptedSeedPhrase;

  const [mode, setMode] = useState<Mode>('choose');

  return (
    <div className="flex min-h-screen w-full justify-center bg-p01-void">
      <div className="w-full max-w-[420px] flex flex-col">
        <header className="flex items-center gap-3 px-4 py-3 border-b border-p01-border">
          <button
            onClick={() => (mode === 'choose' ? navigate(-1) : setMode('choose'))}
            className="p-2 -ml-2 text-p01-chrome hover:text-white transition-colors"
            aria-label="Go back"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex-1">
            <h1 className="text-white font-display font-bold tracking-wide text-sm">LINK DEVICE</h1>
            <p className="text-p01-cyan text-[9px] font-mono tracking-wider">
              ENCRYPTED 2-QR PAIRING
            </p>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-4">
          {mode === 'choose' && <ChooseMode hasWallet={hasWallet} onPick={setMode} />}
          {mode === 'receive' && <ReceiveFlow importWallet={importWallet} hasWallet={hasWallet} />}
          {mode === 'send' && <SendFlow hasWallet={hasWallet} />}
        </div>
      </div>
    </div>
  );
}

// ─── mode chooser ────────────────────────────────────────────────────────────────
function ChooseMode({
  hasWallet,
  onPick,
}: {
  hasWallet: boolean;
  onPick: (m: Mode) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="p-3 rounded-xl bg-p01-gradient-card border border-p01-cyan/15">
        <div className="flex items-center gap-2 mb-1">
          <Smartphone className="w-4 h-4 text-p01-cyan" />
          <span className="text-white text-xs font-display font-bold tracking-wide">
            Pair with another device
          </span>
        </div>
        <p className="text-p01-chrome/60 text-[10px] leading-relaxed">
          Copy this wallet to (or from) your phone or another browser. The seed phrase travels
          encrypted end-to-end — never in plaintext, never over the network.
        </p>
      </div>

      <button
        onClick={() => onPick('send')}
        disabled={!hasWallet}
        className={cn(
          'w-full p-4 rounded-xl border text-left transition-colors flex items-center gap-3',
          hasWallet
            ? 'bg-p01-surface border-p01-border hover:border-p01-cyan/40'
            : 'bg-p01-surface/50 border-p01-border/50 opacity-50 cursor-not-allowed',
        )}
      >
        <div className="w-9 h-9 rounded-lg bg-p01-cyan/20 flex items-center justify-center shrink-0">
          <Upload className="w-5 h-5 text-p01-cyan" />
        </div>
        <div>
          <p className="text-white font-medium text-sm">Send this wallet</p>
          <p className="text-p01-chrome/60 text-[10px]">
            {hasWallet
              ? 'This device has the wallet → copy it to another device'
              : 'No seed-backed wallet on this device'}
          </p>
        </div>
      </button>

      <button
        onClick={() => onPick('receive')}
        className="w-full p-4 rounded-xl border border-p01-border bg-p01-surface hover:border-p01-cyan/40 transition-colors flex items-center gap-3 text-left"
      >
        <div className="w-9 h-9 rounded-lg bg-p01-pink/20 flex items-center justify-center shrink-0">
          <Download className="w-5 h-5 text-p01-pink" />
        </div>
        <div>
          <p className="text-white font-medium text-sm">Receive a wallet</p>
          <p className="text-p01-chrome/60 text-[10px]">
            This device imports a wallet from another device
          </p>
        </div>
      </button>

      {hasWallet && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-warning/10 border border-warning/20">
          <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
          <p className="text-warning/90 text-[10px] leading-relaxed">
            Receiving a wallet will REPLACE the wallet currently on this device. Back up your
            current seed phrase first if you still need it.
          </p>
        </div>
      )}
    </div>
  );
}

// ─── shared QR + paste blocks ─────────────────────────────────────────────────────
function QrBlock({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    await copyToClipboard(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="p-3 rounded-xl bg-p01-gradient-card border border-p01-cyan/15 space-y-2">
      <p className="text-p01-chrome text-[10px] font-mono tracking-wider">{label}</p>
      <div className="flex justify-center bg-white rounded-lg p-3">
        <QRCodeSVG value={value} size={200} level="L" includeMargin={false} />
      </div>
      <button
        onClick={onCopy}
        className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg bg-p01-surface text-p01-cyan text-[11px] font-medium hover:bg-p01-surface/80 transition-colors"
      >
        {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
        {copied ? 'Copied' : 'Copy code (paste on the other device)'}
      </button>
    </div>
  );
}

function PasteBlock({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <p className="text-p01-chrome text-[10px] font-mono mb-2">{label}</p>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={4}
        className="w-full bg-p01-surface border border-p01-border rounded-xl p-3 text-white text-[10px] font-mono outline-none focus:border-p01-cyan/40 placeholder:text-p01-chrome/30 resize-none break-all"
      />
    </div>
  );
}

// ─── RECEIVE flow (this device imports) ──────────────────────────────────────────
type RecvStep = 'show-qr1' | 'verify-sas' | 'confirm-pubkey' | 'done';

function ReceiveFlow({
  importWallet,
  hasWallet,
}: {
  importWallet: (seedPhrase: string[], password: string) => Promise<void>;
  hasWallet: boolean;
}) {
  const navigate = useNavigate();
  // The ephemeral receiver session lives for the lifetime of this flow only.
  const sessionRef = useRef<ReceiverSession>(startAsReceiver());
  const session = sessionRef.current;

  const [step, setStep] = useState<RecvStep>('show-qr1');
  const [pastedQr2, setPastedQr2] = useState('');
  const [typedSas, setTypedSas] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Imported-but-not-yet-persisted mnemonic + the address we derived from it.
  const [pendingMnemonic, setPendingMnemonic] = useState<string | null>(null);
  const [pendingAddress, setPendingAddress] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  // The SAS computed from the pasted QR#2 (what the receiver must match).
  const expectedSas = useMemo(() => {
    const t = pastedQr2.trim();
    if (!t) return null;
    try {
      return session.computeSasForQr2(t);
    } catch {
      return null;
    }
  }, [pastedQr2, session]);

  const sasMatches = !!expectedSas && typedSas.length === 6 && typedSas === expectedSas;

  // Step 2 → 3: SAS confirmed, decrypt + derive the address (NOT yet persisted).
  const handleSasConfirm = useCallback(async () => {
    setError(null);
    try {
      const { mnemonic } = receiverConsumeQr2(session, pastedQr2.trim());
      // Derive the public key to confirm BEFORE persisting anything (Finding #5).
      const kp = await deriveKeypairFromMnemonic(mnemonic);
      setPendingMnemonic(mnemonic);
      setPendingAddress(kp.publicKey.toBase58());
      setStep('confirm-pubkey');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [session, pastedQr2]);

  // Step 3 → done: user confirmed the address → persist via importWallet.
  const handleImport = useCallback(async () => {
    if (!pendingMnemonic) return;
    if (password.length < 8) {
      setError('Choose a password of at least 8 characters to protect this device.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await importWallet(pendingMnemonic.split(' '), password);
      setPendingMnemonic(null);
      setStep('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [pendingMnemonic, password, importWallet]);

  if (step === 'done') {
    return (
      <div className="flex flex-col items-center gap-4 pt-8">
        <ShieldCheck className="w-16 h-16 text-p01-cyan" />
        <p className="text-white font-display font-bold text-lg tracking-wide">Wallet Linked</p>
        <p className="text-p01-chrome text-xs text-center">
          This device now holds the same wallet. Both devices derive identical keys and notes.
        </p>
        <button
          onClick={() => navigate('/')}
          className="mt-4 px-6 py-2 rounded-xl bg-p01-cyan text-p01-void font-bold font-display text-sm tracking-wider"
        >
          Done
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Step 1: show QR#1 + paste QR#2 */}
      <QrBlock label="STEP 1 — SHOW THIS TO THE SENDER (QR #1)" value={session.qr1} />

      <PasteBlock
        label="STEP 2 — PASTE THE SENDER'S CODE (QR #2)"
        placeholder="Paste the p01pairenc1:… code shown on the other device..."
        value={pastedQr2}
        onChange={(v) => {
          setPastedQr2(v);
          setError(null);
        }}
      />

      {/* Forced SAS entry (paste path) */}
      {expectedSas && (
        <div className="p-3 rounded-xl bg-p01-surface border border-p01-border space-y-2">
          <div className="flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 text-p01-cyan" />
            <p className="text-white text-[11px] font-medium">Confirm the 6-digit code</p>
          </div>
          <p className="text-p01-chrome/60 text-[10px] leading-relaxed">
            Type the SECURITY CODE the other device is showing. This proves the code came from
            your device and not an attacker.
          </p>
          <input
            inputMode="numeric"
            pattern="\d*"
            maxLength={6}
            value={typedSas}
            onChange={(e) => setTypedSas(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="------"
            aria-label="Security code"
            className="w-full text-center tracking-[0.5em] text-2xl font-mono bg-p01-void border border-p01-border rounded-xl py-2 text-white outline-none focus:border-p01-cyan/40 placeholder:text-p01-chrome/30"
          />
          {typedSas.length === 6 && !sasMatches && (
            <p className="text-p01-red text-[10px] font-mono">
              Codes do not match. Do NOT continue — start over on both devices.
            </p>
          )}
        </div>
      )}

      {error && (
        <div className="p-3 rounded-lg bg-p01-red/10 border border-p01-red/30" role="alert">
          <p className="text-p01-red text-[10px] font-mono break-all">{error}</p>
        </div>
      )}

      {/* Step 3 modal: confirm pubkey before persist */}
      {step === 'confirm-pubkey' && pendingAddress ? (
        <div className="p-3 rounded-xl bg-p01-gradient-card border border-p01-cyan/30 space-y-3">
          <div className="flex items-center gap-1.5">
            <KeyRound className="w-4 h-4 text-p01-cyan" />
            <p className="text-white text-xs font-display font-bold tracking-wide">
              Confirm wallet address
            </p>
          </div>
          <p className="text-p01-chrome/60 text-[10px] leading-relaxed">
            Check this matches the wallet address on the sending device BEFORE saving.
          </p>
          <div className="bg-p01-void rounded-lg p-2 text-center">
            <p className="text-white text-xs font-mono">{truncateAddress(pendingAddress, 8)}</p>
            <p className="text-p01-chrome/40 text-[8px] font-mono break-all mt-1">{pendingAddress}</p>
          </div>
          {hasWallet && (
            <p className="text-warning text-[10px] leading-relaxed">
              Importing replaces the wallet currently on this device.
            </p>
          )}
          <div>
            <label className="text-p01-chrome/60 text-[10px] mb-1 block">
              Set a password for this device (min 8 chars)
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="New password"
              className="w-full px-3 py-2.5 bg-p01-void border border-p01-border rounded-xl text-white font-mono text-xs outline-none focus:border-p01-cyan/40"
            />
          </div>
          <button
            onClick={handleImport}
            disabled={busy || password.length < 8}
            className="w-full py-2.5 rounded-xl bg-p01-cyan text-p01-void font-bold font-display text-sm tracking-wider disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            {busy ? 'Importing...' : 'Confirm & Import'}
          </button>
        </div>
      ) : (
        <button
          onClick={handleSasConfirm}
          disabled={!sasMatches}
          className={cn(
            'w-full py-3 rounded-xl font-bold font-display text-sm tracking-wider transition-colors flex items-center justify-center gap-2',
            sasMatches
              ? 'bg-p01-cyan text-p01-void hover:bg-p01-cyan/90'
              : 'bg-p01-surface border border-p01-border text-p01-chrome/50 cursor-not-allowed',
          )}
        >
          <ShieldCheck className="w-4 h-4" />
          Codes match — continue
        </button>
      )}
    </div>
  );
}

// ─── SEND flow (this device exports) ─────────────────────────────────────────────
function SendFlow({ hasWallet }: { hasWallet: boolean }) {
  const [pastedQr1, setPastedQr1] = useState('');
  const [qr2, setQr2] = useState<string | null>(null);
  const [sas, setSas] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleBuild = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const parsed = senderConsumeQr1(pastedQr1.trim());
      const built = await senderBuildQr2(parsed);
      setQr2(built.qr2);
      setSas(built.sas);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [pastedQr1]);

  if (!hasWallet) {
    return (
      <div className="p-3 rounded-lg bg-p01-red/10 border border-p01-red/30">
        <p className="text-p01-red text-[11px]">
          No seed-backed wallet on this device to send.
        </p>
      </div>
    );
  }

  if (qr2 && sas) {
    return (
      <div className="space-y-4">
        <QrBlock label="STEP 2 — SHOW THIS TO THE RECEIVER (QR #2)" value={qr2} />
        <div className="p-3 rounded-xl bg-p01-surface border border-p01-cyan/30 space-y-1">
          <div className="flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 text-p01-cyan" />
            <p className="text-white text-[11px] font-medium">Security code</p>
          </div>
          <p className="text-center tracking-[0.5em] text-3xl font-mono text-p01-cyan py-1">
            {sas}
          </p>
          <p className="text-p01-chrome/60 text-[10px] text-center leading-relaxed">
            Read this aloud or type it on the OTHER device when it asks. Only continue there if the
            codes match.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="p-3 rounded-xl bg-p01-gradient-card border border-p01-cyan/15">
        <p className="text-p01-chrome/60 text-[10px] leading-relaxed">
          On the OTHER device, open Link Device → Receive. Paste its QR #1 code below.
        </p>
      </div>

      <PasteBlock
        label="STEP 1 — PASTE THE RECEIVER'S CODE (QR #1)"
        placeholder="Paste the p01pair1:… code shown on the other device..."
        value={pastedQr1}
        onChange={(v) => {
          setPastedQr1(v);
          setError(null);
        }}
      />

      {error && (
        <div className="p-3 rounded-lg bg-p01-red/10 border border-p01-red/30" role="alert">
          <p className="text-p01-red text-[10px] font-mono break-all">{error}</p>
        </div>
      )}

      <button
        onClick={handleBuild}
        disabled={busy || !pastedQr1.trim().startsWith('p01pair1:')}
        className={cn(
          'w-full py-3 rounded-xl font-bold font-display text-sm tracking-wider transition-colors flex items-center justify-center gap-2',
          !busy && pastedQr1.trim().startsWith('p01pair1:')
            ? 'bg-p01-cyan text-p01-void hover:bg-p01-cyan/90'
            : 'bg-p01-surface border border-p01-border text-p01-chrome/50 cursor-not-allowed',
        )}
      >
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
        {busy ? 'Building...' : 'Generate QR #2'}
      </button>
    </div>
  );
}

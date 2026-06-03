/**
 * ConnectLedger — onboard a Ledger hardware wallet (extension).
 *
 * Opened in a DEDICATED TAB (popup.html#/connect-ledger via chrome.tabs.create),
 * because `navigator.hid.requestDevice()` needs a tab: it dies in the toolbar
 * popup, cannot run in the service worker / offscreen, and is blocked in iframes
 * (docs/pairing-ledger-spec.md §1B / Finding #17). One long-lived transport is
 * held for the whole flow.
 *
 * FLOW:
 *   1. Gate on WebHID/WebUSB support.
 *   2. Connect the device (permission prompt) + read the address WITH on-device
 *      display so the user can verify it.
 *   3. Set a wallet password (encrypts the SEPARATE ZK spending seed at rest + is
 *      the unlock password) — only when onboarding a fresh device.
 *   4. Pre-flight blind signing (warn if disabled).
 *   5. Generate a CSPRNG 32-byte spending seed (§0 — fed RAW to the note
 *      pipelines, NEVER HKDF'd), encrypt it under the password, and record the
 *      wallet (walletKind='hardware').
 *   6. Strongly prompt the user to export the encrypted identity backup — the
 *      Ledger recovery phrase does NOT regenerate this random seed, so a storage
 *      wipe without a backup = total note loss.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Usb,
  ShieldCheck,
  AlertTriangle,
  Loader2,
  Check,
  Copy,
  Download,
  KeyRound,
} from 'lucide-react';
import { cn, copyToClipboard, truncateAddress } from '@/shared/utils';
import { useWalletStore } from '@/shared/store/wallet';
import {
  isLedgerSupported,
  openLedgerTransport,
  closeLedgerTransport,
  getActiveLedgerTransport,
  getLedgerAddress,
  getLedgerAppConfiguration,
  DEFAULT_LEDGER_PATH,
  generateSpendingSeed,
  storeSpendingSeed,
  hasSpendingSeed,
} from '@/shared/services/ledger';
import { exportHardwareBackup } from '@/shared/services/backup';

type Step =
  | 'check'
  | 'unsupported'
  | 'connect'
  | 'set-password'
  | 'confirm'
  | 'provisioning'
  | 'backup'
  | 'done';

export default function ConnectLedger() {
  const { connectLedger, walletKind, publicKey: existingPublicKey } = useWalletStore();

  const [step, setStep] = useState<Step>('check');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [devicePublicKey, setDevicePublicKey] = useState<string | null>(null);
  const [blindSignEnabled, setBlindSignEnabled] = useState<boolean | null>(null);

  const [password, setPassword] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');

  const [backupBlob, setBackupBlob] = useState<string | null>(null);
  const [backupCopied, setBackupCopied] = useState(false);

  // Already a hardware wallet on this profile → reconnect (no fresh password).
  const isReconnect = walletKind === 'hardware' && !!existingPublicKey;

  // Gate on transport support up front.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ok = await isLedgerSupported();
      if (cancelled) return;
      setStep(ok ? 'connect' : 'unsupported');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Close the transport when the tab is torn down.
  useEffect(() => {
    return () => {
      void closeLedgerTransport();
    };
  }, []);

  const handleConnect = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      // Opens (and caches) the long-lived transport on this tab. Must be inside a
      // user gesture so the WebHID permission prompt is allowed.
      await openLedgerTransport();
      const transport = getActiveLedgerTransport();
      if (!transport) throw new Error('Failed to open Ledger transport.');

      // Read address WITH on-device display so the user verifies it.
      const addr = await getLedgerAddress(transport, DEFAULT_LEDGER_PATH, true);
      setDevicePublicKey(addr);

      // Pre-flight blind signing (P01 ix require it).
      try {
        const cfg = await getLedgerAppConfiguration(transport);
        setBlindSignEnabled(cfg.blindSigningEnabled);
      } catch {
        setBlindSignEnabled(null); // unknown — surfaced again at first sign
      }

      // Reconnect path: device already provisioned → straight to confirm.
      if (isReconnect) {
        setStep('confirm');
      } else {
        setStep('set-password');
      }
    } catch (e) {
      setError(
        (e as Error)?.message ||
          'Could not connect to the Ledger. Make sure it is unlocked and the Solana app is open.',
      );
    } finally {
      setBusy(false);
    }
  }, [isReconnect]);

  const handleSetPassword = useCallback(() => {
    setError(null);
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirmPwd) {
      setError('Passwords do not match.');
      return;
    }
    setStep('confirm');
  }, [password, confirmPwd]);

  const handleProvision = useCallback(async () => {
    if (!devicePublicKey) return;
    setError(null);
    setBusy(true);
    setStep('provisioning');
    try {
      // Fresh onboard → generate + persist the separate ZK spending seed (§0),
      // and produce the encrypted identity backup BEFORE recording the wallet so
      // we can hand it to the user. Reconnect → reuse the existing seed.
      let blob: string | null = null;
      if (!isReconnect) {
        const seed = generateSpendingSeed();
        // Keep a copy for the backup blob (storeSpendingSeed zeroizes its input).
        const seedCopy = seed.slice();
        await storeSpendingSeed(devicePublicKey, seed, password);
        blob = await exportHardwareBackup({
          spendingSeed: seedCopy,
          ledgerPath: DEFAULT_LEDGER_PATH,
          publicKey: devicePublicKey,
          password,
        });
        seedCopy.fill(0);
        await connectLedger({
          publicKey: devicePublicKey,
          ledgerPath: DEFAULT_LEDGER_PATH,
          password,
        });
      } else {
        // Reconnect: seed already encrypted at rest; nothing to re-provision.
        const already = await hasSpendingSeed(devicePublicKey);
        if (!already) {
          throw new Error(
            'No spending seed found for this Ledger on this device. Restore from your ' +
              'encrypted identity backup, or delete the wallet and onboard fresh.',
          );
        }
      }

      if (blob) {
        setBackupBlob(blob);
        setStep('backup');
      } else {
        setStep('done');
      }
    } catch (e) {
      setError((e as Error)?.message || 'Failed to provision the hardware wallet.');
      setStep('confirm');
    } finally {
      setBusy(false);
    }
  }, [devicePublicKey, isReconnect, password, connectLedger]);

  const handleCopyBackup = useCallback(async () => {
    if (!backupBlob) return;
    await copyToClipboard(backupBlob);
    setBackupCopied(true);
    setTimeout(() => setBackupCopied(false), 2000);
  }, [backupBlob]);

  const handleFinishBackup = useCallback(() => {
    setBackupBlob(null);
    setStep('done');
  }, []);

  return (
    <div className="min-h-screen w-full bg-p01-void flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-12 h-12 rounded-xl bg-p01-cyan/20 flex items-center justify-center">
            <Usb className="w-6 h-6 text-p01-cyan" />
          </div>
          <div>
            <h1 className="text-white font-display font-bold text-xl tracking-wide">
              Connect Ledger
            </h1>
            <p className="text-p01-chrome/60 text-sm">Hardware wallet for Protocol-01</p>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 p-3 mb-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400" role="alert">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" aria-hidden="true" />
            <span className="text-xs break-words">{error}</span>
          </div>
        )}

        {step === 'check' && (
          <div className="text-center py-10">
            <Loader2 className="w-8 h-8 text-p01-cyan animate-spin mx-auto" />
            <p className="text-p01-chrome/60 text-sm mt-3">Checking browser support…</p>
          </div>
        )}

        {step === 'unsupported' && (
          <div className="bg-p01-surface rounded-2xl p-5">
            <AlertTriangle className="w-8 h-8 text-warning mb-3" />
            <p className="text-white font-medium mb-1">WebHID not available</p>
            <p className="text-p01-chrome/60 text-sm">
              Connecting a Ledger needs WebHID or WebUSB. Use a Chromium-based desktop
              browser (Chrome, Brave, or Edge).
            </p>
          </div>
        )}

        {step === 'connect' && (
          <div className="bg-p01-surface rounded-2xl p-5">
            <p className="text-p01-chrome/80 text-sm mb-4">
              Unlock your Ledger and open the <span className="text-white">Solana</span> app,
              then connect it.
            </p>
            <button
              onClick={handleConnect}
              disabled={busy}
              className="w-full py-4 bg-p01-cyan text-p01-void font-display font-bold tracking-wider rounded-xl hover:bg-p01-cyan-dim transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <Usb className="w-5 h-5" />}
              {busy ? 'Connecting…' : 'Connect device'}
            </button>
          </div>
        )}

        {step === 'set-password' && (
          <div className="bg-p01-surface rounded-2xl p-5">
            <div className="flex items-center gap-2 mb-3">
              <KeyRound className="w-5 h-5 text-p01-pink" />
              <p className="text-white font-medium">Set a wallet password</p>
            </div>
            <p className="text-p01-chrome/60 text-xs mb-4">
              This password encrypts your private (ZK) identity on this device and unlocks
              the wallet. It is separate from your Ledger PIN.
            </p>
            <input
              type="password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(null); }}
              placeholder="Password (min 8 chars)"
              className="w-full px-4 py-3 mb-3 bg-p01-void border border-p01-border rounded-xl text-white font-mono text-sm focus:outline-none focus:border-p01-cyan"
            />
            <input
              type="password"
              value={confirmPwd}
              onChange={(e) => { setConfirmPwd(e.target.value); setError(null); }}
              placeholder="Confirm password"
              className="w-full px-4 py-3 mb-4 bg-p01-void border border-p01-border rounded-xl text-white font-mono text-sm focus:outline-none focus:border-p01-cyan"
            />
            <button
              onClick={handleSetPassword}
              disabled={!password || !confirmPwd}
              className="w-full py-3 bg-p01-cyan text-p01-void font-medium rounded-xl hover:bg-p01-cyan-dim transition-colors disabled:opacity-50"
            >
              Continue
            </button>
          </div>
        )}

        {step === 'confirm' && devicePublicKey && (
          <div className="bg-p01-surface rounded-2xl p-5">
            <p className="text-p01-chrome/60 text-xs mb-2">Verify this matches your device</p>
            <div className="bg-p01-void rounded-xl p-3 mb-4 flex items-center justify-between">
              <span className="text-white font-mono text-sm">{truncateAddress(devicePublicKey, 8)}</span>
              <ShieldCheck className="w-5 h-5 text-p01-cyan" />
            </div>

            {blindSignEnabled === false && (
              <div className="bg-warning/10 rounded-xl p-3 mb-4 border border-warning/30 flex gap-2">
                <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" aria-hidden="true" />
                <p className="text-xs text-warning">
                  Blind signing is OFF. Enable it in the Solana app (Settings → Allow
                  blind sign) before your first transaction, or it will be rejected.
                </p>
              </div>
            )}

            <button
              onClick={handleProvision}
              disabled={busy}
              className="w-full py-4 bg-p01-cyan text-p01-void font-display font-bold tracking-wider rounded-xl hover:bg-p01-cyan-dim transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <Check className="w-5 h-5" />}
              {isReconnect ? 'Reconnect this wallet' : 'This is my address'}
            </button>
          </div>
        )}

        {step === 'provisioning' && (
          <div className="text-center py-10">
            <Loader2 className="w-8 h-8 text-p01-cyan animate-spin mx-auto" />
            <p className="text-p01-chrome/60 text-sm mt-3">Setting up your private identity…</p>
          </div>
        )}

        {step === 'backup' && backupBlob && (
          <div className="bg-p01-surface rounded-2xl p-5">
            <div className="bg-red-500/10 rounded-xl p-3 mb-4 border border-red-500/20 flex gap-2">
              <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" aria-hidden="true" />
              <p className="text-xs text-red-400">
                Save this backup now. Your Ledger recovery phrase does NOT restore your
                private (ZK) identity — if this device is wiped without this backup, your
                shielded notes are lost forever.
              </p>
            </div>
            <div className="bg-p01-void rounded-xl p-3 mb-4 max-h-32 overflow-y-auto">
              <code className="text-p01-chrome/80 text-[10px] break-all font-mono">{backupBlob}</code>
            </div>
            <button
              onClick={handleCopyBackup}
              className="w-full py-3 mb-3 bg-p01-void text-white font-medium rounded-xl hover:bg-p01-border transition-colors flex items-center justify-center gap-2"
            >
              {backupCopied ? <Check className="w-4 h-4 text-p01-cyan" /> : <Copy className="w-4 h-4" />}
              {backupCopied ? 'Copied — store it safely' : 'Copy encrypted backup'}
            </button>
            <button
              onClick={handleFinishBackup}
              className="w-full py-3 bg-p01-cyan text-p01-void font-medium rounded-xl hover:bg-p01-cyan-dim transition-colors flex items-center justify-center gap-2"
            >
              <Download className="w-4 h-4" />
              I saved my backup
            </button>
          </div>
        )}

        {step === 'done' && (
          <div className="bg-p01-surface rounded-2xl p-5 text-center">
            <div className="w-16 h-16 rounded-full bg-p01-cyan/20 flex items-center justify-center mx-auto mb-4">
              <Check className="w-8 h-8 text-p01-cyan" />
            </div>
            <p className="text-white font-medium mb-1">Ledger connected</p>
            <p className="text-p01-chrome/60 text-sm mb-4">
              You can close this tab and return to the wallet.
            </p>
            <button
              onClick={() => window.close()}
              className={cn(
                'w-full py-3 bg-p01-cyan text-p01-void font-medium rounded-xl',
                'hover:bg-p01-cyan-dim transition-colors',
              )}
            >
              Close tab
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * CreateWallet: a password, then the twelve words.
 *
 * 🚨 THE TRAP THAT IS GONE. "COMPLETE SETUP" was disabled until the seed had
 * been put on the CLIPBOARD, and the copied flag expired after five seconds —
 * so a user who copied the phrase, wrote it on paper (the thing we are asking
 * them to do), then reached for the button found it dead again with no
 * explanation. It punished the correct behaviour and rewarded leaving twelve
 * words in the system clipboard. The checkbox is the attestation now; copying
 * is offered, never demanded.
 *
 * 🎯 The screen also stopped shouting. A cyan shield medallion above a
 * `SECURE YOUR WALLET` headline above a mono subtitle said one thing three
 * times, in a header that already read CREATE WALLET. The Screen title carries
 * it; the body carries the fields.
 *
 * ⚠️ Nothing about key generation, encryption or `createWallet` moved.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Copy, Check, Eye, EyeOff, AlertTriangle } from 'lucide-react';
import { useWalletStore } from '@/shared/store/wallet';
import { cn, copyToClipboard } from '@/shared/utils';
import { Button, Field, Panel, Screen } from '@/popup/ui';

type Step = 'password' | 'seedphrase';

/** <8 is refused, 12 or more is the target. Shown as words, not a bar alone. */
function strengthOf(length: number): { steps: number; label: string } {
  if (length >= 12) return { steps: 4, label: 'Strong' };
  if (length >= 8) return { steps: 3, label: 'Good' };
  if (length >= 3) return { steps: 1, label: 'At least 8 characters' };
  return { steps: 0, label: 'At least 8 characters' };
}

export default function CreateWallet() {
  const navigate = useNavigate();
  const { createWallet, isLoading, error, clearError } = useWalletStore();

  const [step, setStep] = useState<Step>('password');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [seedPhrase, setSeedPhrase] = useState<string[]>([]);
  const [showPhrase, setShowPhrase] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [localError, setLocalError] = useState('');

  const handleCreateWallet = async () => {
    setLocalError('');
    clearError();

    if (password.length < 8) {
      setLocalError('Password must be at least 8 characters');
      return;
    }

    if (password !== confirmPassword) {
      setLocalError('Passwords do not match');
      return;
    }

    try {
      const words = await createWallet(password);
      setSeedPhrase(words);
      setStep('seedphrase');
    } catch (err) {
      setLocalError((err as Error).message);
    }
  };

  const handleCopySeedPhrase = async () => {
    await copyToClipboard(seedPhrase.join(' '));
    setCopied(true);
    // Keep copied state longer
    setTimeout(() => setCopied(false), 5000);
  };

  // ⛔ No `copied` in this condition. See the header note.
  const handleComplete = () => {
    if (confirmed) {
      navigate('/');
    }
  };

  const strength = strengthOf(password.length);

  // Each message under the field that caused it. Only a failure with no field
  // of its own — the store refusing to create the wallet — falls through to the
  // form-level alert at the bottom.
  const passwordError =
    localError === 'Password must be at least 8 characters' ? localError : undefined;
  const confirmError = localError === 'Passwords do not match' ? localError : undefined;
  const formError = passwordError || confirmError ? undefined : localError || error;

  if (step === 'seedphrase') {
    return (
      <Screen
        title="Recovery phrase"
        onBack={() => setStep('password')}
        footer={
          <Button full size="lg" disabled={!confirmed} onClick={handleComplete}>
            Done
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <Panel tone="warn">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-p01-amber" aria-hidden="true" />
              <p className="text-sm text-p01-text">
                Write these 12 words down on paper. Anyone who reads them owns this wallet, and
                nobody can give them back to you.
              </p>
            </div>
          </Panel>

          <div>
            <div className="flex items-center justify-between">
              <span className="text-tiny text-p01-text-muted">Your 12 words</span>
              <button
                onClick={() => setShowPhrase(!showPhrase)}
                className="flex min-h-[44px] items-center gap-1.5 rounded-lg px-1 text-tiny text-p01-cyan transition-colors duration-exit hover:text-p01-cyan-bright focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-p01-cyan"
                aria-label={showPhrase ? 'Hide seed phrase' : 'Show seed phrase'}
              >
                {showPhrase ? (
                  <EyeOff className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Eye className="h-4 w-4" aria-hidden="true" />
                )}
                {showPhrase ? 'Hide' : 'Show'}
              </button>
            </div>

            <div className="mt-1 grid grid-cols-3 gap-1.5">
              {seedPhrase.map((word, index) => (
                <div
                  key={index}
                  className="flex items-baseline gap-1.5 rounded-lg border border-p01-border-soft bg-p01-dark px-2 py-2"
                >
                  <span className="w-3.5 shrink-0 text-right font-mono text-[0.625rem] text-p01-text-dim tabular">
                    {index + 1}
                  </span>
                  <span className="truncate font-mono text-tiny text-p01-text">
                    {showPhrase ? word : '•••••'}
                  </span>
                </div>
              ))}
            </div>

            <Button
              full
              variant="secondary"
              className="mt-2.5"
              icon={copied ? Check : Copy}
              onClick={() => void handleCopySeedPhrase()}
            >
              {copied ? 'Copied' : 'Copy to clipboard'}
            </Button>
          </div>

          <label className="flex min-h-[44px] cursor-pointer items-start gap-3 rounded-xl border border-p01-border bg-p01-surface p-3">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-p01-cyan"
            />
            <span className="text-sm text-p01-text-muted">
              I have written my recovery phrase down somewhere safe.
            </span>
          </label>
        </div>
      </Screen>
    );
  }

  return (
    <Screen
      title="Create wallet"
      onBack={() => navigate(-1)}
      footer={
        <Button
          full
          size="lg"
          loading={isLoading}
          disabled={!password || !confirmPassword}
          onClick={() => void handleCreateWallet()}
        >
          Create wallet
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-p01-text-muted">
          This password encrypts your wallet on this device. It is not your recovery phrase and
          it cannot be reset.
        </p>

        <Field
          label="Password"
          type={showPassword ? 'text' : 'password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          error={passwordError}
          suffix={
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="flex h-11 w-11 items-center justify-center rounded-lg text-p01-text-dim transition-colors duration-exit hover:text-p01-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-p01-cyan"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? (
                <EyeOff className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Eye className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          }
        />

        {/* Strength sits with the field it describes, not in a summary. */}
        <div
          className="-mt-2 flex flex-col gap-1.5"
          role="meter"
          aria-label="Password strength"
          aria-valuemin={0}
          aria-valuemax={4}
          aria-valuenow={strength.steps}
        >
          <div className="flex gap-1">
            {[1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className={cn(
                  'h-0.5 flex-1 rounded-full transition-colors duration-exit',
                  strength.steps >= i
                    ? strength.steps >= 3
                      ? 'bg-p01-cyan'
                      : 'bg-p01-amber'
                    : 'bg-p01-border',
                )}
              />
            ))}
          </div>
          <p className="text-tiny text-p01-text-dim" aria-live="polite">
            {strength.label}
          </p>
        </div>

        <Field
          label="Confirm password"
          type={showPassword ? 'text' : 'password'}
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          autoComplete="new-password"
          error={confirmError}
        />

        {formError && (
          <p role="alert" className="text-tiny text-p01-red">
            {formError}
          </p>
        )}
      </div>
    </Screen>
  );
}

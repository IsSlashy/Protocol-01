/**
 * ImportWallet: the phrase, then a password to encrypt it here.
 *
 * 🎯 WHAT CHANGED. Both steps opened with the same decorative medallion above a
 * bold headline above a mono subtitle, restating a header that already said
 * IMPORT WALLET — three sizes of the same sentence before the user reached the
 * only field on the screen. And the reassurance that the phrase never leaves
 * the device was set in a mono ALL-CAPS block, which is the typography of a
 * warning attached to the one line here that is meant to calm someone down.
 *
 * Now: the Screen title says where you are, one sentence says what to do, the
 * field is immediately reachable, and the action sits in the footer where it
 * cannot scroll away behind a 24-word phrase.
 *
 * ⚠️ `importWallet`, the 12/24 word check and the password rules are untouched.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import { useWalletStore } from '@/shared/store/wallet';
import { cn } from '@/shared/utils';
import { Button, Field, Screen } from '@/popup/ui';

type Step = 'seedphrase' | 'password';

/** <8 is refused, 12 or more is the target. Shown as words, not a bar alone. */
function strengthOf(length: number): { steps: number; label: string } {
  if (length >= 12) return { steps: 4, label: 'Strong' };
  if (length >= 8) return { steps: 3, label: 'Good' };
  if (length >= 3) return { steps: 1, label: 'At least 8 characters' };
  return { steps: 0, label: 'At least 8 characters' };
}

export default function ImportWallet() {
  const navigate = useNavigate();
  const { importWallet, isLoading, error, clearError } = useWalletStore();

  const [step, setStep] = useState<Step>('seedphrase');
  const [seedPhrase, setSeedPhrase] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [localError, setLocalError] = useState('');

  const handleContinueToPassword = () => {
    const words = seedPhrase.trim().split(/\s+/);

    if (words.length !== 12 && words.length !== 24) {
      setLocalError('Please enter a valid 12 or 24 word seed phrase');
      return;
    }

    setLocalError('');
    setStep('password');
  };

  const handleImport = async () => {
    clearError();
    setLocalError('');

    if (password.length < 8) {
      setLocalError('Password must be at least 8 characters');
      return;
    }

    if (password !== confirmPassword) {
      setLocalError('Passwords do not match');
      return;
    }

    const words = seedPhrase.trim().split(/\s+/);

    try {
      await importWallet(words, password);
      navigate('/');
    } catch (err) {
      setLocalError((err as Error).message);
    }
  };

  const wordCount = seedPhrase.trim() ? seedPhrase.trim().split(/\s+/).length : 0;
  const strength = strengthOf(password.length);

  // Each message under the field that caused it; anything with no field of its
  // own falls through to the form-level alert.
  const passwordError =
    localError === 'Password must be at least 8 characters' ? localError : undefined;
  const confirmError = localError === 'Passwords do not match' ? localError : undefined;
  const formError = passwordError || confirmError ? undefined : localError || error;

  if (step === 'password') {
    return (
      <Screen
        title="Set a password"
        onBack={() => setStep('seedphrase')}
        footer={
          <Button
            full
            size="lg"
            loading={isLoading}
            disabled={!password || !confirmPassword}
            onClick={() => void handleImport()}
          >
            Import wallet
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-p01-text-muted">
            This password encrypts your phrase on this device and unlocks the wallet here. It
            never leaves the machine, and it cannot be reset.
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

  return (
    <Screen
      title="Import wallet"
      onBack={() => navigate(-1)}
      footer={
        <Button full size="lg" disabled={!seedPhrase.trim()} onClick={handleContinueToPassword}>
          Continue
        </Button>
      }
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor="import-seed-phrase" className="text-tiny text-p01-text-muted">
          Recovery phrase
        </label>
        <textarea
          id="import-seed-phrase"
          value={seedPhrase}
          onChange={(e) => {
            setSeedPhrase(e.target.value);
            setLocalError('');
          }}
          placeholder="Your 12 or 24 words, separated by spaces"
          rows={5}
          aria-invalid={localError ? true : undefined}
          aria-describedby={localError ? 'import-seed-error' : 'import-seed-hint'}
          className={cn(
            'w-full resize-none rounded-lg border bg-p01-dark px-3 py-2.5 font-mono text-sm text-p01-text',
            'placeholder:font-body placeholder:text-p01-text-dim',
            'outline-none transition-colors duration-exit focus:border-p01-cyan focus-visible:outline-none',
            localError ? 'border-p01-red' : 'border-p01-border',
          )}
        />

        {localError ? (
          <p id="import-seed-error" role="alert" className="text-tiny text-p01-red">
            {localError}
          </p>
        ) : (
          <p id="import-seed-hint" className="text-tiny text-p01-text-dim">
            <span className="tabular">{wordCount}</span> of 12 or 24 words. The phrase is
            encrypted on this device and never sent anywhere.
          </p>
        )}
      </div>
    </Screen>
  );
}

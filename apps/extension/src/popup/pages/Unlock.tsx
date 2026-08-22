/**
 * Unlock: password in, wallet open.
 *
 * 🚨 THIS SCREEN SAID "LOCKED" FOUR TIMES IN FOUR TYPEFACES. A pink mono
 * `[ LOCKED ]` badge, a bold `WALLET LOCKED` headline under it, an
 * `ENTER PASSWORD TO UNLOCK` mono subtitle under that, and a padlock glyph
 * inside the field — plus a `SOLANA NETWORK` footer that answered a question
 * nobody asks while locked out of their own wallet. Four restatements of one
 * fact is not emphasis, it is noise, and it pushed the only control on the
 * screen down past the fold of a 360px popup.
 *
 * What is left is what Phantom shows: the mark, one sentence, one field, one
 * button, one link. The screen is already the lock; it does not need to say so.
 *
 * ⚠️ NOT TOUCHED: the lockout timer, `getLockoutRemaining`, the
 * `afterUnlockPath` redirect and the reset path. Every one of those is
 * security behaviour, and this was a visual pass.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, EyeOff, LogOut, X } from 'lucide-react';
import { useWalletStore } from '@/shared/store/wallet';
import { getLockoutRemaining } from '@/shared/services/crypto';
import { Button, Field } from '@/popup/ui';
import Wordmark from '../components/Wordmark';

export default function Unlock() {
  const navigate = useNavigate();
  const { unlock, isLoading, error, clearError, reset } = useWalletStore();

  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [localError, setLocalError] = useState('');
  const [showLogoutModal, setShowLogoutModal] = useState(false);
  const [lockoutSeconds, setLockoutSeconds] = useState(0);
  const lockoutTimer = useRef<number | null>(null);

  const isLockedOut = lockoutSeconds > 0;

  // Check lockout on mount and after failed attempts
  const refreshLockout = useCallback(async () => {
    const remaining = await getLockoutRemaining();
    const secs = Math.ceil(remaining / 1000);
    setLockoutSeconds(secs);

    // Clear any existing timer
    if (lockoutTimer.current) {
      clearInterval(lockoutTimer.current);
      lockoutTimer.current = null;
    }

    if (secs > 0) {
      lockoutTimer.current = window.setInterval(async () => {
        const r = await getLockoutRemaining();
        const s = Math.ceil(r / 1000);
        setLockoutSeconds(s);
        if (s <= 0 && lockoutTimer.current) {
          clearInterval(lockoutTimer.current);
          lockoutTimer.current = null;
        }
      }, 1000);
    }
  }, []);

  useEffect(() => {
    refreshLockout();
    return () => {
      if (lockoutTimer.current) clearInterval(lockoutTimer.current);
    };
  }, [refreshLockout]);

  const handleUnlock = async () => {
    if (!password) {
      setLocalError('Please enter your password');
      return;
    }

    if (isLockedOut) return;

    setLocalError('');
    clearError();

    const success = await unlock(password);

    if (success) {
      // Check if there's a pending approval path to redirect to
      try {
        const result = await chrome.storage.session.get('afterUnlockPath');
        if (result.afterUnlockPath) {
          await chrome.storage.session.remove('afterUnlockPath');
          navigate(result.afterUnlockPath);
          return;
        }
      } catch (e) {
        console.error('[Unlock] Error checking afterUnlockPath:', e);
      }
      navigate('/');
    } else {
      // Refresh lockout state — the store may have recorded a new failed attempt
      await refreshLockout();
      if (!isLockedOut) {
        setLocalError('Invalid password');
      }
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleUnlock();
    }
  };

  const handleLogout = () => {
    setShowLogoutModal(true);
  };

  const handleConfirmLogout = async () => {
    await reset();
    navigate('/welcome');
  };

  // One message under one field. The lockout outranks a stale "Invalid
  // password" from the attempt that triggered it.
  const fieldError = isLockedOut
    ? `Too many failed attempts. Try again in ${lockoutSeconds}s.`
    : localError || error || undefined;

  return (
    <div className="flex h-full flex-col bg-p01-void" role="main" aria-label="Unlock wallet">
      <header className="flex shrink-0 items-center px-4 py-3">
        <Wordmark size={20} showText />
      </header>

      <div className="flex flex-1 flex-col items-center justify-center gap-7 px-6 pb-8">
        <Wordmark size={92} animated />

        <div className="w-full">
          <h1 className="mb-4 text-center font-display text-xl font-light">
            Enter your password
          </h1>

          <Field
            label="Password"
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setLocalError('');
            }}
            onKeyPress={handleKeyPress}
            autoFocus
            autoComplete="current-password"
            error={fieldError}
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

          <Button
            full
            size="lg"
            className="mt-4"
            loading={isLoading}
            disabled={!password || isLockedOut}
            onClick={() => void handleUnlock()}
          >
            Unlock
          </Button>
        </div>

        <Button variant="ghost" onClick={handleLogout}>
          Forgot password?
        </Button>
      </div>

      {/* The one confirmation kept on this screen: it wipes the local wallet,
          and it is the only place that says the seed phrase still recovers it. */}
      {showLogoutModal && (
        <div
          className="animate-fadeIn fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="disconnect-modal-title"
        >
          <div className="w-full max-w-sm rounded-xl border border-p01-border bg-p01-dark">
            <div className="flex items-center justify-between border-b border-p01-border-soft py-2 pl-4 pr-2">
              <h2 id="disconnect-modal-title" className="font-display text-lg font-normal">
                Disconnect wallet
              </h2>
              <button
                onClick={() => setShowLogoutModal(false)}
                className="flex h-11 w-11 items-center justify-center rounded-lg text-p01-text-muted transition-colors duration-exit hover:text-p01-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-p01-cyan"
                aria-label="Close"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <div className="flex flex-col gap-4 p-4">
              <p className="text-sm text-p01-text-muted">
                This removes the wallet from this device only. It still exists on chain, and
                your 12 or 24 word recovery phrase imports it back at any time.
              </p>

              <div className="flex gap-2">
                <Button
                  full
                  variant="secondary"
                  onClick={() => setShowLogoutModal(false)}
                >
                  Cancel
                </Button>
                <Button full icon={LogOut} onClick={() => void handleConfirmLogout()}>
                  Disconnect
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

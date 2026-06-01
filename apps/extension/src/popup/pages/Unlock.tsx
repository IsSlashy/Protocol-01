import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertCircle, Eye, EyeOff, Loader2, Lock, LogOut, X } from 'lucide-react';
import { useWalletStore } from '@/shared/store/wallet';
import { getLockoutRemaining } from '@/shared/services/crypto';
import GlitchLogo from '../components/GlitchLogo';
import { cn } from '@/shared/utils';

export default function Unlock() {
  const navigate = useNavigate();
  const { unlock, isLoading, error, clearError, reset, isPrivyWallet } = useWalletStore();

  // Privy users should never see the unlock page — redirect to home
  useEffect(() => {
    if (isPrivyWallet) {
      navigate('/', { replace: true });
    }
  }, [isPrivyWallet, navigate]);

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

  return (
    <div className="flex flex-col h-full bg-p01-void" role="main" aria-label="Unlock wallet">
      <div className="flex-1 flex flex-col items-center justify-center px-6">
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="text-center mb-6"
        >
          {/* Glitch Logo */}
          <GlitchLogo size={80} showText={false} animated={true} />

          {/* Terminal status */}
          <div className="mt-4">
            <span className="text-p01-pink text-[10px] font-bold tracking-[4px] font-mono">
              [ LOCKED ]
            </span>
            <h1 className="text-base font-display font-bold text-white tracking-wider mt-2">
              WALLET LOCKED
            </h1>
            <p className="text-[10px] text-[#555560] font-mono tracking-wider mt-1">
              ENTER PASSWORD TO UNLOCK
            </p>
          </div>
        </motion.div>

        {/* Password Input */}
        <div className="w-full max-w-xs space-y-4">
          <div className="relative">
            <div className="absolute left-3 top-1/2 -translate-y-1/2">
              <Lock className="w-4 h-4 text-p01-chrome/40" />
            </div>
            <input
              type={showPassword ? 'text' : 'password'}
              placeholder="Enter password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setLocalError('');
              }}
              onKeyPress={handleKeyPress}
              className="w-full pl-10 pr-10 py-3 bg-p01-surface border border-p01-border text-white font-mono text-sm focus:outline-none focus:border-p01-cyan transition-colors"
              autoFocus
              aria-label="Wallet password"
              aria-describedby="unlock-error"
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

          {/* Lockout warning */}
          {isLockedOut && (
            <div className="flex items-center gap-2 p-3 bg-warning/10 border border-warning/30 text-warning" role="alert" aria-live="polite">
              <Lock className="w-4 h-4 flex-shrink-0" />
              <span className="text-xs font-mono">
                Too many failed attempts. Try again in {lockoutSeconds}s
              </span>
            </div>
          )}

          {/* Error */}
          {!isLockedOut && (localError || error) && (
            <div id="unlock-error" className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/30 text-red-400" role="alert" aria-live="polite">
              <AlertCircle className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
              <span className="text-xs font-mono">{localError || error}</span>
            </div>
          )}

          {/* Unlock Button */}
          <button
            onClick={handleUnlock}
            disabled={isLoading || !password || isLockedOut}
            className={cn(
              'w-full py-3 font-display font-bold text-sm tracking-wider transition-colors flex items-center justify-center gap-2',
              isLoading || !password || isLockedOut
                ? 'bg-p01-border text-p01-chrome/40 cursor-not-allowed'
                : 'bg-p01-cyan text-p01-void hover:bg-p01-cyan-dim'
            )}
          >
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                UNLOCKING...
              </>
            ) : isLockedOut ? (
              `LOCKED (${lockoutSeconds}s)`
            ) : (
              'UNLOCK'
            )}
          </button>
        </div>

        {/* Logout link */}
        <button
          onClick={handleLogout}
          className="mt-6 text-[10px] text-[#555560] hover:text-p01-cyan transition-colors font-mono tracking-wider flex items-center gap-1"
          aria-label="Forgot password? Disconnect wallet"
        >
          <LogOut className="w-3 h-3" aria-hidden="true" />
          FORGOT PASSWORD? DISCONNECT
        </button>
      </div>

      {/* Network indicator footer */}
      <footer className="py-3 text-center border-t border-p01-border">
        <p className="text-[10px] text-[#555560] tracking-[2px] font-mono uppercase">
          Solana Network
        </p>
      </footer>

      {/* Logout Modal - Simple confirmation */}
      <AnimatePresence>
        {showLogoutModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="disconnect-modal-title"
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-p01-void border border-p01-border w-full max-w-sm"
            >
              {/* Modal Header */}
              <div className="flex items-center justify-between p-4 border-b border-p01-border">
                <div className="flex items-center gap-2">
                  <LogOut className="w-5 h-5 text-p01-cyan" />
                  <h2 id="disconnect-modal-title" className="text-sm font-bold text-white font-mono tracking-wider">
                    DISCONNECT WALLET
                  </h2>
                </div>
                <button
                  onClick={() => setShowLogoutModal(false)}
                  className="p-1 hover:bg-p01-surface transition-colors"
                  aria-label="Close"
                >
                  <X className="w-4 h-4 text-p01-chrome" />
                </button>
              </div>

              {/* Modal Content */}
              <div className="p-4 space-y-4">
                <div className="bg-p01-cyan/10 border border-p01-cyan/30 p-4">
                  <p className="text-xs text-p01-cyan font-mono font-bold mb-2">
                    🔑 YOUR FUNDS ARE SAFE
                  </p>
                  <ul className="text-[11px] text-p01-chrome font-mono space-y-1">
                    <li>• This only disconnects from this device</li>
                    <li>• Your wallet still exists on the blockchain</li>
                    <li>• Re-import anytime with your seed phrase</li>
                  </ul>
                </div>

                <p className="text-[11px] text-p01-chrome/60 font-mono text-center">
                  After disconnecting, you can import your wallet again using your 12 or 24 word recovery phrase.
                </p>

                <div className="flex gap-2">
                  <button
                    onClick={() => setShowLogoutModal(false)}
                    className="flex-1 py-3 bg-p01-surface text-p01-chrome font-bold text-sm tracking-wider font-mono border border-p01-border hover:text-white transition-colors"
                  >
                    CANCEL
                  </button>
                  <button
                    onClick={handleConfirmLogout}
                    className="flex-1 py-3 bg-p01-cyan text-p01-void font-bold text-sm tracking-wider font-mono hover:bg-p01-cyan-dim transition-colors"
                  >
                    DISCONNECT
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

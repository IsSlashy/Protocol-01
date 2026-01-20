import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { AlertCircle, Eye, EyeOff, Loader2, Lock } from 'lucide-react';
import { useWalletStore } from '@/shared/store/wallet';
import GlitchLogo from '../components/GlitchLogo';
import { cn } from '@/shared/utils';

export default function Unlock() {
  const navigate = useNavigate();
  const { unlock, isLoading, error, clearError, reset } = useWalletStore();

  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [localError, setLocalError] = useState('');

  const handleUnlock = async () => {
    if (!password) {
      setLocalError('Please enter your password');
      return;
    }

    setLocalError('');
    clearError();

    console.log('[Unlock] Starting unlock...');
    const success = await unlock(password);
    console.log('[Unlock] Unlock result:', success);

    if (success) {
      // Check if there's a pending approval path to redirect to
      try {
        console.log('[Unlock] Checking for afterUnlockPath...');
        const result = await chrome.storage.session.get('afterUnlockPath');
        console.log('[Unlock] afterUnlockPath:', result.afterUnlockPath);
        if (result.afterUnlockPath) {
          await chrome.storage.session.remove('afterUnlockPath');
          console.log('[Unlock] Navigating to:', result.afterUnlockPath);
          navigate(result.afterUnlockPath);
          return;
        }
      } catch (e) {
        console.error('[Unlock] Error checking afterUnlockPath:', e);
      }
      console.log('[Unlock] Navigating to home');
      navigate('/');
    } else {
      console.log('[Unlock] Unlock failed');
      setLocalError('Invalid password');
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleUnlock();
    }
  };

  const handleReset = () => {
    if (confirm('Are you sure? This will delete your wallet. Make sure you have your seed phrase backed up.')) {
      reset();
      navigate('/welcome');
    }
  };

  return (
    <div className="flex flex-col h-full bg-p01-void">
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
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-p01-chrome/60 hover:text-white"
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>

          {/* Error */}
          {(localError || error) && (
            <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/30 text-red-400">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span className="text-xs font-mono">{localError || error}</span>
            </div>
          )}

          {/* Unlock Button */}
          <button
            onClick={handleUnlock}
            disabled={isLoading || !password}
            className={cn(
              'w-full py-3 font-display font-bold text-sm tracking-wider transition-colors flex items-center justify-center gap-2',
              isLoading || !password
                ? 'bg-p01-border text-p01-chrome/40 cursor-not-allowed'
                : 'bg-p01-cyan text-p01-void hover:bg-p01-cyan-dim'
            )}
          >
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                UNLOCKING...
              </>
            ) : (
              'UNLOCK'
            )}
          </button>
        </div>

        {/* Recovery link */}
        <button
          onClick={handleReset}
          className="mt-6 text-[10px] text-[#555560] hover:text-p01-pink transition-colors font-mono tracking-wider"
        >
          FORGOT PASSWORD? RESET WALLET
        </button>
      </div>

      {/* Network indicator footer */}
      <footer className="py-3 text-center border-t border-p01-border">
        <p className="text-[10px] text-[#555560] tracking-[2px] font-mono uppercase">
          Solana Network
        </p>
      </footer>
    </div>
  );
}

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, AlertCircle, Loader2, Eye, EyeOff, Download, Shield } from 'lucide-react';
import { useWalletStore } from '@/shared/store/wallet';
import { cn } from '@/shared/utils';

type Step = 'seedphrase' | 'password';

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

  return (
    <div className="flex flex-col h-full bg-p01-void">
      {/* Header */}
      <div className="flex items-center gap-3 p-3 border-b border-p01-border bg-p01-surface">
        <button
          onClick={() => (step === 'seedphrase' ? navigate(-1) : setStep('seedphrase'))}
          className="p-2 -ml-2 hover:bg-p01-border transition-colors"
        >
          <ArrowLeft className="w-4 h-4 text-p01-chrome" />
        </button>
        <h1 className="text-sm font-mono font-bold text-white tracking-wider">
          {step === 'seedphrase' ? 'IMPORT WALLET' : 'SET PASSWORD'}
        </h1>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {/* Step 1: Seed Phrase */}
        {step === 'seedphrase' && (
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            className="space-y-4"
          >
            <div className="text-center mb-4">
              <div className="w-14 h-14 mx-auto mb-4 bg-p01-cyan/10 border border-p01-cyan/30 flex items-center justify-center">
                <Download className="w-7 h-7 text-p01-cyan" />
              </div>
              <h2 className="text-base font-display font-bold text-white tracking-wider">IMPORT EXISTING</h2>
              <p className="text-[11px] text-p01-chrome/60 mt-2 font-mono">
                Enter your 12 or 24 word recovery phrase
              </p>
            </div>

            <div>
              <label className="text-[10px] text-p01-chrome/60 font-mono mb-1.5 block tracking-wider">
                RECOVERY PHRASE
              </label>
              <textarea
                value={seedPhrase}
                onChange={(e) => {
                  setSeedPhrase(e.target.value);
                  setLocalError('');
                }}
                placeholder="Enter your seed phrase, words separated by spaces..."
                rows={4}
                className="w-full bg-p01-surface border border-p01-border px-4 py-3 text-sm text-white placeholder-p01-chrome/40 focus:outline-none focus:border-p01-cyan transition-colors resize-none font-mono"
              />

              {/* Word count */}
              <div className="flex justify-between mt-2">
                <span className="text-[10px] text-p01-chrome/60 font-mono">
                  {seedPhrase.trim() ? seedPhrase.trim().split(/\s+/).length : 0} words
                </span>
                <span className="text-[10px] text-p01-chrome/60 font-mono">
                  12 or 24 required
                </span>
              </div>

              {localError && (
                <div className="flex items-center gap-2 mt-3 p-3 bg-red-500/10 border border-red-500/30 text-red-400">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  <span className="text-xs font-mono">{localError}</span>
                </div>
              )}
            </div>

            <div className="bg-p01-surface border border-p01-border p-3">
              <p className="text-[10px] text-p01-chrome/60 font-mono tracking-wider">
                YOUR SEED PHRASE IS ENCRYPTED AND STORED LOCALLY. IT NEVER LEAVES YOUR DEVICE.
              </p>
            </div>

            {/* Continue Button */}
            <button
              onClick={handleContinueToPassword}
              disabled={!seedPhrase.trim()}
              className={cn(
                'w-full py-4 font-display font-bold text-sm tracking-wider transition-colors',
                !seedPhrase.trim()
                  ? 'bg-p01-border text-p01-chrome/40 cursor-not-allowed'
                  : 'bg-p01-cyan text-p01-void hover:bg-p01-cyan-dim'
              )}
            >
              CONTINUE
            </button>
          </motion.div>
        )}

        {/* Step 2: Password */}
        {step === 'password' && (
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            className="space-y-4"
          >
            <div className="text-center mb-6">
              <div className="w-14 h-14 mx-auto mb-4 bg-p01-cyan/10 border border-p01-cyan/30 flex items-center justify-center">
                <Shield className="w-7 h-7 text-p01-cyan" />
              </div>
              <h2 className="text-base font-display font-bold text-white tracking-wider">LOCAL ENCRYPTION</h2>
              <p className="text-[11px] text-p01-chrome/60 mt-2 font-mono">
                Set a password to unlock your wallet on this device
              </p>
              <p className="text-[10px] text-p01-cyan/60 mt-1 font-mono">
                This password is stored locally only
              </p>
            </div>

            {/* Password Input */}
            <div className="space-y-3">
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  placeholder="Enter password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-4 py-3 bg-p01-surface border border-p01-border text-white font-mono text-sm focus:outline-none focus:border-p01-cyan transition-colors"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-p01-chrome/60 hover:text-white"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>

              <input
                type={showPassword ? 'text' : 'password'}
                placeholder="Confirm password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full px-4 py-3 bg-p01-surface border border-p01-border text-white font-mono text-sm focus:outline-none focus:border-p01-cyan transition-colors"
              />
            </div>

            {/* Password strength indicator */}
            <div className="space-y-1">
              <div className="flex gap-1">
                {[1, 2, 3, 4].map((i) => (
                  <div
                    key={i}
                    className={cn(
                      'h-1 flex-1 transition-colors',
                      password.length >= i * 3
                        ? password.length >= 12
                          ? 'bg-green-500'
                          : password.length >= 8
                          ? 'bg-p01-cyan'
                          : 'bg-p01-yellow'
                        : 'bg-p01-border'
                    )}
                  />
                ))}
              </div>
              <p className="text-[10px] text-p01-chrome/60 font-mono tracking-wider">
                {password.length < 8 ? 'MINIMUM 8 CHARACTERS' : password.length >= 12 ? 'STRONG' : 'GOOD'}
              </p>
            </div>

            {/* Error */}
            {(localError || error) && (
              <div className="p-3 bg-red-500/10 border border-red-500/30 text-red-400 text-xs font-mono">
                {localError || error}
              </div>
            )}

            {/* Import Button */}
            <button
              onClick={handleImport}
              disabled={isLoading || !password || !confirmPassword}
              className={cn(
                'w-full py-4 font-display font-bold text-sm tracking-wider transition-colors flex items-center justify-center gap-2',
                isLoading || !password || !confirmPassword
                  ? 'bg-p01-border text-p01-chrome/40 cursor-not-allowed'
                  : 'bg-p01-cyan text-p01-void hover:bg-p01-cyan-dim'
              )}
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  IMPORTING...
                </>
              ) : (
                'IMPORT WALLET'
              )}
            </button>
          </motion.div>
        )}
      </div>
    </div>
  );
}

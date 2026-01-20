import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, Eye, EyeOff, Copy, Check, Shield, AlertTriangle, Loader2 } from 'lucide-react';
import { useWalletStore } from '@/shared/store/wallet';
import { cn, copyToClipboard } from '@/shared/utils';

type Step = 'password' | 'seedphrase';

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

  const handleComplete = () => {
    if (confirmed && copied) {
      navigate('/');
    }
  };

  return (
    <div className="flex flex-col h-full bg-p01-void">
      {/* Header */}
      <div className="flex items-center gap-3 p-3 border-b border-p01-border bg-p01-surface">
        <button
          onClick={() => {
            if (step === 'password') navigate(-1);
            else setStep('password');
          }}
          className="p-2 -ml-2 hover:bg-p01-border transition-colors"
        >
          <ArrowLeft className="w-4 h-4 text-p01-chrome" />
        </button>
        <h1 className="text-sm font-mono font-bold text-white tracking-wider">
          {step === 'password' && 'CREATE WALLET'}
          {step === 'seedphrase' && 'RECOVERY PHRASE'}
        </h1>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {/* Step 1: Password */}
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
              <h2 className="text-base font-display font-bold text-white tracking-wider">SECURE YOUR WALLET</h2>
              <p className="text-[11px] text-p01-chrome/60 mt-2 font-mono">
                Create a password to encrypt your wallet
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

            {/* Create Button */}
            <button
              onClick={handleCreateWallet}
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
                  GENERATING...
                </>
              ) : (
                'CREATE WALLET'
              )}
            </button>
          </motion.div>
        )}

        {/* Step 2: Seed Phrase */}
        {step === 'seedphrase' && (
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            className="space-y-4"
          >
            {/* Warning */}
            <div className="p-3 bg-p01-pink/10 border border-p01-pink/30 flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-p01-pink flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-mono font-bold text-p01-pink tracking-wider">[ WARNING ]</p>
                <p className="text-[10px] text-p01-pink/80 mt-1 font-mono">
                  Write these 12 words down. Never share them with anyone.
                </p>
              </div>
            </div>


            {/* Seed Phrase Grid */}
            <div className="bg-p01-surface border border-p01-border p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-p01-chrome/60 font-mono tracking-wider">
                  SEED PHRASE
                </span>
                <button
                  onClick={() => setShowPhrase(!showPhrase)}
                  className="flex items-center gap-1 text-[10px] text-p01-cyan font-mono tracking-wider"
                >
                  {showPhrase ? (
                    <>
                      <EyeOff className="w-3 h-3" /> HIDE
                    </>
                  ) : (
                    <>
                      <Eye className="w-3 h-3" /> SHOW
                    </>
                  )}
                </button>
              </div>

              <div className="grid grid-cols-3 gap-1">
                {seedPhrase.map((word, index) => (
                  <div
                    key={index}
                    className="flex items-center gap-1 p-2 bg-p01-dark border border-p01-border"
                  >
                    <span className="text-[10px] text-p01-chrome/40 font-mono w-4">
                      {index + 1}.
                    </span>
                    <span className="text-xs text-white font-mono">
                      {showPhrase ? word : '•••••'}
                    </span>
                  </div>
                ))}
              </div>

              {/* Copy Button */}
              <button
                onClick={handleCopySeedPhrase}
                className="w-full mt-3 py-2 bg-p01-dark border border-p01-border text-p01-chrome font-mono text-[10px] flex items-center justify-center gap-2 hover:text-white hover:border-p01-cyan/30 transition-colors tracking-wider"
              >
                {copied ? (
                  <>
                    <Check className="w-3 h-3 text-p01-cyan" />
                    COPIED
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3" />
                    COPY TO CLIPBOARD
                  </>
                )}
              </button>
            </div>

            {/* Confirm Checkbox */}
            <label className="flex items-start gap-3 p-3 bg-p01-surface border border-p01-border cursor-pointer">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                className="mt-0.5 w-4 h-4 accent-p01-cyan"
              />
              <span className="text-[11px] text-p01-chrome font-mono">
                I have copied and saved my seed phrase securely.
              </span>
            </label>

            {/* Complete Button - requires copy + confirm */}
            <button
              onClick={handleComplete}
              disabled={!confirmed || !copied}
              className={cn(
                'w-full py-4 font-display font-bold text-sm tracking-wider transition-colors',
                !confirmed || !copied
                  ? 'bg-p01-border text-p01-chrome/40 cursor-not-allowed'
                  : 'bg-p01-cyan text-p01-void hover:bg-p01-cyan-dim'
              )}
            >
              {!copied ? 'COPY SEED PHRASE FIRST' : 'COMPLETE SETUP'}
            </button>
          </motion.div>
        )}

      </div>
    </div>
  );
}

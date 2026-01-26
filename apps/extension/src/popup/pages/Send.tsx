import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  AlertCircle,
  Shield,
  ShieldCheck,
  ChevronRight,
  EyeOff,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useWalletStore } from '@/shared/store/wallet';
import { usePrivacyStore, getPrivacyScoreColor, getPrivacyScoreLabel } from '@/shared/store/privacy';
import { isValidSolanaAddress } from '@/shared/services/wallet';
import { parseMetaAddress, generateStealthAddress } from '@/shared/services/stealth';
import { calculatePrivacyScore } from '@/shared/services/privacyZone';
import { cn } from '@/shared/utils';

export default function Send() {
  const navigate = useNavigate();
  const { solBalance, network } = useWalletStore();
  const { config: privacyConfig, walletPrivacyScore, protectTransaction } = usePrivacyStore();

  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [localError, setLocalError] = useState('');
  const [highPrivacy, setHighPrivacy] = useState(false);

  // Stealth address detection
  const [isStealthSend, setIsStealthSend] = useState(false);
  const [stealthAddressValid, setStealthAddressValid] = useState(false);

  // Check if recipient is a meta-address (stealth)
  useEffect(() => {
    if (recipient.startsWith('st:')) {
      setIsStealthSend(true);
      try {
        parseMetaAddress(recipient);
        setStealthAddressValid(true);
        setLocalError('');
      } catch (e) {
        setStealthAddressValid(false);
        if (recipient.length > 10) {
          setLocalError('Invalid stealth meta-address format');
        }
      }
    } else {
      setIsStealthSend(false);
      setStealthAddressValid(false);
    }
  }, [recipient]);

  // Calculate estimated privacy score for current transaction
  // Stealth sends get maximum privacy score
  const estimatedPrivacyScore = amount && parseFloat(amount) > 0
    ? isStealthSend && stealthAddressValid
      ? 100 // Maximum privacy for stealth sends
      : calculatePrivacyScore({
          id: 'preview',
          recipient: recipient || 'preview',
          amount: parseFloat(amount),
          timestamp: Date.now(),
          priority: highPrivacy ? 'high' : 'normal',
        }) + (highPrivacy ? 20 : 0)
    : walletPrivacyScore;

  const handleContinue = async () => {
    setLocalError('');

    if (!recipient) {
      setLocalError('Please enter a recipient address');
      return;
    }

    // Handle stealth address
    if (isStealthSend) {
      if (!stealthAddressValid) {
        setLocalError('Invalid stealth meta-address');
        return;
      }
    } else {
      // Normal address validation
      if (!isValidSolanaAddress(recipient)) {
        setLocalError('Invalid Solana address');
        return;
      }
    }

    if (!amount || parseFloat(amount) <= 0) {
      setLocalError('Please enter a valid amount');
      return;
    }

    if (parseFloat(amount) > solBalance) {
      setLocalError('Insufficient balance');
      return;
    }

    // Apply privacy protection if enabled (not needed for stealth)
    if (!isStealthSend && (privacyConfig.enabled || highPrivacy)) {
      protectTransaction(recipient, parseFloat(amount), highPrivacy);
    }

    // For stealth sends, we need to generate the stealth address
    if (isStealthSend && stealthAddressValid) {
      try {
        const { stealthAddress, ephemeralPubKey } = await generateStealthAddress(recipient);

        navigate('/send/confirm', {
          state: {
            recipient: stealthAddress.toBase58(),
            amount: parseFloat(amount),
            highPrivacy: true,
            isStealthSend: true,
            ephemeralPubKey: Array.from(ephemeralPubKey), // Convert to array for serialization
            originalMetaAddress: recipient,
          },
        });
      } catch (e) {
        setLocalError('Failed to generate stealth address');
      }
    } else {
      navigate('/send/confirm', {
        state: { recipient, amount: parseFloat(amount), highPrivacy },
      });
    }
  };

  const percentButtons = [25, 50, 75, 100];

  return (
    <div className="flex flex-col h-full bg-p01-void">
      {/* Header - Industrial */}
      <div className="flex items-center gap-3 p-3 border-b border-p01-border bg-p01-surface">
        <button
          onClick={() => navigate(-1)}
          className="p-2 -ml-2 hover:bg-p01-border transition-colors"
        >
          <ArrowLeft className="w-4 h-4 text-p01-chrome" />
        </button>
        <h1 className="text-sm font-mono font-bold text-white tracking-wider">SEND SOL</h1>

        {/* Stealth Send Badge */}
        <AnimatePresence>
          {isStealthSend && stealthAddressValid && (
            <motion.div
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              className="ml-auto flex items-center gap-1.5 px-2 py-1 bg-p01-cyan/20 border border-p01-cyan rounded text-p01-cyan"
            >
              <EyeOff className="w-3 h-3" />
              <span className="text-[10px] font-mono font-bold tracking-wider">PRIVATE</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Network Badge */}
        {network === 'devnet' && (
          <div className="flex justify-center">
            <span className="px-2 py-0.5 text-[9px] font-mono font-bold bg-yellow-500/10 text-yellow-500 border border-yellow-500/30 tracking-wider">
              [ DEVNET ]
            </span>
          </div>
        )}

        {/* Available Balance */}
        <div className="bg-p01-surface border border-p01-border p-3 rounded-lg">
          <p className="text-[10px] text-[#555560] font-mono tracking-wider mb-1">
            AVAILABLE BALANCE
          </p>
          <p className="text-lg font-mono font-bold text-white">{solBalance.toFixed(4)} SOL</p>
        </div>

        {/* Stealth Send Info Banner */}
        <AnimatePresence>
          {isStealthSend && stealthAddressValid && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="bg-p01-cyan/10 border border-p01-cyan/30 p-3 rounded-lg"
            >
              <div className="flex items-start gap-2">
                <EyeOff className="w-4 h-4 text-p01-cyan flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-[10px] font-mono font-bold text-p01-cyan tracking-wider mb-1">
                    [ STEALTH SEND DETECTED ]
                  </p>
                  <p className="text-[10px] text-p01-chrome font-mono leading-relaxed">
                    This payment will be sent to a unique stealth address. The recipient&apos;s
                    identity will remain private and unlinkable to their main wallet.
                  </p>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Recipient Input */}
        <div>
          <label className="text-[10px] text-[#555560] mb-1.5 block font-mono tracking-wider">
            RECIPIENT ADDRESS {isStealthSend && <span className="text-p01-cyan">(STEALTH)</span>}
          </label>
          <div className="relative">
            <input
              type="text"
              value={recipient}
              onChange={(e) => {
                setRecipient(e.target.value);
                setLocalError('');
              }}
              placeholder="Enter Solana address or st:01... meta-address"
              className={cn(
                'w-full bg-p01-surface border px-3 py-2.5 text-xs font-mono text-white placeholder-[#555560] focus:outline-none transition-colors rounded-lg',
                isStealthSend && stealthAddressValid
                  ? 'border-p01-cyan focus:border-p01-cyan'
                  : 'border-p01-border focus:border-p01-cyan'
              )}
            />
            {isStealthSend && stealthAddressValid && (
              <div className="absolute right-3 top-1/2 -translate-y-1/2">
                <EyeOff className="w-4 h-4 text-p01-cyan" />
              </div>
            )}
          </div>
        </div>

        {/* Amount Input */}
        <div>
          <label className="text-[10px] text-[#555560] mb-1.5 block font-mono tracking-wider">
            AMOUNT (SOL)
          </label>
          <div className="bg-p01-surface border border-p01-border p-4 rounded-lg">
            <input
              type="number"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setLocalError('');
              }}
              placeholder="0.00"
              step="0.0001"
              min="0"
              max={solBalance}
              className="w-full bg-transparent text-2xl font-mono font-bold text-white placeholder-[#555560] focus:outline-none"
            />
            <div className="flex gap-2 mt-3">
              {percentButtons.map((percent) => (
                <button
                  key={percent}
                  onClick={() => {
                    // Leave some for fees
                    const maxAmount = Math.max(0, solBalance - 0.001);
                    setAmount(String(((maxAmount * percent) / 100).toFixed(4)));
                    setLocalError('');
                  }}
                  className="flex-1 py-1.5 text-[10px] font-mono font-medium bg-p01-dark border border-p01-border text-p01-chrome hover:border-p01-cyan/50 hover:text-white transition-colors tracking-wider rounded"
                >
                  {percent}%
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Error */}
        {localError && (
          <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/30 text-red-400 rounded-lg">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span className="text-xs font-mono">{localError}</span>
          </div>
        )}

        {/* Privacy Zone Section - Hidden for stealth sends */}
        {!isStealthSend && (
          <div className="bg-p01-surface border border-p01-border p-3 rounded-lg">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                {privacyConfig.enabled ? (
                  <ShieldCheck className="w-4 h-4 text-p01-cyan" />
                ) : (
                  <Shield className="w-4 h-4 text-p01-chrome/60" />
                )}
                <span className="text-[10px] text-[#555560] font-mono tracking-wider">
                  PRIVACY ZONE
                </span>
              </div>
              <button
                onClick={() => navigate('/privacy')}
                className="flex items-center gap-1 text-[10px] text-p01-cyan hover:underline"
              >
                Settings
                <ChevronRight className="w-3 h-3" />
              </button>
            </div>

            {/* Privacy Score Preview */}
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs text-p01-chrome">Transaction Privacy Score</span>
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'text-sm font-mono font-bold',
                    getPrivacyScoreColor(Math.min(100, estimatedPrivacyScore))
                  )}
                >
                  {Math.min(100, estimatedPrivacyScore)}
                </span>
                <span className="text-[10px] text-p01-chrome/60">
                  ({getPrivacyScoreLabel(Math.min(100, estimatedPrivacyScore))})
                </span>
              </div>
            </div>

            {/* High Privacy Toggle */}
            <button
              onClick={() => setHighPrivacy(!highPrivacy)}
              className={cn(
                'w-full flex items-center justify-between p-2.5 rounded transition-colors',
                highPrivacy
                  ? 'bg-p01-cyan/20 border border-p01-cyan/40'
                  : 'bg-p01-dark border border-p01-border hover:border-p01-cyan/30'
              )}
            >
              <div className="flex items-center gap-2">
                <ShieldCheck
                  className={cn('w-4 h-4', highPrivacy ? 'text-p01-cyan' : 'text-p01-chrome/60')}
                />
                <span
                  className={cn('text-xs font-mono', highPrivacy ? 'text-p01-cyan' : 'text-p01-chrome')}
                >
                  HIGH PRIVACY MODE
                </span>
              </div>
              <div
                className={cn(
                  'w-8 h-5 rounded-full transition-colors relative',
                  highPrivacy ? 'bg-p01-cyan' : 'bg-p01-border'
                )}
              >
                <motion.span
                  layout
                  transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                  className={cn(
                    'absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-md',
                    highPrivacy ? 'left-3.5' : 'left-0.5'
                  )}
                />
              </div>
            </button>

            {highPrivacy && (
              <motion.p
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                className="text-[10px] text-p01-cyan/80 mt-2"
              >
                Max decoys, mixing, and timing obfuscation will be applied
              </motion.p>
            )}

            {!privacyConfig.enabled && !highPrivacy && (
              <p className="text-[10px] text-p01-chrome/60 mt-2">
                Enable Privacy Zone or High Privacy for enhanced protection
              </p>
            )}
          </div>
        )}

        {/* Stealth Privacy Badge - Shown for stealth sends */}
        {isStealthSend && stealthAddressValid && (
          <div className="bg-p01-cyan/10 border border-p01-cyan/30 p-3 rounded-lg">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-p01-cyan" />
                <span className="text-[10px] text-p01-cyan font-mono tracking-wider">
                  MAXIMUM PRIVACY
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-mono font-bold text-p01-cyan">100</span>
                <span className="text-[10px] text-p01-cyan/60">(STEALTH)</span>
              </div>
            </div>
            <p className="text-[10px] text-p01-chrome/70 mt-2">
              Stealth addresses provide the highest level of privacy. The recipient&apos;s address
              will be completely unlinkable.
            </p>
          </div>
        )}

        {/* Fee estimate */}
        <div className="bg-p01-surface border border-p01-border p-3 rounded-lg">
          <div className="flex justify-between items-center">
            <span className="text-[10px] text-[#555560] font-mono tracking-wider">
              ESTIMATED FEE
            </span>
            <span className="text-xs text-p01-chrome font-mono">~0.000005 SOL</span>
          </div>
        </div>
      </div>

      {/* Continue Button */}
      <div className="p-3 border-t border-p01-border bg-p01-surface">
        <button
          onClick={handleContinue}
          disabled={!recipient || !amount || (isStealthSend && !stealthAddressValid)}
          className={cn(
            'w-full py-3 font-display font-bold text-sm tracking-wider transition-colors rounded-lg flex items-center justify-center gap-2',
            !recipient || !amount || (isStealthSend && !stealthAddressValid)
              ? 'bg-p01-border text-p01-chrome/40 cursor-not-allowed'
              : isStealthSend && stealthAddressValid
              ? 'bg-p01-cyan text-p01-void hover:bg-p01-cyan-dim'
              : 'bg-p01-cyan text-p01-void hover:bg-p01-cyan-dim'
          )}
        >
          {isStealthSend && stealthAddressValid && <EyeOff className="w-4 h-4" />}
          {isStealthSend && stealthAddressValid ? 'SEND PRIVATELY' : 'CONTINUE'}
        </button>
      </div>
    </div>
  );
}

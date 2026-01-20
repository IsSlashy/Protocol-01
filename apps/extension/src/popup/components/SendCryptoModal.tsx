/**
 * Send Crypto Modal
 * Modal for sending crypto directly in chat
 */

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Send, AlertCircle, Loader2 } from 'lucide-react';
import { cn, truncateAddress } from '@/shared/utils';
import { useWalletStore } from '@/shared/store/wallet';
import { validatePaymentAmount } from '@/shared/services/paymentRequest';
import TokenSelector, { TokenOption } from './TokenSelector';

interface SendCryptoModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: {
    amount: number;
    token: string;
    tokenMint?: string;
    note?: string;
  }) => Promise<void>;
  contactName?: string;
  contactAddress: string;
  isProcessing?: boolean;
}

export default function SendCryptoModal({
  isOpen,
  onClose,
  onSubmit,
  contactName,
  contactAddress,
  isProcessing = false,
}: SendCryptoModalProps) {
  const { solBalance, tokens } = useWalletStore();
  const [amount, setAmount] = useState('');
  const [selectedToken, setSelectedToken] = useState<TokenOption>({
    symbol: 'SOL',
    name: 'Solana',
    balance: solBalance,
    decimals: 9,
  });
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  // Get current balance for selected token
  const getCurrentBalance = (): number => {
    if (selectedToken.symbol === 'SOL') {
      return solBalance;
    }
    const token = tokens.find(t => t.mint === selectedToken.mint);
    return token ? parseFloat(token.uiBalance) : 0;
  };

  const currentBalance = getCurrentBalance();

  const handleSubmit = async () => {
    setError('');

    const parsedAmount = parseFloat(amount);
    const validation = validatePaymentAmount(parsedAmount, currentBalance, selectedToken.symbol);

    if (!validation.valid) {
      setError(validation.error || 'Invalid amount');
      return;
    }

    try {
      await onSubmit({
        amount: parsedAmount,
        token: selectedToken.symbol,
        tokenMint: selectedToken.mint,
        note: note.trim() || undefined,
      });

      // Reset form
      setAmount('');
      setNote('');
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleTokenSelect = (token: TokenOption) => {
    setSelectedToken(token);
    setError('');
  };

  const handlePercentage = (percent: number) => {
    // Reserve some for fees on SOL
    const minReserve = selectedToken.symbol === 'SOL' ? 0.001 : 0;
    const availableBalance = Math.max(0, currentBalance - minReserve);
    const newAmount = (availableBalance * percent) / 100;
    setAmount(newAmount.toFixed(4));
    setError('');
  };

  const displayName = contactName || truncateAddress(contactAddress, 4);
  const percentButtons = [25, 50, 75, 100];

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/60 z-40"
          />

          {/* Modal */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ type: 'spring', duration: 0.3 }}
            className="fixed inset-x-4 top-1/2 -translate-y-1/2 z-50 max-h-[80vh] overflow-y-auto"
          >
            <div className="bg-p01-surface border border-p01-border rounded-2xl shadow-2xl">
              {/* Header */}
              <div className="flex items-center justify-between p-4 border-b border-p01-border">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-green-500 to-emerald-600 flex items-center justify-center">
                    <Send className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <h2 className="text-white font-display font-bold">Send Crypto</h2>
                    <p className="text-p01-chrome text-xs">to @{displayName}</p>
                  </div>
                </div>
                <button
                  onClick={onClose}
                  disabled={isProcessing}
                  className="p-2 text-p01-chrome hover:text-white transition-colors disabled:opacity-50"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Content */}
              <div className="p-4 space-y-4">
                {/* Amount Input with Token Selector */}
                <div>
                  <label className="text-[10px] text-p01-chrome/60 mb-1.5 block font-mono tracking-wider">
                    AMOUNT
                  </label>
                  <div className="flex gap-2">
                    <div className="flex-1 relative">
                      <input
                        type="number"
                        value={amount}
                        onChange={(e) => {
                          setAmount(e.target.value);
                          setError('');
                        }}
                        placeholder="0.00"
                        step="0.0001"
                        min="0"
                        disabled={isProcessing}
                        className="w-full px-4 py-3 bg-p01-dark border border-p01-border rounded-xl text-white text-lg font-mono placeholder-p01-chrome/40 focus:outline-none focus:border-p01-cyan disabled:opacity-50"
                      />
                    </div>
                    <TokenSelector
                      selectedToken={selectedToken.symbol}
                      onSelect={handleTokenSelect}
                      disabled={isProcessing}
                    />
                  </div>

                  {/* Percentage Buttons */}
                  <div className="flex gap-2 mt-2">
                    {percentButtons.map((percent) => (
                      <button
                        key={percent}
                        onClick={() => handlePercentage(percent)}
                        disabled={isProcessing}
                        className="flex-1 py-1.5 text-[10px] font-mono font-medium bg-p01-dark border border-p01-border text-p01-chrome hover:border-p01-cyan/50 hover:text-white transition-colors tracking-wider rounded disabled:opacity-50"
                      >
                        {percent}%
                      </button>
                    ))}
                  </div>
                </div>

                {/* Balance Display */}
                <div className="p-3 bg-p01-dark border border-p01-border rounded-xl">
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] text-p01-chrome/60 font-mono tracking-wider">
                      AVAILABLE BALANCE
                    </span>
                    <span className="text-sm font-mono text-white">
                      {currentBalance.toFixed(4)} {selectedToken.symbol}
                    </span>
                  </div>
                </div>

                {/* Note Input */}
                <div>
                  <label className="text-[10px] text-p01-chrome/60 mb-1.5 block font-mono tracking-wider">
                    NOTE (OPTIONAL)
                  </label>
                  <input
                    type="text"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Add a message..."
                    maxLength={100}
                    disabled={isProcessing}
                    className="w-full px-4 py-3 bg-p01-dark border border-p01-border rounded-xl text-white text-sm font-mono placeholder-p01-chrome/40 focus:outline-none focus:border-p01-cyan disabled:opacity-50"
                  />
                </div>

                {/* Error */}
                {error && (
                  <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/30 text-red-400 rounded-xl">
                    <AlertCircle className="w-4 h-4 flex-shrink-0" />
                    <span className="text-xs font-mono">{error}</span>
                  </div>
                )}

                {/* Preview */}
                {amount && parseFloat(amount) > 0 && (
                  <div className="p-3 bg-p01-dark border border-p01-border rounded-xl">
                    <p className="text-[10px] text-p01-chrome/60 font-mono tracking-wider mb-1">
                      PREVIEW
                    </p>
                    <p className="text-white text-sm">
                      Sending <span className="font-mono font-bold text-green-400">{parseFloat(amount).toFixed(4)} {selectedToken.symbol}</span> to @{displayName}
                      {note && <span className="text-p01-chrome"> - "{note}"</span>}
                    </p>
                    <p className="text-p01-chrome/60 text-xs mt-1">
                      Network fee: ~0.000005 SOL
                    </p>
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="flex gap-3 p-4 border-t border-p01-border">
                <button
                  onClick={onClose}
                  disabled={isProcessing}
                  className="flex-1 py-3 bg-p01-dark border border-p01-border rounded-xl text-p01-chrome font-display font-bold text-sm tracking-wider hover:text-white hover:border-p01-border transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={!amount || parseFloat(amount) <= 0 || isProcessing}
                  className={cn(
                    'flex-1 py-3 rounded-xl font-display font-bold text-sm tracking-wider transition-colors flex items-center justify-center gap-2',
                    !amount || parseFloat(amount) <= 0 || isProcessing
                      ? 'bg-p01-border text-p01-chrome/40 cursor-not-allowed'
                      : 'bg-green-500 text-white hover:bg-green-600'
                  )}
                >
                  {isProcessing ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Sending...
                    </>
                  ) : (
                    <>
                      <Send className="w-4 h-4" />
                      Send
                    </>
                  )}
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

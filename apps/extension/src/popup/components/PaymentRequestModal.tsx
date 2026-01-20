/**
 * Payment Request Modal
 * Modal for creating a payment request in chat
 */

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, DollarSign, AlertCircle, Clock } from 'lucide-react';
import { cn, truncateAddress } from '@/shared/utils';
import TokenSelector, { TokenOption } from './TokenSelector';

interface PaymentRequestModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: {
    amount: number;
    token: string;
    tokenMint?: string;
    note?: string;
    expiresIn?: number;
  }) => void;
  contactName?: string;
  contactAddress: string;
}

// Expiration options in seconds
const EXPIRATION_OPTIONS = [
  { label: 'No expiration', value: undefined },
  { label: '1 hour', value: 3600 },
  { label: '24 hours', value: 86400 },
  { label: '7 days', value: 604800 },
];

export default function PaymentRequestModal({
  isOpen,
  onClose,
  onSubmit,
  contactName,
  contactAddress,
}: PaymentRequestModalProps) {
  const [amount, setAmount] = useState('');
  const [selectedToken, setSelectedToken] = useState<TokenOption>({
    symbol: 'SOL',
    name: 'Solana',
    balance: 0,
    decimals: 9,
  });
  const [note, setNote] = useState('');
  const [expiresIn, setExpiresIn] = useState<number | undefined>(undefined);
  const [error, setError] = useState('');

  const handleSubmit = () => {
    setError('');

    if (!amount || parseFloat(amount) <= 0) {
      setError('Please enter a valid amount');
      return;
    }

    onSubmit({
      amount: parseFloat(amount),
      token: selectedToken.symbol,
      tokenMint: selectedToken.mint,
      note: note.trim() || undefined,
      expiresIn,
    });

    // Reset form
    setAmount('');
    setNote('');
    setExpiresIn(undefined);
    onClose();
  };

  const handleTokenSelect = (token: TokenOption) => {
    setSelectedToken(token);
  };

  const displayName = contactName || truncateAddress(contactAddress, 4);

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
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-p01-pink to-purple-600 flex items-center justify-center">
                    <DollarSign className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <h2 className="text-white font-display font-bold">Request Payment</h2>
                    <p className="text-p01-chrome text-xs">from @{displayName}</p>
                  </div>
                </div>
                <button
                  onClick={onClose}
                  className="p-2 text-p01-chrome hover:text-white transition-colors"
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
                        className="w-full px-4 py-3 bg-p01-dark border border-p01-border rounded-xl text-white text-lg font-mono placeholder-p01-chrome/40 focus:outline-none focus:border-p01-cyan"
                      />
                    </div>
                    <TokenSelector
                      selectedToken={selectedToken.symbol}
                      onSelect={handleTokenSelect}
                    />
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
                    placeholder="What's this for?"
                    maxLength={100}
                    className="w-full px-4 py-3 bg-p01-dark border border-p01-border rounded-xl text-white text-sm font-mono placeholder-p01-chrome/40 focus:outline-none focus:border-p01-cyan"
                  />
                </div>

                {/* Expiration Selector */}
                <div>
                  <label className="text-[10px] text-p01-chrome/60 mb-1.5 block font-mono tracking-wider">
                    EXPIRES
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {EXPIRATION_OPTIONS.map((option) => (
                      <button
                        key={option.label}
                        onClick={() => setExpiresIn(option.value)}
                        className={cn(
                          'px-3 py-2 rounded-lg text-xs font-mono transition-colors',
                          expiresIn === option.value
                            ? 'bg-p01-cyan text-p01-void'
                            : 'bg-p01-dark border border-p01-border text-p01-chrome hover:text-white hover:border-p01-cyan/50'
                        )}
                      >
                        {option.value && <Clock className="w-3 h-3 inline mr-1" />}
                        {option.label}
                      </button>
                    ))}
                  </div>
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
                      Requesting <span className="font-mono font-bold text-p01-cyan">{parseFloat(amount).toFixed(4)} {selectedToken.symbol}</span> from @{displayName}
                      {note && <span className="text-p01-chrome"> - "{note}"</span>}
                    </p>
                    {expiresIn && (
                      <p className="text-p01-chrome/60 text-xs mt-1 flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        Expires in {EXPIRATION_OPTIONS.find(o => o.value === expiresIn)?.label}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="flex gap-3 p-4 border-t border-p01-border">
                <button
                  onClick={onClose}
                  className="flex-1 py-3 bg-p01-dark border border-p01-border rounded-xl text-p01-chrome font-display font-bold text-sm tracking-wider hover:text-white hover:border-p01-border transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={!amount || parseFloat(amount) <= 0}
                  className={cn(
                    'flex-1 py-3 rounded-xl font-display font-bold text-sm tracking-wider transition-colors',
                    amount && parseFloat(amount) > 0
                      ? 'bg-p01-cyan text-p01-void hover:bg-p01-cyan/90'
                      : 'bg-p01-border text-p01-chrome/40 cursor-not-allowed'
                  )}
                >
                  Request
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

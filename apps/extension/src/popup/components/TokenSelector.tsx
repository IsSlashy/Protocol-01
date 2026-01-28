/**
 * Token Selector Component
 * Dropdown for selecting tokens with balance display
 */

import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, Check } from 'lucide-react';
import { cn } from '@/shared/utils';
import { useWalletStore, TokenBalance } from '@/shared/store/wallet';
import { KNOWN_TOKENS } from '@/shared/services/paymentRequest';

export interface TokenOption {
  symbol: string;
  name: string;
  mint?: string;
  balance: number;
  decimals: number;
  icon?: string;
}

interface TokenSelectorProps {
  selectedToken: string;
  onSelect: (token: TokenOption) => void;
  className?: string;
  disabled?: boolean;
}

// Token icon colors for gradient backgrounds
const TOKEN_COLORS: Record<string, { from: string; to: string }> = {
  SOL: { from: 'from-[#9945FF]', to: 'to-[#14F195]' },
  USDC: { from: 'from-[#2775CA]', to: 'to-[#2775CA]' },
  USDT: { from: 'from-[#50AF95]', to: 'to-[#50AF95]' },
  BONK: { from: 'from-[#F5A623]', to: 'to-[#F5A623]' },
};

export default function TokenSelector({
  selectedToken,
  onSelect,
  className,
  disabled = false,
}: TokenSelectorProps) {
  const { solBalance, tokens } = useWalletStore();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Build token options from wallet balances
  const tokenOptions: TokenOption[] = [
    {
      symbol: 'SOL',
      name: 'Solana',
      mint: KNOWN_TOKENS.SOL.mint,
      balance: solBalance,
      decimals: 9,
    },
    // Add SPL tokens from wallet
    ...tokens.map((token: TokenBalance) => ({
      symbol: getSymbolFromMint(token.mint),
      name: getTokenName(token.mint),
      mint: token.mint,
      balance: parseFloat(token.uiBalance),
      decimals: token.decimals,
    })),
  ];

  // Filter to only show known tokens with balance
  const availableTokens = tokenOptions.filter(
    (t) => t.balance > 0 || t.symbol === 'SOL'
  );

  const selectedTokenOption = availableTokens.find((t) => t.symbol === selectedToken) ||
    availableTokens[0];

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = (token: TokenOption) => {
    onSelect(token);
    setIsOpen(false);
  };

  return (
    <div ref={dropdownRef} className={cn('relative', className)}>
      {/* Selected Token Button */}
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={cn(
          'flex items-center gap-2 px-3 py-2 bg-p01-surface border border-p01-border rounded-xl',
          'hover:border-p01-cyan/50 transition-colors min-w-[100px]',
          disabled && 'opacity-50 cursor-not-allowed hover:border-p01-border'
        )}
      >
        {/* Token Icon */}
        <div
          className={cn(
            'w-5 h-5 rounded-full bg-gradient-to-br flex items-center justify-center',
            TOKEN_COLORS[selectedTokenOption.symbol]?.from || 'from-p01-pink',
            TOKEN_COLORS[selectedTokenOption.symbol]?.to || 'to-p01-cyan'
          )}
        >
          <span className="text-[8px] font-bold text-white">
            {selectedTokenOption.symbol[0]}
          </span>
        </div>

        {/* Token Symbol */}
        <span className="text-sm font-mono font-medium text-white">
          {selectedTokenOption.symbol}
        </span>

        {/* Dropdown Arrow */}
        <ChevronDown
          className={cn(
            'w-4 h-4 text-p01-chrome transition-transform',
            isOpen && 'rotate-180'
          )}
        />
      </button>

      {/* Dropdown Menu */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: -10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className="absolute z-50 top-full mt-2 right-0 min-w-[180px] bg-p01-surface border border-p01-border rounded-xl shadow-xl overflow-hidden"
          >
            <div className="py-1">
              {availableTokens.map((token) => (
                <button
                  key={token.symbol}
                  onClick={() => handleSelect(token)}
                  className={cn(
                    'w-full flex items-center gap-3 px-3 py-2.5 hover:bg-p01-elevated transition-colors',
                    token.symbol === selectedToken && 'bg-p01-elevated'
                  )}
                >
                  {/* Token Icon */}
                  <div
                    className={cn(
                      'w-6 h-6 rounded-full bg-gradient-to-br flex items-center justify-center',
                      TOKEN_COLORS[token.symbol]?.from || 'from-p01-pink',
                      TOKEN_COLORS[token.symbol]?.to || 'to-p01-cyan'
                    )}
                  >
                    <span className="text-[10px] font-bold text-white">
                      {token.symbol[0]}
                    </span>
                  </div>

                  {/* Token Info */}
                  <div className="flex-1 text-left">
                    <p className="text-sm font-mono font-medium text-white">
                      {token.symbol}
                    </p>
                    <p className="text-[10px] text-p01-chrome">
                      {token.balance.toFixed(4)}
                    </p>
                  </div>

                  {/* Check Mark */}
                  {token.symbol === selectedToken && (
                    <Check className="w-4 h-4 text-p01-cyan" />
                  )}
                </button>
              ))}

              {availableTokens.length === 0 && (
                <div className="px-3 py-4 text-center">
                  <p className="text-sm text-p01-chrome">No tokens available</p>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Helper functions
function getSymbolFromMint(mint: string): string {
  for (const [symbol, info] of Object.entries(KNOWN_TOKENS) as [string, { mint: string }][]) {
    if (info.mint === mint) {
      return symbol;
    }
  }
  return 'SPL';
}

function getTokenName(mint: string): string {
  const names: Record<string, string> = {
    [KNOWN_TOKENS.SOL.mint]: 'Solana',
    [KNOWN_TOKENS.USDC.mint]: 'USD Coin',
    [KNOWN_TOKENS.USDT.mint]: 'Tether',
    [KNOWN_TOKENS.BONK.mint]: 'Bonk',
  };
  return names[mint] || 'Unknown Token';
}

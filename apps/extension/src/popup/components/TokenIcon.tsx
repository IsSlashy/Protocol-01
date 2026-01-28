import { useState } from 'react';
import { cn } from '@/shared/utils';

// Local fallback logos for common tokens
const TOKEN_LOGOS: Record<string, string> = {
  SOL: 'https://assets.coingecko.com/coins/images/4128/small/solana.png',
  USDC: 'https://assets.coingecko.com/coins/images/6319/small/USD_Coin_icon.png',
  USDT: 'https://assets.coingecko.com/coins/images/325/small/Tether.png',
  BONK: 'https://assets.coingecko.com/coins/images/28600/small/bonk.jpg',
  JUP: 'https://assets.coingecko.com/coins/images/34188/small/jup.png',
  RAY: 'https://assets.coingecko.com/coins/images/13928/small/PSigc4ie_400x400.jpg',
  ORCA: 'https://assets.coingecko.com/coins/images/17547/small/Orca_Logo.png',
  PYTH: 'https://assets.coingecko.com/coins/images/31924/small/pyth.png',
  JTO: 'https://assets.coingecko.com/coins/images/33103/small/jto.png',
  WIF: 'https://assets.coingecko.com/coins/images/33566/small/dogwifhat.jpg',
  WSOL: 'https://assets.coingecko.com/coins/images/4128/small/solana.png',
};

// Gradient colors for fallback
const GRADIENT_COLORS = [
  'from-cyan-500 to-blue-600',
  'from-purple-500 to-pink-600',
  'from-orange-500 to-red-600',
  'from-green-500 to-teal-600',
  'from-yellow-500 to-orange-600',
];

interface TokenIconProps {
  symbol: string;
  logoURI?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export default function TokenIcon({ symbol, logoURI, size = 'md', className }: TokenIconProps) {
  const [imageError, setImageError] = useState(false);

  const sizeClasses = {
    sm: 'w-6 h-6 text-[10px]',
    md: 'w-10 h-10 text-sm',
    lg: 'w-12 h-12 text-base',
  };

  // Try to get a working logo URL
  const getLogoUrl = (): string | null => {
    // First try the symbol lookup
    const symbolUpper = symbol.toUpperCase();
    if (TOKEN_LOGOS[symbolUpper]) {
      return TOKEN_LOGOS[symbolUpper];
    }
    // Then try the provided logoURI
    if (logoURI) {
      return logoURI;
    }
    return null;
  };

  const logoUrl = getLogoUrl();
  const showImage = logoUrl && !imageError;

  // Get a consistent gradient based on symbol
  const gradientIndex = symbol.charCodeAt(0) % GRADIENT_COLORS.length;
  const gradient = GRADIENT_COLORS[gradientIndex];

  if (showImage) {
    return (
      <img
        src={logoUrl}
        alt={symbol}
        className={cn(
          'rounded-full object-cover',
          sizeClasses[size],
          className
        )}
        onError={() => setImageError(true)}
      />
    );
  }

  // Fallback: gradient circle with symbol initials
  return (
    <div
      className={cn(
        'rounded-full flex items-center justify-center bg-gradient-to-br font-bold text-white',
        gradient,
        sizeClasses[size],
        className
      )}
    >
      {symbol.slice(0, 2).toUpperCase()}
    </div>
  );
}

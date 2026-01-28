import { cn } from '@/shared/utils';

// Token colors for gradient fallback
const TOKEN_COLORS: Record<string, [string, string]> = {
  SOL: ['#9945FF', '#14F195'],
  USDC: ['#2775CA', '#2775CA'],
  USDT: ['#26A17B', '#26A17B'],
  BONK: ['#F7931A', '#F7931A'],
  JUP: ['#00D18C', '#00D18C'],
  RAY: ['#5AC4BE', '#5AC4BE'],
  ORCA: ['#FFD15C', '#FFD15C'],
  PYTH: ['#E6DAFE', '#E6DAFE'],
};

const DEFAULT_GRADIENTS: [string, string][] = [
  ['#39c5bb', '#00ffe5'],
  ['#9333ea', '#ec4899'],
  ['#f97316', '#ef4444'],
  ['#22c55e', '#14b8a6'],
  ['#eab308', '#f97316'],
];

interface TokenIconProps {
  symbol: string;
  logoURI?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export default function TokenIcon({ symbol, logoURI, size = 'md', className }: TokenIconProps) {
  const sizeConfig = {
    sm: { container: 'w-6 h-6', text: 'text-[10px]' },
    md: { container: 'w-10 h-10', text: 'text-sm' },
    lg: { container: 'w-12 h-12', text: 'text-base' },
  };

  const config = sizeConfig[size];
  const symbolUpper = symbol.toUpperCase();

  // Get colors for this token
  const colors = TOKEN_COLORS[symbolUpper] || DEFAULT_GRADIENTS[symbol.charCodeAt(0) % DEFAULT_GRADIENTS.length];

  // Always show gradient circle with first letter - no external images to avoid CORS
  return (
    <div
      className={cn(
        'rounded-full flex items-center justify-center flex-shrink-0',
        config.container,
        className
      )}
      style={{
        background: `linear-gradient(135deg, ${colors[0]}, ${colors[1]})`,
      }}
    >
      <span className={cn('font-bold text-white', config.text)}>
        {symbolUpper.charAt(0)}
      </span>
    </div>
  );
}

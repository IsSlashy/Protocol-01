"use client";

/**
 * Inline token logos (self-contained SVG — no network/image deps).
 * SOL and ETH use authentic brand marks so users recognize the asset;
 * STRK is a stylized Starknet mark (coming-soon; swap for the exact asset later).
 */

function Solana({ s }: { s: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 100 80" aria-label="Solana" role="img">
      <defs>
        <linearGradient id="sol-g" x1="0" y1="80" x2="100" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#9945FF" />
          <stop offset="1" stopColor="#14F195" />
        </linearGradient>
      </defs>
      <path fill="url(#sol-g)" d="M18 10h78l-14 14H4z" />
      <path fill="url(#sol-g)" d="M4 34h78l14 14H18z" />
      <path fill="url(#sol-g)" d="M18 58h78l-14 14H4z" />
    </svg>
  );
}

function Ethereum({ s }: { s: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 256 417" aria-label="Ethereum" role="img">
      <path fill="#c0cbf6" d="M128 0 128 155.4 255.4 213z" />
      <path fill="#8398f0" d="M128 0 0 213 128 155.4z" />
      <path fill="#c0cbf6" d="M128 268.5 128 416.6 256 236.6z" />
      <path fill="#8398f0" d="M128 416.6 128 268.5 0 236.6z" />
      <path fill="#6c86ec" d="M128 242.3 255.4 213 128 155.4z" />
      <path fill="#5372e0" d="M0 213 128 242.3 128 155.4z" />
    </svg>
  );
}

function Starknet({ s }: { s: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 100 100" aria-label="Starknet" role="img">
      <defs>
        <linearGradient id="strk-g" x1="0" y1="0" x2="100" y2="100" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#EC796B" />
          <stop offset="1" stopColor="#0C0C4F" />
        </linearGradient>
      </defs>
      <path
        fill="url(#strk-g)"
        d="M50 6c22 0 38 8 44 20-10-6-24-6-36 0-10 5-18 5-28 1C36 12 42 6 50 6zM12 34c8 6 20 7 32 1 14-7 30-6 42 4 4 6 6 13 6 21 0 24-19 40-42 40S8 84 8 60c0-10 1-19 4-26z"
      />
      <circle cx="38" cy="58" r="6" fill="#fff" opacity="0.92" />
    </svg>
  );
}

function Lettermark({ symbol, s }: { symbol: string; s: number }) {
  return (
    <span
      className="flex items-center justify-center rounded-full border border-p01-border bg-p01-void font-mono text-p01-cyan"
      style={{ width: s, height: s, fontSize: s * 0.34 }}
    >
      {symbol.slice(0, 3)}
    </span>
  );
}

export default function TokenLogo({ symbol, size = 28 }: { symbol: string; size?: number }) {
  const inner = (() => {
    switch (symbol.toUpperCase()) {
      case "SOL":
        return <Solana s={size * 0.72} />;
      case "ETH":
        return <Ethereum s={size * 0.72} />;
      case "STRK":
        return <Starknet s={size * 0.82} />;
      default:
        return null;
    }
  })();

  if (!inner) return <Lettermark symbol={symbol} s={size} />;

  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full border border-p01-border bg-p01-void"
      style={{ width: size, height: size }}
    >
      {inner}
    </span>
  );
}

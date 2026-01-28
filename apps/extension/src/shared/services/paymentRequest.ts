/**
 * Payment Request utilities for Protocol 01
 */

// Known Solana tokens with their mint addresses
export const KNOWN_TOKENS = {
  SOL: {
    symbol: 'SOL',
    name: 'Solana',
    mint: 'So11111111111111111111111111111111111111112', // Native SOL wrapped mint
    decimals: 9,
    icon: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
  },
  USDC: {
    symbol: 'USDC',
    name: 'USD Coin',
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // Mainnet USDC
    decimals: 6,
    icon: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png',
  },
  USDT: {
    symbol: 'USDT',
    name: 'Tether',
    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // Mainnet USDT
    decimals: 6,
    icon: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.png',
  },
  BONK: {
    symbol: 'BONK',
    name: 'Bonk',
    mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // Mainnet BONK
    decimals: 5,
    icon: 'https://arweave.net/hQiPZOsRZXGXBJd_82PhVdlM_hACsT_q6wqwf5cSY7I',
  },
} as const;

export type TokenSymbol = keyof typeof KNOWN_TOKENS;
export type TokenInfo = typeof KNOWN_TOKENS[TokenSymbol];

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate a payment amount against balance
 * Returns { valid: boolean, error?: string }
 */
export function validatePaymentAmount(
  amount: number,
  balance: number,
  token: string = 'SOL'
): ValidationResult {
  if (typeof amount !== 'number' || isNaN(amount)) {
    return { valid: false, error: 'Invalid amount: must be a number' };
  }

  if (amount <= 0) {
    return { valid: false, error: 'Amount must be greater than 0' };
  }

  const tokenInfo = KNOWN_TOKENS[token as TokenSymbol];
  const decimals = tokenInfo?.decimals ?? 9;
  const minAmount = Math.pow(10, -decimals);

  if (amount < minAmount) {
    return { valid: false, error: `Amount too small. Minimum is ${minAmount} ${token}` };
  }

  // Check against balance
  if (amount > balance) {
    return { valid: false, error: `Insufficient balance. You have ${balance} ${token}` };
  }

  // Max reasonable amount check (1 billion)
  if (amount > 1_000_000_000) {
    return { valid: false, error: 'Amount exceeds maximum allowed' };
  }

  return { valid: true };
}

/**
 * Format amount with proper decimals for a token
 */
export function formatTokenAmount(amount: number, token: TokenSymbol = 'SOL'): string {
  const tokenInfo = KNOWN_TOKENS[token];
  return amount.toFixed(tokenInfo.decimals).replace(/\.?0+$/, '');
}

/**
 * Get token info by mint address
 */
export function getTokenByMint(mint: string): TokenInfo | undefined {
  for (const token of Object.values(KNOWN_TOKENS)) {
    if (token.mint === mint) {
      return token;
    }
  }
  return undefined;
}

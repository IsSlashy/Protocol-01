/**
 * Supported tokens configuration for Protocol 01
 */

export interface TokenConfig {
  symbol: string;
  name: string;
  mint: string;
  decimals: number;
  logoURI?: string;
  coingeckoId?: string;
  isNative?: boolean;
  isStablecoin?: boolean;
  isWrapped?: boolean;
}

/**
 * Native SOL (pseudo-token)
 */
export const SOL_TOKEN: TokenConfig = {
  symbol: 'SOL',
  name: 'Solana',
  mint: '11111111111111111111111111111111', // System program
  decimals: 9,
  logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
  coingeckoId: 'solana',
  isNative: true,
};

/**
 * Wrapped SOL
 */
export const WRAPPED_SOL: TokenConfig = {
  symbol: 'wSOL',
  name: 'Wrapped SOL',
  mint: 'So11111111111111111111111111111111111111112',
  decimals: 9,
  logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
  coingeckoId: 'solana',
  isWrapped: true,
};

/**
 * Popular SPL tokens on mainnet
 */
export const MAINNET_TOKENS: TokenConfig[] = [
  SOL_TOKEN,
  WRAPPED_SOL,
  {
    symbol: 'USDC',
    name: 'USD Coin',
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    decimals: 6,
    logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png',
    coingeckoId: 'usd-coin',
    isStablecoin: true,
  },
  {
    symbol: 'USDT',
    name: 'Tether USD',
    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    decimals: 6,
    logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.svg',
    coingeckoId: 'tether',
    isStablecoin: true,
  },
  {
    symbol: 'BONK',
    name: 'Bonk',
    mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    decimals: 5,
    logoURI: 'https://arweave.net/hQiPZOsRZXGXBJd_82PhVdlM_hACsT_q6wqwf5cSY7I',
    coingeckoId: 'bonk',
  },
  {
    symbol: 'JUP',
    name: 'Jupiter',
    mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    decimals: 6,
    logoURI: 'https://static.jup.ag/jup/icon.png',
    coingeckoId: 'jupiter-exchange-solana',
  },
  {
    symbol: 'RAY',
    name: 'Raydium',
    mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
    decimals: 6,
    logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R/logo.png',
    coingeckoId: 'raydium',
  },
  {
    symbol: 'ORCA',
    name: 'Orca',
    mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',
    decimals: 6,
    logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE/logo.png',
    coingeckoId: 'orca',
  },
  {
    symbol: 'PYTH',
    name: 'Pyth Network',
    mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
    decimals: 6,
    logoURI: 'https://pyth.network/token.svg',
    coingeckoId: 'pyth-network',
  },
  {
    symbol: 'JTO',
    name: 'Jito',
    mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',
    decimals: 9,
    logoURI: 'https://metadata.jito.network/token/jto/image',
    coingeckoId: 'jito-governance-token',
  },
  {
    symbol: 'WIF',
    name: 'dogwifhat',
    mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    decimals: 6,
    logoURI: 'https://bafkreibk3covs5ltyqxa272uodhculbr6kea6betidfwy3ajsav2vjzyum.ipfs.nftstorage.link',
    coingeckoId: 'dogwifcoin',
  },
];

/**
 * Devnet test tokens
 */
export const DEVNET_TOKENS: TokenConfig[] = [
  {
    ...SOL_TOKEN,
    name: 'Solana (Devnet)',
  },
  {
    symbol: 'USDC',
    name: 'USDC (Devnet)',
    mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    decimals: 6,
    isStablecoin: true,
  },
];

/**
 * Get token by mint address
 */
export function getTokenByMint(mint: string, network: 'mainnet' | 'devnet' = 'mainnet'): TokenConfig | undefined {
  const tokens = network === 'mainnet' ? MAINNET_TOKENS : DEVNET_TOKENS;
  return tokens.find(token => token.mint === mint);
}

/**
 * Get token by symbol
 */
export function getTokenBySymbol(symbol: string, network: 'mainnet' | 'devnet' = 'mainnet'): TokenConfig | undefined {
  const tokens = network === 'mainnet' ? MAINNET_TOKENS : DEVNET_TOKENS;
  return tokens.find(token => token.symbol.toLowerCase() === symbol.toLowerCase());
}

/**
 * Get stablecoins
 */
export function getStablecoins(network: 'mainnet' | 'devnet' = 'mainnet'): TokenConfig[] {
  const tokens = network === 'mainnet' ? MAINNET_TOKENS : DEVNET_TOKENS;
  return tokens.filter(token => token.isStablecoin);
}

/**
 * Check if token is stablecoin
 */
export function isStablecoin(mint: string): boolean {
  const token = getTokenByMint(mint);
  return token?.isStablecoin ?? false;
}

/**
 * Check if mint is wrapped SOL
 */
export function isWrappedSOL(mint: string): boolean {
  return mint === WRAPPED_SOL.mint;
}

/**
 * Check if mint is native SOL (system program)
 */
export function isNativeSOL(mint: string): boolean {
  return mint === SOL_TOKEN.mint;
}

/**
 * Get all supported mints
 */
export function getSupportedMints(network: 'mainnet' | 'devnet' = 'mainnet'): string[] {
  const tokens = network === 'mainnet' ? MAINNET_TOKENS : DEVNET_TOKENS;
  return tokens.map(token => token.mint);
}

/**
 * Popular tokens for quick selection
 */
export const POPULAR_TOKENS = ['SOL', 'USDC', 'USDT', 'BONK', 'JUP'];

/**
 * Default token list (what user sees initially)
 */
export const DEFAULT_TOKEN_LIST = MAINNET_TOKENS.filter(
  token => POPULAR_TOKENS.includes(token.symbol) || token.isNative
);

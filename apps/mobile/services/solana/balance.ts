import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getConnection, switchEndpoint } from './connection';

const BALANCE_CACHE_KEY = 'p01_balance_cache_';

// Rate limit handling
const MAX_RETRIES = 2;
const RETRY_DELAY = 3000; // 3 seconds

async function withRetry<T>(fn: () => Promise<T>, retries = MAX_RETRIES): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    const errorMsg = error?.message || '';
    const shouldRetry = errorMsg.includes('429') ||
                        errorMsg.includes('rate') ||
                        errorMsg.includes('401') ||
                        errorMsg.includes('Invalid API') ||
                        errorMsg.includes('503') ||
                        errorMsg.includes('timeout');

    if (retries > 0 && shouldRetry) {
      console.log(`RPC error (${errorMsg.slice(0, 50)}...), retrying in ${RETRY_DELAY}ms...`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      return withRetry(fn, retries - 1);
    }
    throw error;
  }
}

// Known token mints on devnet/mainnet
export const TOKEN_MINTS = {
  // Mainnet
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  // Devnet (use these for testing)
  USDC_DEVNET: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
};

// Token metadata
export interface TokenInfo {
  symbol: string;
  name: string;
  decimals: number;
  mint: string;
  logoUri?: string;
}

export interface TokenBalance {
  mint: string;
  symbol: string;
  name: string;
  balance: number;
  decimals: number;
  uiBalance: string;
  usdValue?: number;
  logoUri?: string;
}

export interface WalletBalance {
  sol: number;
  solUsd?: number;
  tokens: TokenBalance[];
  totalUsd?: number;
}

// Simple price cache
let priceCache: { sol: number; timestamp: number } | null = null;
const PRICE_CACHE_TTL = 60000; // 1 minute

/**
 * Get SOL balance for a wallet
 */
export async function getSolBalance(publicKey: string): Promise<number> {
  try {
    return await withRetry(async () => {
      const connection = getConnection();
      const pubkey = new PublicKey(publicKey);
      const balance = await connection.getBalance(pubkey);
      return balance / LAMPORTS_PER_SOL;
    });
  } catch (error) {
    console.error('Failed to get SOL balance:', error);
    return 0; // Return 0 on error
  }
}

/**
 * Get SOL price in USD (from CoinGecko)
 */
export async function getSolPrice(): Promise<number> {
  // Check cache
  if (priceCache && Date.now() - priceCache.timestamp < PRICE_CACHE_TTL) {
    return priceCache.sol;
  }

  try {
    const response = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd'
    );
    const data = await response.json();
    const price = data.solana?.usd || 0;

    // Update cache
    priceCache = { sol: price, timestamp: Date.now() };
    return price;
  } catch (error) {
    console.warn('Failed to fetch SOL price:', error);
    return priceCache?.sol || 0;
  }
}

/**
 * Get all token balances for a wallet
 */
export async function getTokenBalances(publicKey: string): Promise<TokenBalance[]> {
  try {
    return await withRetry(async () => {
      const connection = getConnection();
      const pubkey = new PublicKey(publicKey);

      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(pubkey, {
        programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
      });

      const balances: TokenBalance[] = [];

      for (const account of tokenAccounts.value) {
        const parsedInfo = account.account.data.parsed.info;
        const mint = parsedInfo.mint;
        const balance = parsedInfo.tokenAmount.uiAmount || 0;
        const decimals = parsedInfo.tokenAmount.decimals;

        // Skip zero balances
        if (balance === 0) continue;

        // Get token metadata (simplified - in production, use token metadata program)
        const tokenInfo = getTokenInfo(mint);

        balances.push({
          mint,
          symbol: tokenInfo?.symbol || 'UNKNOWN',
          name: tokenInfo?.name || 'Unknown Token',
          balance,
          decimals,
          uiBalance: formatBalance(balance, decimals),
          logoUri: tokenInfo?.logoUri,
        });
      }

      return balances;
    });
  } catch (error) {
    console.error('Failed to fetch token balances:', error);
    return [];
  }
}

/**
 * Get cached balance (instant, from local storage)
 */
export async function getCachedBalance(publicKey: string): Promise<WalletBalance | null> {
  try {
    console.log('[Balance] Loading cache for:', publicKey.slice(0, 8) + '...');
    const cached = await AsyncStorage.getItem(BALANCE_CACHE_KEY + publicKey);
    if (cached) {
      const data = JSON.parse(cached);
      console.log('[Balance] ✓ CACHE HIT:', data.sol, 'SOL loaded instantly');
      return data;
    } else {
      console.log('[Balance] ✗ CACHE MISS: No cached balance found');
    }
  } catch (error) {
    console.warn('[Balance] Failed to load cache:', error);
  }
  return null;
}

/**
 * Save balance to local cache
 */
async function cacheBalance(publicKey: string, balance: WalletBalance): Promise<void> {
  try {
    await AsyncStorage.setItem(BALANCE_CACHE_KEY + publicKey, JSON.stringify(balance));
    console.log('[Balance] Cached balance:', balance.sol, 'SOL');
  } catch (error) {
    console.warn('[Balance] Failed to cache:', error);
  }
}

/**
 * Get complete wallet balance
 */
export async function getWalletBalance(publicKey: string): Promise<WalletBalance> {
  const [sol, tokens, solPrice] = await Promise.all([
    getSolBalance(publicKey),
    getTokenBalances(publicKey),
    getSolPrice(),
  ]);

  const solUsd = sol * solPrice;

  // Calculate total USD (simplified - only SOL for now)
  const totalUsd = solUsd + tokens.reduce((acc, t) => acc + (t.usdValue || 0), 0);

  const balance: WalletBalance = {
    sol,
    solUsd,
    tokens,
    totalUsd,
  };

  // Cache for instant loading next time
  await cacheBalance(publicKey, balance);

  return balance;
}

/**
 * Get known token info
 */
function getTokenInfo(mint: string): TokenInfo | null {
  const knownTokens: Record<string, TokenInfo> = {
    [TOKEN_MINTS.USDC]: {
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      mint: TOKEN_MINTS.USDC,
      logoUri: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png',
    },
    [TOKEN_MINTS.USDT]: {
      symbol: 'USDT',
      name: 'Tether USD',
      decimals: 6,
      mint: TOKEN_MINTS.USDT,
      logoUri: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.svg',
    },
    [TOKEN_MINTS.USDC_DEVNET]: {
      symbol: 'USDC',
      name: 'USD Coin (Devnet)',
      decimals: 6,
      mint: TOKEN_MINTS.USDC_DEVNET,
    },
  };

  return knownTokens[mint] || null;
}

/**
 * Format balance for display
 */
export function formatBalance(balance: number, decimals: number = 9): string {
  if (balance === 0) return '0';
  if (balance < 0.001) return '<0.001';
  if (balance < 1) return balance.toFixed(4);
  if (balance < 1000) return balance.toFixed(2);
  if (balance < 1000000) return `${(balance / 1000).toFixed(2)}K`;
  return `${(balance / 1000000).toFixed(2)}M`;
}

/**
 * Format USD value
 */
export function formatUsd(value: number): string {
  if (value === 0) return '$0.00';
  if (value < 0.01) return '<$0.01';
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

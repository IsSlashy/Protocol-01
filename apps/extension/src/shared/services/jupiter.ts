/**
 * Jupiter Aggregator API Service
 * Integrates with Jupiter V6 API for best-rate token swaps
 *
 * @see https://station.jup.ag/docs/apis/swap-api
 */

import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';

// Jupiter API endpoints
const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP_API = 'https://quote-api.jup.ag/v6/swap';
const JUPITER_TOKENS_API = 'https://token.jup.ag/all';

// Common token mints on Solana
export const TOKEN_MINTS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  RAY: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  PYTH: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
  ORCA: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',
  MNGO: 'MangoCzJ36AjZyKwVj3VnYU4GTonjfVEnJmvvWaxLac',
  STEP: 'StepAscQoEioFxxWGnh2sLBDFp9d8rvKz2Yp39iDpyT',
};

// ============== PLATFORM FEE CONFIG ==============
// Your commission on each swap (0.25% by default)
export const PLATFORM_FEE_CONFIG = {
  // Fee in basis points: 25 = 0.25%, 50 = 0.5%, 100 = 1%
  feeBps: 25,

  // Your wallet that receives fees
  feeWallet: '3EwUAV44kvjL23emA2yHCwZvAfJbfG4MrhL6YHUrqVLi',
};

// SPL Token Program ID
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

/**
 * Derive the Associated Token Account (ATA) for a wallet + mint
 */
export function getAssociatedTokenAddress(
  mint: PublicKey,
  owner: PublicKey
): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return address;
}

/**
 * Get the fee account (ATA) for a given token mint
 */
export function getFeeAccount(mint: string): string | undefined {
  if (!PLATFORM_FEE_CONFIG.feeWallet) {
    return undefined;
  }

  try {
    const feeWallet = new PublicKey(PLATFORM_FEE_CONFIG.feeWallet);
    const mintPubkey = new PublicKey(mint);
    const ata = getAssociatedTokenAddress(mintPubkey, feeWallet);
    return ata.toBase58();
  } catch (e) {
    console.error('[Jupiter] Failed to derive fee account:', e);
    return undefined;
  }
}

// Token info cache
let tokenListCache: JupiterToken[] | null = null;
let tokenListCacheTime = 0;
const TOKEN_LIST_CACHE_TTL = 60 * 60 * 1000; // 1 hour

export interface JupiterToken {
  address: string;
  chainId: number;
  decimals: number;
  name: string;
  symbol: string;
  logoURI?: string;
  tags?: string[];
}

export interface QuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: 'ExactIn' | 'ExactOut';
  slippageBps: number;
  platformFee?: {
    amount: string;
    feeBps: number;
  };
  priceImpactPct: string;
  routePlan: RoutePlan[];
  contextSlot?: number;
  timeTaken?: number;
}

export interface RoutePlan {
  swapInfo: {
    ammKey: string;
    label: string;
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    feeAmount: string;
    feeMint: string;
  };
  percent: number;
}

export interface SwapRequest {
  quoteResponse: QuoteResponse;
  userPublicKey: string;
  wrapAndUnwrapSol?: boolean;
  useSharedAccounts?: boolean;
  feeAccount?: string;
  trackingAccount?: string;
  computeUnitPriceMicroLamports?: number;
  prioritizationFeeLamports?: number | 'auto';
  asLegacyTransaction?: boolean;
  useTokenLedger?: boolean;
  destinationTokenAccount?: string;
  dynamicComputeUnitLimit?: boolean;
  skipUserAccountsRpcCalls?: boolean;
}

export interface SwapResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports?: number;
  computeUnitLimit?: number;
  prioritizationType?: {
    computeBudget: {
      microLamports: number;
      estimatedMicroLamports: number;
    };
  };
  dynamicSlippageReport?: {
    slippageBps: number;
    otherAmount: number;
    simulatedIncurredSlippageBps: number;
    amplificationRatio: string;
  };
  simulationError?: string;
}

export interface SwapParams {
  inputMint: string;
  outputMint: string;
  amount: number;         // In smallest unit (lamports, etc.)
  slippageBps?: number;   // Slippage in basis points (default: 50 = 0.5%)
  userPublicKey: string;
}

export interface ExecuteSwapParams {
  connection: Connection;
  swapTransaction: string;
  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
}

/**
 * Fetch all Jupiter-supported tokens
 */
export async function fetchTokenList(): Promise<JupiterToken[]> {
  // Check cache
  if (tokenListCache && Date.now() - tokenListCacheTime < TOKEN_LIST_CACHE_TTL) {
    return tokenListCache;
  }

  try {
    const response = await fetch(JUPITER_TOKENS_API);
    if (!response.ok) {
      throw new Error(`Failed to fetch token list: ${response.status}`);
    }

    const tokens: JupiterToken[] = await response.json();
    tokenListCache = tokens;
    tokenListCacheTime = Date.now();

    return tokens;
  } catch (error) {
    console.error('[Jupiter] Error fetching token list:', error);
    // Return cached if available, even if stale
    if (tokenListCache) {
      return tokenListCache;
    }
    // Return empty array instead of throwing - let caller use fallback
    return [];
  }
}

/**
 * Get token info by mint address
 */
export async function getTokenInfo(mint: string): Promise<JupiterToken | undefined> {
  const tokens = await fetchTokenList();
  return tokens.find(t => t.address === mint);
}

/**
 * Get token info by symbol (may return multiple matches)
 */
export async function getTokenBySymbol(symbol: string): Promise<JupiterToken | undefined> {
  const tokens = await fetchTokenList();
  // Prefer exact match, case-insensitive
  return tokens.find(t => t.symbol.toUpperCase() === symbol.toUpperCase());
}

// Fallback tokens when API fails (CORS issues in extensions)
const FALLBACK_TOKENS: JupiterToken[] = [
  { address: TOKEN_MINTS.SOL, chainId: 101, decimals: 9, name: 'Solana', symbol: 'SOL', logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png' },
  { address: TOKEN_MINTS.USDC, chainId: 101, decimals: 6, name: 'USD Coin', symbol: 'USDC', logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png' },
  { address: TOKEN_MINTS.USDT, chainId: 101, decimals: 6, name: 'Tether USD', symbol: 'USDT', logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.svg' },
  { address: TOKEN_MINTS.BONK, chainId: 101, decimals: 5, name: 'Bonk', symbol: 'BONK', logoURI: 'https://arweave.net/hQiPZOsRZXGXBJd_82PhVdlM_hACsT_q6wqwf5cSY7I' },
  { address: TOKEN_MINTS.JUP, chainId: 101, decimals: 6, name: 'Jupiter', symbol: 'JUP', logoURI: 'https://static.jup.ag/jup/icon.png' },
  { address: TOKEN_MINTS.RAY, chainId: 101, decimals: 6, name: 'Raydium', symbol: 'RAY', logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R/logo.png' },
];

/**
 * Get popular/common tokens for the swap UI
 */
export async function getPopularTokens(): Promise<JupiterToken[]> {
  try {
    const tokens = await fetchTokenList();
    const popularMints = Object.values(TOKEN_MINTS);

    const result = popularMints
      .map(mint => tokens.find(t => t.address === mint))
      .filter((t): t is JupiterToken => t !== undefined);

    if (result.length > 0) {
      return result;
    }
  } catch (error) {
    console.warn('[Jupiter] API failed, using fallback tokens');
  }

  // Return fallback tokens when API fails
  return FALLBACK_TOKENS;
}

/**
 * Get a quote for a swap (includes platform fee)
 */
export async function getQuote(params: {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps?: number;
  swapMode?: 'ExactIn' | 'ExactOut';
  includePlatformFee?: boolean;
}): Promise<QuoteResponse> {
  const {
    inputMint,
    outputMint,
    amount,
    slippageBps = 50,
    swapMode = 'ExactIn',
    includePlatformFee = true,
  } = params;

  const url = new URL(JUPITER_QUOTE_API);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', amount);
  url.searchParams.set('slippageBps', slippageBps.toString());
  url.searchParams.set('swapMode', swapMode);

  // Add platform fee
  if (includePlatformFee && PLATFORM_FEE_CONFIG.feeBps > 0) {
    url.searchParams.set('platformFeeBps', PLATFORM_FEE_CONFIG.feeBps.toString());
  }

  console.log('[Jupiter] Fetching quote:', url.toString());

  const response = await fetch(url.toString());

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[Jupiter] Quote error:', errorText);
    throw new Error(`Failed to get quote: ${response.status} - ${errorText}`);
  }

  const quote: QuoteResponse = await response.json();
  console.log('[Jupiter] Quote received:', {
    inAmount: quote.inAmount,
    outAmount: quote.outAmount,
    priceImpact: quote.priceImpactPct,
    routes: quote.routePlan.length,
  });

  return quote;
}

/**
 * Get the swap transaction from Jupiter (with fee account)
 */
export async function getSwapTransaction(params: {
  quoteResponse: QuoteResponse;
  userPublicKey: string;
  wrapUnwrapSOL?: boolean;
  priorityFee?: 'auto' | number;
  includePlatformFee?: boolean;
}): Promise<SwapResponse> {
  const {
    quoteResponse,
    userPublicKey,
    wrapUnwrapSOL = true,
    priorityFee = 'auto',
    includePlatformFee = true,
  } = params;

  const feeAccount = includePlatformFee
    ? getFeeAccount(quoteResponse.outputMint)
    : undefined;

  const body: SwapRequest = {
    quoteResponse,
    userPublicKey,
    wrapAndUnwrapSol: wrapUnwrapSOL,
    useSharedAccounts: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: priorityFee,
    feeAccount,
  };

  console.log('[Jupiter] Getting swap transaction...', feeAccount ? `(fee -> ${feeAccount})` : '');

  const response = await fetch(JUPITER_SWAP_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[Jupiter] Swap error:', errorText);
    throw new Error(`Failed to get swap transaction: ${response.status} - ${errorText}`);
  }

  const swapResponse: SwapResponse = await response.json();

  if (swapResponse.simulationError) {
    console.warn('[Jupiter] Simulation warning:', swapResponse.simulationError);
  }

  return swapResponse;
}

/**
 * Execute a swap transaction
 */
export async function executeSwap(params: ExecuteSwapParams): Promise<string> {
  const { connection, swapTransaction, signTransaction } = params;

  console.log('[Jupiter] Deserializing transaction...');

  // Deserialize the transaction
  const transactionBuf = Buffer.from(swapTransaction, 'base64');
  const transaction = VersionedTransaction.deserialize(transactionBuf);

  console.log('[Jupiter] Signing transaction...');

  // Sign the transaction
  const signedTx = await signTransaction(transaction);

  console.log('[Jupiter] Sending transaction...');

  // Send the transaction
  const signature = await connection.sendRawTransaction(signedTx.serialize(), {
    skipPreflight: false,
    maxRetries: 2,
  });

  console.log('[Jupiter] Transaction sent:', signature);

  // Wait for confirmation
  const latestBlockhash = await connection.getLatestBlockhash();
  await connection.confirmTransaction({
    signature,
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
  });

  console.log('[Jupiter] Transaction confirmed:', signature);

  return signature;
}

/**
 * High-level swap function combining quote + execute
 */
export async function swap(params: {
  connection: Connection;
  inputMint: string;
  outputMint: string;
  amountIn: bigint;
  userPublicKey: PublicKey;
  slippageBps?: number;
  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
}): Promise<{ signature: string; inputAmount: string; outputAmount: string }> {
  const {
    connection,
    inputMint,
    outputMint,
    amountIn,
    userPublicKey,
    slippageBps = 50,
    signTransaction,
  } = params;

  // Get quote
  const quote = await getQuote({
    inputMint,
    outputMint,
    amount: amountIn.toString(),
    slippageBps,
  });

  // Get swap transaction
  const swapResponse = await getSwapTransaction({
    quoteResponse: quote,
    userPublicKey: userPublicKey.toBase58(),
  });

  // Execute swap
  const signature = await executeSwap({
    connection,
    swapTransaction: swapResponse.swapTransaction,
    signTransaction,
  });

  return {
    signature,
    inputAmount: quote.inAmount,
    outputAmount: quote.outAmount,
  };
}

/**
 * Calculate price impact category
 */
export function getPriceImpactSeverity(priceImpactPct: string): 'low' | 'medium' | 'high' {
  const impact = parseFloat(priceImpactPct);
  if (impact < 1) return 'low';
  if (impact < 5) return 'medium';
  return 'high';
}

/**
 * Format amount for display
 */
export function formatTokenAmount(amount: string, decimals: number): string {
  const num = BigInt(amount);
  const divisor = BigInt(10 ** decimals);
  const whole = num / divisor;
  const fraction = num % divisor;

  const fractionStr = fraction.toString().padStart(decimals, '0');
  const trimmedFraction = fractionStr.slice(0, 6).replace(/0+$/, '');

  if (trimmedFraction) {
    return `${whole}.${trimmedFraction}`;
  }
  return whole.toString();
}

/**
 * Parse amount from user input
 */
export function parseTokenAmount(amount: string, decimals: number): bigint {
  const [whole, fraction = ''] = amount.split('.');
  const paddedFraction = fraction.padEnd(decimals, '0').slice(0, decimals);
  return BigInt(whole + paddedFraction);
}

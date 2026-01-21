/**
 * Solana Agent Kit Integration for Specter Extension
 *
 * Provides AI-powered Solana actions based on the Solana Agent Kit.
 * Browser extension version with localStorage persistence.
 *
 * @see https://github.com/sendaifun/solana-agent-kit
 */

import { Connection, PublicKey, LAMPORTS_PER_SOL, Transaction, SystemProgram } from '@solana/web3.js';

// RPC endpoints
const RPC_ENDPOINTS = {
  devnet: 'https://api.devnet.solana.com',
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
};

// Agent action types
export type AgentActionType =
  | 'transfer_sol'
  | 'transfer_token'
  | 'get_balance'
  | 'get_token_balance'
  | 'get_price'
  | 'swap_tokens'
  | 'stake_sol'
  | 'create_token'
  | 'deploy_collection'
  | 'mint_nft';

// Agent action result
export interface AgentActionResult<T = unknown> {
  success: boolean;
  action: AgentActionType;
  data?: T;
  error?: string;
  signature?: string;
}

// Balance info
export interface BalanceInfo {
  sol: number;
  tokens: Array<{
    mint: string;
    symbol: string;
    balance: number;
    uiBalance: string;
  }>;
  totalUsdValue?: number;
}

// Price info
export interface PriceInfo {
  symbol: string;
  price: number;
  change24h?: number;
  volume24h?: number;
}

// Transfer params
export interface TransferParams {
  to: string;
  amount: number;
  token?: string;
}

// Swap params
export interface SwapParams {
  inputToken: string;
  outputToken: string;
  amount: number;
  slippage?: number;
}

/**
 * Specter Agent Kit for Extension
 */
export class SpecterAgentKit {
  private connection: Connection;
  private publicKey: PublicKey;

  constructor(connection: Connection, publicKey: PublicKey) {
    this.connection = connection;
    this.publicKey = publicKey;
  }

  /**
   * Get SOL balance
   */
  async getBalance(): Promise<AgentActionResult<BalanceInfo>> {
    try {
      const balance = await this.connection.getBalance(this.publicKey);
      const solBalance = balance / LAMPORTS_PER_SOL;

      return {
        success: true,
        action: 'get_balance',
        data: {
          sol: solBalance,
          tokens: [],
        },
      };
    } catch (error: any) {
      return {
        success: false,
        action: 'get_balance',
        error: error.message || 'Failed to get balance',
      };
    }
  }

  /**
   * Get token price from Jupiter
   */
  async getPrice(tokenSymbol: string): Promise<AgentActionResult<PriceInfo>> {
    try {
      const tokenMints: Record<string, string> = {
        SOL: 'So11111111111111111111111111111111111111112',
        USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
        BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
      };

      const mint = tokenMints[tokenSymbol.toUpperCase()] || tokenSymbol;

      const response = await fetch(`https://price.jup.ag/v4/price?ids=${mint}`);

      if (!response.ok) {
        throw new Error('Failed to fetch price');
      }

      const data = await response.json();
      const priceData = data.data[mint];

      if (!priceData) {
        throw new Error(`Price not found for ${tokenSymbol}`);
      }

      return {
        success: true,
        action: 'get_price',
        data: {
          symbol: tokenSymbol.toUpperCase(),
          price: priceData.price,
          change24h: priceData.change24h,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        action: 'get_price',
        error: error.message || 'Failed to get price',
      };
    }
  }

  /**
   * Create a SOL transfer transaction (unsigned)
   */
  async createTransferTransaction(params: TransferParams): Promise<AgentActionResult<Transaction>> {
    try {
      const { to, amount, token } = params;

      if (token) {
        return {
          success: false,
          action: 'transfer_token',
          error: 'Token transfers not yet implemented',
        };
      }

      const recipient = new PublicKey(to);
      const lamports = Math.round(amount * LAMPORTS_PER_SOL);

      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: this.publicKey,
          toPubkey: recipient,
          lamports,
        })
      );

      const { blockhash } = await this.connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = this.publicKey;

      return {
        success: true,
        action: 'transfer_sol',
        data: transaction,
      };
    } catch (error: any) {
      return {
        success: false,
        action: 'transfer_sol',
        error: error.message || 'Failed to create transfer',
      };
    }
  }

  /**
   * Get swap quote from Jupiter
   */
  async getSwapQuote(params: SwapParams): Promise<AgentActionResult<{
    inputAmount: number;
    outputAmount: number;
    priceImpact: number;
    route: any;
  }>> {
    try {
      const { inputToken, outputToken, amount, slippage = 1 } = params;

      const tokenMints: Record<string, string> = {
        SOL: 'So11111111111111111111111111111111111111112',
        USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      };

      const inputMint = tokenMints[inputToken.toUpperCase()] || inputToken;
      const outputMint = tokenMints[outputToken.toUpperCase()] || outputToken;

      const inputDecimals = inputMint === tokenMints.SOL ? 9 : 6;
      const inputAmountLamports = Math.round(amount * Math.pow(10, inputDecimals));

      const response = await fetch(
        `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${inputAmountLamports}&slippageBps=${slippage * 100}`
      );

      if (!response.ok) {
        throw new Error('Failed to get swap quote');
      }

      const quote = await response.json();

      return {
        success: true,
        action: 'swap_tokens',
        data: {
          inputAmount: amount,
          outputAmount: parseInt(quote.outAmount) / Math.pow(10, outputMint === tokenMints.SOL ? 9 : 6),
          priceImpact: parseFloat(quote.priceImpactPct),
          route: quote,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        action: 'swap_tokens',
        error: error.message || 'Failed to get swap quote',
      };
    }
  }

  /**
   * Get recent transactions
   */
  async getRecentTransactions(limit: number = 10): Promise<AgentActionResult<Array<{
    signature: string;
    slot: number;
    err: any;
    memo?: string;
  }>>> {
    try {
      const signatures = await this.connection.getSignaturesForAddress(
        this.publicKey,
        { limit }
      );

      return {
        success: true,
        action: 'get_balance',
        data: signatures.map(sig => ({
          signature: sig.signature,
          slot: sig.slot,
          err: sig.err,
          memo: sig.memo || undefined,
        })),
      };
    } catch (error: any) {
      return {
        success: false,
        action: 'get_balance',
        error: error.message || 'Failed to get transactions',
      };
    }
  }
}

/**
 * Create an agent kit instance
 */
export function createAgentKit(
  publicKey: string | PublicKey,
  network: 'devnet' | 'mainnet-beta' = 'devnet'
): SpecterAgentKit {
  const connection = new Connection(RPC_ENDPOINTS[network], 'confirmed');
  const pubkey = typeof publicKey === 'string' ? new PublicKey(publicKey) : publicKey;
  return new SpecterAgentKit(connection, pubkey);
}

/**
 * Execute an agent action by name
 */
export async function executeAgentAction(
  agent: SpecterAgentKit,
  actionType: AgentActionType,
  params?: Record<string, unknown>
): Promise<AgentActionResult> {
  switch (actionType) {
    case 'get_balance':
      return agent.getBalance();

    case 'get_price':
      if (!params?.symbol) {
        return { success: false, action: actionType, error: 'Token symbol required' };
      }
      return agent.getPrice(params.symbol as string);

    case 'transfer_sol':
      if (!params?.to || !params?.amount) {
        return { success: false, action: actionType, error: 'Recipient and amount required' };
      }
      return agent.createTransferTransaction({
        to: params.to as string,
        amount: params.amount as number,
      });

    case 'swap_tokens':
      if (!params?.inputToken || !params?.outputToken || !params?.amount) {
        return { success: false, action: actionType, error: 'Input token, output token, and amount required' };
      }
      return agent.getSwapQuote({
        inputToken: params.inputToken as string,
        outputToken: params.outputToken as string,
        amount: params.amount as number,
        slippage: params.slippage as number | undefined,
      });

    default:
      return { success: false, action: actionType, error: `Action ${actionType} not implemented` };
  }
}

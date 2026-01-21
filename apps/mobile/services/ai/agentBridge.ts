/**
 * Agent Bridge - Connects Gemma AI with Solana Agent Kit
 *
 * This bridge translates AI intents into real Solana actions.
 */

import { PublicKey } from '@solana/web3.js';
import {
  GemmaIntentResponse,
  WalletIntent,
  processWithGemma,
  GemmaMessage,
} from './gemma';
import {
  SpecterAgentKit,
  createAgentKit,
  AgentActionResult,
  BalanceInfo,
  PriceInfo,
} from '../solana/agentKit';
import { Stream } from '../solana/streams';
import { analyzeStreams, formatAnalysisForAI, getBalanceSummary, StreamAnalysis } from './streamAnalyzer';

// Action execution result
export interface ActionExecutionResult {
  success: boolean;
  intent: WalletIntent;
  message: string;
  data?: Record<string, unknown>;
  requiresSignature?: boolean;
  transaction?: any; // Unsigned transaction for user to sign
}

// Bridge configuration
export interface AgentBridgeConfig {
  publicKey: string;
  network: 'devnet' | 'mainnet-beta';
  autoExecuteReadOnly?: boolean; // Auto-execute read-only actions (balance, price)
}

// Stream context for analysis
export interface StreamContext {
  streams: Stream[];
  balance: number;
}

/**
 * Agent Bridge class that connects AI to Solana actions
 */
export class AgentBridge {
  private agentKit: SpecterAgentKit | null = null;
  private config: AgentBridgeConfig;
  private conversationHistory: GemmaMessage[] = [];
  private streamContext: StreamContext | null = null;

  constructor(config: AgentBridgeConfig) {
    this.config = config;
  }

  /**
   * Update stream context for analysis
   */
  updateStreamContext(context: StreamContext): void {
    this.streamContext = context;
  }

  /**
   * Initialize the agent kit
   */
  async initialize(): Promise<void> {
    this.agentKit = await createAgentKit(
      this.config.publicKey,
      this.config.network
    );
  }

  /**
   * Process a user message and potentially execute actions
   */
  async processMessage(userMessage: string): Promise<ActionExecutionResult> {
    // First, get AI interpretation
    const gemmaResponse = await processWithGemma(
      userMessage,
      this.conversationHistory
    );

    // Update conversation history
    this.conversationHistory.push(
      { role: 'user', parts: [{ text: userMessage }] },
      { role: 'model', parts: [{ text: gemmaResponse.response }] }
    );

    // Limit history
    if (this.conversationHistory.length > 20) {
      this.conversationHistory = this.conversationHistory.slice(-20);
    }

    // Check if we should execute an action
    const shouldExecute = this.shouldAutoExecute(gemmaResponse);

    if (shouldExecute && this.agentKit) {
      return await this.executeAction(gemmaResponse);
    }

    // Return AI response without execution
    return {
      success: true,
      intent: gemmaResponse.intent,
      message: gemmaResponse.response,
      data: gemmaResponse.entities,
      requiresSignature: gemmaResponse.requiresConfirmation,
    };
  }

  /**
   * Check if action should be auto-executed
   */
  private shouldAutoExecute(response: GemmaIntentResponse): boolean {
    if (!this.config.autoExecuteReadOnly) return false;

    // Read-only actions that are safe to auto-execute
    const readOnlyIntents: WalletIntent[] = [
      'check_balance',
      'price_lookup',
      'gas_estimation',
    ];

    return readOnlyIntents.includes(response.intent);
  }

  /**
   * Execute a Solana action based on AI intent
   */
  async executeAction(response: GemmaIntentResponse): Promise<ActionExecutionResult> {
    if (!this.agentKit) {
      return {
        success: false,
        intent: response.intent,
        message: 'Agent not initialized. Please try again.',
      };
    }

    try {
      switch (response.intent) {
        case 'check_balance':
          return await this.handleBalanceCheck();

        case 'price_lookup':
          return await this.handlePriceLookup(response.entities.token as string);

        case 'send_transaction':
        case 'stealth_send':
          return await this.handleTransfer(response);

        case 'swap_tokens':
          return await this.handleSwap(response);

        case 'analyze_streams':
        case 'stream_analysis':
          return this.handleStreamAnalysis();

        default:
          // For intents without direct actions, return the AI response
          return {
            success: true,
            intent: response.intent,
            message: response.response,
            data: response.entities,
          };
      }
    } catch (error: any) {
      return {
        success: false,
        intent: response.intent,
        message: `Error: ${error.message || 'Action failed'}`,
      };
    }
  }

  /**
   * Handle balance check
   */
  private async handleBalanceCheck(): Promise<ActionExecutionResult> {
    const result = await this.agentKit!.getBalance();

    if (!result.success) {
      return {
        success: false,
        intent: 'check_balance',
        message: result.error || 'Failed to check balance',
      };
    }

    const balance = result.data as BalanceInfo;
    const message = `Your current balance:\n\n**SOL**: ${balance.sol.toFixed(4)} SOL`;

    return {
      success: true,
      intent: 'check_balance',
      message,
      data: balance,
    };
  }

  /**
   * Handle price lookup
   */
  private async handlePriceLookup(token: string = 'SOL'): Promise<ActionExecutionResult> {
    const result = await this.agentKit!.getPrice(token);

    if (!result.success) {
      return {
        success: false,
        intent: 'price_lookup',
        message: result.error || 'Failed to get price',
      };
    }

    const price = result.data as PriceInfo;
    const changeStr = price.change24h
      ? ` (${price.change24h > 0 ? '+' : ''}${price.change24h.toFixed(2)}% 24h)`
      : '';
    const message = `The current price of ${price.symbol} is $${price.price.toFixed(2)}${changeStr}`;

    return {
      success: true,
      intent: 'price_lookup',
      message,
      data: price,
    };
  }

  /**
   * Handle transfer (creates unsigned transaction)
   */
  private async handleTransfer(response: GemmaIntentResponse): Promise<ActionExecutionResult> {
    const { amount, recipient, token } = response.entities;

    if (!amount || !recipient) {
      return {
        success: true,
        intent: response.intent,
        message: "I need the amount and recipient address to prepare the transfer. Could you provide those details?",
        data: response.entities,
      };
    }

    const result = await this.agentKit!.createTransferTransaction({
      to: recipient as string,
      amount: parseFloat(amount as string),
      token: token as string | undefined,
    });

    if (!result.success) {
      return {
        success: false,
        intent: response.intent,
        message: result.error || 'Failed to create transfer',
      };
    }

    return {
      success: true,
      intent: response.intent,
      message: `I've prepared a transfer of ${amount} ${token || 'SOL'} to ${recipient}. Please review and sign the transaction.`,
      data: response.entities,
      requiresSignature: true,
      transaction: result.data,
    };
  }

  /**
   * Handle swap (gets quote)
   */
  private async handleSwap(response: GemmaIntentResponse): Promise<ActionExecutionResult> {
    const { amount, token } = response.entities;
    const inputToken = token as string || 'SOL';
    const outputToken = 'USDC'; // Default output, should be extracted from intent

    if (!amount) {
      return {
        success: true,
        intent: 'swap_tokens',
        message: "How much would you like to swap?",
        data: response.entities,
      };
    }

    const result = await this.agentKit!.getSwapQuote({
      inputToken,
      outputToken,
      amount: parseFloat(amount as string),
    });

    if (!result.success) {
      return {
        success: false,
        intent: 'swap_tokens',
        message: result.error || 'Failed to get swap quote',
      };
    }

    const quote = result.data as any;
    return {
      success: true,
      intent: 'swap_tokens',
      message: `Swap quote: ${quote.inputAmount} ${inputToken} → ${quote.outputAmount.toFixed(4)} ${outputToken}\nPrice impact: ${(quote.priceImpact * 100).toFixed(2)}%\n\nWould you like to proceed?`,
      data: { ...response.entities, quote },
      requiresSignature: true,
    };
  }

  /**
   * Handle stream analysis
   */
  private handleStreamAnalysis(): ActionExecutionResult {
    if (!this.streamContext || this.streamContext.streams.length === 0) {
      return {
        success: true,
        intent: 'analyze_streams' as WalletIntent,
        message: "ANALYSE DE VOS ABONNEMENTS\n\nAucun stream trouvé. Créez votre premier abonnement pour que je puisse vous aider à optimiser vos dépenses.",
      };
    }

    const analysis = analyzeStreams(this.streamContext.streams, this.streamContext.balance);

    return {
      success: true,
      intent: 'analyze_streams' as WalletIntent,
      message: formatAnalysisForAI(analysis),
      data: {
        totalMonthlySpend: analysis.totalMonthlySpend,
        totalYearlySpend: analysis.totalYearlySpend,
        activeStreams: analysis.activeStreams,
        savingsPotential: analysis.savingsPotential,
        balanceRunwayDays: analysis.balanceRunwayDays,
        recommendationsCount: analysis.recommendations.length,
      },
    };
  }

  /**
   * Get stream analysis (can be called directly without going through AI)
   */
  getStreamAnalysis(): StreamAnalysis | null {
    if (!this.streamContext || this.streamContext.streams.length === 0) {
      return null;
    }
    return analyzeStreams(this.streamContext.streams, this.streamContext.balance);
  }

  /**
   * Get balance summary with stream context
   */
  getBalanceSummary(): string {
    if (!this.streamContext) {
      return "Aucune donnée de solde disponible.";
    }
    const analysis = analyzeStreams(this.streamContext.streams, this.streamContext.balance);
    return getBalanceSummary(this.streamContext.balance, analysis);
  }

  /**
   * Clear conversation history
   */
  clearHistory(): void {
    this.conversationHistory = [];
  }
}

/**
 * Create an agent bridge instance
 */
export function createAgentBridge(config: AgentBridgeConfig): AgentBridge {
  return new AgentBridge(config);
}

/**
 * Gemma 3n AI Service for Protocol 01 Mobile
 *
 * Provides on-device AI inference using Google's Gemma 3n model.
 * Supports multiple backends:
 * - Ollama (local server with gemma3 model)
 * - Google AI Studio API (cloud-based)
 * - MediaPipe LLM Inference (future: native on-device)
 *
 * @see https://ai.google.dev/gemma/docs/gemma-3n
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { AgentCapability } from '../../hooks/agent/useAgent';

// Gemma 3n Configuration
export interface GemmaConfig {
  backend: 'ollama' | 'google-ai' | 'mediapipe';
  // Ollama settings
  ollamaUrl?: string;
  ollamaModel?: string; // gemma3:2b, gemma3n:2b, etc.
  // Google AI settings
  googleApiKey?: string;
  googleModel?: string; // gemma-3n-e4b-it, etc.
  // Common settings
  temperature: number;
  maxTokens: number;
  topP: number;
  topK: number;
}

// Default Gemma configuration
export const DEFAULT_GEMMA_CONFIG: GemmaConfig = {
  backend: 'ollama',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'gemma3:2b',
  googleModel: 'gemma-3n-e4b-it',
  temperature: 0.7,
  maxTokens: 1024,
  topP: 0.95,
  topK: 40,
};

// Intent types that Gemma should recognize
export type WalletIntent =
  | 'send_transaction'
  | 'stealth_send'
  | 'check_balance'
  | 'price_lookup'
  | 'create_stream'
  | 'manage_stream'
  | 'swap_tokens'
  | 'gas_estimation'
  | 'explain_transaction'
  | 'general_query'
  | 'greeting'
  | 'help';

// Structured response from Gemma
export interface GemmaIntentResponse {
  intent: WalletIntent;
  confidence: number;
  entities: {
    amount?: string;
    token?: string;
    recipient?: string;
    duration?: string;
    frequency?: string;
    [key: string]: unknown;
  };
  response: string;
  suggestions?: Array<{
    text: string;
    action: string;
  }>;
  requiresConfirmation?: boolean;
  requiredCapability?: AgentCapability;
}

// Chat message format for Gemma
export interface GemmaMessage {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
}

// System prompt for wallet-focused interactions
const SPECTER_SYSTEM_PROMPT = `You are P-01 Agent, the intelligent assistant for the Protocol 01 wallet on Solana.

CAPABILITIES:
- Send SOL and SPL tokens (including private stealth transfers)
- Check wallet balances
- Look up token prices
- Create and manage payment streams (recurring payments)
- Estimate gas fees
- Explain transactions

RESPONSE FORMAT:
Always respond with valid JSON in this exact format:
{
  "intent": "<intent_type>",
  "confidence": <0.0-1.0>,
  "entities": {
    "amount": "<if mentioned>",
    "token": "<SOL, USDC, etc.>",
    "recipient": "<address or name>"
  },
  "response": "<your natural language response to the user>",
  "suggestions": [
    {"text": "Display text", "action": "action_name"}
  ],
  "requiresConfirmation": <true/false>,
  "requiredCapability": "<capability_needed>"
}

INTENT TYPES:
- send_transaction: User wants to send tokens
- stealth_send: Private/stealth transfer
- check_balance: Check wallet balance
- price_lookup: Token price inquiry
- create_stream: Create recurring payment
- manage_stream: Pause/resume/cancel stream
- swap_tokens: Token swap request
- gas_estimation: Fee estimation
- explain_transaction: Explain a tx
- general_query: General questions
- greeting: Hello/hi messages
- help: Help requests

GUIDELINES:
- Be concise and helpful
- For transactions, always extract amount, token, and recipient
- Default token is SOL if not specified
- Mark transactions as requiresConfirmation: true
- Suggest relevant next actions
- For privacy-related requests (stealth, private), use stealth_send intent
- Format amounts clearly (e.g., "0.5 SOL" not "0.50000000")`;

const STORAGE_KEY = 'p01_gemma_config';

/**
 * Load Gemma configuration from storage
 */
export async function loadGemmaConfig(): Promise<GemmaConfig> {
  try {
    const stored = await AsyncStorage.getItem(STORAGE_KEY);
    if (stored) {
      return { ...DEFAULT_GEMMA_CONFIG, ...JSON.parse(stored) };
    }
  } catch (error) {
    console.error('[Gemma] Failed to load config:', error);
  }
  return DEFAULT_GEMMA_CONFIG;
}

/**
 * Save Gemma configuration
 */
export async function saveGemmaConfig(config: Partial<GemmaConfig>): Promise<void> {
  try {
    const current = await loadGemmaConfig();
    const updated = { ...current, ...config };
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch (error) {
    console.error('[Gemma] Failed to save config:', error);
    throw error;
  }
}

/**
 * Test Gemma connection
 */
export async function testGemmaConnection(config?: GemmaConfig): Promise<{
  success: boolean;
  error?: string;
  modelInfo?: string;
}> {
  const cfg = config || await loadGemmaConfig();

  try {
    if (cfg.backend === 'ollama') {
      const response = await fetch(`${cfg.ollamaUrl}/api/tags`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        return { success: false, error: `Ollama not responding (${response.status})` };
      }

      const data = await response.json();
      const models = data.models || [];
      const gemmaModel = models.find((m: any) =>
        m.name === cfg.ollamaModel ||
        m.name.startsWith('gemma')
      );

      if (!gemmaModel) {
        return {
          success: false,
          error: `Gemma model not found. Run: ollama pull ${cfg.ollamaModel}`,
        };
      }

      return {
        success: true,
        modelInfo: `${gemmaModel.name} (${(gemmaModel.size / 1e9).toFixed(1)}GB)`,
      };
    } else if (cfg.backend === 'google-ai') {
      if (!cfg.googleApiKey) {
        return { success: false, error: 'Google AI API key required' };
      }

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${cfg.googleApiKey}`
      );

      if (!response.ok) {
        return { success: false, error: 'Invalid Google AI API key' };
      }

      const data = await response.json();
      const gemmaModels = (data.models || []).filter((m: any) =>
        m.name.includes('gemma')
      );

      return {
        success: true,
        modelInfo: `${gemmaModels.length} Gemma models available`,
      };
    }

    return { success: false, error: 'MediaPipe backend not yet implemented' };
  } catch (error: any) {
    return {
      success: false,
      error: error.message?.includes('Network request failed')
        ? 'Cannot connect. Check your network and server settings.'
        : error.message || 'Connection failed',
    };
  }
}

/**
 * Process user message with Gemma and get structured response
 */
export async function processWithGemma(
  userMessage: string,
  conversationHistory: GemmaMessage[] = [],
  config?: GemmaConfig
): Promise<GemmaIntentResponse> {
  const cfg = config || await loadGemmaConfig();

  // Build messages with system prompt
  const messages: GemmaMessage[] = [
    { role: 'user', parts: [{ text: SPECTER_SYSTEM_PROMPT }] },
    { role: 'model', parts: [{ text: 'Understood. I will respond with structured JSON for wallet interactions.' }] },
    ...conversationHistory,
    { role: 'user', parts: [{ text: userMessage }] },
  ];

  let rawResponse: string;

  try {
    if (cfg.backend === 'ollama') {
      rawResponse = await sendToOllama(messages, cfg);
    } else if (cfg.backend === 'google-ai') {
      rawResponse = await sendToGoogleAI(messages, cfg);
    } else {
      throw new Error('MediaPipe backend not yet implemented');
    }

    // Parse structured response
    return parseGemmaResponse(rawResponse, userMessage);
  } catch (error: any) {
    console.error('[Gemma] Processing error:', error);

    // Return fallback response
    return {
      intent: 'general_query',
      confidence: 0,
      entities: {},
      response: "I'm having trouble processing your request. Please try again.",
      suggestions: [
        { text: 'Check my balance', action: 'check_balance' },
        { text: 'Help', action: 'help' },
      ],
    };
  }
}

/**
 * Send messages to Ollama with Gemma model
 */
async function sendToOllama(messages: GemmaMessage[], config: GemmaConfig): Promise<string> {
  const response = await fetch(`${config.ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.ollamaModel,
      messages: messages.map(m => ({
        role: m.role === 'model' ? 'assistant' : m.role,
        content: m.parts.map(p => p.text).join('\n'),
      })),
      stream: false,
      format: 'json',
      options: {
        temperature: config.temperature,
        num_predict: config.maxTokens,
        top_p: config.topP,
        top_k: config.topK,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Ollama error: ${error}`);
  }

  const data = await response.json();
  return data.message?.content || '';
}

/**
 * Send messages to Google AI Studio
 */
async function sendToGoogleAI(messages: GemmaMessage[], config: GemmaConfig): Promise<string> {
  if (!config.googleApiKey) {
    throw new Error('Google AI API key required');
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${config.googleModel}:generateContent?key=${config.googleApiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: messages,
        generationConfig: {
          temperature: config.temperature,
          maxOutputTokens: config.maxTokens,
          topP: config.topP,
          topK: config.topK,
          responseMimeType: 'application/json',
        },
      }),
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || 'Google AI request failed');
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

/**
 * Parse Gemma's response into structured format
 */
function parseGemmaResponse(rawResponse: string, originalMessage: string): GemmaIntentResponse {
  try {
    // Try to parse as JSON
    const parsed = JSON.parse(rawResponse);

    // Validate required fields
    if (parsed.intent && parsed.response) {
      return {
        intent: parsed.intent as WalletIntent,
        confidence: parsed.confidence ?? 0.8,
        entities: parsed.entities || {},
        response: parsed.response,
        suggestions: parsed.suggestions,
        requiresConfirmation: parsed.requiresConfirmation,
        requiredCapability: mapIntentToCapability(parsed.intent),
      };
    }
  } catch (e) {
    console.warn('[Gemma] Failed to parse JSON response, using fallback');
  }

  // Fallback: Use the raw response as text and infer intent
  return fallbackIntentParsing(originalMessage, rawResponse);
}

/**
 * Fallback intent parsing when Gemma doesn't return valid JSON
 */
function fallbackIntentParsing(userMessage: string, aiResponse: string): GemmaIntentResponse {
  const lower = userMessage.toLowerCase();

  // Simple pattern matching as fallback
  if (lower.includes('balance') || lower.includes('how much')) {
    return {
      intent: 'check_balance',
      confidence: 0.7,
      entities: {},
      response: aiResponse || "Let me check your balance.",
      requiredCapability: 'check_balance',
    };
  }

  if (lower.includes('send') || lower.includes('transfer')) {
    const amountMatch = userMessage.match(/(\d+(?:\.\d+)?)\s*(sol|usdc|usdt)?/i);
    const addressMatch = userMessage.match(/to\s+([A-HJ-NP-Za-km-z1-9]{32,44})/i);

    return {
      intent: lower.includes('stealth') || lower.includes('private') ? 'stealth_send' : 'send_transaction',
      confidence: 0.7,
      entities: {
        amount: amountMatch?.[1],
        token: amountMatch?.[2]?.toUpperCase() || 'SOL',
        recipient: addressMatch?.[1],
      },
      response: aiResponse || "I'll help you send that transaction.",
      requiresConfirmation: true,
      requiredCapability: lower.includes('stealth') ? 'stealth_send' : 'send_transaction',
    };
  }

  if (lower.includes('stream') || lower.includes('recurring') || lower.includes('subscription')) {
    return {
      intent: 'create_stream',
      confidence: 0.7,
      entities: {},
      response: aiResponse || "Let's set up a payment stream.",
      requiredCapability: 'create_stream',
    };
  }

  if (lower.includes('price')) {
    const tokenMatch = userMessage.match(/(sol|btc|eth|usdc|usdt)/i);
    return {
      intent: 'price_lookup',
      confidence: 0.7,
      entities: { token: tokenMatch?.[1]?.toUpperCase() || 'SOL' },
      response: aiResponse || "Let me look up that price for you.",
      requiredCapability: 'price_lookup',
    };
  }

  if (lower.includes('gas') || lower.includes('fee')) {
    return {
      intent: 'gas_estimation',
      confidence: 0.7,
      entities: {},
      response: aiResponse || "I'll check the current fees.",
      requiredCapability: 'gas_estimation',
    };
  }

  if (lower.match(/^(hi|hello|hey|bonjour|salut)/)) {
    return {
      intent: 'greeting',
      confidence: 0.9,
      entities: {},
      response: aiResponse || "Hello! I'm P-01 Agent. How can I help you with your wallet today?",
      suggestions: [
        { text: 'Check my balance', action: 'check_balance' },
        { text: 'Send tokens', action: 'send_prompt' },
        { text: 'Create a stream', action: 'create_stream' },
      ],
    };
  }

  if (lower.includes('help')) {
    return {
      intent: 'help',
      confidence: 0.9,
      entities: {},
      response: aiResponse || "I can help you send transactions, check balances, look up prices, or create payment streams. What would you like to do?",
      suggestions: [
        { text: 'Check my balance', action: 'check_balance' },
        { text: 'Send tokens', action: 'send_prompt' },
        { text: 'Create a stream', action: 'create_stream' },
      ],
    };
  }

  // Default general query
  return {
    intent: 'general_query',
    confidence: 0.5,
    entities: {},
    response: aiResponse || "I'm here to help you manage your Protocol 01 wallet. You can ask me to send payments, check your balance, or create payment streams.",
    suggestions: [
      { text: 'Check my balance', action: 'check_balance' },
      { text: 'What can you do?', action: 'help' },
    ],
  };
}

/**
 * Map intent to required capability
 */
function mapIntentToCapability(intent: WalletIntent): AgentCapability | undefined {
  const mapping: Partial<Record<WalletIntent, AgentCapability>> = {
    send_transaction: 'send_transaction',
    stealth_send: 'stealth_send',
    check_balance: 'check_balance',
    price_lookup: 'price_lookup',
    create_stream: 'create_stream',
    manage_stream: 'manage_stream',
    gas_estimation: 'gas_estimation',
    explain_transaction: 'explain_transaction',
  };
  return mapping[intent];
}

/**
 * Quick intent classification without full AI response
 * Used for capability checking before processing
 */
export function quickClassifyIntent(message: string): WalletIntent {
  const lower = message.toLowerCase();

  if (lower.includes('balance') || lower.includes('how much')) return 'check_balance';
  if (lower.includes('stealth') || lower.includes('private send')) return 'stealth_send';
  if (lower.includes('send') || lower.includes('transfer')) return 'send_transaction';
  if (lower.includes('stream') || lower.includes('recurring')) return 'create_stream';
  if (lower.includes('price') || lower.includes('worth')) return 'price_lookup';
  if (lower.includes('swap')) return 'swap_tokens';
  if (lower.includes('gas') || lower.includes('fee')) return 'gas_estimation';
  if (lower.match(/^(hi|hello|hey|bonjour|salut)/)) return 'greeting';
  if (lower.includes('help')) return 'help';

  return 'general_query';
}

// Export types
export type { GemmaMessage };

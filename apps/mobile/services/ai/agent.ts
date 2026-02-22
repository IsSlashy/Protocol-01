import AsyncStorage from '@react-native-async-storage/async-storage';
import { Stream } from '../solana/streams';
import { analyzeStreams, formatAnalysisForAI, getBalanceSummary, StreamAnalysis } from './streamAnalyzer';
import { getMarketSummary, formatMarketContext, MarketSummary } from '../crypto/marketData';
import * as LlamaService from './llamaService';

// AI Service Configuration
export interface AIConfig {
  provider: 'groq' | 'gemma' | 'gemma-cloud' | 'llama-local' | 'ollama' | 'openai' | 'anthropic' | 'custom';
  baseUrl: string;
  model: string;
  apiKey?: string;
  groqApiKey?: string;
  temperature: number;
  maxTokens: number;
  gemmaBackend?: 'on-device' | 'google-ai' | 'ollama';
  voiceEnabled?: boolean;
  voiceAutoSend?: boolean;
}

// Default configurations for different providers
export const DEFAULT_CONFIGS: Record<string, Partial<AIConfig>> = {
  groq: {
    provider: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    temperature: 0.7,
    maxTokens: 1024,
  },
  gemma: {
    provider: 'gemma',
    baseUrl: '',
    model: 'gemma-3n-2b',
    temperature: 0.7,
    maxTokens: 1024,
    gemmaBackend: 'on-device',
  },
  'gemma-cloud': {
    provider: 'gemma-cloud',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemma-3n-e4b-it',
    temperature: 0.7,
    maxTokens: 1024,
    gemmaBackend: 'google-ai',
  },
  'llama-local': {
    provider: 'llama-local',
    baseUrl: '',
    model: 'gemma-3-1b-q4',
    temperature: 0.7,
    maxTokens: 512,
  },
  ollama: {
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    model: 'gemma3:2b',
    temperature: 0.7,
    maxTokens: 1024,
  },
  openai: {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    temperature: 0.7,
    maxTokens: 1024,
  },
  anthropic: {
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-3-haiku-20240307',
    temperature: 0.7,
    maxTokens: 1024,
  },
};

// Enhanced system prompt for cloud models
const SYSTEM_PROMPT = `You are P-01 Agent, the AI assistant for Protocol 01 — a privacy-focused Solana wallet with ZK shielded transactions, streaming payments, and DeFi.

YOUR CAPABILITIES:
1. CRYPTO MARKET DATA: Current prices, Fear & Greed Index, market sentiment analysis
2. PORTFOLIO ANALYSIS: Wallet balance, token holdings, spending trends, runway estimation
3. STREAM ANALYSIS: Recurring payment optimization, savings recommendations, upcoming payments
4. SOLANA KNOWLEDGE: DeFi protocols, staking (Marinade, JitoSOL), NFTs, ZK privacy, SPL tokens, Jupiter swaps
5. GENERAL CRYPTO: Bitcoin, Ethereum, Solana ecosystem, market trends, on-chain metrics
6. ZK PRIVACY: Shielded transfers, commitment pools, Merkle proofs, zero-knowledge proofs

PERSONALITY:
- Concise and direct — no fluff or filler
- Uses real numbers and data when available
- Proactive about savings opportunities and risks
- Security-conscious — warns about risks, scams, phishing
- Friendly but professional — you're a crypto-native assistant

RESPONSE FORMAT:
- Keep responses short (2-5 sentences for simple queries, bullets for lists)
- Format prices clearly: "$142.50" not "$142.502847"
- Format SOL amounts: "0.5 SOL" not "0.50000000 SOL"
- Use bullet points for lists, bold for emphasis
- Use code blocks for addresses or technical data
- If you don't know something, say so honestly

CONTEXT:
- App: Protocol 01 wallet on Solana
- Network: Devnet (test network)
- Features: ZK shielded transfers, streaming payments, Jupiter swap, on-device AI
- Privacy: User may be using shielded pool for private transactions`;

// Minimal system prompt for on-device model (saves tokens)
const SYSTEM_PROMPT_LOCAL = `You are P-01 Agent, a crypto assistant for Protocol 01, a Solana wallet with ZK privacy, streams, and swap.
Be concise. Use real data when available. Format prices like "$142.50" and SOL like "0.5 SOL".`;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatResponse {
  success: boolean;
  message?: string;
  error?: string;
  suggestions?: string[];
}

// Context for AI to analyze
export interface AIContext {
  streams?: Stream[];
  balance?: number;
  walletAddress?: string;
  marketData?: MarketSummary;
}

const STORAGE_KEY = 'p01_ai_config';

// API keys from environment
const GEMINI_API_KEY = process.env.EXPO_PUBLIC_GEMINI_API_KEY || '';
const GROQ_API_KEY = process.env.EXPO_PUBLIC_GROQ_API_KEY || '';

/**
 * Build full context string from all available data
 */
export function buildContextString(context: AIContext): string {
  const parts: string[] = [];

  if (context.marketData) {
    parts.push('LIVE MARKET DATA:');
    parts.push(formatMarketContext(context.marketData));
  }

  if (context.balance !== undefined) {
    parts.push(`\nWALLET: ${context.balance.toFixed(4)} SOL`);
  }

  if (context.streams && context.streams.length > 0) {
    const analysis = analyzeStreams(context.streams, context.balance || 0);
    parts.push(`\nSTREAM DATA:\n${formatAnalysisForAI(analysis)}`);
  }

  return parts.join('\n');
}

/**
 * Extract suggestion chips from an AI response
 */
export function extractSuggestions(userMessage: string, _response: string): string[] {
  const lower = userMessage.toLowerCase();

  if (lower.includes('price') || lower.includes('market') || lower.includes('prix')) {
    return ['Fear & Greed', 'SOL Price', 'Market Summary'];
  }
  if (lower.includes('stream') || lower.includes('subscription') || lower.includes('abonnement')) {
    return ['Savings Tips', 'Next Payments', 'My Balance'];
  }
  if (lower.includes('balance') || lower.includes('solde') || lower.includes('portfolio')) {
    return ['Analyze Streams', 'Market Summary', 'SOL Price'];
  }
  if (lower.includes('fear') || lower.includes('greed') || lower.includes('sentiment')) {
    return ['SOL Price', 'Market Summary', 'My Portfolio'];
  }
  return ['SOL Price', 'Fear & Greed', 'Analyze Streams'];
}

// Load AI configuration from storage
export async function loadConfig(): Promise<AIConfig> {
  try {
    const stored = await AsyncStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored) as AIConfig;
    }
  } catch {}
  // Default to Groq if API key available, else Gemma (cloud/on-device)
  if (GROQ_API_KEY) {
    return { ...DEFAULT_CONFIGS.groq, groqApiKey: GROQ_API_KEY } as AIConfig;
  }
  return DEFAULT_CONFIGS.gemma as AIConfig;
}

// Save AI configuration
export async function saveConfig(config: AIConfig): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch (error) {
    console.error('Failed to save AI config:', error);
    throw error;
  }
}

// Test connection to the AI provider
export async function testConnection(config: AIConfig): Promise<{ success: boolean; error?: string }> {
  try {
    if (config.provider === 'gemma' && config.gemmaBackend === 'on-device') {
      return { success: true };
    }

    if (config.provider === 'groq') {
      const key = config.groqApiKey || GROQ_API_KEY;
      if (!key) return { success: false, error: 'Groq API key required' };
      const response = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { 'Authorization': `Bearer ${key}` },
      });
      return { success: response.ok, error: response.ok ? undefined : 'Invalid Groq API key' };
    }

    if (config.provider === 'gemma' || config.provider === 'gemma-cloud') {
      if (config.gemmaBackend === 'google-ai') {
        const key = config.apiKey || GEMINI_API_KEY;
        if (!key) return { success: true }; // Falls back to free tier
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`
        );
        return { success: response.ok, error: response.ok ? undefined : 'Invalid Google AI API key' };
      }
      return { success: true };
    }

    if (config.provider === 'ollama') {
      const response = await fetch(`${config.baseUrl}/api/tags`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!response.ok) {
        return { success: false, error: `Ollama not responding (${response.status})` };
      }
      const data = await response.json();
      const models = data.models || [];
      const hasModel = models.some((m: any) => m.name === config.model || m.name.startsWith(config.model));
      if (!hasModel && models.length > 0) {
        return {
          success: false,
          error: `Model "${config.model}" not found. Available: ${models.map((m: any) => m.name).slice(0, 3).join(', ')}`
        };
      }
      return { success: true };
    } else if (config.provider === 'openai') {
      if (!config.apiKey) return { success: false, error: 'API key required for OpenAI' };
      const response = await fetch(`${config.baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${config.apiKey}` },
      });
      return { success: response.ok, error: response.ok ? undefined : 'Invalid API key' };
    } else if (config.provider === 'anthropic') {
      if (!config.apiKey) return { success: false, error: 'API key required for Anthropic' };
      return { success: true };
    }

    return { success: false, error: 'Unknown provider' };
  } catch (error: any) {
    return {
      success: false,
      error: error.message?.includes('Network request failed')
        ? 'Cannot connect. Check your connection settings.'
        : error.message || 'Connection failed'
    };
  }
}

/**
 * Send a chat message (non-streaming, with fallback chain)
 *
 * Priority: Groq > Gemini > Gemma Local > Rule-based
 */
export async function sendMessage(
  messages: ChatMessage[],
  config?: AIConfig,
  context?: AIContext
): Promise<ChatResponse> {
  const activeConfig = config || await loadConfig();

  const enhancedPrompt = buildEnhancedPrompt(activeConfig, context);

  const allMessages: ChatMessage[] = [
    { role: 'system', content: enhancedPrompt },
    ...messages,
  ];

  try {
    // Try provider-specific first
    if (activeConfig.provider === 'groq') {
      return await sendToGroq(allMessages, activeConfig);
    }

    // Try llama-local if model is loaded
    if (activeConfig.provider === 'llama-local' || LlamaService.isModelLoaded()) {
      try {
        return await sendToLlamaLocal(allMessages, activeConfig, context);
      } catch (error: any) {
        console.warn('[AI] llama-local failed, falling back:', error.message);
      }
    }

    if (activeConfig.provider === 'gemma' || activeConfig.provider === 'gemma-cloud') {
      return await sendToGemma(allMessages, activeConfig, context);
    } else if (activeConfig.provider === 'ollama') {
      return await sendToOllama(allMessages, activeConfig);
    } else if (activeConfig.provider === 'openai') {
      return await sendToOpenAI(allMessages, activeConfig);
    } else if (activeConfig.provider === 'anthropic') {
      return await sendToAnthropic(allMessages, activeConfig);
    } else {
      return { success: false, error: 'Unknown AI provider' };
    }
  } catch (error: any) {
    console.error('AI request failed:', error);
    // Last resort: rule-based
    const lastUserMsg = messages.filter(m => m.role === 'user').pop()?.content || '';
    return sendToRuleBased(lastUserMsg, context);
  }
}

/**
 * Send a message with streaming token-by-token response.
 *
 * Fallback chain: Groq SSE > Gemini SSE > Gemma Local > non-streaming fallback
 */
export async function sendMessageStreaming(
  messages: ChatMessage[],
  onToken: (token: string) => void,
  config?: AIConfig,
  context?: AIContext
): Promise<string> {
  const activeConfig = config || await loadConfig();
  const enhancedPrompt = buildEnhancedPrompt(activeConfig, context);

  const allMessages: ChatMessage[] = [
    { role: 'system', content: enhancedPrompt },
    ...messages,
  ];

  // 1. Groq streaming (highest priority when key available)
  const groqKey = activeConfig.groqApiKey || GROQ_API_KEY;
  if (groqKey && (activeConfig.provider === 'groq' || activeConfig.provider === 'gemma' || activeConfig.provider === 'gemma-cloud')) {
    try {
      return await streamFromGroq(allMessages, groqKey, activeConfig, onToken);
    } catch (error: any) {
      console.warn('[AI] Groq streaming failed, trying Gemini:', error.message);
    }
  }

  // 2. Gemini streaming
  const geminiKey = activeConfig.apiKey || GEMINI_API_KEY;
  if (geminiKey) {
    try {
      return await streamFromGemini(allMessages, geminiKey, activeConfig, onToken);
    } catch (error: any) {
      console.warn('[AI] Gemini streaming failed, trying local:', error.message);
    }
  }

  // 3. Gemma local with onToken callback
  if (LlamaService.isModelLoaded()) {
    try {
      return await streamFromLocal(allMessages, activeConfig, onToken);
    } catch (error: any) {
      console.warn('[AI] Local streaming failed:', error.message);
    }
  }

  // 4. Fallback: non-streaming
  const response = await sendMessage(messages, activeConfig, context);
  if (response.success && response.message) {
    onToken(response.message);
    return response.message;
  }
  throw new Error(response.error || 'All AI providers failed');
}

// ---- Streaming Providers ----

/**
 * Groq SSE streaming (Llama 3.3 70B)
 */
async function streamFromGroq(
  messages: ChatMessage[],
  apiKey: string,
  config: AIConfig,
  onToken: (token: string) => void
): Promise<string> {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: config.model || 'llama-3.3-70b-versatile',
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      temperature: config.temperature || 0.7,
      max_tokens: config.maxTokens || 1024,
      stream: true,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Groq error (${response.status}): ${err}`);
  }

  return await parseSSEStream(response, onToken);
}

/**
 * Gemini SSE streaming
 */
async function streamFromGemini(
  messages: ChatMessage[],
  apiKey: string,
  config: AIConfig,
  onToken: (token: string) => void
): Promise<string> {
  const systemPrompt = messages.find(m => m.role === 'system')?.content || '';
  const chatMessages = messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?alt=sse&key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: chatMessages,
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: {
          temperature: config.temperature || 0.7,
          maxOutputTokens: config.maxTokens || 1024,
        },
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini error (${response.status}): ${err}`);
  }

  // Parse Gemini SSE format
  let fullText = '';
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            fullText += text;
            onToken(text);
          }
        } catch {}
      }
    }
  }

  return fullText;
}

/**
 * Local Gemma 3 streaming via llama.rn
 */
async function streamFromLocal(
  messages: ChatMessage[],
  config: AIConfig,
  onToken: (token: string) => void
): Promise<string> {
  const systemPrompt = messages.find(m => m.role === 'system')?.content || SYSTEM_PROMPT_LOCAL;
  const chatMessages = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role, content: m.content }));

  const llamaMessages = [
    { role: 'user', content: systemPrompt + '\n\nRespond to the user.' },
    { role: 'assistant', content: 'Understood. I am P-01 Agent, ready to help.' },
    ...chatMessages,
  ];

  const text = await LlamaService.chat(llamaMessages, onToken, {
    temperature: config.temperature || 0.7,
    maxTokens: config.maxTokens || 512,
  });

  return text.trim();
}

/**
 * Parse OpenAI-compatible SSE stream (used by Groq)
 */
async function parseSSEStream(
  response: Response,
  onToken: (token: string) => void
): Promise<string> {
  let fullText = '';
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            fullText += delta;
            onToken(delta);
          }
        } catch {}
      }
    }
  }

  return fullText;
}

// ---- Non-streaming Providers ----

function buildEnhancedPrompt(config: AIConfig, context?: AIContext): string {
  const isLocal = config.provider === 'llama-local' || (config.provider === 'gemma' && config.gemmaBackend === 'on-device');
  let prompt = isLocal ? SYSTEM_PROMPT_LOCAL : SYSTEM_PROMPT;

  const contextStr = context ? buildContextString(context) : '';
  if (contextStr) {
    prompt += `\n\n${contextStr}`;
  }

  return prompt;
}

// Groq (non-streaming)
async function sendToGroq(messages: ChatMessage[], config: AIConfig): Promise<ChatResponse> {
  const key = config.groqApiKey || GROQ_API_KEY;
  if (!key) return { success: false, error: 'Groq API key required' };

  const lastUserMessage = messages.filter(m => m.role === 'user').pop()?.content || '';

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: config.model || 'llama-3.3-70b-versatile',
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      temperature: config.temperature || 0.7,
      max_tokens: config.maxTokens || 1024,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    return { success: false, error: `Groq error: ${error}` };
  }

  const data = await response.json();
  const message = data.choices?.[0]?.message?.content;
  if (message) {
    const suggestions = extractSuggestions(lastUserMessage, message);
    return { success: true, message, suggestions };
  }
  return { success: false, error: 'No response from Groq' };
}

// Gemma AI (on-device or Google AI)
async function sendToGemma(messages: ChatMessage[], config: AIConfig, context?: AIContext): Promise<ChatResponse> {
  const lastUserMessage = messages.filter(m => m.role === 'user').pop()?.content || '';
  const systemPrompt = messages.find(m => m.role === 'system')?.content || SYSTEM_PROMPT;

  // Try Gemini API if key is available
  const apiKey = config.apiKey || GEMINI_API_KEY;
  if (apiKey) {
    try {
      const gemmaMessages = messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: gemmaMessages.filter(m => m.role !== 'system'),
            systemInstruction: { parts: [{ text: systemPrompt }] },
            generationConfig: {
              temperature: config.temperature || 0.7,
              maxOutputTokens: config.maxTokens || 1024,
            },
          }),
        }
      );

      if (response.ok) {
        const data = await response.json();
        const message = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (message) {
          const suggestions = extractSuggestions(lastUserMessage, message);
          return { success: true, message, suggestions };
        }
      }
    } catch (error: any) {
      console.warn('[AI] Gemini API failed:', error.message);
    }
  }

  // Fallback to rule-based responses
  return sendToRuleBased(lastUserMessage, context);
}

// On-device Gemma 3 via llama.rn
async function sendToLlamaLocal(
  messages: ChatMessage[],
  config: AIConfig,
  context?: AIContext
): Promise<ChatResponse> {
  if (!LlamaService.isModelLoaded()) {
    throw new Error('Model not loaded');
  }

  const systemPrompt = messages.find(m => m.role === 'system')?.content || SYSTEM_PROMPT_LOCAL;
  const chatMessages = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role, content: m.content }));

  const llamaMessages = [
    { role: 'user', content: systemPrompt + '\n\nRespond to the user.' },
    { role: 'assistant', content: 'Understood. I am P-01 Agent, ready to help.' },
    ...chatMessages,
  ];

  const lastUserMessage = messages.filter(m => m.role === 'user').pop()?.content || '';

  const text = await LlamaService.chat(llamaMessages, undefined, {
    temperature: config.temperature || 0.7,
    maxTokens: config.maxTokens || 512,
  });

  const suggestions = extractSuggestions(lastUserMessage, text);
  return { success: true, message: text.trim(), suggestions };
}

// Rule-based fallback (trimmed)
function sendToRuleBased(userMessage: string, context?: AIContext): ChatResponse {
  const lower = userMessage.toLowerCase();
  const hasStreams = context?.streams && context.streams.length > 0;
  const hasBalance = context?.balance !== undefined;
  const hasMarket = context?.marketData;

  let analysis: StreamAnalysis | null = null;
  if (hasStreams) {
    analysis = analyzeStreams(context!.streams!, context?.balance || 0);
  }

  // Price queries
  if (lower.includes('price') || lower.includes('prix') || lower.match(/\b(sol|btc|eth)\b.*\?/)) {
    if (hasMarket && Object.keys(context!.marketData!.prices).length > 0) {
      const prices = context!.marketData!.prices;
      const tokenMap: Record<string, string> = {
        sol: 'SOL', btc: 'WBTC', bitcoin: 'WBTC', eth: 'WETH', ethereum: 'WETH',
        bonk: 'BONK', jup: 'JUP', wif: 'WIF',
      };
      const tokenMatch = lower.match(/\b(sol|btc|bitcoin|eth|ethereum|bonk|jup|wif)\b/);
      if (tokenMatch) {
        const symbol = tokenMap[tokenMatch[1]] || tokenMatch[1].toUpperCase();
        const price = prices[symbol];
        if (price !== undefined) {
          return { success: true, message: `${symbol}: $${fmtPrice(price)}`, suggestions: ['Market Summary', 'Fear & Greed', 'My Portfolio'] };
        }
      }
      let msg = 'Current Prices:\n';
      for (const s of ['SOL', 'WBTC', 'WETH', 'JUP', 'BONK']) {
        if (prices[s] !== undefined) msg += `- ${s}: $${fmtPrice(prices[s])}\n`;
      }
      return { success: true, message: msg, suggestions: ['Fear & Greed', 'My Portfolio'] };
    }
    return { success: true, message: 'Price data unavailable. Check your connection.', suggestions: ['My Balance', 'Help'] };
  }

  // Fear & Greed
  if (lower.includes('fear') || lower.includes('greed') || lower.includes('sentiment')) {
    if (hasMarket && context!.marketData!.fearGreed) {
      const fg = context!.marketData!.fearGreed;
      const label = fg.value <= 25 ? 'Extreme Fear' : fg.value <= 45 ? 'Fear' : fg.value <= 55 ? 'Neutral' : fg.value <= 75 ? 'Greed' : 'Extreme Greed';
      return {
        success: true,
        message: `Fear & Greed: ${fg.value}/100 (${label})\n\n${fg.value < 30 ? 'Markets are fearful — historically a buying opportunity.' : fg.value > 70 ? 'Markets are greedy — consider taking profits.' : 'Neutral territory.'}`,
        suggestions: ['SOL Price', 'Market Summary'],
      };
    }
    return { success: true, message: 'Fear & Greed data unavailable.', suggestions: ['SOL Price', 'Help'] };
  }

  // Market summary
  if (lower.includes('market') || lower.includes('summary') || lower.includes('overview')) {
    if (hasMarket) {
      const parts: string[] = [];
      if (context!.marketData!.fearGreed) {
        const fg = context!.marketData!.fearGreed;
        parts.push(`Fear & Greed: ${fg.value}/100 (${fg.classification})`);
      }
      const p = context!.marketData!.prices;
      if (p.SOL) parts.push(`SOL: $${fmtPrice(p.SOL)}`);
      if (p.WBTC) parts.push(`BTC: $${fmtPrice(p.WBTC)}`);
      if (p.WETH) parts.push(`ETH: $${fmtPrice(p.WETH)}`);
      return { success: true, message: `Market Summary:\n${parts.map(x => `- ${x}`).join('\n')}`, suggestions: ['SOL Price', 'My Portfolio'] };
    }
    return { success: true, message: 'Market data unavailable.', suggestions: ['My Balance', 'Help'] };
  }

  // Balance / portfolio
  if (lower.includes('balance') || lower.includes('portfolio') || lower.includes('my sol')) {
    if (hasBalance) {
      let msg = `Balance: ${context!.balance!.toFixed(4)} SOL`;
      if (hasMarket && context!.marketData!.prices.SOL) {
        msg += ` (~$${(context!.balance! * context!.marketData!.prices.SOL).toFixed(2)})`;
      }
      if (analysis) {
        msg += `\nActive Streams: ${analysis.activeStreams}\nMonthly: ${analysis.totalMonthlySpend.toFixed(4)} SOL`;
      }
      return { success: true, message: msg, suggestions: ['SOL Price', 'Analyze Streams'] };
    }
    return { success: true, message: 'Connect your wallet to see balance.', suggestions: ['SOL Price', 'Help'] };
  }

  // Streams
  if (lower.includes('stream') || lower.includes('analyze') || lower.includes('subscription')) {
    if (analysis) {
      return { success: true, message: formatAnalysisForAI(analysis), suggestions: ['Savings Tips', 'My Balance'] };
    }
    return { success: true, message: 'No streams found.', suggestions: ['SOL Price', 'Help'] };
  }

  // Greetings
  if (lower.match(/^(hi|hello|hey|gm|sup|yo)/)) {
    let msg = "Hey! I'm P-01 Agent.\n";
    if (hasMarket && context!.marketData!.prices.SOL) {
      msg += `SOL: $${fmtPrice(context!.marketData!.prices.SOL)}`;
      if (context!.marketData!.fearGreed) msg += ` | F&G: ${context!.marketData!.fearGreed.value}/100`;
      msg += '\n';
    }
    msg += '\nWhat can I help with?';
    return { success: true, message: msg, suggestions: ['SOL Price', 'Fear & Greed', 'My Portfolio'] };
  }

  // Help
  if (lower.includes('help') || lower === '?') {
    return {
      success: true,
      message: 'P-01 Agent can help with:\n- Crypto prices ("SOL price")\n- Market sentiment ("Fear & Greed")\n- Portfolio ("My portfolio")\n- Stream analysis ("Analyze streams")\n- Voice input (tap mic)',
      suggestions: ['SOL Price', 'Fear & Greed', 'Analyze Streams'],
    };
  }

  // Default
  let msg = "I'm P-01 Agent. ";
  if (hasMarket && context!.marketData!.prices.SOL) {
    msg += `SOL: $${fmtPrice(context!.marketData!.prices.SOL)}. `;
  }
  msg += 'Ask me about prices, sentiment, or your portfolio!';
  return { success: true, message: msg, suggestions: ['SOL Price', 'Fear & Greed', 'My Portfolio'] };
}

function fmtPrice(price: number): string {
  if (price >= 1000) return price.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (price >= 1) return price.toFixed(2);
  if (price >= 0.001) return price.toFixed(4);
  return price.toFixed(8);
}

// Ollama API
async function sendToOllama(messages: ChatMessage[], config: AIConfig): Promise<ChatResponse> {
  const response = await fetch(`${config.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      stream: false,
      options: { temperature: config.temperature, num_predict: config.maxTokens },
    }),
  });
  if (!response.ok) {
    return { success: false, error: `Ollama error: ${await response.text()}` };
  }
  const data = await response.json();
  return { success: true, message: data.message?.content || data.response || 'No response' };
}

// OpenAI API
async function sendToOpenAI(messages: ChatMessage[], config: AIConfig): Promise<ChatResponse> {
  if (!config.apiKey) return { success: false, error: 'OpenAI API key required' };
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      temperature: config.temperature,
      max_tokens: config.maxTokens,
    }),
  });
  if (!response.ok) {
    const error = await response.json();
    return { success: false, error: error.error?.message || 'OpenAI request failed' };
  }
  const data = await response.json();
  return { success: true, message: data.choices?.[0]?.message?.content || 'No response' };
}

// Anthropic API
async function sendToAnthropic(messages: ChatMessage[], config: AIConfig): Promise<ChatResponse> {
  if (!config.apiKey) return { success: false, error: 'Anthropic API key required' };
  const systemMessage = messages.find(m => m.role === 'system')?.content || '';
  const chatMessages = messages.filter(m => m.role !== 'system');
  const response = await fetch(`${config.baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: config.maxTokens,
      system: systemMessage,
      messages: chatMessages.map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      })),
    }),
  });
  if (!response.ok) {
    const error = await response.json();
    return { success: false, error: error.error?.message || 'Anthropic request failed' };
  }
  const data = await response.json();
  return { success: true, message: data.content?.[0]?.text || 'No response' };
}

// Get available Ollama models
export async function getOllamaModels(baseUrl: string): Promise<string[]> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`);
    if (!response.ok) return [];
    const data = await response.json();
    return (data.models || []).map((m: any) => m.name);
  } catch {
    return [];
  }
}

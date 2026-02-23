/**
 * AI Agent Service for Chrome Extension
 * Multi-provider AI chat with streaming support.
 * Ported from mobile (apps/mobile/services/ai/agent.ts), adapted for chrome.storage.
 */

import { getMarketSummary, formatMarketContext, type MarketSummary } from './marketData';

// AI Service Configuration
export interface AIConfig {
  provider: 'groq' | 'gemma-cloud' | 'ollama';
  baseUrl: string;
  model: string;
  apiKey?: string;
  groqApiKey?: string;
  temperature: number;
  maxTokens: number;
}

export const DEFAULT_CONFIGS: Record<string, Partial<AIConfig>> = {
  groq: {
    provider: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    temperature: 0.7,
    maxTokens: 1024,
  },
  'gemma-cloud': {
    provider: 'gemma-cloud',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemma-3n-e4b-it',
    temperature: 0.7,
    maxTokens: 1024,
  },
  ollama: {
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    model: 'gemma3:2b',
    temperature: 0.7,
    maxTokens: 1024,
  },
};

const SYSTEM_PROMPT = `You are P-01 Agent, the AI assistant for Protocol 01 — a privacy-focused Solana wallet with ZK shielded transactions, streaming payments, and DeFi.

YOUR CAPABILITIES:
1. CRYPTO MARKET DATA: Current prices, Fear & Greed Index, market sentiment analysis
2. PORTFOLIO ANALYSIS: Wallet balance, token holdings, spending trends, runway estimation
3. SOLANA KNOWLEDGE: DeFi protocols, staking (Marinade, JitoSOL), NFTs, ZK privacy, SPL tokens, Jupiter swaps
4. GENERAL CRYPTO: Bitcoin, Ethereum, Solana ecosystem, market trends, on-chain metrics
5. ZK PRIVACY: Shielded transfers, commitment pools, Merkle proofs, zero-knowledge proofs

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
- If you don't know something, say so honestly

CONTEXT:
- App: Protocol 01 wallet (Chrome extension) on Solana
- Network: Devnet (test network)
- Features: ZK shielded transfers, streaming payments, Jupiter swap, AI assistant`;

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

export interface AIContext {
  balance?: number;
  walletAddress?: string;
  marketData?: MarketSummary;
}

const STORAGE_KEY = 'p01_ai_config';

/**
 * Build context string from available data
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

  return parts.join('\n');
}

/**
 * Extract suggestion chips from AI response
 */
export function extractSuggestions(userMessage: string, _response: string): string[] {
  const lower = userMessage.toLowerCase();

  if (lower.includes('price') || lower.includes('market')) {
    return ['Fear & Greed', 'SOL Price', 'Market Summary'];
  }
  if (lower.includes('balance') || lower.includes('portfolio')) {
    return ['Market Summary', 'SOL Price'];
  }
  if (lower.includes('fear') || lower.includes('greed') || lower.includes('sentiment')) {
    return ['SOL Price', 'Market Summary', 'My Portfolio'];
  }
  return ['SOL Price', 'Fear & Greed', 'My Portfolio'];
}

/**
 * Load config from chrome.storage.local
 */
export async function loadConfig(): Promise<AIConfig> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    if (result[STORAGE_KEY]) {
      return JSON.parse(result[STORAGE_KEY]) as AIConfig;
    }
  } catch {}
  return DEFAULT_CONFIGS.groq as AIConfig;
}

/**
 * Save config to chrome.storage.local
 */
export async function saveConfig(config: AIConfig): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: JSON.stringify(config) });
}

/**
 * Test connection to AI provider
 */
export async function testConnection(config: AIConfig): Promise<{ success: boolean; error?: string }> {
  try {
    if (config.provider === 'groq') {
      const key = config.groqApiKey;
      if (!key) return { success: false, error: 'Groq API key required' };
      const response = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { Authorization: `Bearer ${key}` },
      });
      return { success: response.ok, error: response.ok ? undefined : 'Invalid Groq API key' };
    }

    if (config.provider === 'gemma-cloud') {
      const key = config.apiKey;
      if (!key) return { success: true }; // Free tier fallback
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
      return { success: response.ok, error: response.ok ? undefined : 'Invalid Google AI API key' };
    }

    if (config.provider === 'ollama') {
      const response = await fetch(`${config.baseUrl}/api/tags`);
      if (!response.ok) return { success: false, error: `Ollama not responding (${response.status})` };
      const data = await response.json();
      const models = data.models || [];
      const hasModel = models.some((m: any) => m.name === config.model || m.name.startsWith(config.model));
      if (!hasModel && models.length > 0) {
        return { success: false, error: `Model "${config.model}" not found. Available: ${models.map((m: any) => m.name).slice(0, 3).join(', ')}` };
      }
      return { success: true };
    }

    return { success: false, error: 'Unknown provider' };
  } catch (error: any) {
    return {
      success: false,
      error: error.message?.includes('Failed to fetch')
        ? 'Cannot connect. Check your connection settings.'
        : error.message || 'Connection failed',
    };
  }
}

function buildEnhancedPrompt(context?: AIContext): string {
  let prompt = SYSTEM_PROMPT;
  const contextStr = context ? buildContextString(context) : '';
  if (contextStr) {
    prompt += `\n\n${contextStr}`;
  }
  return prompt;
}

/**
 * Send message (non-streaming)
 */
export async function sendMessage(
  messages: ChatMessage[],
  config?: AIConfig,
  context?: AIContext
): Promise<ChatResponse> {
  const activeConfig = config || (await loadConfig());
  const enhancedPrompt = buildEnhancedPrompt(context);

  const allMessages: ChatMessage[] = [{ role: 'system', content: enhancedPrompt }, ...messages];
  const lastUserMsg = messages.filter(m => m.role === 'user').pop()?.content || '';

  try {
    if (activeConfig.provider === 'groq') {
      return await sendToGroq(allMessages, activeConfig, lastUserMsg);
    }
    if (activeConfig.provider === 'gemma-cloud') {
      return await sendToGemmaCloud(allMessages, activeConfig, lastUserMsg);
    }
    if (activeConfig.provider === 'ollama') {
      return await sendToOllama(allMessages, activeConfig, lastUserMsg);
    }
    return { success: false, error: 'Unknown AI provider' };
  } catch (error: any) {
    return sendRuleBased(lastUserMsg, context);
  }
}

/**
 * Send message with SSE streaming
 */
export async function sendMessageStreaming(
  messages: ChatMessage[],
  onToken: (token: string) => void,
  config?: AIConfig,
  context?: AIContext
): Promise<string> {
  const activeConfig = config || (await loadConfig());
  const enhancedPrompt = buildEnhancedPrompt(context);

  const allMessages: ChatMessage[] = [{ role: 'system', content: enhancedPrompt }, ...messages];

  // Groq streaming
  if (activeConfig.provider === 'groq' && activeConfig.groqApiKey) {
    try {
      return await streamFromGroq(allMessages, activeConfig.groqApiKey, activeConfig, onToken);
    } catch (e: any) {
      console.warn('[AI] Groq streaming failed:', e.message);
    }
  }

  // Gemma cloud streaming
  if (activeConfig.provider === 'gemma-cloud' && activeConfig.apiKey) {
    try {
      return await streamFromGemini(allMessages, activeConfig.apiKey, activeConfig, onToken);
    } catch (e: any) {
      console.warn('[AI] Gemini streaming failed:', e.message);
    }
  }

  // Fallback: non-streaming
  const response = await sendMessage(messages, activeConfig, context);
  if (response.success && response.message) {
    onToken(response.message);
    return response.message;
  }
  throw new Error(response.error || 'All AI providers failed');
}

// ---- Streaming ----

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
      Authorization: `Bearer ${apiKey}`,
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

async function parseSSEStream(response: Response, onToken: (token: string) => void): Promise<string> {
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

// ---- Non-streaming providers ----

async function sendToGroq(messages: ChatMessage[], config: AIConfig, lastUserMsg: string): Promise<ChatResponse> {
  const key = config.groqApiKey;
  if (!key) return { success: false, error: 'Groq API key required' };

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
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
    return { success: true, message, suggestions: extractSuggestions(lastUserMsg, message) };
  }
  return { success: false, error: 'No response from Groq' };
}

async function sendToGemmaCloud(messages: ChatMessage[], config: AIConfig, lastUserMsg: string): Promise<ChatResponse> {
  const apiKey = config.apiKey;
  if (!apiKey) return sendRuleBased(lastUserMsg);

  const systemPrompt = messages.find(m => m.role === 'system')?.content || '';
  const chatMessages = messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: chatMessages,
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { temperature: config.temperature || 0.7, maxOutputTokens: config.maxTokens || 1024 },
      }),
    }
  );

  if (response.ok) {
    const data = await response.json();
    const message = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (message) {
      return { success: true, message, suggestions: extractSuggestions(lastUserMsg, message) };
    }
  }

  return sendRuleBased(lastUserMsg);
}

async function sendToOllama(messages: ChatMessage[], config: AIConfig, lastUserMsg: string): Promise<ChatResponse> {
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
  const message = data.message?.content || data.response || 'No response';
  return { success: true, message, suggestions: extractSuggestions(lastUserMsg, message) };
}

// ---- Rule-based fallback ----

function fmtPrice(price: number): string {
  if (price >= 1000) return price.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (price >= 1) return price.toFixed(2);
  if (price >= 0.001) return price.toFixed(4);
  return price.toFixed(8);
}

function sendRuleBased(userMessage: string, context?: AIContext): ChatResponse {
  const lower = userMessage.toLowerCase();
  const hasBalance = context?.balance !== undefined;
  const hasMarket = context?.marketData;

  if (lower.includes('price') || lower.match(/\b(sol|btc|eth)\b.*\?/)) {
    if (hasMarket && Object.keys(context!.marketData!.prices).length > 0) {
      const prices = context!.marketData!.prices;
      let msg = 'Current Prices:\n';
      for (const s of ['SOL', 'WBTC', 'WETH', 'JUP', 'BONK']) {
        if (prices[s] !== undefined) msg += `- ${s}: $${fmtPrice(prices[s])}\n`;
      }
      return { success: true, message: msg, suggestions: ['Fear & Greed', 'My Portfolio'] };
    }
    return { success: true, message: 'Price data unavailable. Check your connection.', suggestions: ['My Balance', 'Help'] };
  }

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
      return { success: true, message: `Market Summary:\n${parts.map(x => `- ${x}`).join('\n')}`, suggestions: ['SOL Price', 'My Portfolio'] };
    }
    return { success: true, message: 'Market data unavailable.', suggestions: ['My Balance', 'Help'] };
  }

  if (lower.includes('balance') || lower.includes('portfolio') || lower.includes('my sol')) {
    if (hasBalance) {
      let msg = `Balance: ${context!.balance!.toFixed(4)} SOL`;
      if (hasMarket && context!.marketData!.prices.SOL) {
        msg += ` (~$${(context!.balance! * context!.marketData!.prices.SOL).toFixed(2)})`;
      }
      return { success: true, message: msg, suggestions: ['SOL Price', 'Market Summary'] };
    }
    return { success: true, message: 'Connect your wallet to see balance.', suggestions: ['SOL Price', 'Help'] };
  }

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

  if (lower.includes('help') || lower === '?') {
    return {
      success: true,
      message: 'P-01 Agent can help with:\n- Crypto prices ("SOL price")\n- Market sentiment ("Fear & Greed")\n- Portfolio ("My portfolio")\n- General crypto questions',
      suggestions: ['SOL Price', 'Fear & Greed', 'My Portfolio'],
    };
  }

  let msg = "I'm P-01 Agent. ";
  if (hasMarket && context!.marketData!.prices.SOL) {
    msg += `SOL: $${fmtPrice(context!.marketData!.prices.SOL)}. `;
  }
  msg += 'Ask me about prices, sentiment, or your portfolio!';
  return { success: true, message: msg, suggestions: ['SOL Price', 'Fear & Greed', 'My Portfolio'] };
}

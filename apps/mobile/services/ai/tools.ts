/**
 * P-01 Agent Tool System — Inspired by SeekerClaw's tool architecture
 *
 * Gives the AI agent real capabilities: web search, price lookups,
 * wallet actions, memory, and device features.
 * Tools are defined as typed objects and dispatched via executeTool().
 *
 * @see https://github.com/sepivip/SeekerClaw (MIT)
 */

import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getMarketSummary, MarketSummary } from '../crypto/marketData';

// ── Tool Definition ──────────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean; enum?: string[] }>;
}

export interface ToolResult {
  success: boolean;
  data?: any;
  error?: string;
}

// ── Tool Registry ────────────────────────────────────────────────────────────

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    name: 'web_search',
    description: 'Search the web for current information using DuckDuckGo. Use for crypto prices, news, protocol info.',
    parameters: {
      query: { type: 'string', description: 'Search query', required: true },
      count: { type: 'number', description: 'Number of results (1-5, default 3)' },
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch content from a URL and return as text. Use for reading articles, docs, API endpoints.',
    parameters: {
      url: { type: 'string', description: 'URL to fetch', required: true },
      raw: { type: 'boolean', description: 'Return raw text without processing (default false)' },
    },
  },
  {
    name: 'solana_price',
    description: 'Get current SOL price, 24h change, market cap, and Fear & Greed index.',
    parameters: {},
  },
  {
    name: 'token_price',
    description: 'Get current price of any crypto token by symbol or contract address via Jupiter.',
    parameters: {
      token: { type: 'string', description: 'Token symbol (e.g. SOL, BONK, JUP) or mint address', required: true },
    },
  },
  {
    name: 'memory_save',
    description: 'Save important information to persistent memory. Survives app restarts. Use for user preferences, important facts.',
    parameters: {
      key: { type: 'string', description: 'Memory key (e.g. "user_risk_profile")', required: true },
      value: { type: 'string', description: 'Value to remember', required: true },
    },
  },
  {
    name: 'memory_read',
    description: 'Read a previously saved memory by key.',
    parameters: {
      key: { type: 'string', description: 'Memory key to read', required: true },
    },
  },
  {
    name: 'memory_list',
    description: 'List all saved memory keys.',
    parameters: {},
  },
  {
    name: 'clipboard_copy',
    description: 'Copy text to the device clipboard.',
    parameters: {
      text: { type: 'string', description: 'Text to copy', required: true },
    },
  },
  {
    name: 'datetime',
    description: 'Get current date, time, and timezone.',
    parameters: {},
  },
  {
    name: 'calculate',
    description: 'Evaluate a math expression. Supports +, -, *, /, %, **, parentheses.',
    parameters: {
      expression: { type: 'string', description: 'Math expression (e.g. "1.5 * 142.50")', required: true },
    },
  },
];

// ── Memory Storage (persistent via AsyncStorage) ─────────────────────────────

const MEMORY_PREFIX = 'p01_agent_mem_';

async function memorySave(key: string, value: string): Promise<ToolResult> {
  try {
    await AsyncStorage.setItem(MEMORY_PREFIX + key, value);
    return { success: true, data: { key, saved: true } };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

async function memoryRead(key: string): Promise<ToolResult> {
  try {
    const value = await AsyncStorage.getItem(MEMORY_PREFIX + key);
    if (value === null) return { success: false, error: `No memory found for key "${key}"` };
    return { success: true, data: { key, value } };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

async function memoryList(): Promise<ToolResult> {
  try {
    const allKeys = await AsyncStorage.getAllKeys();
    const memKeys = allKeys
      .filter(k => k.startsWith(MEMORY_PREFIX))
      .map(k => k.slice(MEMORY_PREFIX.length));
    return { success: true, data: { keys: memKeys, count: memKeys.length } };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ── Web Search (DuckDuckGo HTML — no API key needed) ─────────────────────────

async function webSearch(query: string, count: number = 3): Promise<ToolResult> {
  try {
    const encoded = encodeURIComponent(query);
    const response = await fetch(
      `https://html.duckduckgo.com/html/?q=${encoded}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/125.0.0.0 Mobile',
        },
      }
    );

    if (!response.ok) {
      return { success: false, error: `Search failed (${response.status})` };
    }

    const html = await response.text();

    // Parse results from DDG HTML
    const results: { title: string; url: string; snippet: string }[] = [];
    const resultRegex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>(.*?)<\/a>/gi;
    let match;
    while ((match = resultRegex.exec(html)) !== null && results.length < count) {
      const url = decodeURIComponent((match[1] || '').replace(/.*uddg=/, '').replace(/&.*/, ''));
      const title = (match[2] || '').replace(/<[^>]*>/g, '').trim();
      const snippet = (match[3] || '').replace(/<[^>]*>/g, '').trim();
      if (title && url) results.push({ title, url, snippet });
    }

    if (results.length === 0) {
      return { success: true, data: { results: [], message: 'No results found' } };
    }

    return { success: true, data: { query, results } };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ── Web Fetch ────────────────────────────────────────────────────────────────

async function webFetch(url: string, raw: boolean = false): Promise<ToolResult> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/125.0.0.0 Mobile',
        'Accept': 'text/html,application/json,text/plain',
      },
    });

    if (!response.ok) {
      return { success: false, error: `Fetch failed (${response.status})` };
    }

    const contentType = response.headers.get('content-type') || '';
    let text = await response.text();

    // If JSON, return parsed
    if (contentType.includes('application/json')) {
      try {
        return { success: true, data: JSON.parse(text) };
      } catch {}
    }

    // Strip HTML tags for readability (basic)
    if (!raw && contentType.includes('text/html')) {
      text = text
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    // Truncate to 10K chars
    if (text.length > 10000) {
      text = text.slice(0, 10000) + '\n...(truncated)';
    }

    return { success: true, data: { url, content: text } };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ── Solana Price ─────────────────────────────────────────────────────────────

async function solanaPrice(): Promise<ToolResult> {
  try {
    const market = await getMarketSummary();
    const solPrice = market.prices?.['SOL'] || market.prices?.['solana'] || 0;
    const fg = market.fearGreed;
    return {
      success: true,
      data: {
        price: solPrice ? `$${solPrice.toFixed(2)}` : 'unavailable',
        fearGreed: fg ? `${fg.value} (${fg.classification})` : 'unavailable',
      },
    };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ── Token Price (Jupiter) ────────────────────────────────────────────────────

const KNOWN_MINTS: Record<string, string> = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  WIF: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  PYTH: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
  RAY: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
};

async function tokenPrice(token: string): Promise<ToolResult> {
  try {
    const mint = KNOWN_MINTS[token.toUpperCase()] || token;
    const response = await fetch(`https://api.jup.ag/price/v2?ids=${mint}`);
    if (!response.ok) return { success: false, error: `Jupiter API error (${response.status})` };
    const data = await response.json();
    const info = data.data?.[mint];
    if (!info) return { success: false, error: `Token not found: ${token}` };
    return {
      success: true,
      data: {
        token: token.toUpperCase(),
        mint,
        price: `$${parseFloat(info.price).toFixed(6)}`,
      },
    };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────

function calculate(expression: string): ToolResult {
  try {
    // Safe eval: only allow numbers, operators, parentheses, decimals
    const sanitized = expression.replace(/[^0-9+\-*/%().e ]/gi, '');
    if (sanitized !== expression.replace(/\s/g, '')) {
      return { success: false, error: 'Invalid characters in expression' };
    }
    // eslint-disable-next-line no-eval
    const result = Function(`"use strict"; return (${sanitized})`)();
    if (typeof result !== 'number' || !isFinite(result)) {
      return { success: false, error: 'Expression did not produce a finite number' };
    }
    return { success: true, data: { expression, result } };
  } catch (e: any) {
    return { success: false, error: `Calculation error: ${e.message}` };
  }
}

// ── Tool Dispatch ────────────────────────────────────────────────────────────

export async function executeTool(name: string, input: Record<string, any>): Promise<ToolResult> {
  switch (name) {
    case 'web_search':
      return webSearch(input.query, input.count);
    case 'web_fetch':
      return webFetch(input.url, input.raw);
    case 'solana_price':
      return solanaPrice();
    case 'token_price':
      return tokenPrice(input.token);
    case 'memory_save':
      return memorySave(input.key, input.value);
    case 'memory_read':
      return memoryRead(input.key);
    case 'memory_list':
      return memoryList();
    case 'clipboard_copy':
      await Clipboard.setStringAsync(input.text);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      return { success: true, data: { copied: true } };
    case 'datetime':
      return {
        success: true,
        data: {
          date: new Date().toLocaleDateString(),
          time: new Date().toLocaleTimeString(),
          timestamp: Date.now(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      };
    case 'calculate':
      return calculate(input.expression);
    default:
      return { success: false, error: `Unknown tool: ${name}` };
  }
}

/**
 * Format tool definitions for injection into the system prompt.
 * This lets models without native tool-use (like Gemma 3) invoke tools
 * by outputting structured JSON blocks.
 */
export function formatToolsForPrompt(): string {
  const lines = AGENT_TOOLS.map(t => {
    const params = Object.entries(t.parameters)
      .map(([k, v]) => `${k}: ${v.type}${v.required ? ' (required)' : ''}`)
      .join(', ');
    return `- ${t.name}(${params}): ${t.description}`;
  });

  return `AVAILABLE TOOLS:
${lines.join('\n')}

To use a tool, respond with a JSON block:
\`\`\`tool
{"tool": "tool_name", "input": {"param": "value"}}
\`\`\`
You can call multiple tools. After each tool result, continue your response.`;
}

/**
 * Parse tool calls from an AI response.
 * Looks for ```tool JSON blocks in the response text.
 */
export function parseToolCalls(response: string): { tool: string; input: Record<string, any> }[] {
  const calls: { tool: string; input: Record<string, any> }[] = [];
  const regex = /```tool\s*\n?([\s\S]*?)```/gi;
  let match;
  while ((match = regex.exec(response)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed.tool && typeof parsed.tool === 'string') {
        calls.push({ tool: parsed.tool, input: parsed.input || {} });
      }
    } catch {}
  }
  return calls;
}

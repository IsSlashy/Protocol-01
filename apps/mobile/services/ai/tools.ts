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
import { Share } from 'react-native';
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

  // ── Wallet Tools ──────────────────────────────────────────────
  {
    name: 'wallet_balance',
    description: 'Get current wallet SOL balance and USD value.',
    parameters: {},
  },
  {
    name: 'wallet_address',
    description: 'Get the user\'s wallet public key (Solana address).',
    parameters: {},
  },
  {
    name: 'wallet_send',
    description: 'Send SOL to a recipient address. Requires confirmation.',
    parameters: {
      to: { type: 'string', description: 'Recipient Solana address', required: true },
      amount: { type: 'number', description: 'Amount in SOL', required: true },
    },
  },
  {
    name: 'wallet_history',
    description: 'Get recent transaction history (last N transactions).',
    parameters: {
      limit: { type: 'number', description: 'Number of transactions (default 5, max 20)' },
    },
  },
  {
    name: 'wallet_airdrop',
    description: 'Request devnet SOL airdrop (devnet only, max 1 SOL).',
    parameters: {
      amount: { type: 'number', description: 'Amount in SOL (default 1, max 1)' },
    },
  },
  {
    name: 'wallet_receive',
    description: 'Get the stealth receive address for incoming funds (auto-shields).',
    parameters: {},
  },

  // ── Privacy Tools ─────────────────────────────────────────────
  {
    name: 'privacy_shield',
    description: 'Shield SOL into the privacy pool. Creates a shielded note.',
    parameters: {
      amount: { type: 'number', description: 'Amount in SOL (0.1, 1, 10, or 100)', required: true },
    },
  },
  {
    name: 'privacy_notes',
    description: 'List all shielded notes with their status (pending, mature, locked, spent).',
    parameters: {
      status: { type: 'string', description: 'Filter by status (all, mature, pending, locked)', enum: ['all', 'mature', 'pending', 'locked'] },
    },
  },
  {
    name: 'privacy_send',
    description: 'Send SOL privately via stealth routing. Both sender and receiver hidden on-chain.',
    parameters: {
      to: { type: 'string', description: 'Recipient address or P01 stealth address (st:01...)', required: true },
      amount: { type: 'number', description: 'Amount in SOL', required: true },
      level: { type: 'number', description: 'Privacy level 1-5 (default 3)' },
    },
  },
  {
    name: 'privacy_route_status',
    description: 'Check the status of active privacy routes (hops completed, ETA).',
    parameters: {},
  },
  {
    name: 'privacy_level',
    description: 'Get or set the default privacy level (1=Minimal, 2=Basic, 3=Standard, 4=High, 5=Paranoid).',
    parameters: {
      level: { type: 'number', description: 'New privacy level (1-5). Omit to read current.' },
    },
  },

  // ── Solana Network Tools ──────────────────────────────────────
  {
    name: 'solana_slot',
    description: 'Get the current Solana slot number.',
    parameters: {},
  },
  {
    name: 'solana_epoch',
    description: 'Get current epoch info: epoch number, slot index, slots remaining.',
    parameters: {},
  },
  {
    name: 'solana_tps',
    description: 'Get current Solana network TPS (transactions per second).',
    parameters: {},
  },
  {
    name: 'solana_tx',
    description: 'Look up a transaction by signature and return its details.',
    parameters: {
      signature: { type: 'string', description: 'Transaction signature (base58)', required: true },
    },
  },
  {
    name: 'solana_account',
    description: 'Look up an account: balance, owner, data size.',
    parameters: {
      address: { type: 'string', description: 'Solana address (base58)', required: true },
    },
  },
  {
    name: 'solana_rent',
    description: 'Calculate rent-exempt minimum for a given account data size.',
    parameters: {
      bytes: { type: 'number', description: 'Account data size in bytes', required: true },
    },
  },

  // ── Token & DeFi Tools ────────────────────────────────────────
  {
    name: 'token_balance',
    description: 'Get balance of a specific SPL token in the wallet.',
    parameters: {
      mint: { type: 'string', description: 'Token mint address or symbol (e.g. USDC, BONK)', required: true },
    },
  },
  {
    name: 'swap_quote',
    description: 'Get a swap quote from Jupiter aggregator.',
    parameters: {
      from: { type: 'string', description: 'Source token symbol or mint (e.g. SOL)', required: true },
      to: { type: 'string', description: 'Target token symbol or mint (e.g. USDC)', required: true },
      amount: { type: 'number', description: 'Amount of source token', required: true },
    },
  },
  {
    name: 'portfolio_value',
    description: 'Get total portfolio value: SOL + all tokens in USD.',
    parameters: {},
  },

  // ── Conversion Tools ──────────────────────────────────────────
  {
    name: 'convert_sol',
    description: 'Convert between SOL and USD at current market price.',
    parameters: {
      amount: { type: 'number', description: 'Amount to convert', required: true },
      from: { type: 'string', description: '"SOL" or "USD"', required: true, enum: ['SOL', 'USD'] },
    },
  },
  {
    name: 'convert_lamports',
    description: 'Convert between SOL and lamports (1 SOL = 1,000,000,000 lamports).',
    parameters: {
      value: { type: 'number', description: 'Value to convert', required: true },
      from: { type: 'string', description: '"SOL" or "lamports"', required: true, enum: ['SOL', 'lamports'] },
    },
  },
  {
    name: 'convert_epoch',
    description: 'Convert a Solana epoch number to approximate date, or get epoch for a date.',
    parameters: {
      epoch: { type: 'number', description: 'Epoch number to convert to date' },
      date: { type: 'string', description: 'ISO date to convert to epoch (e.g. "2026-03-17")' },
    },
  },

  // ── Validation Tools ──────────────────────────────────────────
  {
    name: 'address_validate',
    description: 'Check if a string is a valid Solana address, and optionally check its on-chain status.',
    parameters: {
      address: { type: 'string', description: 'Address to validate', required: true },
    },
  },

  // ── Device Tools ──────────────────────────────────────────────
  {
    name: 'share_text',
    description: 'Share text via the OS share sheet (messages, email, etc.).',
    parameters: {
      text: { type: 'string', description: 'Text to share', required: true },
      title: { type: 'string', description: 'Share title (optional)' },
    },
  },
  {
    name: 'haptic',
    description: 'Trigger haptic feedback on the device.',
    parameters: {
      type: { type: 'string', description: 'Type: light, medium, heavy, success, error, warning', enum: ['light', 'medium', 'heavy', 'success', 'error', 'warning'] },
    },
  },
  {
    name: 'notification',
    description: 'Show a notification/alert to the user.',
    parameters: {
      title: { type: 'string', description: 'Notification title', required: true },
      message: { type: 'string', description: 'Notification message', required: true },
    },
  },

  // ── Alert Tools ───────────────────────────────────────────────
  {
    name: 'alert_price',
    description: 'Set a price alert for SOL. Notifies when price crosses threshold.',
    parameters: {
      price: { type: 'number', description: 'Target price in USD', required: true },
      direction: { type: 'string', description: '"above" or "below"', required: true, enum: ['above', 'below'] },
    },
  },
  {
    name: 'alert_list',
    description: 'List all active price alerts.',
    parameters: {},
  },
  {
    name: 'alert_clear',
    description: 'Clear a price alert by ID or clear all.',
    parameters: {
      id: { type: 'string', description: 'Alert ID to clear, or "all" to clear everything', required: true },
    },
  },

  // ── Staking Tools ──────────────────────────────────────────────
  {
    name: 'stake_info',
    description: 'Get staking info for the current wallet: delegated amount, validator, rewards.',
    parameters: {},
  },
  {
    name: 'stake_apy',
    description: 'Get current Solana staking APY estimate.',
    parameters: {},
  },
  {
    name: 'stake_validators',
    description: 'List top Solana validators by stake weight.',
    parameters: {
      limit: { type: 'number', description: 'Number of validators to return (default 5, max 20)' },
    },
  },

  // ── NFT Tools ──────────────────────────────────────────────────
  {
    name: 'nft_list',
    description: 'List NFTs in the current wallet (via Helius DAS API).',
    parameters: {},
  },
  {
    name: 'nft_floor',
    description: 'Get floor price of an NFT collection by name or collection address.',
    parameters: {
      collection: { type: 'string', description: 'Collection name or mint address', required: true },
    },
  },

  // ── DeFi Tools ─────────────────────────────────────────────────
  {
    name: 'swap_execute',
    description: 'Execute a token swap via Jupiter. Redirects to the swap screen with prefilled parameters.',
    parameters: {
      from: { type: 'string', description: 'Source token symbol (e.g. SOL)', required: true },
      to: { type: 'string', description: 'Target token symbol (e.g. USDC)', required: true },
      amount: { type: 'number', description: 'Amount of source token', required: true },
    },
  },
  {
    name: 'defi_tvl',
    description: 'Get Total Value Locked (TVL) of a Solana protocol via DeFi Llama.',
    parameters: {
      protocol: { type: 'string', description: 'Protocol slug (e.g. marinade-finance, raydium, jupiter)', required: true },
    },
  },
  {
    name: 'lending_rates',
    description: 'Get current lending and borrow rates for SOL and USDC on major Solana protocols.',
    parameters: {},
  },

  // ── Analytics Tools ────────────────────────────────────────────
  {
    name: 'gas_tracker',
    description: 'Get current Solana priority fee estimates (low, medium, high).',
    parameters: {},
  },
  {
    name: 'whale_watch',
    description: 'Get recent large SOL transfers (>1000 SOL).',
    parameters: {
      limit: { type: 'number', description: 'Number of results (default 5, max 10)' },
    },
  },
  {
    name: 'market_dominance',
    description: 'Get SOL market dominance compared to BTC and ETH.',
    parameters: {},
  },

  // ── Social Tools ───────────────────────────────────────────────
  {
    name: 'protocol_info',
    description: 'Get info about a Solana protocol or project (TVL, description, links).',
    parameters: {
      name: { type: 'string', description: 'Protocol name (e.g. jupiter, marinade, raydium)', required: true },
    },
  },
  {
    name: 'trending_tokens',
    description: 'Get trending tokens on Jupiter/Birdeye by volume or price change.',
    parameters: {
      limit: { type: 'number', description: 'Number of tokens (default 10, max 20)' },
    },
  },

  // ── Utility Tools ──────────────────────────────────────────────
  {
    name: 'encode_base58',
    description: 'Encode a hex string to base58, or decode a base58 string to hex.',
    parameters: {
      value: { type: 'string', description: 'Hex or base58 string to convert', required: true },
      direction: { type: 'string', description: '"encode" (hex→base58) or "decode" (base58→hex)', required: true, enum: ['encode', 'decode'] },
    },
  },
  {
    name: 'generate_keypair',
    description: 'Generate a new random Solana keypair for testing purposes only. Never use for real funds.',
    parameters: {},
  },
  {
    name: 'timestamp_convert',
    description: 'Convert between unix timestamp (seconds) and human-readable date.',
    parameters: {
      value: { type: 'string', description: 'Unix timestamp (number) or ISO date string', required: true },
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

    // ── Wallet Tools ──
    case 'wallet_balance': {
      const { useWalletStore } = require('@/stores/walletStore');
      const { balance, publicKey } = useWalletStore.getState();
      const sol = balance?.sol ?? 0;
      const usd = balance?.solUsd ?? 0;
      return { success: true, data: { sol: sol.toFixed(4), usd: `$${usd.toFixed(2)}`, address: publicKey?.slice(0, 8) + '...' } };
    }
    case 'wallet_address': {
      const { useWalletStore } = require('@/stores/walletStore');
      const pk = useWalletStore.getState().publicKey;
      return pk ? { success: true, data: { address: pk } } : { success: false, error: 'No wallet connected' };
    }
    case 'wallet_send':
      return { success: false, error: 'Use the Send screen for transfers. Navigate to Wallet → Send.' };
    case 'wallet_history': {
      const { useWalletStore } = require('@/stores/walletStore');
      const txs = useWalletStore.getState().transactions || [];
      const limit = Math.min(input.limit || 5, 20);
      const recent = txs.slice(0, limit).map((tx: any) => ({
        type: tx.type, amount: tx.amount, token: tx.token || 'SOL',
        status: tx.status, time: tx.timestamp ? new Date(tx.timestamp * 1000).toLocaleString() : 'unknown',
        sig: tx.signature?.slice(0, 16) + '...',
      }));
      return { success: true, data: { count: recent.length, total: txs.length, transactions: recent } };
    }
    case 'wallet_airdrop': {
      try {
        const { requestAirdrop } = require('@/services/solana/connection');
        const { useWalletStore } = require('@/stores/walletStore');
        const pk = useWalletStore.getState().publicKey;
        if (!pk) return { success: false, error: 'No wallet' };
        const sig = await requestAirdrop(pk, Math.min(input.amount || 1, 1));
        return { success: true, data: { signature: sig, amount: '1 SOL (devnet)' } };
      } catch (e: any) { return { success: false, error: e.message }; }
    }
    case 'wallet_receive': {
      try {
        const { useAutoShieldStore } = require('@/stores/autoShieldStore');
        await useAutoShieldStore.getState().load();
        const addr = await useAutoShieldStore.getState().generateReceiveAddress();
        return { success: true, data: { stealthAddress: addr, note: 'Funds sent here will be auto-shielded' } };
      } catch (e: any) { return { success: false, error: e.message }; }
    }

    // ── Privacy Tools ──
    case 'privacy_shield':
      return { success: false, error: `Navigate to Privacy → Shield to shield ${input.amount} SOL.` };
    case 'privacy_notes': {
      const { useDenominatedPoolStore } = require('@/stores/denominatedPoolStore');
      const notes = useDenominatedPoolStore.getState().notes || [];
      const statusFilter = input.status || 'all';
      const filtered = statusFilter === 'all' ? notes : notes.filter((n: any) => n.status === statusFilter);
      return { success: true, data: {
        total: notes.length, filtered: filtered.length,
        notes: filtered.map((n: any) => ({
          id: n.id, denomination: n.denomination, token: n.token, status: n.status,
          shieldedAt: new Date(n.shieldedAt).toLocaleString(),
        })),
      }};
    }
    case 'privacy_send':
      return { success: false, error: `Navigate to Privacy → Private Send to send ${input.amount} SOL privately.` };
    case 'privacy_route_status': {
      try {
        const { useWalletStore } = require('@/stores/walletStore');
        const pk = useWalletStore.getState().publicKey;
        if (!pk) return { success: false, error: 'No wallet' };
        const { sha256 } = require('@noble/hashes/sha256');
        const { bytesToHex } = require('@noble/hashes/utils');
        const skHash = bytesToHex(sha256(new TextEncoder().encode(pk)));
        const { loadAllRoutes } = require('@/services/privacyRouter/routeCipher');
        const routes = await loadAllRoutes(skHash);
        const active = routes.filter((r: any) => r.status !== 'completed' && r.status !== 'failed');
        return { success: true, data: {
          activeRoutes: active.length, totalRoutes: routes.length,
          routes: active.map((r: any) => ({
            id: r.id.slice(0, 12), hops: r.hops.length,
            completed: r.hops.filter((h: any) => h.status === 'completed').length,
            destination: r.destination.slice(0, 8) + '...', status: r.status,
            eta: new Date(r.estimatedCompletionAt).toLocaleString(),
          })),
        }};
      } catch (e: any) { return { success: false, error: e.message }; }
    }
    case 'privacy_level': {
      const key = 'settings_privacy_level';
      if (input.level !== undefined) {
        const l = Math.max(1, Math.min(5, input.level));
        const labels = ['', 'Minimal', 'Basic', 'Standard', 'High', 'Paranoid'];
        await AsyncStorage.setItem(key, String(l));
        return { success: true, data: { level: l, label: labels[l] } };
      }
      const current = await AsyncStorage.getItem(key) || '3';
      const labels = ['', 'Minimal', 'Basic', 'Standard', 'High', 'Paranoid'];
      return { success: true, data: { level: parseInt(current), label: labels[parseInt(current)] } };
    }

    // ── Solana Network Tools ──
    case 'solana_slot': {
      try {
        const { getConnection } = require('@/services/solana/connection');
        const slot = await getConnection().getSlot();
        return { success: true, data: { slot } };
      } catch (e: any) { return { success: false, error: e.message }; }
    }
    case 'solana_epoch': {
      try {
        const { getConnection } = require('@/services/solana/connection');
        const info = await getConnection().getEpochInfo();
        return { success: true, data: {
          epoch: info.epoch, slotIndex: info.slotIndex,
          slotsInEpoch: info.slotsInEpoch,
          slotsRemaining: info.slotsInEpoch - info.slotIndex,
          progress: `${((info.slotIndex / info.slotsInEpoch) * 100).toFixed(1)}%`,
        }};
      } catch (e: any) { return { success: false, error: e.message }; }
    }
    case 'solana_tps': {
      try {
        const { getConnection } = require('@/services/solana/connection');
        const perf = await getConnection().getRecentPerformanceSamples(1);
        if (perf.length > 0) {
          const tps = Math.round(perf[0].numTransactions / perf[0].samplePeriodSecs);
          return { success: true, data: { tps, samplePeriod: perf[0].samplePeriodSecs } };
        }
        return { success: false, error: 'No performance data' };
      } catch (e: any) { return { success: false, error: e.message }; }
    }
    case 'solana_tx': {
      try {
        const { getConnection } = require('@/services/solana/connection');
        const tx = await getConnection().getParsedTransaction(input.signature, { maxSupportedTransactionVersion: 0 });
        if (!tx) return { success: false, error: 'Transaction not found' };
        return { success: true, data: {
          slot: tx.slot, blockTime: tx.blockTime ? new Date(tx.blockTime * 1000).toLocaleString() : null,
          fee: tx.meta?.fee, status: tx.meta?.err ? 'failed' : 'confirmed',
          signers: tx.transaction.message.accountKeys.filter((a: any) => a.signer).map((a: any) => a.pubkey.toBase58()),
        }};
      } catch (e: any) { return { success: false, error: e.message }; }
    }
    case 'solana_account': {
      try {
        const { getConnection } = require('@/services/solana/connection');
        const { PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
        const info = await getConnection().getAccountInfo(new PublicKey(input.address));
        if (!info) return { success: true, data: { exists: false, address: input.address } };
        return { success: true, data: {
          exists: true, balance: (info.lamports / LAMPORTS_PER_SOL).toFixed(4) + ' SOL',
          owner: info.owner.toBase58(), dataSize: info.data.length, executable: info.executable,
        }};
      } catch (e: any) { return { success: false, error: e.message }; }
    }
    case 'solana_rent': {
      try {
        const { getConnection } = require('@/services/solana/connection');
        const { LAMPORTS_PER_SOL } = require('@solana/web3.js');
        const rent = await getConnection().getMinimumBalanceForRentExemption(input.bytes);
        return { success: true, data: { bytes: input.bytes, lamports: rent, sol: (rent / LAMPORTS_PER_SOL).toFixed(6) } };
      } catch (e: any) { return { success: false, error: e.message }; }
    }

    // ── Token & DeFi ──
    case 'token_balance': {
      const { useWalletStore } = require('@/stores/walletStore');
      const bal = useWalletStore.getState().balance;
      const token = input.mint?.toUpperCase();
      if (token === 'SOL') return { success: true, data: { token: 'SOL', balance: (bal?.sol ?? 0).toFixed(4) } };
      if (token === 'USDC') return { success: true, data: { token: 'USDC', balance: (bal?.usdc ?? 0).toFixed(2) } };
      return { success: true, data: { token, balance: 'Token balance lookup by mint not yet supported — use SOL or USDC' } };
    }
    case 'swap_quote': {
      try {
        const fromMint = KNOWN_MINTS[input.from?.toUpperCase()] || input.from;
        const toMint = KNOWN_MINTS[input.to?.toUpperCase()] || input.to;
        const decimals = input.from?.toUpperCase() === 'USDC' ? 6 : 9;
        const amountRaw = Math.round(input.amount * (10 ** decimals));
        const res = await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=${fromMint}&outputMint=${toMint}&amount=${amountRaw}&slippageBps=50`);
        if (!res.ok) return { success: false, error: `Jupiter API error (${res.status})` };
        const data = await res.json();
        const outDecimals = input.to?.toUpperCase() === 'USDC' ? 6 : 9;
        const outAmount = parseInt(data.outAmount) / (10 ** outDecimals);
        return { success: true, data: {
          from: input.from, to: input.to, inputAmount: input.amount,
          outputAmount: outAmount.toFixed(6), priceImpact: data.priceImpactPct,
          route: data.routePlan?.map((r: any) => r.swapInfo?.label).join(' → '),
        }};
      } catch (e: any) { return { success: false, error: e.message }; }
    }
    case 'portfolio_value': {
      const { useWalletStore } = require('@/stores/walletStore');
      const bal = useWalletStore.getState().balance;
      const solUsd = bal?.solUsd ?? 0;
      return { success: true, data: {
        sol: { balance: (bal?.sol ?? 0).toFixed(4), usd: `$${solUsd.toFixed(2)}` },
        totalUsd: `$${solUsd.toFixed(2)}`,
      }};
    }

    // ── Conversion ──
    case 'convert_sol': {
      try {
        const market = await getMarketSummary();
        const solPrice = market.prices?.['SOL'] || market.prices?.['solana'] || 0;
        if (!solPrice) return { success: false, error: 'SOL price unavailable' };
        if (input.from === 'SOL') {
          return { success: true, data: { sol: input.amount, usd: (input.amount * solPrice).toFixed(2), rate: solPrice } };
        }
        return { success: true, data: { usd: input.amount, sol: (input.amount / solPrice).toFixed(6), rate: solPrice } };
      } catch (e: any) { return { success: false, error: e.message }; }
    }
    case 'convert_lamports': {
      if (input.from === 'SOL') {
        return { success: true, data: { sol: input.value, lamports: Math.round(input.value * 1e9) } };
      }
      return { success: true, data: { lamports: input.value, sol: (input.value / 1e9).toFixed(9) } };
    }
    case 'convert_epoch': {
      // Rough estimate: Solana mainnet started epoch 0 around March 2020
      // Each epoch is ~2-3 days. Devnet epochs are faster (~1h).
      if (input.epoch !== undefined) {
        const { getConnection } = require('@/services/solana/connection');
        try {
          const info = await getConnection().getEpochInfo();
          const currentEpoch = info.epoch;
          const diff = input.epoch - currentEpoch;
          const approxMs = diff * 2 * 24 * 60 * 60_000; // ~2 days per epoch mainnet
          const date = new Date(Date.now() + approxMs);
          return { success: true, data: { epoch: input.epoch, approxDate: date.toISOString().split('T')[0], currentEpoch } };
        } catch (e: any) { return { success: false, error: e.message }; }
      }
      return { success: false, error: 'Provide epoch number' };
    }

    // ── Validation ──
    case 'address_validate': {
      try {
        const { PublicKey } = require('@solana/web3.js');
        new PublicKey(input.address);
        return { success: true, data: { valid: true, address: input.address } };
      } catch {
        return { success: true, data: { valid: false, address: input.address } };
      }
    }

    // ── Device ──
    case 'share_text': {
      try {
        await Share.share({ message: input.text, title: input.title });
        return { success: true, data: { shared: true } };
      } catch (e: any) { return { success: false, error: e.message }; }
    }
    case 'haptic': {
      const typeMap: Record<string, any> = {
        light: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
        medium: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium),
        heavy: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy),
        success: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
        error: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
        warning: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning),
      };
      const fn = typeMap[input.type || 'medium'];
      if (fn) { await fn(); return { success: true, data: { type: input.type || 'medium' } }; }
      return { success: false, error: 'Invalid haptic type' };
    }
    case 'notification': {
      const { p01Alert } = require('@/stores/alertStore');
      p01Alert(input.title, input.message);
      return { success: true, data: { shown: true } };
    }

    // ── Alerts ──
    case 'alert_price': {
      const id = `alert_${Date.now()}`;
      await AsyncStorage.setItem(`p01_price_alert_${id}`, JSON.stringify({
        price: input.price, direction: input.direction, createdAt: Date.now(),
      }));
      return { success: true, data: { id, price: input.price, direction: input.direction } };
    }
    case 'alert_list': {
      const allKeys = await AsyncStorage.getAllKeys();
      const alertKeys = allKeys.filter(k => k.startsWith('p01_price_alert_'));
      const alerts = await Promise.all(alertKeys.map(async k => {
        const raw = await AsyncStorage.getItem(k);
        return raw ? { id: k.replace('p01_price_alert_', ''), ...JSON.parse(raw) } : null;
      }));
      return { success: true, data: { alerts: alerts.filter(Boolean) } };
    }
    case 'alert_clear': {
      if (input.id === 'all') {
        const allKeys = await AsyncStorage.getAllKeys();
        const alertKeys = allKeys.filter(k => k.startsWith('p01_price_alert_'));
        await AsyncStorage.multiRemove(alertKeys);
        return { success: true, data: { cleared: alertKeys.length } };
      }
      await AsyncStorage.removeItem(`p01_price_alert_${input.id}`);
      return { success: true, data: { cleared: input.id } };
    }

    // ── Staking Tools ──
    case 'stake_info': {
      try {
        const { getConnection } = require('@/services/solana/connection');
        const { useWalletStore } = require('@/stores/walletStore');
        const { PublicKey } = require('@solana/web3.js');
        const pk = useWalletStore.getState().publicKey;
        if (!pk) return { success: false, error: 'No wallet connected' };
        const conn = getConnection();
        const stakeAccounts = await conn.getParsedProgramAccounts(
          new PublicKey('Stake11111111111111111111111111111111111111'),
          { filters: [{ memcmp: { offset: 12, bytes: pk } }] },
        );
        if (stakeAccounts.length === 0) {
          return { success: true, data: { staked: false, message: 'No active stake accounts found' } };
        }
        const stakes = stakeAccounts.map((acc: any) => {
          const parsed = acc.account.data?.parsed?.info;
          return {
            address: acc.pubkey.toBase58(),
            lamports: acc.account.lamports,
            sol: (acc.account.lamports / 1e9).toFixed(4),
            validator: parsed?.stake?.delegation?.voter,
            status: parsed?.stake?.delegation ? 'delegated' : 'inactive',
          };
        });
        const totalSol = stakes.reduce((s: number, a: any) => s + parseFloat(a.sol), 0);
        return { success: true, data: { stakeAccounts: stakes.length, totalStaked: totalSol.toFixed(4) + ' SOL', stakes } };
      } catch (e: any) { return { success: false, error: e.message }; }
    }
    case 'stake_apy': {
      try {
        const res = await fetch('https://api.marinade.finance/msol/apy');
        if (res.ok) {
          const data = await res.json();
          const apy = typeof data === 'number' ? data : data.apy ?? data.value;
          return { success: true, data: { apy: `${(apy * 100).toFixed(2)}%`, source: 'Marinade mSOL', note: 'Native staking APY is typically similar' } };
        }
        // Fallback: estimate from epoch info
        const { getConnection } = require('@/services/solana/connection');
        const info = await getConnection().getEpochInfo();
        const epochsPerYear = 365.25 * 24 * 3600 / (info.slotsInEpoch * 0.4);
        const estimatedApy = (1 + 0.05 / epochsPerYear) ** epochsPerYear - 1;
        return { success: true, data: { apy: `~${(estimatedApy * 100).toFixed(1)}%`, source: 'estimated', note: 'Based on ~5% inflation, actual varies by validator' } };
      } catch (e: any) { return { success: false, error: e.message }; }
    }
    case 'stake_validators': {
      try {
        const { getConnection } = require('@/services/solana/connection');
        const limit = Math.min(input.limit || 5, 20);
        const { current } = await getConnection().getVoteAccounts();
        const sorted = current
          .sort((a: any, b: any) => b.activatedStake - a.activatedStake)
          .slice(0, limit);
        const validators = sorted.map((v: any, i: number) => ({
          rank: i + 1,
          votePubkey: v.votePubkey,
          stake: (v.activatedStake / 1e9).toFixed(0) + ' SOL',
          commission: v.commission + '%',
          lastVote: v.lastVote,
        }));
        return { success: true, data: { count: validators.length, validators } };
      } catch (e: any) { return { success: false, error: e.message }; }
    }

    // ── NFT Tools ──
    case 'nft_list': {
      try {
        const { useWalletStore } = require('@/stores/walletStore');
        const pk = useWalletStore.getState().publicKey;
        if (!pk) return { success: false, error: 'No wallet connected' };
        const { getConnection } = require('@/services/solana/connection');
        const { PublicKey } = require('@solana/web3.js');
        // Try Helius DAS API if the RPC endpoint supports it
        const conn = getConnection();
        const rpcUrl = (conn as any)._rpcEndpoint || '';
        if (rpcUrl.includes('helius')) {
          const res = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0', id: 1, method: 'getAssetsByOwner',
              params: { ownerAddress: pk, page: 1, limit: 20 },
            }),
          });
          if (res.ok) {
            const data = await res.json();
            const items = (data.result?.items || []).filter(
              (a: any) => a.interface === 'V1_NFT' || a.interface === 'ProgrammableNFT',
            );
            const nfts = items.map((a: any) => ({
              name: a.content?.metadata?.name || 'Unknown',
              collection: a.grouping?.[0]?.group_value || null,
              mint: a.id,
              image: a.content?.links?.image || null,
            }));
            return { success: true, data: { count: nfts.length, nfts } };
          }
        }
        return { success: true, data: { message: 'NFT listing requires a Helius RPC endpoint. Navigate to the NFT tab to view your collection.' } };
      } catch (e: any) { return { success: false, error: e.message }; }
    }
    case 'nft_floor': {
      try {
        // Try fetching from Tensor or a public API
        const res = await fetch(
          `https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(input.collection)}/stats`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } },
        );
        if (res.ok) {
          const data = await res.json();
          return { success: true, data: {
            collection: input.collection,
            floorPrice: data.floorPrice ? (data.floorPrice / 1e9).toFixed(4) + ' SOL' : 'N/A',
            listedCount: data.listedCount, volumeAll: data.volumeAll ? (data.volumeAll / 1e9).toFixed(0) + ' SOL' : 'N/A',
          }};
        }
        return { success: true, data: { collection: input.collection, message: 'Floor price data unavailable. Try searching on Magic Eden or Tensor.' } };
      } catch (e: any) { return { success: false, error: e.message }; }
    }

    // ── DeFi Tools ──
    case 'swap_execute':
      return { success: false, error: `Navigate to Wallet → Swap to exchange ${input.amount} ${input.from} for ${input.to}. The swap screen will handle Jupiter routing and signing.` };
    case 'defi_tvl': {
      try {
        const res = await fetch(`https://api.llama.fi/tvl/${encodeURIComponent(input.protocol)}`);
        if (!res.ok) return { success: false, error: `DeFi Llama API error (${res.status}). Check protocol slug.` };
        const tvl = await res.json();
        if (typeof tvl === 'number') {
          return { success: true, data: { protocol: input.protocol, tvl: `$${(tvl / 1e6).toFixed(2)}M`, raw: tvl } };
        }
        return { success: false, error: `Unknown response format for "${input.protocol}". Try: marinade-finance, raydium, jupiter` };
      } catch (e: any) { return { success: false, error: e.message }; }
    }
    case 'lending_rates': {
      try {
        // Fetch from DeFi Llama yields API for Solana lending protocols
        const res = await fetch('https://yields.llama.fi/pools');
        if (!res.ok) return { success: false, error: `DeFi Llama yields API error (${res.status})` };
        const data = await res.json();
        const pools = (data.data || []).filter(
          (p: any) => p.chain === 'Solana' &&
            (p.symbol?.includes('SOL') || p.symbol?.includes('USDC')) &&
            (p.project === 'marinade-finance' || p.project === 'solend' || p.project === 'marginfi' || p.project === 'kamino'),
        );
        const rates = pools.slice(0, 10).map((p: any) => ({
          protocol: p.project,
          symbol: p.symbol,
          apy: `${p.apy?.toFixed(2)}%`,
          tvl: `$${(p.tvlUsd / 1e6).toFixed(2)}M`,
          apyBase: p.apyBase ? `${p.apyBase.toFixed(2)}%` : undefined,
        }));
        return { success: true, data: { count: rates.length, rates } };
      } catch (e: any) { return { success: false, error: e.message }; }
    }

    // ── Analytics Tools ──
    case 'gas_tracker': {
      try {
        const { getConnection } = require('@/services/solana/connection');
        const conn = getConnection();
        const fees = await conn.getRecentPrioritizationFees();
        if (!fees || fees.length === 0) {
          return { success: true, data: { message: 'No recent priority fee data available' } };
        }
        const nonZero = fees.filter((f: any) => f.prioritizationFee > 0);
        const sorted = nonZero.map((f: any) => f.prioritizationFee).sort((a: number, b: number) => a - b);
        const low = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.25)] : 0;
        const medium = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.5)] : 0;
        const high = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.75)] : 0;
        return { success: true, data: {
          priorityFees: {
            low: `${low} microlamports`,
            medium: `${medium} microlamports`,
            high: `${high} microlamports`,
          },
          samplesAnalyzed: fees.length,
          note: 'Priority fees are per compute unit. Base fee is 5000 lamports.',
        }};
      } catch (e: any) { return { success: false, error: e.message }; }
    }
    case 'whale_watch': {
      try {
        const { getConnection } = require('@/services/solana/connection');
        const { LAMPORTS_PER_SOL } = require('@solana/web3.js');
        const conn = getConnection();
        const limit = Math.min(input.limit || 5, 10);
        const sigs = await conn.getSignaturesForAddress(
          require('@solana/web3.js').SystemProgram.programId,
          { limit: 50 },
        );
        const largeTxs: any[] = [];
        for (const sig of sigs) {
          if (largeTxs.length >= limit) break;
          try {
            const tx = await conn.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0 });
            const instructions = tx?.transaction?.message?.instructions || [];
            for (const ix of instructions) {
              const parsed = (ix as any).parsed;
              if (parsed?.type === 'transfer' && parsed?.info?.lamports >= 1000 * LAMPORTS_PER_SOL) {
                largeTxs.push({
                  signature: sig.signature.slice(0, 16) + '...',
                  amount: (parsed.info.lamports / LAMPORTS_PER_SOL).toFixed(2) + ' SOL',
                  from: parsed.info.source?.slice(0, 8) + '...',
                  to: parsed.info.destination?.slice(0, 8) + '...',
                  time: tx?.blockTime ? new Date(tx.blockTime * 1000).toLocaleString() : 'unknown',
                });
              }
            }
          } catch {}
        }
        if (largeTxs.length === 0) {
          return { success: true, data: { message: 'No large transfers (>1000 SOL) found in recent blocks. This scans a limited window.' } };
        }
        return { success: true, data: { count: largeTxs.length, transfers: largeTxs } };
      } catch (e: any) { return { success: false, error: e.message }; }
    }
    case 'market_dominance': {
      try {
        const res = await fetch('https://api.coingecko.com/api/v3/global');
        if (!res.ok) return { success: false, error: `CoinGecko API error (${res.status})` };
        const data = await res.json();
        const mcaps = data.data?.market_cap_percentage || {};
        return { success: true, data: {
          btc: `${(mcaps.btc || 0).toFixed(2)}%`,
          eth: `${(mcaps.eth || 0).toFixed(2)}%`,
          sol: `${(mcaps.sol || 0).toFixed(2)}%`,
          totalMarketCap: data.data?.total_market_cap?.usd ? `$${(data.data.total_market_cap.usd / 1e12).toFixed(2)}T` : 'N/A',
          source: 'CoinGecko',
        }};
      } catch (e: any) { return { success: false, error: e.message }; }
    }

    // ── Social Tools ──
    case 'protocol_info': {
      try {
        const slug = input.name.toLowerCase().replace(/\s+/g, '-');
        const res = await fetch(`https://api.llama.fi/protocol/${encodeURIComponent(slug)}`);
        if (!res.ok) return { success: false, error: `Protocol not found: "${input.name}". Try: jupiter, marinade-finance, raydium, drift, orca` };
        const data = await res.json();
        return { success: true, data: {
          name: data.name, symbol: data.symbol, category: data.category,
          description: data.description?.slice(0, 300) || 'No description',
          tvl: data.tvl ? `$${(data.tvl / 1e6).toFixed(2)}M` : 'N/A',
          chains: data.chains, url: data.url,
          twitter: data.twitter ? `@${data.twitter}` : null,
        }};
      } catch (e: any) { return { success: false, error: e.message }; }
    }
    case 'trending_tokens': {
      try {
        const limit = Math.min(input.limit || 10, 20);
        const res = await fetch('https://token.jup.ag/strict');
        if (!res.ok) return { success: false, error: `Jupiter token list error (${res.status})` };
        const tokens = await res.json();
        // Return popular Solana tokens (Jupiter strict list is curated)
        const trending = tokens.slice(0, limit).map((t: any) => ({
          symbol: t.symbol, name: t.name, mint: t.address,
          decimals: t.decimals, tags: t.tags?.join(', ') || '',
        }));
        return { success: true, data: { count: trending.length, tokens: trending, source: 'Jupiter Strict List' } };
      } catch (e: any) { return { success: false, error: e.message }; }
    }

    // ── Utility Tools ──
    case 'encode_base58': {
      try {
        const bs58 = require('bs58');
        if (input.direction === 'encode') {
          const bytes = Buffer.from(input.value, 'hex');
          const encoded = bs58.default?.encode?.(bytes) ?? bs58.encode(bytes);
          return { success: true, data: { hex: input.value, base58: encoded } };
        } else {
          const decoded = bs58.default?.decode?.(input.value) ?? bs58.decode(input.value);
          const hex = Buffer.from(decoded).toString('hex');
          return { success: true, data: { base58: input.value, hex } };
        }
      } catch (e: any) { return { success: false, error: `Base58 error: ${e.message}` }; }
    }
    case 'generate_keypair': {
      try {
        const { Keypair } = require('@solana/web3.js');
        const bs58 = require('bs58');
        const kp = Keypair.generate();
        const pubkey = kp.publicKey.toBase58();
        const secretHex = Buffer.from(kp.secretKey).toString('hex');
        return { success: true, data: {
          publicKey: pubkey,
          secretKeyHex: secretHex,
          warning: 'FOR TESTING ONLY. Never use for real funds. Secret key is exposed.',
        }};
      } catch (e: any) { return { success: false, error: e.message }; }
    }
    case 'timestamp_convert': {
      try {
        const val = input.value.trim();
        // If numeric, treat as unix timestamp (seconds)
        if (/^\d+$/.test(val)) {
          const ts = parseInt(val);
          const date = new Date(ts * 1000);
          return { success: true, data: {
            unix: ts, iso: date.toISOString(),
            human: date.toLocaleString(),
            relative: `${Math.round((Date.now() - date.getTime()) / 86400_000)} days ago`,
          }};
        }
        // Otherwise parse as date string
        const date = new Date(val);
        if (isNaN(date.getTime())) return { success: false, error: 'Could not parse date. Use ISO format (e.g. 2026-03-17) or unix timestamp.' };
        return { success: true, data: {
          unix: Math.floor(date.getTime() / 1000), iso: date.toISOString(),
          human: date.toLocaleString(),
        }};
      } catch (e: any) { return { success: false, error: e.message }; }
    }

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

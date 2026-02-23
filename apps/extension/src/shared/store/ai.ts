/**
 * AI Store for Chrome Extension
 * Zustand store with chrome.storage persistence for conversations.
 * Ported from mobile (apps/mobile/stores/aiStore.ts).
 */

import { create } from 'zustand';
import {
  AIConfig,
  ChatMessage,
  AIContext,
  loadConfig,
  saveConfig,
  testConnection,
  sendMessage as sendAIMessage,
  sendMessageStreaming as sendAIMessageStreaming,
  DEFAULT_CONFIGS,
  extractSuggestions,
} from '../services/ai/agent';
import { getMarketSummary, type MarketSummary } from '../services/ai/marketData';
import { useWalletStore } from './wallet';

export interface DisplayMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  suggestions?: string[];
}

export interface Conversation {
  id: string;
  title: string;
  messages: DisplayMessage[];
  createdAt: number;
  updatedAt: number;
}

const MAX_CONVERSATIONS = 50;
const MAX_MESSAGES_PER_CONVERSATION = 200;
const CONV_STORAGE_KEY = 'p01_ai_conversations';

interface AIState {
  config: AIConfig;
  isConnected: boolean;
  messages: DisplayMessage[];
  isLoading: boolean;
  error: string | null;
  marketData: MarketSummary | null;
  streamingMessage: string | null;
  conversations: Conversation[];
  activeConversationId: string | null;

  initialize: () => Promise<void>;
  updateConfig: (config: Partial<AIConfig>) => Promise<void>;
  testConnection: () => Promise<{ success: boolean; error?: string }>;
  sendMessage: (content: string) => Promise<void>;
  sendMessageStreaming: (content: string) => Promise<void>;
  clearMessages: () => void;
  clearError: () => void;
  refreshMarketData: () => Promise<void>;
  createConversation: () => string;
  switchConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
}

let messageIdCounter = 0;
function nextId(): string {
  return `msg_${Date.now()}_${++messageIdCounter}`;
}

function conversationId(): string {
  return `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function loadConversations(): Promise<{ conversations: Conversation[]; activeConversationId: string | null }> {
  try {
    const result = await chrome.storage.local.get(CONV_STORAGE_KEY);
    if (result[CONV_STORAGE_KEY]) {
      const data = JSON.parse(result[CONV_STORAGE_KEY]);
      return {
        conversations: data.conversations || [],
        activeConversationId: data.activeConversationId || null,
      };
    }
  } catch {}
  return { conversations: [], activeConversationId: null };
}

async function persistConversations(conversations: Conversation[], activeConversationId: string | null): Promise<void> {
  try {
    await chrome.storage.local.set({
      [CONV_STORAGE_KEY]: JSON.stringify({ conversations, activeConversationId }),
    });
  } catch (e) {
    console.warn('[AIStore] Failed to persist conversations:', e);
  }
}

export const useAIStore = create<AIState>((set, get) => ({
  config: DEFAULT_CONFIGS.groq as AIConfig,
  isConnected: false,
  messages: [],
  isLoading: false,
  error: null,
  marketData: null,
  streamingMessage: null,
  conversations: [],
  activeConversationId: null,

  initialize: async () => {
    try {
      const config = await loadConfig();
      set({ config });

      const result = await testConnection(config);
      set({ isConnected: result.success });

      // Load persisted conversations
      const { conversations, activeConversationId } = await loadConversations();
      set({ conversations, activeConversationId });

      if (activeConversationId) {
        const active = conversations.find(c => c.id === activeConversationId);
        if (active) set({ messages: active.messages });
      }

      // Background market data fetch
      get().refreshMarketData();
    } catch (error) {
      console.error('Failed to initialize AI:', error);
      set({ isConnected: false });
    }
  },

  updateConfig: async (updates: Partial<AIConfig>) => {
    const { config } = get();
    const newConfig = { ...config, ...updates };

    await saveConfig(newConfig);
    set({ config: newConfig, isConnected: false });

    const result = await testConnection(newConfig);
    set({ isConnected: result.success });
  },

  testConnection: async () => {
    const { config } = get();
    const result = await testConnection(config);
    set({ isConnected: result.success });
    return result;
  },

  sendMessage: async (content: string) => {
    const { config, messages, marketData, activeConversationId, conversations } = get();

    let convId = activeConversationId;
    if (!convId) {
      convId = get().createConversation();
    }

    const userMsg: DisplayMessage = { id: nextId(), role: 'user', content, timestamp: Date.now() };
    const updatedMessages = [...messages, userMsg].slice(-MAX_MESSAGES_PER_CONVERSATION);
    set({ messages: updatedMessages, isLoading: true, error: null });

    try {
      const walletStore = useWalletStore.getState();
      let currentMarket = marketData;
      if (!currentMarket || Date.now() - currentMarket.fetchedAt > 60_000) {
        try {
          currentMarket = await getMarketSummary();
          set({ marketData: currentMarket });
        } catch {}
      }

      const context: AIContext = {
        balance: walletStore.solBalance || 0,
        walletAddress: walletStore.publicKey || undefined,
        marketData: currentMarket || undefined,
      };

      const chatMessages: ChatMessage[] = updatedMessages.map(m => ({ role: m.role, content: m.content }));
      const response = await sendAIMessage(chatMessages, config, context);

      if (response.success && response.message) {
        const suggestions = response.suggestions || extractSuggestions(content, response.message);
        const assistantMsg: DisplayMessage = {
          id: nextId(),
          role: 'assistant',
          content: response.message,
          timestamp: Date.now(),
          suggestions,
        };
        const finalMessages = [...updatedMessages, assistantMsg].slice(-MAX_MESSAGES_PER_CONVERSATION);
        set({ messages: finalMessages, isLoading: false });
        _persistConv(get, set, finalMessages, convId!);
      } else {
        set({ error: response.error || 'Failed to get response', isLoading: false });
      }
    } catch (error: any) {
      set({ error: error.message || 'Error', isLoading: false });
    }
  },

  sendMessageStreaming: async (content: string) => {
    const { config, messages, marketData, activeConversationId } = get();

    let convId = activeConversationId;
    if (!convId) {
      convId = get().createConversation();
    }

    const userMsg: DisplayMessage = { id: nextId(), role: 'user', content, timestamp: Date.now() };
    const updatedMessages = [...messages, userMsg].slice(-MAX_MESSAGES_PER_CONVERSATION);

    const assistantId = nextId();
    const placeholderMsg: DisplayMessage = { id: assistantId, role: 'assistant', content: '', timestamp: Date.now() };

    set({
      messages: [...updatedMessages, placeholderMsg],
      isLoading: true,
      error: null,
      streamingMessage: '',
    });

    try {
      const walletStore = useWalletStore.getState();
      let currentMarket = marketData;
      if (!currentMarket || Date.now() - currentMarket.fetchedAt > 60_000) {
        try {
          currentMarket = await getMarketSummary();
          set({ marketData: currentMarket });
        } catch {}
      }

      const context: AIContext = {
        balance: walletStore.solBalance || 0,
        walletAddress: walletStore.publicKey || undefined,
        marketData: currentMarket || undefined,
      };

      const chatMessages: ChatMessage[] = updatedMessages.map(m => ({ role: m.role, content: m.content }));
      let accumulated = '';

      const fullText = await sendAIMessageStreaming(
        chatMessages,
        (token: string) => {
          accumulated += token;
          const currentMessages = get().messages;
          const updated = currentMessages.map(m => (m.id === assistantId ? { ...m, content: accumulated } : m));
          set({ messages: updated, streamingMessage: accumulated });
        },
        config,
        context
      );

      const suggestions = extractSuggestions(content, fullText);
      const currentMessages = get().messages;
      const finalMessages = currentMessages
        .map(m => (m.id === assistantId ? { ...m, content: fullText, suggestions } : m))
        .slice(-MAX_MESSAGES_PER_CONVERSATION);

      set({ messages: finalMessages, isLoading: false, streamingMessage: null });
      _persistConv(get, set, finalMessages, convId!);
    } catch (error: any) {
      const currentMessages = get().messages;
      const cleaned = currentMessages.filter(m => m.id !== assistantId || m.content.length > 0);
      set({ messages: cleaned, error: error.message || 'Streaming failed', isLoading: false, streamingMessage: null });
    }
  },

  clearMessages: () => set({ messages: [], error: null, streamingMessage: null }),
  clearError: () => set({ error: null }),

  refreshMarketData: async () => {
    try {
      const data = await getMarketSummary();
      set({ marketData: data });
    } catch (error) {
      console.warn('[AIStore] Market data fetch failed:', error);
    }
  },

  createConversation: () => {
    const id = conversationId();
    const conv: Conversation = { id, title: 'New Chat', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    const { conversations } = get();
    const updated = [conv, ...conversations].slice(0, MAX_CONVERSATIONS);
    set({ conversations: updated, activeConversationId: id, messages: [] });
    persistConversations(updated, id);
    return id;
  },

  switchConversation: (id: string) => {
    const { conversations, messages, activeConversationId } = get();

    // Save current conversation
    if (activeConversationId && messages.length > 0) {
      _persistConv(get, set, messages, activeConversationId);
    }

    const conv = conversations.find(c => c.id === id);
    if (conv) {
      set({ activeConversationId: id, messages: conv.messages, error: null, streamingMessage: null });
      persistConversations(get().conversations, id);
    }
  },

  deleteConversation: (id: string) => {
    const { conversations, activeConversationId } = get();
    const updated = conversations.filter(c => c.id !== id);
    const isActive = activeConversationId === id;

    set({
      conversations: updated,
      ...(isActive ? { activeConversationId: null, messages: [] } : {}),
    });

    persistConversations(updated, isActive ? null : activeConversationId);
  },
}));

function _persistConv(
  get: () => AIState,
  set: (state: Partial<AIState>) => void,
  msgs: DisplayMessage[],
  convId: string
) {
  const { conversations } = get();
  const updated = conversations.map(c => {
    if (c.id === convId) {
      const firstUserMsg = msgs.find(m => m.role === 'user');
      const title = firstUserMsg
        ? firstUserMsg.content.slice(0, 40) + (firstUserMsg.content.length > 40 ? '...' : '')
        : c.title;
      return { ...c, messages: msgs, title, updatedAt: Date.now() };
    }
    return c;
  });
  set({ conversations: updated });
  persistConversations(updated, convId);
}

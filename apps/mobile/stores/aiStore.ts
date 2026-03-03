import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
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
import { getMarketSummary, MarketSummary } from '../services/crypto/marketData';
import * as LlamaService from '../services/ai/llamaService';
import type { ModelStatus } from '../services/ai/llamaService';
import { useStreamStore } from './streamStore';
import { useWalletStore } from './walletStore';

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
  walletAddress?: string; // Scoped to wallet — conversations without this are legacy/orphaned
}

const MAX_CONVERSATIONS = 50;
const MAX_MESSAGES_PER_CONVERSATION = 200;

interface AIState {
  // Configuration
  config: AIConfig;
  isConfigured: boolean;
  isConnected: boolean;

  // Chat state (active conversation)
  messages: DisplayMessage[];
  isLoading: boolean;
  error: string | null;

  // Market data
  marketData: MarketSummary | null;

  // Streaming
  streamingMessage: string | null;

  // On-device model
  modelStatus: ModelStatus;
  modelDownloadProgress: number;
  modelLoadProgress: number;
  downloadError: string | null;

  // Voice
  isRecording: boolean;
  isTranscribing: boolean;

  // Conversations (persisted)
  conversations: Conversation[];
  activeConversationId: string | null;

  // Actions
  initialize: () => Promise<void>;
  updateConfig: (config: Partial<AIConfig>) => Promise<void>;
  testConnection: () => Promise<{ success: boolean; error?: string }>;

  // Chat actions
  sendMessage: (content: string) => Promise<void>;
  sendMessageStreaming: (content: string) => Promise<void>;
  clearMessages: () => void;
  clearError: () => void;

  // Market data
  refreshMarketData: () => Promise<void>;

  // Model management
  downloadModel: () => Promise<void>;
  cancelDownload: () => Promise<void>;
  initModel: () => Promise<void>;
  releaseModel: () => Promise<void>;
  deleteModel: () => Promise<void>;

  // Conversation management
  createConversation: () => string;
  switchConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
  searchConversations: (query: string) => Conversation[];

  // Voice
  setRecording: (recording: boolean) => void;
  setTranscribing: (transcribing: boolean) => void;
}

let messageIdCounter = 0;
function nextId(): string {
  return `msg_${Date.now()}_${++messageIdCounter}`;
}

function conversationId(): string {
  return `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Separate persisted state for conversations
const useConversationStore = create(
  persist<{
    conversations: Conversation[];
    activeConversationId: string | null;
  }>(
    () => ({
      conversations: [],
      activeConversationId: null,
    }),
    {
      name: 'p01_conversations',
      storage: createJSONStorage(() => AsyncStorage),
    }
  )
);

export const useAIStore = create<AIState>((set, get) => ({
  config: DEFAULT_CONFIGS.groq as AIConfig,
  isConfigured: true,
  isConnected: true,
  messages: [],
  isLoading: false,
  error: null,
  marketData: null,
  streamingMessage: null,
  modelStatus: 'not_downloaded',
  modelDownloadProgress: 0,
  modelLoadProgress: 0,
  downloadError: null,
  isRecording: false,
  isTranscribing: false,
  conversations: [],
  activeConversationId: null,

  initialize: async () => {
    try {
      const config = await loadConfig();
      set({ config, isConfigured: true });

      if (config.provider === 'gemma' && config.gemmaBackend === 'on-device') {
        set({ isConnected: true });
      } else {
        const result = await testConnection(config);
        set({ isConnected: result.success });
      }

      // Fetch market data in background
      get().refreshMarketData();

      // Check on-device model status
      const downloaded = await LlamaService.isModelDownloaded();
      set({ modelStatus: downloaded ? 'ready' : 'not_downloaded' });

      // Listen for model status changes
      LlamaService.onStatusChange((status, progress) => {
        set({
          modelStatus: status,
          ...(status === 'downloading' ? { modelDownloadProgress: progress || 0 } : {}),
          ...(status === 'loading' ? { modelLoadProgress: progress || 0 } : {}),
        });
      });

      // Load persisted conversations — scoped to current wallet
      const convState = useConversationStore.getState();
      const walletStore = useWalletStore.getState();
      const currentWallet = walletStore.publicKey || '';

      // Filter conversations to current wallet (legacy convos without walletAddress are excluded)
      const walletConversations = convState.conversations.filter(
        c => c.walletAddress === currentWallet
      );

      // Only restore active conversation if it belongs to current wallet
      const activeId = convState.activeConversationId;
      const activeValid = activeId && walletConversations.some(c => c.id === activeId);

      set({
        conversations: walletConversations,
        activeConversationId: activeValid ? activeId : null,
      });

      // If there's a valid active conversation, restore its messages
      if (activeValid) {
        const active = walletConversations.find(c => c.id === activeId);
        if (active) {
          set({ messages: active.messages });
        }
      } else {
        set({ messages: [] });
      }
    } catch (error) {
      console.error('Failed to initialize AI:', error);
      set({ isConnected: true });
    }
  },

  updateConfig: async (updates: Partial<AIConfig>) => {
    const { config } = get();
    const newConfig = { ...config, ...updates };

    await saveConfig(newConfig);
    set({ config: newConfig, isConnected: false });

    if (newConfig.provider === 'gemma' && newConfig.gemmaBackend === 'on-device') {
      set({ isConnected: true });
    } else {
      const result = await testConnection(newConfig);
      set({ isConnected: result.success });
    }
  },

  testConnection: async () => {
    const { config } = get();

    if (config.provider === 'gemma' && config.gemmaBackend === 'on-device') {
      set({ isConnected: true });
      return { success: true };
    }

    const result = await testConnection(config);
    set({ isConnected: result.success });
    return result;
  },

  sendMessage: async (content: string) => {
    const { config, messages, marketData, activeConversationId } = get();

    // Auto-create conversation if none active
    let convId = activeConversationId;
    if (!convId) {
      convId = get().createConversation();
    }

    // Add user message
    const userMsg: DisplayMessage = {
      id: nextId(),
      role: 'user',
      content,
      timestamp: Date.now(),
    };
    const updatedMessages = [...messages, userMsg].slice(-MAX_MESSAGES_PER_CONVERSATION);
    set({ messages: updatedMessages, isLoading: true, error: null });

    try {
      // Gather context
      const streamStore = useStreamStore.getState();
      const walletStore = useWalletStore.getState();

      let currentMarket = marketData;
      if (!currentMarket || Date.now() - currentMarket.fetchedAt > 60_000) {
        try {
          currentMarket = await getMarketSummary();
          set({ marketData: currentMarket });
        } catch {}
      }

      const context: AIContext = {
        streams: streamStore.streams,
        balance: walletStore.balance?.sol || 0,
        walletAddress: walletStore.publicKey || undefined,
        marketData: currentMarket || undefined,
      };

      const chatMessages: ChatMessage[] = updatedMessages.map(m => ({
        role: m.role,
        content: m.content,
      }));

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
        get()._persistConversation(finalMessages, convId!);
      } else {
        set({
          error: response.error || 'Failed to get response',
          isLoading: false,
        });
      }
    } catch (error: any) {
      set({
        error: error.message || 'Error',
        isLoading: false,
      });
    }
  },

  sendMessageStreaming: async (content: string) => {
    const { config, messages, marketData, activeConversationId } = get();

    let convId = activeConversationId;
    if (!convId) {
      convId = get().createConversation();
    }

    // Add user message
    const userMsg: DisplayMessage = {
      id: nextId(),
      role: 'user',
      content,
      timestamp: Date.now(),
    };
    const updatedMessages = [...messages, userMsg].slice(-MAX_MESSAGES_PER_CONVERSATION);

    // Add placeholder assistant message for streaming
    const assistantId = nextId();
    const placeholderMsg: DisplayMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    };
    set({
      messages: [...updatedMessages, placeholderMsg],
      isLoading: true,
      error: null,
      streamingMessage: '',
    });

    try {
      const streamStore = useStreamStore.getState();
      const walletStore = useWalletStore.getState();

      let currentMarket = marketData;
      if (!currentMarket || Date.now() - currentMarket.fetchedAt > 60_000) {
        try {
          currentMarket = await getMarketSummary();
          set({ marketData: currentMarket });
        } catch {}
      }

      const context: AIContext = {
        streams: streamStore.streams,
        balance: walletStore.balance?.sol || 0,
        walletAddress: walletStore.publicKey || undefined,
        marketData: currentMarket || undefined,
      };

      const chatMessages: ChatMessage[] = updatedMessages.map(m => ({
        role: m.role,
        content: m.content,
      }));

      let accumulated = '';

      const fullText = await sendAIMessageStreaming(
        chatMessages,
        (token: string) => {
          accumulated += token;
          // Update the placeholder message content in-place
          const currentMessages = get().messages;
          const updated = currentMessages.map(m =>
            m.id === assistantId ? { ...m, content: accumulated } : m
          );
          set({ messages: updated, streamingMessage: accumulated });
        },
        config,
        context
      );

      const suggestions = extractSuggestions(content, fullText);
      const currentMessages = get().messages;
      const finalMessages = currentMessages.map(m =>
        m.id === assistantId ? { ...m, content: fullText, suggestions } : m
      ).slice(-MAX_MESSAGES_PER_CONVERSATION);

      set({
        messages: finalMessages,
        isLoading: false,
        streamingMessage: null,
      });
      get()._persistConversation(finalMessages, convId!);
    } catch (error: any) {
      // Remove the empty placeholder on error
      const currentMessages = get().messages;
      const cleaned = currentMessages.filter(m => m.id !== assistantId || m.content.length > 0);
      set({
        messages: cleaned,
        error: error.message || 'Streaming failed',
        isLoading: false,
        streamingMessage: null,
      });
    }
  },

  clearMessages: () => {
    set({ messages: [], error: null, streamingMessage: null });
  },

  clearError: () => {
    set({ error: null });
  },

  refreshMarketData: async () => {
    try {
      const data = await getMarketSummary();
      set({ marketData: data });
    } catch (error) {
      // Market data fetch failed — non-critical
    }
  },

  downloadModel: async () => {
    set({ downloadError: null });
    try {
      await LlamaService.downloadModel((progress) => {
        set({ modelDownloadProgress: progress });
      });
    } catch (error: any) {
      set({ downloadError: error.message || 'Download failed' });
    }
  },

  cancelDownload: async () => {
    await LlamaService.cancelDownload();
    set({ downloadError: null, modelDownloadProgress: 0 });
  },

  initModel: async () => {
    try {
      await LlamaService.initModel((progress) => {
        set({ modelLoadProgress: progress });
      });
    } catch (error: any) {
      set({ error: `Model load failed: ${error.message}` });
    }
  },

  releaseModel: async () => {
    await LlamaService.releaseModel();
  },

  deleteModel: async () => {
    await LlamaService.deleteModel();
    set({ modelStatus: 'not_downloaded', modelDownloadProgress: 0, modelLoadProgress: 0 });
  },

  // ---- Conversation Management ----

  createConversation: () => {
    const id = conversationId();
    const walletStore = useWalletStore.getState();
    const currentWallet = walletStore.publicKey || '';

    const conv: Conversation = {
      id,
      title: 'New Chat',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      walletAddress: currentWallet,
    };

    const { conversations } = get();
    const updated = [conv, ...conversations].slice(0, MAX_CONVERSATIONS);
    set({ conversations: updated, activeConversationId: id, messages: [] });

    // Persist ALL conversations (including other wallets) so nothing is lost
    const allConversations = useConversationStore.getState().conversations;
    const allUpdated = [conv, ...allConversations.filter(c => c.id !== id)].slice(0, MAX_CONVERSATIONS * 2);
    useConversationStore.setState({ conversations: allUpdated, activeConversationId: id });
    return id;
  },

  switchConversation: (id: string) => {
    const { conversations, messages, activeConversationId } = get();

    // Save current conversation first
    if (activeConversationId && messages.length > 0) {
      get()._persistConversation(messages, activeConversationId);
    }

    const conv = conversations.find(c => c.id === id);
    if (conv) {
      set({
        activeConversationId: id,
        messages: conv.messages,
        error: null,
        streamingMessage: null,
      });
      useConversationStore.setState({ activeConversationId: id });
    }
  },

  deleteConversation: (id: string) => {
    const { conversations, activeConversationId } = get();
    const updated = conversations.filter(c => c.id !== id);
    const newState: Partial<AIState> = { conversations: updated };

    if (activeConversationId === id) {
      newState.activeConversationId = null;
      newState.messages = [];
    }

    set(newState as any);

    // Also remove from full persisted store
    const allConversations = useConversationStore.getState().conversations;
    useConversationStore.setState({
      conversations: allConversations.filter(c => c.id !== id),
      activeConversationId: activeConversationId === id ? null : activeConversationId,
    });
  },

  searchConversations: (query: string) => {
    const { conversations } = get();
    const lower = query.toLowerCase();
    return conversations.filter(c =>
      c.title.toLowerCase().includes(lower) ||
      c.messages.some(m => m.content.toLowerCase().includes(lower))
    );
  },

  // Voice state
  setRecording: (recording: boolean) => set({ isRecording: recording }),
  setTranscribing: (transcribing: boolean) => set({ isTranscribing: transcribing }),

  // Internal: persist conversation messages
  _persistConversation: (msgs: DisplayMessage[], convId: string) => {
    const { conversations } = get();
    const walletStore = useWalletStore.getState();
    const currentWallet = walletStore.publicKey || '';

    const updated = conversations.map(c => {
      if (c.id === convId) {
        // Auto-title from first user message
        const firstUserMsg = msgs.find(m => m.role === 'user');
        const title = firstUserMsg
          ? firstUserMsg.content.slice(0, 40) + (firstUserMsg.content.length > 40 ? '...' : '')
          : c.title;
        return { ...c, messages: msgs, title, updatedAt: Date.now(), walletAddress: c.walletAddress || currentWallet };
      }
      return c;
    });
    set({ conversations: updated });

    // Merge into full persisted store (all wallets)
    const allConversations = useConversationStore.getState().conversations;
    const mergedIds = new Set(updated.map(c => c.id));
    const otherWalletConvos = allConversations.filter(c => !mergedIds.has(c.id));
    useConversationStore.setState({ conversations: [...updated, ...otherWalletConvos] });
  },
} as any));

import { create } from 'zustand';
import {
  AIConfig,
  ChatMessage,
  AIContext,
  loadConfig,
  saveConfig,
  testConnection,
  sendMessage,
  DEFAULT_CONFIGS,
} from '../services/ai/agent';
import { useStreamStore } from './streamStore';
import { useWalletStore } from './walletStore';

interface AIState {
  // Configuration
  config: AIConfig;
  isConfigured: boolean;
  isConnected: boolean;

  // Chat state
  messages: ChatMessage[];
  isLoading: boolean;
  error: string | null;

  // Actions
  initialize: () => Promise<void>;
  updateConfig: (config: Partial<AIConfig>) => Promise<void>;
  testConnection: () => Promise<{ success: boolean; error?: string }>;

  // Chat actions
  sendMessage: (content: string) => Promise<void>;
  clearMessages: () => void;
  clearError: () => void;
}

export const useAIStore = create<AIState>((set, get) => ({
  // Initial state - Gemma on-device by default (always ready)
  config: DEFAULT_CONFIGS.gemma as AIConfig,
  isConfigured: true,
  isConnected: true, // On-device mode is always connected
  messages: [],
  isLoading: false,
  error: null,

  // Initialize - load config from storage
  initialize: async () => {
    try {
      const config = await loadConfig();
      set({ config, isConfigured: true });

      // On-device mode is always immediately connected
      if (config.provider === 'gemma' && config.gemmaBackend === 'on-device') {
        set({ isConnected: true });
        return;
      }

      // Test connection for other providers in background
      const result = await testConnection(config);
      set({ isConnected: result.success });
    } catch (error) {
      console.error('Failed to initialize AI:', error);
      // Fall back to on-device mode if initialization fails
      set({ isConnected: true });
    }
  },

  // Update configuration
  updateConfig: async (updates: Partial<AIConfig>) => {
    const { config } = get();
    const newConfig = { ...config, ...updates };

    await saveConfig(newConfig);
    set({ config: newConfig, isConnected: false });

    // Test new connection
    const result = await testConnection(newConfig);
    set({ isConnected: result.success });
  },

  // Test connection
  testConnection: async () => {
    const { config } = get();

    // On-device mode is always immediately connected
    if (config.provider === 'gemma' && config.gemmaBackend === 'on-device') {
      set({ isConnected: true });
      return { success: true };
    }

    const result = await testConnection(config);
    set({ isConnected: result.success });
    return result;
  },

  // Send message to AI (always works with on-device mode)
  sendMessage: async (content: string) => {
    const { config, messages } = get();

    // Add user message
    const userMessage: ChatMessage = { role: 'user', content };
    const newMessages = [...messages, userMessage];
    set({ messages: newMessages, isLoading: true, error: null });

    try {
      // Get context from other stores
      const streamStore = useStreamStore.getState();
      const walletStore = useWalletStore.getState();


      const context: AIContext = {
        streams: streamStore.streams,
        balance: walletStore.balance?.sol || 0,
        walletAddress: walletStore.publicKey || undefined,
      };

      // Send to AI with context
      const response = await sendMessage(newMessages, config, context);

      if (response.success && response.message) {
        // Add assistant response
        const assistantMessage: ChatMessage = {
          role: 'assistant',
          content: response.message,
        };
        set({ messages: [...newMessages, assistantMessage], isLoading: false });
      } else {
        set({
          error: response.error || 'Erreur de réponse',
          isLoading: false,
        });
      }
    } catch (error: any) {
      set({
        error: error.message || 'Erreur',
        isLoading: false,
      });
    }
  },

  // Clear messages
  clearMessages: () => {
    set({ messages: [], error: null });
  },

  // Clear error
  clearError: () => {
    set({ error: null });
  },
}));

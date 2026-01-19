import { create } from 'zustand';
import {
  AIConfig,
  ChatMessage,
  loadConfig,
  saveConfig,
  testConnection,
  sendMessage,
  DEFAULT_CONFIGS,
} from '../services/ai/agent';

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
  // Initial state
  config: DEFAULT_CONFIGS.ollama as AIConfig,
  isConfigured: false,
  isConnected: false,
  messages: [],
  isLoading: false,
  error: null,

  // Initialize - load config from storage
  initialize: async () => {
    try {
      const config = await loadConfig();
      set({ config, isConfigured: true });

      // Test connection in background
      const result = await testConnection(config);
      set({ isConnected: result.success });
    } catch (error) {
      console.error('Failed to initialize AI:', error);
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
    const result = await testConnection(config);
    set({ isConnected: result.success });
    return result;
  },

  // Send message to AI
  sendMessage: async (content: string) => {
    const { config, messages, isConnected } = get();

    if (!isConnected) {
      set({ error: 'AI not connected. Check your settings.' });
      return;
    }

    // Add user message
    const userMessage: ChatMessage = { role: 'user', content };
    const newMessages = [...messages, userMessage];
    set({ messages: newMessages, isLoading: true, error: null });

    try {
      // Send to AI
      const response = await sendMessage(newMessages, config);

      if (response.success && response.message) {
        // Add assistant response
        const assistantMessage: ChatMessage = {
          role: 'assistant',
          content: response.message,
        };
        set({ messages: [...newMessages, assistantMessage], isLoading: false });
      } else {
        set({
          error: response.error || 'Failed to get response',
          isLoading: false,
        });
      }
    } catch (error: any) {
      set({
        error: error.message || 'Failed to send message',
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

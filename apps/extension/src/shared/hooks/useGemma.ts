/**
 * React Hook for Gemma 3n AI in Specter Extension
 *
 * Provides easy-to-use AI-powered chat functionality for React components.
 */

import { useState, useCallback, useRef } from 'react';
import {
  processWithGemma,
  quickClassifyIntent,
  testGemmaConnection,
  loadGemmaConfig,
  saveGemmaConfig,
  GemmaConfig,
  GemmaMessage,
  GemmaIntentResponse,
  WalletIntent,
} from '../services/gemma';

// Message types for the chat interface
export type MessageRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  intent?: WalletIntent;
  entities?: Record<string, unknown>;
  suggestions?: Array<{ text: string; action: string }>;
  requiresConfirmation?: boolean;
  timestamp: number;
  isLoading?: boolean;
}

// Hook state
interface UseGemmaState {
  messages: ChatMessage[];
  isProcessing: boolean;
  isConnected: boolean;
  error: string | null;
  config: GemmaConfig | null;
}

// Hook return type
interface UseGemmaReturn extends UseGemmaState {
  sendMessage: (content: string) => Promise<GemmaIntentResponse | null>;
  clearMessages: () => void;
  testConnection: () => Promise<boolean>;
  updateConfig: (config: Partial<GemmaConfig>) => Promise<void>;
  quickClassify: (message: string) => WalletIntent;
}

/**
 * Hook for Gemma 3n AI chat
 */
export function useGemma(): UseGemmaReturn {
  const [state, setState] = useState<UseGemmaState>({
    messages: [],
    isProcessing: false,
    isConnected: false,
    error: null,
    config: null,
  });

  const conversationHistoryRef = useRef<GemmaMessage[]>([]);

  // Initialize config on first use
  const initConfig = useCallback(async () => {
    if (!state.config) {
      const config = await loadGemmaConfig();
      setState(prev => ({ ...prev, config }));
      return config;
    }
    return state.config;
  }, [state.config]);

  // Send message to Gemma
  const sendMessage = useCallback(async (content: string): Promise<GemmaIntentResponse | null> => {
    if (!content.trim() || state.isProcessing) return null;

    setState(prev => ({ ...prev, isProcessing: true, error: null }));

    // Add user message
    const userMessage: ChatMessage = {
      id: `msg_${Date.now()}_user`,
      role: 'user',
      content: content.trim(),
      timestamp: Date.now(),
    };

    setState(prev => ({
      ...prev,
      messages: [...prev.messages, userMessage],
    }));

    try {
      const config = await initConfig();

      // Process with Gemma
      const response = await processWithGemma(
        content,
        conversationHistoryRef.current,
        config!
      );

      // Update conversation history
      conversationHistoryRef.current.push(
        { role: 'user', parts: [{ text: content }] },
        { role: 'model', parts: [{ text: response.response }] }
      );

      // Keep history limited
      if (conversationHistoryRef.current.length > 20) {
        conversationHistoryRef.current = conversationHistoryRef.current.slice(-20);
      }

      // Add assistant message
      const assistantMessage: ChatMessage = {
        id: `msg_${Date.now()}_assistant`,
        role: 'assistant',
        content: response.response,
        intent: response.intent,
        entities: response.entities,
        suggestions: response.suggestions,
        requiresConfirmation: response.requiresConfirmation,
        timestamp: Date.now(),
      };

      setState(prev => ({
        ...prev,
        messages: [...prev.messages, assistantMessage],
        isProcessing: false,
        isConnected: true,
      }));

      return response;
    } catch (error: any) {
      const errorMessage = error.message || 'Failed to process message';

      setState(prev => ({
        ...prev,
        isProcessing: false,
        error: errorMessage,
        isConnected: false,
      }));

      // Add error message
      const errorMsg: ChatMessage = {
        id: `msg_${Date.now()}_error`,
        role: 'system',
        content: `Error: ${errorMessage}`,
        timestamp: Date.now(),
      };

      setState(prev => ({
        ...prev,
        messages: [...prev.messages, errorMsg],
      }));

      return null;
    }
  }, [state.isProcessing, initConfig]);

  // Clear messages
  const clearMessages = useCallback(() => {
    conversationHistoryRef.current = [];
    setState(prev => ({
      ...prev,
      messages: [],
      error: null,
    }));
  }, []);

  // Test connection
  const testConnection = useCallback(async (): Promise<boolean> => {
    const config = await initConfig();
    const result = await testGemmaConnection(config!);

    setState(prev => ({
      ...prev,
      isConnected: result.success,
      error: result.error || null,
    }));

    return result.success;
  }, [initConfig]);

  // Update config
  const updateConfig = useCallback(async (newConfig: Partial<GemmaConfig>): Promise<void> => {
    await saveGemmaConfig(newConfig);
    const config = await loadGemmaConfig();
    setState(prev => ({ ...prev, config }));
  }, []);

  // Quick classify
  const quickClassify = useCallback((message: string): WalletIntent => {
    return quickClassifyIntent(message);
  }, []);

  return {
    ...state,
    sendMessage,
    clearMessages,
    testConnection,
    updateConfig,
    quickClassify,
  };
}

/**
 * Hook for AI settings management
 */
export function useGemmaSettings() {
  const [config, setConfig] = useState<GemmaConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    error?: string;
    modelInfo?: string;
  } | null>(null);

  // Load config
  const loadConfig = useCallback(async () => {
    setIsLoading(true);
    const cfg = await loadGemmaConfig();
    setConfig(cfg);
    setIsLoading(false);
  }, []);

  // Save config
  const saveConfig = useCallback(async (newConfig: Partial<GemmaConfig>) => {
    await saveGemmaConfig(newConfig);
    await loadConfig();
  }, [loadConfig]);

  // Test connection
  const testConnection = useCallback(async () => {
    setIsTesting(true);
    setTestResult(null);
    const result = await testGemmaConnection(config!);
    setTestResult(result);
    setIsTesting(false);
    return result.success;
  }, [config]);

  return {
    config,
    isLoading,
    isTesting,
    testResult,
    loadConfig,
    saveConfig,
    testConnection,
  };
}

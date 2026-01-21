/**
 * useChat - Agent chat messages and conversation
 * @module hooks/agent/useChat
 *
 * Uses Gemma 3n for AI-powered intent parsing and response generation.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useAsyncStorage, ASYNC_KEYS } from '../storage/useAsyncStorage';
import { useAgent, AgentCapability } from './useAgent';
import {
  processWithGemma,
  quickClassifyIntent,
  GemmaMessage,
  GemmaIntentResponse,
} from '../../services/ai/gemma';

export type MessageRole = 'user' | 'agent' | 'system';

export type MessageType =
  | 'text'
  | 'transaction_request'
  | 'transaction_result'
  | 'stream_request'
  | 'balance_info'
  | 'price_info'
  | 'confirmation_request'
  | 'error'
  | 'suggestion';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  type: MessageType;
  content: string;
  data?: Record<string, unknown>;
  timestamp: number;
  isLoading?: boolean;
}

export interface Suggestion {
  id: string;
  text: string;
  action: string;
  params?: Record<string, unknown>;
}

export interface ChatContext {
  lastIntent?: string;
  entities?: Record<string, unknown>;
  conversationId: string;
}

interface UseChatReturn {
  messages: ChatMessage[];
  isTyping: boolean;
  suggestions: Suggestion[];
  context: ChatContext;
  sendMessage: (content: string) => Promise<void>;
  clearChat: () => Promise<void>;
  loadHistory: () => Promise<void>;
  addSystemMessage: (content: string, type?: MessageType) => void;
  executeSuggestion: (suggestion: Suggestion) => Promise<void>;
}

const MAX_HISTORY_MESSAGES = 100;

export function useChat(): UseChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [context, setContext] = useState<ChatContext>({
    conversationId: generateConversationId(),
  });

  const processingRef = useRef(false);
  const conversationHistoryRef = useRef<GemmaMessage[]>([]);

  const { isReady, hasCapability, state: agentState } = useAgent();

  const {
    value: chatHistory,
    setValue: setChatHistory,
  } = useAsyncStorage<ChatMessage[]>({
    key: ASYNC_KEYS.AGENT_HISTORY,
    defaultValue: [],
  });

  // Load history on mount
  useEffect(() => {
    if (chatHistory && chatHistory.length > 0) {
      setMessages(chatHistory.slice(-MAX_HISTORY_MESSAGES));
    }
  }, [chatHistory]);

  // Save messages to history
  const saveToHistory = useCallback(async (msgs: ChatMessage[]) => {
    const toSave = msgs.slice(-MAX_HISTORY_MESSAGES);
    await setChatHistory(toSave);
  }, [setChatHistory]);

  const addMessage = useCallback((message: Omit<ChatMessage, 'id' | 'timestamp'>) => {
    const newMessage: ChatMessage = {
      ...message,
      id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      timestamp: Date.now(),
    };

    setMessages(prev => {
      const updated = [...prev, newMessage];
      saveToHistory(updated);
      return updated;
    });

    return newMessage;
  }, [saveToHistory]);

  const updateMessage = useCallback((messageId: string, updates: Partial<ChatMessage>) => {
    setMessages(prev =>
      prev.map(msg =>
        msg.id === messageId ? { ...msg, ...updates } : msg
      )
    );
  }, []);

  // Convert Gemma response to chat message format
  const gemmaResponseToMessage = useCallback((
    gemmaResponse: GemmaIntentResponse
  ): { content: string; type: MessageType; data?: Record<string, unknown>; suggestions?: Suggestion[] } => {
    // Map intent to message type
    const typeMapping: Partial<Record<string, MessageType>> = {
      send_transaction: 'transaction_request',
      stealth_send: 'transaction_request',
      check_balance: 'balance_info',
      price_lookup: 'price_info',
      create_stream: 'stream_request',
      manage_stream: 'stream_request',
    };

    const messageType = typeMapping[gemmaResponse.intent] || 'text';

    // Convert Gemma suggestions to our format
    const suggestions: Suggestion[] = (gemmaResponse.suggestions || []).map((s, i) => ({
      id: `sug_${Date.now()}_${i}`,
      text: s.text,
      action: s.action,
      params: gemmaResponse.entities,
    }));

    // Add default suggestions if none provided
    if (suggestions.length === 0) {
      if (gemmaResponse.requiresConfirmation) {
        suggestions.push(
          { id: '1', text: 'Yes, proceed', action: 'confirm', params: gemmaResponse.entities },
          { id: '2', text: 'Cancel', action: 'cancel' }
        );
      } else if (gemmaResponse.intent === 'greeting' || gemmaResponse.intent === 'help') {
        suggestions.push(
          { id: '1', text: 'Check my balance', action: 'check_balance' },
          { id: '2', text: 'Send payment', action: 'send_prompt' },
          { id: '3', text: 'Create a stream', action: 'stream_prompt' }
        );
      }
    }

    return {
      content: gemmaResponse.response,
      type: messageType,
      data: gemmaResponse.entities,
      suggestions: suggestions.length > 0 ? suggestions : undefined,
    };
  }, []);

  // Process message with Gemma 3n AI
  const processWithAI = useCallback(async (
    content: string
  ): Promise<{ content: string; type: MessageType; data?: Record<string, unknown>; suggestions?: Suggestion[]; requiredCapability?: AgentCapability }> => {
    try {
      // Process with Gemma
      const gemmaResponse = await processWithGemma(
        content,
        conversationHistoryRef.current
      );

      // Update conversation history
      conversationHistoryRef.current.push(
        { role: 'user', parts: [{ text: content }] },
        { role: 'model', parts: [{ text: gemmaResponse.response }] }
      );

      // Keep history limited to last 10 exchanges
      if (conversationHistoryRef.current.length > 20) {
        conversationHistoryRef.current = conversationHistoryRef.current.slice(-20);
      }

      const result = gemmaResponseToMessage(gemmaResponse);
      return {
        ...result,
        requiredCapability: gemmaResponse.requiredCapability,
      };
    } catch (error) {
      console.error('[useChat] AI processing error:', error);

      // Fallback response
      return {
        content: "I'm having trouble connecting to the AI. Please check your settings or try again.",
        type: 'error',
        suggestions: [
          { id: '1', text: 'Check my balance', action: 'check_balance' },
          { id: '2', text: 'Try again', action: 'retry' },
        ],
      };
    }
  }, [gemmaResponseToMessage]);

  const sendMessage = useCallback(async (content: string) => {
    if (!content.trim() || processingRef.current) return;

    processingRef.current = true;
    setSuggestions([]);

    // Add user message
    addMessage({
      role: 'user',
      type: 'text',
      content: content.trim(),
    });

    // Check if agent is ready
    if (!isReady) {
      addMessage({
        role: 'system',
        type: 'error',
        content: 'Agent is not available. Please unlock your wallet and ensure you have network connectivity.',
      });
      processingRef.current = false;
      return;
    }

    // Show typing indicator
    setIsTyping(true);

    try {
      // Quick classify to check capability before full AI processing
      const quickIntent = quickClassifyIntent(content);
      const quickCapability = mapIntentToCapability(quickIntent);

      // Check capability
      if (quickCapability && !hasCapability(quickCapability)) {
        addMessage({
          role: 'agent',
          type: 'error',
          content: `I don't have permission to ${quickCapability.replace(/_/g, ' ')}. You can grant this permission in settings.`,
        });
        setIsTyping(false);
        processingRef.current = false;
        return;
      }

      // Process with Gemma 3n AI
      const response = await processWithAI(content);

      // Double-check capability from AI response
      if (response.requiredCapability && !hasCapability(response.requiredCapability)) {
        addMessage({
          role: 'agent',
          type: 'error',
          content: `I don't have permission to ${response.requiredCapability.replace(/_/g, ' ')}. You can grant this permission in settings.`,
        });
        setIsTyping(false);
        processingRef.current = false;
        return;
      }

      // Update context
      setContext(prev => ({
        ...prev,
        lastIntent: quickIntent,
        entities: response.data || {},
      }));

      // Add agent response
      addMessage({
        role: 'agent',
        type: response.type,
        content: response.content,
        data: response.data,
      });

      // Set suggestions
      if (response.suggestions) {
        setSuggestions(response.suggestions);
      }
    } catch (error) {
      console.error('[useChat] Send message error:', error);
      addMessage({
        role: 'agent',
        type: 'error',
        content: 'Sorry, I encountered an error processing your request. Please try again.',
      });
    } finally {
      setIsTyping(false);
      processingRef.current = false;
    }
  }, [isReady, hasCapability, processWithAI, addMessage]);

  const clearChat = useCallback(async () => {
    setMessages([]);
    setSuggestions([]);
    conversationHistoryRef.current = []; // Clear Gemma conversation history
    setContext({
      conversationId: generateConversationId(),
    });
    await setChatHistory([]);
  }, [setChatHistory]);

  const loadHistory = useCallback(async () => {
    if (chatHistory) {
      setMessages(chatHistory.slice(-MAX_HISTORY_MESSAGES));
    }
  }, [chatHistory]);

  const addSystemMessage = useCallback((content: string, type: MessageType = 'text') => {
    addMessage({
      role: 'system',
      type,
      content,
    });
  }, [addMessage]);

  const executeSuggestion = useCallback(async (suggestion: Suggestion) => {
    // Treat suggestion as a user action
    await sendMessage(suggestion.text);
  }, [sendMessage]);

  return {
    messages,
    isTyping,
    suggestions,
    context,
    sendMessage,
    clearChat,
    loadHistory,
    addSystemMessage,
    executeSuggestion,
  };
}

function generateConversationId(): string {
  return `conv_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

// Map quick intent to capability for permission checking
function mapIntentToCapability(intent: string): AgentCapability | undefined {
  const mapping: Record<string, AgentCapability> = {
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

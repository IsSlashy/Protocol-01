/**
 * useChat - Agent chat messages and conversation
 * @module hooks/agent/useChat
 */

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useAsyncStorage, ASYNC_KEYS } from '../storage/useAsyncStorage';
import { useAgent, AgentCapability } from './useAgent';

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

  // Parse user intent and entities from message
  const parseIntent = useCallback((content: string): {
    intent: string;
    entities: Record<string, unknown>;
    requiredCapability?: AgentCapability;
  } => {
    const lowerContent = content.toLowerCase();

    // Send intent
    if (lowerContent.includes('send') || lowerContent.includes('transfer')) {
      const amountMatch = content.match(/(\d+(?:\.\d+)?)\s*(eth|usdc|usdt|dai)?/i);
      const addressMatch = content.match(/to\s+(0x[a-fA-F0-9]{40}|[\w-]+\.eth)/i);

      return {
        intent: 'send_transaction',
        entities: {
          amount: amountMatch?.[1],
          token: amountMatch?.[2]?.toUpperCase() ?? 'ETH',
          recipient: addressMatch?.[1],
        },
        requiredCapability: lowerContent.includes('stealth') || lowerContent.includes('private')
          ? 'stealth_send'
          : 'send_transaction',
      };
    }

    // Stream intent
    if (lowerContent.includes('stream') || lowerContent.includes('salary')) {
      return {
        intent: 'create_stream',
        entities: {},
        requiredCapability: 'create_stream',
      };
    }

    // Balance intent
    if (lowerContent.includes('balance') || lowerContent.includes('how much')) {
      return {
        intent: 'check_balance',
        entities: {},
        requiredCapability: 'check_balance',
      };
    }

    // Price intent
    if (lowerContent.includes('price') || lowerContent.includes('worth')) {
      const tokenMatch = content.match(/(eth|btc|usdc|usdt|dai)/i);
      return {
        intent: 'price_lookup',
        entities: { token: tokenMatch?.[1]?.toUpperCase() },
        requiredCapability: 'price_lookup',
      };
    }

    // Gas intent
    if (lowerContent.includes('gas') || lowerContent.includes('fee')) {
      return {
        intent: 'gas_estimation',
        entities: {},
        requiredCapability: 'gas_estimation',
      };
    }

    // Default to general query
    return {
      intent: 'general_query',
      entities: {},
    };
  }, []);

  // Generate response based on intent
  const generateResponse = useCallback(async (
    intent: string,
    entities: Record<string, unknown>
  ): Promise<{ content: string; type: MessageType; data?: Record<string, unknown>; suggestions?: Suggestion[] }> => {
    // Simulate AI processing delay
    await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 1000));

    switch (intent) {
      case 'send_transaction':
        if (entities.amount && entities.recipient) {
          return {
            content: `I'll help you send ${entities.amount} ${entities.token} to ${entities.recipient}. Would you like me to prepare this transaction?`,
            type: 'transaction_request',
            data: entities,
            suggestions: [
              { id: '1', text: 'Yes, proceed', action: 'confirm_send', params: entities },
              { id: '2', text: 'Use stealth address', action: 'stealth_send', params: entities },
              { id: '3', text: 'Cancel', action: 'cancel' },
            ],
          };
        }
        return {
          content: 'I need more details to process your transaction. Who would you like to send to and how much?',
          type: 'text',
          suggestions: [
            { id: '1', text: 'Send 0.1 ETH to...', action: 'prompt', params: { template: 'send' } },
          ],
        };

      case 'check_balance':
        // In real implementation, fetch actual balance
        return {
          content: 'Here is your current balance:\n\n**ETH**: 1.5 ($3,750)\n**USDC**: 500 ($500)\n\n**Total**: $4,250',
          type: 'balance_info',
          data: {
            eth: '1.5',
            usdc: '500',
            totalUsd: '4250',
          },
        };

      case 'price_lookup':
        const token = entities.token ?? 'ETH';
        return {
          content: `The current price of ${token} is $2,500.00 (+2.5% in 24h)`,
          type: 'price_info',
          data: {
            token,
            price: 2500,
            change24h: 2.5,
          },
        };

      case 'gas_estimation':
        return {
          content: 'Current gas prices:\n\n**Slow**: 15 gwei (~$0.50)\n**Normal**: 20 gwei (~$0.75)\n**Fast**: 30 gwei (~$1.10)',
          type: 'text',
          suggestions: [
            { id: '1', text: 'Set gas to fast', action: 'set_gas', params: { speed: 'fast' } },
          ],
        };

      case 'create_stream':
        return {
          content: 'I can help you create a payment stream. Who should receive the stream and what amount over what period?',
          type: 'stream_request',
          suggestions: [
            { id: '1', text: 'Monthly salary', action: 'stream_template', params: { type: 'salary' } },
            { id: '2', text: 'Custom stream', action: 'stream_custom' },
          ],
        };

      default:
        return {
          content: "I'm here to help you manage your wallet. You can ask me to send payments, check your balance, look up prices, or create payment streams.",
          type: 'text',
          suggestions: [
            { id: '1', text: 'Check my balance', action: 'check_balance' },
            { id: '2', text: 'Send payment', action: 'send_prompt' },
            { id: '3', text: 'Create a stream', action: 'stream_prompt' },
          ],
        };
    }
  }, []);

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
      // Parse intent
      const { intent, entities, requiredCapability } = parseIntent(content);

      // Check capability
      if (requiredCapability && !hasCapability(requiredCapability)) {
        addMessage({
          role: 'agent',
          type: 'error',
          content: `I don't have permission to ${requiredCapability.replace(/_/g, ' ')}. You can grant this permission in settings.`,
        });
        setIsTyping(false);
        processingRef.current = false;
        return;
      }

      // Update context
      setContext(prev => ({
        ...prev,
        lastIntent: intent,
        entities,
      }));

      // Generate response
      const response = await generateResponse(intent, entities);

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
      addMessage({
        role: 'agent',
        type: 'error',
        content: 'Sorry, I encountered an error processing your request. Please try again.',
      });
    } finally {
      setIsTyping(false);
      processingRef.current = false;
    }
  }, [isReady, hasCapability, parseIntent, generateResponse, addMessage]);

  const clearChat = useCallback(async () => {
    setMessages([]);
    setSuggestions([]);
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

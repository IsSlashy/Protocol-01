import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Animated, { FadeInDown, FadeIn } from 'react-native-reanimated';

import {
  AgentAvatar,
  ChatBubble,
  ActionPreview,
  ExecutionProgress,
  SuggestionChip,
} from '@/components/agent';
import { useAIStore } from '@/stores/aiStore';

// Message types
interface BaseMessage {
  id: string;
  timestamp: string;
}

interface TextMessage extends BaseMessage {
  type: 'agent' | 'user';
  content: string;
}

interface ActionMessage extends BaseMessage {
  type: 'action';
  content: string;
  action: {
    type: 'swap' | 'send' | 'buy';
    from?: string;
    to?: string;
    route?: string;
    amount?: string;
    recipient?: string;
    token?: string;
    method?: string;
  };
}

interface ExecutionMessage extends BaseMessage {
  type: 'execution';
  steps: Array<{ label: string; done: boolean }>;
  progress: number;
}

type Message = TextMessage | ActionMessage | ExecutionMessage;

const suggestions = [
  { label: 'Swap tokens', icon: 'swap-horizontal' as const },
  { label: 'Send SOL', icon: 'arrow-up' as const },
  { label: 'Check balance', icon: 'wallet-outline' as const },
  { label: 'Help', icon: 'help-circle-outline' as const },
];

export default function AgentChat() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ action?: string }>();
  const scrollViewRef = useRef<ScrollView>(null);

  const {
    messages: aiMessages,
    isLoading,
    isConnected,
    error,
    initialize,
    sendMessage: sendAIMessage,
    clearMessages,
    clearError,
  } = useAIStore();

  const [displayMessages, setDisplayMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');

  // Initialize AI on mount
  useEffect(() => {
    initialize();
  }, []);

  // Add welcome message on first load
  useEffect(() => {
    if (displayMessages.length === 0) {
      const welcomeMessage: TextMessage = {
        id: 'welcome',
        type: 'agent',
        content: isConnected
          ? "Hello! I'm your P-01 Agent powered by local AI. I can help you with transactions, answer questions about Solana, and more. What would you like to do?"
          : "Hello! I'm your P-01 Agent. To enable AI responses, please configure your AI settings (tap the settings icon). For now, I'll provide basic assistance.",
        timestamp: 'Just now',
      };
      setDisplayMessages([welcomeMessage]);
    }
  }, [isConnected]);

  // Sync AI messages to display messages
  useEffect(() => {
    if (aiMessages.length > 0) {
      const newMessages: Message[] = aiMessages.map((msg, index) => ({
        id: `ai-${index}`,
        type: msg.role === 'user' ? 'user' : 'agent',
        content: msg.content,
        timestamp: 'Just now',
      }));

      // Keep welcome message and add AI messages
      setDisplayMessages((prev) => {
        const welcome = prev.find(m => m.id === 'welcome');
        return welcome ? [welcome, ...newMessages] : newMessages;
      });
    }
  }, [aiMessages]);

  // Show error alert
  useEffect(() => {
    if (error) {
      Alert.alert('AI Error', error, [
        { text: 'Settings', onPress: () => router.push('/(main)/(agent)/settings') },
        { text: 'OK', onPress: clearError },
      ]);
    }
  }, [error]);

  const handleSend = async () => {
    if (!inputText.trim()) return;

    const userContent = inputText.trim();
    setInputText('');

    // Add user message to display immediately
    const userMessage: TextMessage = {
      id: Date.now().toString(),
      type: 'user',
      content: userContent,
      timestamp: 'Just now',
    };
    setDisplayMessages((prev) => [...prev, userMessage]);

    if (isConnected) {
      // Send to real AI
      await sendAIMessage(userContent);
    } else {
      // Fallback to simple responses when AI not connected
      setTimeout(() => {
        const response = getOfflineResponse(userContent);
        const agentMessage: TextMessage = {
          id: (Date.now() + 1).toString(),
          type: 'agent',
          content: response,
          timestamp: 'Just now',
        };
        setDisplayMessages((prev) => [...prev, agentMessage]);
      }, 500);
    }
  };

  // Simple offline responses
  const getOfflineResponse = (input: string): string => {
    const lower = input.toLowerCase();
    if (lower.includes('balance')) {
      return "To check your balance, go to the Wallet tab. I can provide more detailed analysis once AI is configured.";
    }
    if (lower.includes('send')) {
      return "To send tokens, go to Wallet > Send. Configure AI in settings for intelligent assistance.";
    }
    if (lower.includes('swap')) {
      return "Token swaps are planned for a future update. Configure AI for more help.";
    }
    if (lower.includes('help') || lower.includes('what can')) {
      return "I can help with:\n\n- Checking balances\n- Sending tokens\n- Answering Solana questions\n\nFor full AI capabilities, configure Ollama in settings.";
    }
    return "I understand. To get intelligent AI responses, please configure Ollama or another AI provider in the Agent settings.";
  };

  const handleSuggestion = (suggestion: string) => {
    setInputText(suggestion);
  };

  const renderMessage = (message: Message, index: number) => {
    switch (message.type) {
      case 'user':
        return (
          <Animated.View key={message.id} entering={FadeInDown.delay(50)}>
            <ChatBubble
              type="user"
              content={message.content}
              timestamp={message.timestamp}
              showAvatar={false}
            />
          </Animated.View>
        );
      case 'agent':
        return (
          <Animated.View key={message.id} entering={FadeInDown.delay(50)}>
            <ChatBubble
              type="agent"
              content={message.content}
              timestamp={message.timestamp}
            />
          </Animated.View>
        );
      case 'action':
        return (
          <Animated.View key={message.id} entering={FadeInDown.delay(50)}>
            <ChatBubble
              type="agent"
              content={message.content}
              showAvatar={true}
            />
            <View className="ml-10">
              <ActionPreview action={message.action as any} />
            </View>
          </Animated.View>
        );
      case 'execution':
        return (
          <Animated.View key={message.id} entering={FadeInDown.delay(50)} className="ml-10">
            <ExecutionProgress
              steps={message.steps}
              progress={message.progress}
            />
          </Animated.View>
        );
      default:
        return null;
    }
  };

  return (
    <View className="flex-1 bg-p01-void" style={{ paddingTop: insets.top }}>
      {/* Header */}
      <Animated.View
        entering={FadeIn}
        className="flex-row items-center justify-between px-4 py-3 border-b border-p01-border"
      >
        <View className="flex-row items-center">
          <TouchableOpacity
            onPress={() => router.back()}
            className="w-10 h-10 rounded-full items-center justify-center mr-2"
          >
            <Ionicons name="chevron-back" size={24} color="#ffffff" />
          </TouchableOpacity>
          <AgentAvatar size="sm" isActive={isConnected} />
          <View className="ml-3">
            <Text className="text-white font-semibold">P-01 Agent</Text>
            <Text style={{ fontSize: 12, color: isConnected ? '#39c5bb' : '#a0a0a0' }}>
              {isConnected ? 'AI Connected' : 'Offline Mode'}
            </Text>
          </View>
        </View>
        <TouchableOpacity
          onPress={() => router.push('/(main)/(agent)/settings')}
          className="w-10 h-10 rounded-full items-center justify-center"
        >
          <Ionicons name="settings-outline" size={22} color="#888888" />
        </TouchableOpacity>
      </Animated.View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1"
        keyboardVerticalOffset={0}
      >
        {/* Messages */}
        <ScrollView
          ref={scrollViewRef}
          className="flex-1 px-4"
          contentContainerStyle={{ paddingVertical: 16 }}
          showsVerticalScrollIndicator={false}
          onContentSizeChange={() =>
            scrollViewRef.current?.scrollToEnd({ animated: true })
          }
        >
          {displayMessages.map((message, index) => renderMessage(message, index))}

          {/* Typing indicator */}
          {isLoading && (
            <Animated.View entering={FadeIn} className="flex-row items-center">
              <AgentAvatar size="sm" isActive={true} />
              <View className="ml-2 bg-p01-surface rounded-xl px-4 py-3">
                <Text className="text-p01-text-muted">Thinking...</Text>
              </View>
            </Animated.View>
          )}
        </ScrollView>

        {/* Suggestions */}
        <Animated.View entering={FadeInDown.delay(200)} className="px-4 pb-2">
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingRight: 16 }}
          >
            {suggestions.map((suggestion, index) => (
              <SuggestionChip
                key={index}
                label={suggestion.label}
                icon={suggestion.icon}
                onPress={() => handleSuggestion(suggestion.label)}
              />
            ))}
          </ScrollView>
        </Animated.View>

        {/* Input Bar */}
        <View
          className="flex-row items-center px-4 py-3 border-t border-p01-border"
          style={{ paddingBottom: insets.bottom + 8 }}
        >
          <View
            className="flex-1 flex-row items-center bg-p01-surface border border-p01-border rounded-2xl px-4 py-2"
            style={{
              minHeight: 48,
            }}
          >
            <TextInput
              className="flex-1 text-white text-base mr-2"
              placeholder="Message your agent..."
              placeholderTextColor="#666666"
              value={inputText}
              onChangeText={setInputText}
              multiline
              maxLength={500}
              onSubmitEditing={handleSend}
              returnKeyType="send"
            />
            <TouchableOpacity
              className="w-8 h-8 items-center justify-center"
              activeOpacity={0.7}
            >
              <Ionicons name="mic-outline" size={22} color="#888888" />
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            onPress={handleSend}
            disabled={!inputText.trim()}
            className="ml-3 w-12 h-12 rounded-full items-center justify-center"
            style={
              inputText.trim()
                ? {
                    backgroundColor: '#00D1FF',
                    shadowColor: '#00D1FF',
                    shadowOpacity: 0.4,
                    shadowRadius: 8,
                    shadowOffset: { width: 0, height: 2 },
                    elevation: 6,
                  }
                : { backgroundColor: '#0a0a0a' }
            }
            activeOpacity={0.7}
          >
            <Ionicons
              name="send"
              size={20}
              color={inputText.trim() ? '#000000' : '#666666'}
            />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

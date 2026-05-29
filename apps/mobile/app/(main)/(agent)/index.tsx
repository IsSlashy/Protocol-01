import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  Keyboard,
  Platform,
  Dimensions,
  ActivityIndicator,
  RefreshControl,
  AppState,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import Animated from 'react-native-reanimated';


import { ChatBubble, SuggestionChip } from '@/components/agent';
import { VoiceButton } from '@/components/agent/VoiceButton';
import { useAIStore, DisplayMessage } from '@/stores/aiStore';
import { useWalletStore } from '@/stores/walletStore';
import { Colors, FontSize, FontFamily, Spacing } from '@/constants/theme';
import { p01Alert } from '@/stores/alertStore';
import * as VoiceService from '@/services/ai/voiceService';
import * as LlamaService from '@/services/ai/llamaService';
import { useT } from '@/i18n';

const QUICK_ACTIONS = [
  { icon: 'trending-up-outline' as const, key: 'solPrice' as const, prompt: 'SOL Price', color: Colors.primary },
  { icon: 'pulse-outline' as const, key: 'fearGreed' as const, prompt: 'Fear & Greed', color: Colors.yellow },
  { icon: 'wallet-outline' as const, key: 'myPortfolio' as const, prompt: 'My Portfolio', color: Colors.primary },
  { icon: 'analytics-outline' as const, key: 'analyzeStreams' as const, prompt: 'Analyze Streams', color: Colors.pink },
  { icon: 'globe-outline' as const, key: 'marketSummary' as const, prompt: 'Market Summary', color: Colors.primary },
  { icon: 'help-circle-outline' as const, key: 'help' as const, prompt: 'Help', color: Colors.textSecondary },
];

export default function AgentDashboard() {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const flatListRef = useRef<FlatList>(null);
  const inputRef = useRef<TextInput>(null);

  const [inputText, setInputText] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  const {
    messages,
    isLoading,
    error,
    isConnected,
    marketData,
    streamingMessage,
    activeConversationId,
    initialize,
    sendMessageStreaming,
    sendMessage,
    stopGeneration,
    clearError,
    clearMessages,
    refreshMarketData,
    createConversation,
    initModel,
    releaseModel,
    config,
    isRecording,
    isTranscribing,
    setRecording,
    setTranscribing,
  } = useAIStore();

  // Re-initialize agent when wallet changes (scopes conversations to wallet)
  const walletPublicKey = useWalletStore((s) => s.publicKey);
  const lastWalletRef = useRef<string | null>(null);

  useEffect(() => {
    if (lastWalletRef.current !== walletPublicKey) {
      lastWalletRef.current = walletPublicKey;
      initialize();
    }
  }, [walletPublicKey]);

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [messages.length, isLoading, streamingMessage]);

  // Track keyboard visibility and height — manually offset content instead of KAV
  useEffect(() => {
    const showSub = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      (e) => {
        // Use screenY for accurate height — endCoordinates.height can exclude
        // the navigation bar on edge-to-edge Android layouts
        const screenH = Dimensions.get('screen').height;
        setKeyboardHeight(screenH - e.endCoordinates.screenY);
        setKeyboardVisible(true);
        if (messages.length > 0) {
          setTimeout(() => {
            flatListRef.current?.scrollToEnd({ animated: true });
          }, 300);
        }
      }
    );
    const hideSub = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => {
        setKeyboardHeight(0);
        setKeyboardVisible(false);
      },
    );
    return () => { showSub.remove(); hideSub.remove(); };
  }, [messages.length]);

  // Free the ~800MB on-device model while the app is backgrounded, then reload
  // it on return (on-device provider only). Without this the model stays
  // resident in RAM until a manual unload.
  const autoReleasedRef = useRef(false);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background') {
        if (LlamaService.isModelLoaded()) {
          autoReleasedRef.current = true;
          releaseModel();
        }
      } else if (next === 'active') {
        if (autoReleasedRef.current && config.provider === 'llama-local') {
          autoReleasedRef.current = false;
          initModel();
        } else {
          autoReleasedRef.current = false;
        }
      }
    });
    return () => sub.remove();
  }, [config.provider, releaseModel, initModel]);

  // ── KV Cache Pre-warming ──────────────────────────────────────────────────
  // When the on-device model is loaded and the user starts typing, pre-warm
  // the KV cache with system prompt + conversation history. This means only
  // the new user message needs prefill when they hit send (~1-2s faster).
  const warmupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleTextChange = useCallback((text: string) => {
    setInputText(text);

    // Only warm up for on-device model
    if (!LlamaService.isModelLoaded()) return;
    if (config.provider !== 'llama-local') return;

    // Debounce 500ms — don't warm on every keystroke
    if (warmupTimerRef.current) clearTimeout(warmupTimerRef.current);
    if (text.trim().length < 2) return; // wait for meaningful input

    warmupTimerRef.current = setTimeout(() => {
      // Build the messages that will be used for the next completion
      const historyMessages = messages.map(m => ({ role: m.role, content: m.content }));
      const warmupMessages = [
        { role: 'user', content: 'You are P-01 Agent, a crypto assistant.\nRespond to the user.' },
        { role: 'assistant', content: 'Understood. I am P-01 Agent, ready to help.' },
        ...historyMessages,
      ];
      LlamaService.warmupCache(warmupMessages);
    }, 500);
  }, [messages, config.provider]);

  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text || isLoading) return;

    // Cancel any in-progress warmup before sending
    LlamaService.cancelWarmup();
    if (warmupTimerRef.current) {
      clearTimeout(warmupTimerRef.current);
      warmupTimerRef.current = null;
    }

    setInputText('');
    // Use streaming for cloud providers, regular for local
    const useStreaming = config.provider === 'groq' || config.provider === 'gemma-cloud' || config.provider === 'gemma';
    if (useStreaming) {
      await sendMessageStreaming(text);
    } else {
      await sendMessage(text);
    }
  }, [inputText, isLoading, sendMessage, sendMessageStreaming, config.provider]);

  const handleQuickAction = useCallback((label: string) => {
    const useStreaming = config.provider === 'groq' || config.provider === 'gemma-cloud' || config.provider === 'gemma';
    if (useStreaming) {
      sendMessageStreaming(label);
    } else {
      sendMessage(label);
    }
  }, [sendMessage, sendMessageStreaming, config.provider]);

  const handleSuggestionPress = useCallback((suggestion: string) => {
    handleQuickAction(suggestion);
  }, [handleQuickAction]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await refreshMarketData();
    setRefreshing(false);
  }, [refreshMarketData]);

  const handleStartRecording = useCallback(async () => {
    const started = await VoiceService.startRecording();
    if (started) {
      setRecording(true);
    }
  }, [setRecording]);

  const handleStopRecording = useCallback(async () => {
    setRecording(false);
    const uri = await VoiceService.stopRecording();
    if (!uri) return;

    const groqKey = config.groqApiKey || process.env.EXPO_PUBLIC_GROQ_API_KEY || '';
    if (!groqKey) {
      p01Alert('Voice Setup', 'Add a Groq API key in Agent Settings to enable voice transcription.');
      return;
    }

    setTranscribing(true);
    try {
      const text = await VoiceService.transcribe(uri, groqKey);
      if (text) {
        // Auto-send: skip the text input entirely
        if (config.voiceAutoSend) {
          const useStreaming = config.provider === 'groq' || config.provider === 'gemma-cloud' || config.provider === 'gemma';
          if (useStreaming) {
            sendMessageStreaming(text);
          } else {
            sendMessage(text);
          }
        } else {
          // Put text in input for user to review/edit before sending
          setInputText(text);
        }
      }
    } catch (err: any) {
      console.error('[Voice] Transcription failed:', err);
      p01Alert('Transcription Failed', err?.message || 'Could not transcribe audio');
    } finally {
      setTranscribing(false);
    }
  }, [config, setRecording, setTranscribing, sendMessage, sendMessageStreaming]);

  const handleNewChat = useCallback(() => {
    clearMessages();
    createConversation();
  }, [clearMessages, createConversation]);

  const hasMessages = messages.length > 0;

  const latestSuggestions = messages.length > 0
    ? [...messages].reverse().find(m => m.role === 'assistant' && m.suggestions)?.suggestions
    : undefined;

  // Find active conversation title
  const conversations = useAIStore((s) => s.conversations);
  const activeConv = conversations.find((c: any) => c.id === activeConversationId);
  const chatTitle = activeConv?.title && activeConv.title !== 'New Chat'
    ? activeConv.title
    : 'P-01 Agent';

  const renderMessage = useCallback(({ item, index }: { item: DisplayMessage; index: number }) => {
    const isLastAssistant = item.role === 'assistant' && index === messages.length - 1;
    return (
      <View style={{ paddingHorizontal: Spacing.lg }}>
        <ChatBubble
          type={item.role === 'user' ? 'user' : 'agent'}
          content={item.content}
          timestamp={new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          showAvatar={item.role === 'assistant'}
          isStreaming={isLastAssistant && streamingMessage !== null}
        />
      </View>
    );
  }, [messages.length, streamingMessage]);

  return (
    <View style={{ flex: 1, backgroundColor: 'transparent' }}>
      <View style={{ flex: 1 }}>
        {/* Header */}
        <Animated.View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingTop: insets.top + 8,
            paddingBottom: Spacing.lg,
            paddingHorizontal: Spacing.xl,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View style={{
              width: 6, height: 6, borderRadius: 3,
              backgroundColor: isConnected ? Colors.primary : Colors.textTertiary,
              marginRight: 8,
            }} />
            <Text
              style={{
                color: Colors.text,
                fontFamily: FontFamily.bold,
                fontSize: 18,
                letterSpacing: 1,
              }}
              numberOfLines={1}
              accessibilityRole="header"
            >
              {hasMessages && chatTitle !== 'P-01 Agent' ? chatTitle : 'AGENT'}
            </Text>
          </View>

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: Spacing.sm }}>
            {hasMessages && (
              <TouchableOpacity
                onPress={handleNewChat}
                accessibilityRole="button"
                accessibilityLabel="New chat"
                style={{
                  width: 40, height: 40, borderRadius: 9999,
                  alignItems: 'center', justifyContent: 'center',
                  backgroundColor: Colors.surfaceSecondary,
                }}
              >
                <Ionicons name="add-outline" size={20} color={Colors.text} />
              </TouchableOpacity>
            )}
            <TouchableOpacity
              onPress={() => router.push('/(main)/(agent)/history')}
              accessibilityRole="button"
              accessibilityLabel="Chat history"
              style={{
                width: 40, height: 40, borderRadius: 9999,
                alignItems: 'center', justifyContent: 'center',
                backgroundColor: Colors.surfaceSecondary,
              }}
            >
              <Ionicons name="time-outline" size={20} color={Colors.text} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => router.push('/(main)/(agent)/settings')}
              accessibilityRole="button"
              accessibilityLabel="Agent settings"
              style={{
                width: 40, height: 40, borderRadius: 9999,
                alignItems: 'center', justifyContent: 'center',
                backgroundColor: Colors.surfaceSecondary,
              }}
            >
              <Ionicons name="settings-outline" size={20} color={Colors.text} />
            </TouchableOpacity>
          </View>
        </Animated.View>

        {/* Content */}
        {!hasMessages ? (
          // Welcome state
          <FlatList
            data={[]}
            renderItem={() => null}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={handleRefresh}
                tintColor={Colors.primary}
              />
            }
            ListHeaderComponent={
              <View style={{ flex: 1, paddingHorizontal: Spacing.xl, paddingTop: 12 }}>
                {/* Greeting + inline market data */}
                <Animated.View
                  style={{ marginBottom: 28 }}
                >
                  <Text style={{
                    color: Colors.text,
                    fontSize: 24,
                    fontFamily: FontFamily.semibold,
                    letterSpacing: -0.3,
                  }}>
                    {t('agent.howCanIHelp')}
                  </Text>
                  <Text style={{
                    color: Colors.textTertiary,
                    marginTop: 4,
                    fontSize: 13,
                    fontFamily: FontFamily.regular,
                  }}>
                    {marketData?.prices?.SOL
                      ? `SOL $${marketData.prices.SOL.toFixed(2)}${marketData.fearGreed ? `  ·  F&G ${marketData.fearGreed.value}` : ''}`
                      : t('agent.marketFallback')
                    }
                  </Text>
                </Animated.View>

                {/* Quick Actions — 2-column grid */}
                <Animated.View style={{ marginBottom: 120 }}>
                  <View style={{
                    flexDirection: 'row',
                    flexWrap: 'wrap',
                    gap: 10,
                  }}>
                    {QUICK_ACTIONS.map((action, i) => (
                      <Animated.View
                        key={action.key}
                        style={{ width: '48%' as any, flexGrow: 1, flexBasis: '47%' as any }}
                      >
                        <TouchableOpacity
                          onPress={() => handleQuickAction(action.prompt)}
                          activeOpacity={0.7}
                          style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 10,
                            paddingHorizontal: 14,
                            paddingVertical: 13,
                            borderRadius: 14,
                            backgroundColor: Colors.surfaceSecondary,
                          }}
                        >
                          <Ionicons name={action.icon} size={16} color={action.color} />
                          <Text style={{
                            color: Colors.textSecondary,
                            fontSize: 13,
                            fontFamily: FontFamily.medium,
                          }}>
                            {t(`agent.${action.key}`)}
                          </Text>
                        </TouchableOpacity>
                      </Animated.View>
                    ))}
                  </View>
                </Animated.View>
              </View>
            }
          />
        ) : (
          // Chat state
          <FlatList
            ref={flatListRef}
            data={messages}
            renderItem={renderMessage}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ paddingTop: 12, paddingBottom: 8 }}
            onContentSizeChange={() => {
              if (keyboardVisible) {
                flatListRef.current?.scrollToEnd({ animated: true });
              }
            }}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={handleRefresh}
                tintColor={Colors.primary}
              />
            }
            ListFooterComponent={
              <>
                {/* Typing indicator (non-streaming loading) */}
                {isLoading && streamingMessage === null && (
                  <View style={{ paddingHorizontal: Spacing.lg }}>
                    <ChatBubble type="agent" content="" isTyping={true} />
                  </View>
                )}

                {/* Error */}
                {error && (
                  <TouchableOpacity
                    onPress={clearError}
                    accessibilityRole="button"
                    accessibilityLabel="Dismiss error"
                    style={{
                      marginHorizontal: Spacing.lg,
                      marginVertical: 8,
                      padding: 12,
                      borderRadius: 14,
                      backgroundColor: Colors.errorDim,
                      borderWidth: 1,
                      borderColor: 'rgba(255, 51, 102, 0.3)',
                    }}
                  >
                    <Text style={{ color: Colors.error, fontSize: FontSize.sm }}>
                      {error}
                    </Text>
                  </TouchableOpacity>
                )}

                {/* Suggestion chips */}
                {latestSuggestions && latestSuggestions.length > 0 && !isLoading && (
                  <Animated.View
                    style={{ paddingHorizontal: Spacing.lg, marginTop: 4, marginBottom: 8 }}
                  >
                    <FlatList
                      horizontal
                      data={latestSuggestions}
                      keyExtractor={(item) => item}
                      showsHorizontalScrollIndicator={false}
                      renderItem={({ item, index }) => (
                        <SuggestionChip
                          label={item}
                          onPress={() => handleSuggestionPress(item)}
                          index={index}
                        />
                      )}
                    />
                  </Animated.View>
                )}
              </>
            }
          />
        )}

        {/* Glass Input Bar */}
        <View style={{ overflow: 'hidden' }}>
          <BlurView
            intensity={25}
            tint="dark"
            style={{
              paddingBottom: keyboardVisible ? 8 : (insets.bottom + 88),
              backgroundColor: 'rgba(10, 10, 12, 0.85)',
            }}
          >
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'flex-end',
                paddingHorizontal: 12,
                paddingVertical: 8,
                gap: 8,
              }}
            >
              <View
                style={{
                  flex: 1,
                  flexDirection: 'row',
                  alignItems: 'flex-end',
                  borderRadius: 22,
                  paddingHorizontal: 16,
                  backgroundColor: Colors.surfaceSecondary,
                  minHeight: 44,
                  maxHeight: 120,
                }}
              >
                <TextInput
                  ref={inputRef}
                  value={inputText}
                  onChangeText={handleTextChange}
                  placeholder={t('agent.askAnything')}
                  placeholderTextColor={Colors.textTertiary}
                  multiline
                  maxLength={1000}
                  style={{
                    flex: 1,
                    color: Colors.text,
                    fontSize: FontSize.md,
                    fontFamily: FontFamily.regular,
                    paddingVertical: Platform.OS === 'ios' ? 10 : 8,
                    maxHeight: 100,
                  }}
                  onSubmitEditing={handleSend}
                  blurOnSubmit={false}
                  returnKeyType="send"
                  editable={!isLoading}
                  accessibilityLabel="Message input"
                  accessibilityHint="Type a message to the AI agent"
                />
              </View>

              {/* Stop / Mic / Send toggle */}
              {isTranscribing ? (
                <View
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 22,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: Colors.primaryDim,
                  }}
                  accessibilityLabel="Transcribing voice input"
                  accessibilityRole="progressbar"
                >
                  <ActivityIndicator size="small" color={Colors.primary} />
                </View>
              ) : isLoading ? (
                <TouchableOpacity
                  onPress={stopGeneration}
                  accessibilityRole="button"
                  accessibilityLabel="Stop generating"
                  accessibilityHint="Stops the AI response in progress"
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 22,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: Colors.primaryDim,
                  }}
                >
                  <Ionicons name="stop" size={20} color={Colors.primary} />
                </TouchableOpacity>
              ) : inputText.trim() ? (
                <TouchableOpacity
                  onPress={handleSend}
                  accessibilityRole="button"
                  accessibilityLabel="Send message"
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 22,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: Colors.primary,
                  }}
                >
                  <Ionicons name="arrow-up" size={22} color={Colors.background} />
                </TouchableOpacity>
              ) : (
                <VoiceButton
                  isRecording={isRecording}
                  onStartRecording={handleStartRecording}
                  onStopRecording={handleStopRecording}
                  disabled={isLoading}
                />
              )}
            </View>
          </BlurView>
        </View>

        {/* Keyboard spacer — pushes content up when keyboard is visible */}
        {keyboardHeight > 0 && <View style={{ height: keyboardHeight }} />}
      </View>
    </View>
  );
}

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
  Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import Animated, { FadeIn, FadeInDown, FadeInUp } from 'react-native-reanimated';


import { AgentAvatar, ChatBubble, SuggestionChip, QuickActionButton } from '@/components/agent';
import { VoiceButton } from '@/components/agent/VoiceButton';
import { useAIStore, DisplayMessage } from '@/stores/aiStore';
import { useWalletStore } from '@/stores/walletStore';
import { Colors, FontSize, FontFamily, Spacing } from '@/constants/theme';
import * as VoiceService from '@/services/ai/voiceService';

const QUICK_ACTIONS = [
  { icon: 'trending-up-outline' as const, label: 'SOL Price', color: Colors.primary },
  { icon: 'pulse-outline' as const, label: 'Fear & Greed', color: Colors.yellow },
  { icon: 'wallet-outline' as const, label: 'My Portfolio', color: Colors.primary },
  { icon: 'analytics-outline' as const, label: 'Analyze Streams', color: Colors.pink },
  { icon: 'globe-outline' as const, label: 'Market Summary', color: Colors.primary },
  { icon: 'help-circle-outline' as const, label: 'Help', color: Colors.textSecondary },
];

export default function AgentDashboard() {
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
    clearError,
    clearMessages,
    refreshMarketData,
    createConversation,
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

  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text || isLoading) return;

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
      Alert.alert('Voice Setup', 'Add a Groq API key in Agent Settings to enable voice transcription.');
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
      Alert.alert('Transcription Failed', err?.message || 'Could not transcribe audio');
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
        {/* Glass Header */}
        <View style={{ overflow: 'hidden' }}>
          <BlurView
            intensity={30}
            tint="dark"
            style={{
              paddingTop: insets.top + 4,
              paddingBottom: 10,
              paddingHorizontal: Spacing.lg,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              backgroundColor: 'rgba(10, 10, 12, 0.75)',
              borderBottomWidth: 1,
              borderBottomColor: 'rgba(57, 197, 187, 0.1)',
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
              <AgentAvatar size="sm" isActive={isConnected} />
              <View style={{ marginLeft: 10, flex: 1 }}>
                <Text
                  style={{
                    color: Colors.text,
                    fontFamily: FontFamily.semibold,
                    fontSize: FontSize.md,
                  }}
                  numberOfLines={1}
                  accessibilityRole="header"
                >
                  {chatTitle}
                </Text>
                <Text
                  style={{
                    color: isConnected ? Colors.primary : Colors.textTertiary,
                    fontSize: FontSize.xs,
                  }}
                  accessibilityLabel={`Agent status: ${isConnected ? 'online' : 'offline'}`}
                >
                  {isConnected ? 'Online' : 'Offline'}
                </Text>
              </View>
            </View>

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              {/* New Chat */}
              {hasMessages && (
                <TouchableOpacity
                  onPress={handleNewChat}
                  accessibilityRole="button"
                  accessibilityLabel="New chat"
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: 19,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: 'rgba(255, 255, 255, 0.06)',
                  }}
                >
                  <Ionicons name="add-outline" size={22} color={Colors.textSecondary} />
                </TouchableOpacity>
              )}
              {/* History */}
              <TouchableOpacity
                onPress={() => router.push('/(main)/(agent)/history')}
                accessibilityRole="button"
                accessibilityLabel="Chat history"
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 19,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: 'rgba(255, 255, 255, 0.06)',
                }}
              >
                <Ionicons name="time-outline" size={20} color={Colors.textSecondary} />
              </TouchableOpacity>
              {/* Settings */}
              <TouchableOpacity
                onPress={() => router.push('/(main)/(agent)/settings')}
                accessibilityRole="button"
                accessibilityLabel="Agent settings"
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 19,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: 'rgba(255, 255, 255, 0.06)',
                }}
              >
                <Ionicons name="settings-outline" size={20} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>
          </BlurView>
        </View>

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
              <View style={{ flex: 1, paddingHorizontal: Spacing.xl, paddingTop: 24 }}>
                {/* Avatar + Greeting */}
                <Animated.View
                  entering={FadeInDown.delay(100).springify()}
                  style={{ alignItems: 'center', marginBottom: 20 }}
                >
                  <AgentAvatar size="lg" isActive={true} />
                  <Text
                    style={{
                      color: Colors.text,
                      fontSize: FontSize.xl,
                      fontFamily: FontFamily.bold,
                      marginTop: Spacing.lg,
                    }}
                  >
                    Hey, I'm P-01 Agent
                  </Text>
                  <Text
                    style={{
                      color: Colors.textSecondary,
                      textAlign: 'center',
                      marginTop: 6,
                      fontSize: FontSize.sm,
                      lineHeight: 20,
                    }}
                  >
                    Your crypto assistant. Ask me about prices,{'\n'}market sentiment, or your portfolio.
                  </Text>

                  {/* Market snapshot */}
                  {marketData?.prices?.SOL && (
                    <Animated.View
                      entering={FadeIn.delay(400)}
                      accessibilityRole="text"
                      accessibilityLabel={`SOL price $${marketData.prices.SOL.toFixed(2)}${marketData.fearGreed ? `, Fear and Greed index ${marketData.fearGreed.value} out of 100` : ''}`}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        marginTop: Spacing.lg,
                        paddingHorizontal: Spacing.lg,
                        paddingVertical: Spacing.sm,
                        borderRadius: 999,
                        backgroundColor: Colors.primaryDim,
                        borderWidth: 1,
                        borderColor: 'rgba(57, 197, 187, 0.2)',
                      }}
                    >
                      <Text
                        style={{
                          color: Colors.primary,
                          fontSize: FontSize.sm,
                          fontFamily: FontFamily.medium,
                        }}
                      >
                        SOL ${marketData.prices.SOL.toFixed(2)}
                      </Text>
                      {marketData.fearGreed && (
                        <>
                          <View
                            style={{
                              width: 1,
                              height: 14,
                              backgroundColor: 'rgba(57, 197, 187, 0.3)',
                              marginHorizontal: 10,
                            }}
                          />
                          <Text
                            style={{
                              color: Colors.primary,
                              fontSize: FontSize.sm,
                              fontFamily: FontFamily.medium,
                            }}
                          >
                            F&G {marketData.fearGreed.value}/100
                          </Text>
                        </>
                      )}
                    </Animated.View>
                  )}
                </Animated.View>

                {/* Quick Actions Grid */}
                <Animated.View entering={FadeInUp.delay(200).springify()} style={{ marginBottom: 120 }}>
                  <Text
                    style={{
                      fontSize: FontSize.xs,
                      fontFamily: FontFamily.semibold,
                      letterSpacing: 1,
                      textTransform: 'uppercase',
                      marginBottom: 10,
                      color: Colors.textTertiary,
                    }}
                    accessibilityRole="header"
                  >
                    Quick Actions
                  </Text>
                  <View
                    style={{
                      flexDirection: 'row',
                      flexWrap: 'wrap',
                      gap: 8,
                    }}
                  >
                    {QUICK_ACTIONS.map((action) => (
                      <View key={action.label} style={{ width: '31%' }}>
                        <QuickActionButton
                          icon={action.icon}
                          label={action.label}
                          color={action.color}
                          variant="compact"
                          onPress={() => handleQuickAction(action.label)}
                        />
                      </View>
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
                    entering={FadeIn.delay(200)}
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
              backgroundColor: 'rgba(10, 10, 12, 0.8)',
              borderTopWidth: 1,
              borderTopColor: 'rgba(57, 197, 187, 0.08)',
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
                  backgroundColor: 'rgba(21, 21, 24, 0.8)',
                  borderWidth: 1,
                  borderColor: 'rgba(57, 197, 187, 0.12)',
                  minHeight: 44,
                  maxHeight: 120,
                }}
              >
                <TextInput
                  ref={inputRef}
                  value={inputText}
                  onChangeText={setInputText}
                  placeholder="Ask anything..."
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

              {/* Mic / Send toggle */}
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
              ) : inputText.trim() ? (
                <TouchableOpacity
                  onPress={handleSend}
                  disabled={isLoading}
                  accessibilityRole="button"
                  accessibilityLabel="Send message"
                  accessibilityState={{ disabled: isLoading }}
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 22,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: isLoading
                      ? Colors.primaryDim
                      : Colors.primary,
                  }}
                >
                  {isLoading ? (
                    <ActivityIndicator size="small" color={Colors.primary} />
                  ) : (
                    <Ionicons name="arrow-up" size={22} color={Colors.background} />
                  )}
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

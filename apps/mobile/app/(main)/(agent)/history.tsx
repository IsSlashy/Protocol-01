import React, { useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  TextInput,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import Animated, { FadeIn, FadeInDown, SlideOutRight } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';

import { useAIStore, Conversation } from '@/stores/aiStore';
import { Colors, FontSize, FontFamily, Spacing } from '@/constants/theme';
import { p01Alert } from '@/stores/alertStore';

export default function ChatHistory() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [searchQuery, setSearchQuery] = useState('');

  const {
    conversations,
    activeConversationId,
    switchConversation,
    deleteConversation,
    createConversation,
    clearMessages,
  } = useAIStore();

  const filteredConversations = useMemo(() => {
    if (!searchQuery.trim()) {
      return [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
    }
    const lower = searchQuery.toLowerCase();
    return [...conversations]
      .filter(c =>
        c.title.toLowerCase().includes(lower) ||
        c.messages.some(m => m.content.toLowerCase().includes(lower))
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [conversations, searchQuery]);

  const handleSelectConversation = useCallback((conv: Conversation) => {
    switchConversation(conv.id);
    router.back();
  }, [switchConversation, router]);

  const handleDeleteConversation = useCallback((conv: Conversation) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    p01Alert(
      'Delete Conversation',
      `Delete "${conv.title}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => deleteConversation(conv.id),
        },
      ]
    );
  }, [deleteConversation]);

  const handleNewChat = useCallback(() => {
    clearMessages();
    createConversation();
    router.back();
  }, [clearMessages, createConversation, router]);

  const formatDate = (timestamp: number): string => {
    const now = Date.now();
    const diff = now - timestamp;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(timestamp).toLocaleDateString();
  };

  const renderConversation = useCallback(({ item, index }: { item: Conversation; index: number }) => {
    const isActive = item.id === activeConversationId;
    const lastMessage = item.messages[item.messages.length - 1];
    const messageCount = item.messages.length;

    return (
      <Animated.View entering={FadeInDown.delay(index * 50).springify()}>
        <TouchableOpacity
          onPress={() => handleSelectConversation(item)}
          onLongPress={() => handleDeleteConversation(item)}
          activeOpacity={0.7}
          style={{
            marginHorizontal: Spacing.lg,
            marginBottom: 10,
            borderRadius: 16,
            overflow: 'hidden',
            borderWidth: 1,
            borderColor: isActive
              ? 'rgba(57, 197, 187, 0.3)'
              : 'rgba(42, 42, 48, 0.5)',
          }}
        >
          <BlurView
            intensity={15}
            tint="dark"
            style={{
              padding: 14,
              backgroundColor: isActive
                ? 'rgba(57, 197, 187, 0.06)'
                : 'rgba(21, 21, 24, 0.7)',
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View style={{ flex: 1, marginRight: 10 }}>
                <Text
                  numberOfLines={1}
                  style={{
                    color: isActive ? Colors.primary : Colors.text,
                    fontSize: FontSize.md,
                    fontFamily: FontFamily.semibold,
                  }}
                >
                  {item.title}
                </Text>
                {lastMessage && (
                  <Text
                    numberOfLines={1}
                    style={{
                      color: Colors.textSecondary,
                      fontSize: FontSize.sm,
                      marginTop: 3,
                    }}
                  >
                    {lastMessage.role === 'user' ? 'You: ' : 'Agent: '}
                    {lastMessage.content.replace(/\n/g, ' ')}
                  </Text>
                )}
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={{ color: Colors.textTertiary, fontSize: FontSize.xs }}>
                  {formatDate(item.updatedAt)}
                </Text>
                <Text style={{ color: Colors.textTertiary, fontSize: FontSize.xs, marginTop: 2 }}>
                  {messageCount} msgs
                </Text>
              </View>
            </View>
          </BlurView>
        </TouchableOpacity>
      </Animated.View>
    );
  }, [activeConversationId, handleSelectConversation, handleDeleteConversation]);

  return (
    <View style={{ flex: 1, backgroundColor: 'transparent', paddingTop: insets.top }}>
      {/* Header */}
      <View style={{ overflow: 'hidden' }}>
        <BlurView
          intensity={30}
          tint="dark"
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: Spacing.lg,
            paddingVertical: 12,
            backgroundColor: 'rgba(10, 10, 12, 0.75)',
            borderBottomWidth: 1,
            borderBottomColor: 'rgba(57, 197, 187, 0.1)',
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <TouchableOpacity
              onPress={() => router.back()}
              style={{
                width: 38,
                height: 38,
                borderRadius: 19,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: 'rgba(255, 255, 255, 0.06)',
              }}
            >
              <Ionicons name="chevron-back" size={22} color={Colors.text} />
            </TouchableOpacity>
            <Text
              style={{
                color: Colors.text,
                fontFamily: FontFamily.semibold,
                fontSize: FontSize.lg,
                marginLeft: 10,
              }}
            >
              Chat History
            </Text>
          </View>
          <TouchableOpacity
            onPress={handleNewChat}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 14,
              paddingVertical: 8,
              borderRadius: 999,
              backgroundColor: Colors.primaryDim,
              borderWidth: 1,
              borderColor: 'rgba(57, 197, 187, 0.25)',
            }}
          >
            <Ionicons name="add" size={18} color={Colors.primary} />
            <Text
              style={{
                color: Colors.primary,
                fontSize: FontSize.sm,
                fontFamily: FontFamily.medium,
                marginLeft: 4,
              }}
            >
              New Chat
            </Text>
          </TouchableOpacity>
        </BlurView>
      </View>

      {/* Search Bar */}
      <View style={{ paddingHorizontal: Spacing.lg, paddingVertical: 10 }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: 'rgba(21, 21, 24, 0.8)',
            borderRadius: 14,
            paddingHorizontal: 14,
            borderWidth: 1,
            borderColor: Colors.border,
            height: 42,
          }}
        >
          <Ionicons name="search-outline" size={18} color={Colors.textTertiary} />
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search conversations..."
            placeholderTextColor={Colors.textTertiary}
            style={{
              flex: 1,
              color: Colors.text,
              fontSize: FontSize.sm,
              fontFamily: FontFamily.regular,
              marginLeft: 8,
              paddingVertical: 0,
            }}
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery('')}>
              <Ionicons name="close-circle" size={18} color={Colors.textTertiary} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Conversation List */}
      {filteredConversations.length > 0 ? (
        <FlatList
          data={filteredConversations}
          renderItem={renderConversation}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingTop: 4, paddingBottom: insets.bottom + 20 }}
          showsVerticalScrollIndicator={false}
        />
      ) : (
        // Empty state
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40 }}>
          <Animated.View entering={FadeIn.delay(100)} style={{ alignItems: 'center' }}>
            <View
              style={{
                width: 80,
                height: 80,
                borderRadius: 40,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: Colors.primaryDim,
                marginBottom: 20,
              }}
            >
              <Ionicons name="chatbubbles-outline" size={36} color={Colors.primary} />
            </View>
            <Text
              style={{
                color: Colors.text,
                fontSize: FontSize.xl,
                fontFamily: FontFamily.bold,
                marginBottom: 8,
              }}
            >
              {searchQuery ? 'No Results' : 'No Conversations'}
            </Text>
            <Text
              style={{
                color: Colors.textSecondary,
                fontSize: FontSize.sm,
                textAlign: 'center',
                lineHeight: 20,
              }}
            >
              {searchQuery
                ? 'Try a different search term.'
                : 'Start chatting with P-01 Agent to see your conversation history here.'}
            </Text>
            {!searchQuery && (
              <TouchableOpacity
                onPress={handleNewChat}
                style={{
                  marginTop: 20,
                  paddingHorizontal: 20,
                  paddingVertical: 10,
                  borderRadius: 999,
                  backgroundColor: Colors.primary,
                }}
              >
                <Text
                  style={{
                    color: Colors.background,
                    fontSize: FontSize.sm,
                    fontFamily: FontFamily.semibold,
                  }}
                >
                  Start Chatting
                </Text>
              </TouchableOpacity>
            )}
          </Animated.View>
        </View>
      )}
    </View>
  );
}

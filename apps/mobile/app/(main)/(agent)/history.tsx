import React, { useState, useCallback, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, FlatList, TextInput, StyleSheet,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';

import { useAIStore, Conversation } from '@/stores/aiStore';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import { p01Alert } from '@/stores/alertStore';
import { useT } from '@/i18n';

const formatDate = (timestamp: number): string => {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

export default function ChatHistory() {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [searchQuery, setSearchQuery] = useState('');

  const {
    conversations, activeConversationId,
    switchConversation, deleteConversation,
    createConversation, clearMessages,
  } = useAIStore();

  const filteredConversations = useMemo(() => {
    const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
    if (!searchQuery.trim()) return sorted;
    const lower = searchQuery.toLowerCase();
    return sorted.filter(c =>
      c.title.toLowerCase().includes(lower) ||
      c.messages.some(m => m.content.toLowerCase().includes(lower))
    );
  }, [conversations, searchQuery]);

  const handleSelect = useCallback((conv: Conversation) => {
    switchConversation(conv.id);
    router.back();
  }, [switchConversation, router]);

  const handleDelete = useCallback((conv: Conversation) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    p01Alert(
      t('agent.deleteConversation'),
      t('agent.deleteConversationConfirm', { title: conv.title }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('common.delete'), style: 'destructive', onPress: () => deleteConversation(conv.id) },
      ]
    );
  }, [deleteConversation, t]);

  const handleNewChat = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    clearMessages();
    createConversation();
    router.back();
  }, [clearMessages, createConversation, router]);

  const renderItem = useCallback(({ item, index }: { item: Conversation; index: number }) => {
    const isActive = item.id === activeConversationId;
    const lastMsg = item.messages[item.messages.length - 1];
    const count = item.messages.length;

    return (
      <Animated.View entering={FadeInDown.delay(index * 40).duration(250)}>
        <TouchableOpacity
          onPress={() => handleSelect(item)}
          onLongPress={() => handleDelete(item)}
          activeOpacity={0.7}
          style={[st.card, isActive && st.cardActive]}
        >
          {/* Icon */}
          <View style={[st.cardIcon, isActive ? st.cardIconActive : st.cardIconDefault]}>
            <Ionicons
              name={isActive ? 'chatbubble' : 'chatbubble-outline'}
              size={18}
              color={isActive ? P01Colors.cyan : Colors.textTertiary}
            />
          </View>

          {/* Content */}
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text
              numberOfLines={1}
              style={[st.cardTitle, isActive && { color: P01Colors.cyan }]}
            >
              {item.title}
            </Text>
            {lastMsg && (
              <Text numberOfLines={1} style={st.cardPreview}>
                {lastMsg.role === 'user' ? 'You: ' : 'Agent: '}
                {lastMsg.content.replace(/\n/g, ' ')}
              </Text>
            )}
          </View>

          {/* Meta */}
          <View style={{ alignItems: 'flex-end', gap: 3 }}>
            <Text style={st.cardTime}>{formatDate(item.updatedAt)}</Text>
            <View style={st.countChip}>
              <Text style={st.countText}>{count}</Text>
            </View>
          </View>
        </TouchableOpacity>
      </Animated.View>
    );
  }, [activeConversationId, handleSelect, handleDelete]);

  return (
    <View style={[st.container, { paddingTop: insets.top }]}>
      {/* ── Header ── */}
      <View style={st.header}>
        <TouchableOpacity onPress={() => router.back()} style={st.backBtn}>
          <Ionicons name="arrow-back" size={20} color={Colors.text} />
        </TouchableOpacity>
        <Text style={st.headerTitle}>{t('agent.chatHistory')}</Text>
        <TouchableOpacity onPress={handleNewChat} style={st.newBtn}>
          <Ionicons name="add" size={18} color="#000" />
          <Text style={st.newBtnText}>{t('agent.newChat')}</Text>
        </TouchableOpacity>
      </View>

      {/* ── Search ── */}
      <View style={st.searchWrap}>
        <View style={st.searchBar}>
          <Ionicons name="search-outline" size={16} color={Colors.textTertiary} />
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder={t('agent.searchConversations')}
            placeholderTextColor={Colors.textTertiary}
            style={st.searchInput}
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery('')}>
              <Ionicons name="close-circle" size={16} color={Colors.textTertiary} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* ── List ── */}
      {filteredConversations.length > 0 ? (
        <FlatList
          data={filteredConversations}
          renderItem={renderItem}
          keyExtractor={item => item.id}
          contentContainerStyle={{ paddingHorizontal: Spacing.xl, paddingTop: 4, paddingBottom: insets.bottom + 24 }}
          showsVerticalScrollIndicator={false}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        />
      ) : (
        <View style={st.emptyWrap}>
          <Animated.View entering={FadeIn.delay(100).duration(300)} style={{ alignItems: 'center' }}>
            <View style={st.emptyIcon}>
              <Ionicons name="chatbubbles-outline" size={28} color={P01Colors.cyan} />
            </View>
            <Text style={st.emptyTitle}>
              {searchQuery ? t('agent.noResults') : t('agent.noConversations')}
            </Text>
            <Text style={st.emptyDesc}>
              {searchQuery ? t('agent.noResultsDesc') : t('agent.noConversationsDesc')}
            </Text>
            {!searchQuery && (
              <TouchableOpacity onPress={handleNewChat} style={st.startBtn}>
                <Ionicons name="chatbubble-outline" size={16} color="#000" />
                <Text style={st.startBtnText}>{t('agent.startChatting')}</Text>
              </TouchableOpacity>
            )}
          </Animated.View>
        </View>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },

  // Header
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl, paddingVertical: Spacing.lg,
  },
  backBtn: {
    width: 40, height: 40, borderRadius: BorderRadius.full,
    backgroundColor: Colors.surfaceSecondary, alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: { fontSize: 18, fontFamily: FontFamily.bold, color: Colors.text },
  newBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: BorderRadius.full,
    backgroundColor: P01Colors.cyan,
  },
  newBtnText: { fontSize: 13, fontFamily: FontFamily.semibold, color: '#000' },

  // Search
  searchWrap: { paddingHorizontal: Spacing.xl, marginBottom: 12 },
  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: Colors.surfaceSecondary, borderRadius: BorderRadius.lg,
    paddingHorizontal: 14, height: 42,
  },
  searchInput: {
    flex: 1, color: Colors.text, fontSize: 14,
    fontFamily: FontFamily.regular, paddingVertical: 0,
  },

  // Cards
  card: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 14, backgroundColor: Colors.surfaceSecondary, borderRadius: BorderRadius.xl,
  },
  cardActive: {
    borderWidth: 1, borderColor: `${P01Colors.cyan}30`,
  },
  cardIcon: {
    width: 42, height: 42, borderRadius: BorderRadius.md,
    alignItems: 'center', justifyContent: 'center',
  },
  cardIconActive: { backgroundColor: `${P01Colors.cyan}18` },
  cardIconDefault: { backgroundColor: '#1a1a1f' },
  cardTitle: { fontSize: 14, fontFamily: FontFamily.medium, color: Colors.text },
  cardPreview: {
    fontSize: 12, fontFamily: FontFamily.regular, color: Colors.textSecondary, marginTop: 3,
  },
  cardTime: { fontSize: 11, fontFamily: FontFamily.regular, color: Colors.textTertiary },
  countChip: {
    paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6,
    backgroundColor: `${P01Colors.cyan}18`,
  },
  countText: { fontSize: 10, fontFamily: FontFamily.semibold, color: P01Colors.cyan },

  // Empty state
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40 },
  emptyIcon: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: `${P01Colors.cyan}18`, alignItems: 'center', justifyContent: 'center',
    marginBottom: 16,
  },
  emptyTitle: { fontSize: 16, fontFamily: FontFamily.semibold, color: Colors.text, marginBottom: 4 },
  emptyDesc: {
    fontSize: 13, fontFamily: FontFamily.regular, color: Colors.textSecondary,
    textAlign: 'center', lineHeight: 20,
  },
  startBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    marginTop: 20, paddingHorizontal: 20, paddingVertical: 10,
    borderRadius: BorderRadius.full, backgroundColor: P01Colors.cyan,
  },
  startBtnText: { fontSize: 14, fontFamily: FontFamily.semibold, color: '#000' },
});

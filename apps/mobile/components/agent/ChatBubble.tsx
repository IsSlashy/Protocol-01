import React, { useCallback } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Colors, FontSize, FontFamily } from '@/constants/theme';
import { TypingIndicator } from './TypingIndicator';
import { MarkdownBubble } from './MarkdownBubble';

type BubbleType = 'agent' | 'user' | 'system';

interface ChatBubbleProps {
  type: BubbleType;
  content: string;
  timestamp?: string;
  showAvatar?: boolean;
  isTyping?: boolean;
  isStreaming?: boolean;
}

export const ChatBubble: React.FC<ChatBubbleProps> = ({
  type,
  content,
  timestamp,
  showAvatar = true,
  isTyping = false,
  isStreaming = false,
}) => {
  const isAgent = type === 'agent';
  const isUser = type === 'user';

  const handleCopy = useCallback(async () => {
    if (!content) return;
    await Clipboard.setStringAsync(content);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [content]);

  if (type === 'system') {
    return (
      <View style={{ alignItems: 'center', marginVertical: 12 }}>
        <View
          style={{
            backgroundColor: 'rgba(21,21,24,0.7)',
            paddingHorizontal: 16,
            paddingVertical: 8,
            borderRadius: 999,
          }}
        >
          <Text style={{ color: Colors.textSecondary, fontSize: FontSize.xs }}>
            {content}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <Animated.View
      entering={FadeInDown.duration(300).springify()}
      style={{
        flexDirection: 'row',
        justifyContent: isAgent ? 'flex-start' : 'flex-end',
        marginBottom: 12,
      }}
    >
      {/* Agent avatar */}
      {isAgent && showAvatar && (
        <View style={{ marginRight: 8 }}>
          <View
            style={{
              width: 32,
              height: 32,
              borderRadius: 16,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: 'rgba(57, 197, 187, 0.1)',
              borderWidth: 1,
              borderColor: 'rgba(57, 197, 187, 0.3)',
            }}
          >
            <Ionicons name="sparkles" size={16} color={Colors.primary} />
          </View>
        </View>
      )}

      {/* Bubble */}
      <View
        style={{
          maxWidth: '78%',
          borderRadius: 18,
          overflow: 'hidden',
          borderWidth: 1,
          borderColor: isAgent
            ? 'rgba(57, 197, 187, 0.15)'
            : 'rgba(57, 197, 187, 0.3)',
          ...(isAgent
            ? { borderTopLeftRadius: 6 }
            : { borderTopRightRadius: 6 }),
        }}
      >
        {isAgent ? (
          // Glass morphism for agent bubbles
          <BlurView
            intensity={20}
            tint="dark"
            style={{
              paddingHorizontal: 14,
              paddingVertical: 10,
              backgroundColor: 'rgba(21, 21, 24, 0.7)',
            }}
          >
            {isTyping ? (
              <TypingIndicator />
            ) : (
              <>
                <MarkdownBubble content={content} />
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginTop: 6,
                  }}
                >
                  {timestamp && (
                    <Text style={{ color: Colors.textTertiary, fontSize: 10 }}>
                      {timestamp}
                    </Text>
                  )}
                  {!isStreaming && content.length > 0 && (
                    <TouchableOpacity
                      onPress={handleCopy}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      style={{ padding: 2 }}
                    >
                      <Ionicons name="copy-outline" size={13} color={Colors.textTertiary} />
                    </TouchableOpacity>
                  )}
                </View>
              </>
            )}
          </BlurView>
        ) : (
          // User bubble
          <View
            style={{
              paddingHorizontal: 14,
              paddingVertical: 10,
              backgroundColor: 'rgba(57, 197, 187, 0.1)',
            }}
          >
            <Text
              style={{
                color: Colors.primary,
                fontSize: FontSize.sm,
                lineHeight: 20,
              }}
            >
              {content}
            </Text>
            {timestamp && (
              <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 4 }}>
                <Text style={{ color: Colors.textTertiary, fontSize: 10 }}>
                  {timestamp}
                </Text>
                <Ionicons
                  name="checkmark"
                  size={12}
                  color={Colors.primary}
                  style={{ marginLeft: 4 }}
                />
              </View>
            )}
          </View>
        )}
      </View>

      {/* Spacer for user messages without avatar */}
      {isUser && showAvatar && <View style={{ width: 32, marginLeft: 8 }} />}
    </Animated.View>
  );
};

export default ChatBubble;

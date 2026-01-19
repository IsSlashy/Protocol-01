import React from 'react';
import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Avatar } from '../ui/Avatar';

type BubbleType = 'agent' | 'user' | 'system';
type MessageStatus = 'sending' | 'sent' | 'error';

interface ChatBubbleProps {
  type: BubbleType;
  content: string;
  timestamp?: string;
  showAvatar?: boolean;
  status?: MessageStatus;
  isTyping?: boolean;
  className?: string;
}

const TypingIndicator: React.FC = () => (
  <View className="flex-row items-center gap-1 py-1">
    <View className="w-2 h-2 rounded-full bg-p01-cyan/60" />
    <View className="w-2 h-2 rounded-full bg-p01-cyan/40" />
    <View className="w-2 h-2 rounded-full bg-p01-cyan/20" />
  </View>
);

export const ChatBubble: React.FC<ChatBubbleProps> = ({
  type,
  content,
  timestamp,
  showAvatar = true,
  status = 'sent',
  isTyping = false,
  className,
}) => {
  const isAgent = type === 'agent';
  const isSystem = type === 'system';
  const isUser = type === 'user';

  if (isSystem) {
    return (
      <View className={`items-center my-4 ${className || ''}`}>
        <View className="bg-p01-surface/50 px-4 py-2 rounded-full">
          <Text className="text-p01-text-secondary text-xs">
            {content}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View
      className={`
        flex-row
        ${isAgent ? 'justify-start' : 'justify-end'}
        mb-3
        ${className || ''}
      `}
    >
      {isAgent && showAvatar && (
        <View className="mr-2">
          <View
            className="w-8 h-8 rounded-full items-center justify-center"
            style={{
              backgroundColor: 'rgba(57, 197, 187, 0.1)',
              borderWidth: 1,
              borderColor: 'rgba(57, 197, 187, 0.3)',
            }}
          >
            <Ionicons name="sparkles" size={16} color="#39c5bb" />
          </View>
        </View>
      )}

      <View
        className={`
          max-w-[75%]
          rounded-2xl
          px-4
          py-3
          ${isAgent ? 'rounded-tl-md' : 'rounded-tr-md'}
        `}
        style={{
          backgroundColor: isAgent
            ? 'rgba(21, 21, 24, 0.9)'
            : 'rgba(57, 197, 187, 0.1)',
          borderWidth: 1,
          borderColor: isAgent
            ? 'rgba(42, 42, 48, 0.5)'
            : 'rgba(57, 197, 187, 0.3)',
        }}
      >
        {isTyping ? (
          <TypingIndicator />
        ) : (
          <>
            <Text
              className={`
                text-base
                ${isAgent ? 'text-white' : 'text-p01-cyan'}
              `}
            >
              {content}
            </Text>

            <View className="flex-row items-center justify-end mt-1 gap-1">
              {timestamp && (
                <Text className="text-p01-text-secondary text-xs">
                  {timestamp}
                </Text>
              )}
              {isUser && (
                <View>
                  {status === 'sending' && (
                    <Ionicons name="time-outline" size={12} color="#888892" />
                  )}
                  {status === 'sent' && (
                    <Ionicons name="checkmark" size={12} color="#39c5bb" />
                  )}
                  {status === 'error' && (
                    <Ionicons name="alert-circle" size={12} color="#ef4444" />
                  )}
                </View>
              )}
            </View>
          </>
        )}
      </View>

      {isUser && showAvatar && <View className="w-8 ml-2" />}
    </View>
  );
};

export default ChatBubble;

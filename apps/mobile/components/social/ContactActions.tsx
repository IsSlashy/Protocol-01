import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

interface ContactActionsProps {
  onSend?: () => void;
  onRequest?: () => void;
  onStream?: () => void;
}

interface ActionButtonProps {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress?: () => void;
  variant?: 'primary' | 'secondary';
}

const ActionButton: React.FC<ActionButtonProps> = ({
  icon,
  label,
  onPress,
  variant = 'primary',
}) => {
  const isPrimary = variant === 'primary';

  return (
    <TouchableOpacity
      className={`
        flex-1 items-center py-4 rounded-2xl
        ${isPrimary ? 'bg-blue-500' : 'bg-p01-surface border border-blue-500/30'}
      `}
      onPress={onPress}
      activeOpacity={0.7}
      style={
        isPrimary
          ? {
              shadowColor: '#3b82f6',
              shadowOpacity: 0.4,
              shadowRadius: 12,
              shadowOffset: { width: 0, height: 4 },
              elevation: 8,
            }
          : undefined
      }
    >
      <View
        className={`
          w-12 h-12 rounded-full items-center justify-center mb-2
          ${isPrimary ? 'bg-white/20' : 'bg-blue-500/20'}
        `}
      >
        <Ionicons
          name={icon}
          size={24}
          color={isPrimary ? '#ffffff' : '#3b82f6'}
        />
      </View>
      <Text
        className={`
          font-semibold text-sm
          ${isPrimary ? 'text-white' : 'text-blue-400'}
        `}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
};

export const ContactActions: React.FC<ContactActionsProps> = ({
  onSend,
  onRequest,
  onStream,
}) => {
  return (
    <View className="flex-row gap-3">
      <ActionButton
        icon="paper-plane"
        label="Send"
        onPress={onSend}
        variant="primary"
      />
      <ActionButton
        icon="download-outline"
        label="Request"
        onPress={onRequest}
        variant="secondary"
      />
      <ActionButton
        icon="water-outline"
        label="Stream"
        onPress={onStream}
        variant="secondary"
      />
    </View>
  );
};

export default ContactActions;

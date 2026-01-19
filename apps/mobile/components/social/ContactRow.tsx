import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Avatar } from '../ui/Avatar';

interface ContactRowProps {
  id: string;
  name: string;
  address: string;
  avatar?: string;
  isVerified?: boolean;
  isFavorite?: boolean;
  lastTransaction?: Date;
  onPress?: () => void;
  onLongPress?: () => void;
  onSend?: () => void;
  onStream?: () => void;
}

const formatAddress = (addr: string): string => {
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
};

const formatLastTx = (date?: Date): string => {
  if (!date) return 'No transactions';

  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  return date.toLocaleDateString();
};

export const ContactRow: React.FC<ContactRowProps> = ({
  id,
  name,
  address,
  avatar,
  isVerified = false,
  isFavorite = false,
  lastTransaction,
  onPress,
  onLongPress,
  onSend,
  onStream,
}) => {
  return (
    <TouchableOpacity
      onPress={onPress}
      onLongPress={onLongPress}
      className="flex-row items-center py-4 px-4 bg-p01-surface rounded-xl mb-2"
      activeOpacity={0.7}
    >
      <View className="relative">
        <Avatar
          source={avatar}
          name={name}
          size="md"
        />
        {isFavorite && (
          <View className="absolute -top-1 -right-1 bg-p01-void rounded-full p-0.5">
            <Ionicons name="star" size={12} color="#eab308" />
          </View>
        )}
      </View>

      <View className="flex-1 ml-3">
        <View className="flex-row items-center">
          <Text className="text-white font-semibold text-base">{name}</Text>
          {isVerified && (
            <View className="ml-1.5">
              <Ionicons name="shield-checkmark" size={14} color="#39c5bb" />
            </View>
          )}
        </View>
        <View className="flex-row items-center mt-0.5">
          <Text className="text-p01-text-secondary text-sm">
            {formatAddress(address)}
          </Text>
          <View className="w-1 h-1 rounded-full bg-p01-text-secondary mx-2" />
          <Text className="text-p01-text-secondary text-xs">
            {formatLastTx(lastTransaction)}
          </Text>
        </View>
      </View>

      <View className="flex-row gap-2">
        {onSend && (
          <TouchableOpacity
            onPress={onSend}
            className="w-9 h-9 bg-p01-cyan/20 rounded-full items-center justify-center"
            hitSlop={{ top: 5, bottom: 5, left: 5, right: 5 }}
          >
            <Ionicons name="arrow-up" size={18} color="#39c5bb" />
          </TouchableOpacity>
        )}
        {onStream && (
          <TouchableOpacity
            onPress={onStream}
            className="w-9 h-9 bg-p01-surface border border-p01-border rounded-full items-center justify-center"
            hitSlop={{ top: 5, bottom: 5, left: 5, right: 5 }}
          >
            <Ionicons name="water" size={16} color="#888892" />
          </TouchableOpacity>
        )}
      </View>
    </TouchableOpacity>
  );
};

export default ContactRow;

import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

type ActivityType = 'send' | 'receive' | 'swap' | 'stream' | 'stake' | 'unstake';
type ActivityStatus = 'pending' | 'confirmed' | 'failed';

interface ActivityItemProps {
  type: ActivityType;
  status: ActivityStatus;
  amount: number;
  symbol: string;
  address?: string;
  timestamp: Date;
  txHash?: string;
  isPrivate?: boolean;
  onPress?: () => void;
}

const activityConfig: Record<
  ActivityType,
  { icon: keyof typeof Ionicons.glyphMap; label: string; color: string }
> = {
  send: { icon: 'arrow-up-circle', label: 'Sent', color: '#ef4444' },
  receive: { icon: 'arrow-down-circle', label: 'Received', color: '#39c5bb' },
  swap: { icon: 'swap-horizontal', label: 'Swapped', color: '#3b82f6' },
  stream: { icon: 'water', label: 'Streaming', color: '#ff77a8' },
  stake: { icon: 'layers', label: 'Staked', color: '#f97316' },
  unstake: { icon: 'layers-outline', label: 'Unstaked', color: '#eab308' },
};

const statusConfig: Record<ActivityStatus, { color: string; label: string }> = {
  pending: { color: '#eab308', label: 'Pending' },
  confirmed: { color: '#39c5bb', label: 'Confirmed' },
  failed: { color: '#ef4444', label: 'Failed' },
};

export const ActivityItem: React.FC<ActivityItemProps> = ({
  type,
  status,
  amount,
  symbol,
  address,
  timestamp,
  txHash,
  isPrivate = false,
  onPress,
}) => {
  const config = activityConfig[type];
  const statusInfo = statusConfig[status];

  const formatAddress = (addr: string): string => {
    if (addr.length <= 12) return addr;
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  const formatTime = (date: Date): string => {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString();
  };

  const isSend = type === 'send' || type === 'stake';

  return (
    <TouchableOpacity
      onPress={onPress}
      className="flex-row items-center py-4 px-4 bg-p01-surface rounded-xl mb-2"
      activeOpacity={0.7}
    >
      <View
        className="w-12 h-12 rounded-full items-center justify-center"
        style={{ backgroundColor: `${config.color}20` }}
      >
        <Ionicons name={config.icon} size={24} color={config.color} />
      </View>

      <View className="flex-1 ml-3">
        <View className="flex-row items-center">
          <Text className="text-white font-semibold text-base">
            {config.label}
          </Text>
          {isPrivate && (
            <View className="ml-2">
              <Ionicons name="shield-checkmark" size={14} color="#39c5bb" />
            </View>
          )}
          {status === 'pending' && (
            <View className="ml-2 px-2 py-0.5 bg-yellow-500/20 rounded">
              <Text className="text-yellow-500 text-xs">{statusInfo.label}</Text>
            </View>
          )}
          {status === 'failed' && (
            <View className="ml-2 px-2 py-0.5 bg-red-500/20 rounded">
              <Text className="text-red-500 text-xs">{statusInfo.label}</Text>
            </View>
          )}
        </View>
        <View className="flex-row items-center mt-0.5">
          {address && (
            <Text className="text-p01-text-secondary text-sm">
              {isSend ? 'To: ' : 'From: '}
              {formatAddress(address)}
            </Text>
          )}
          <Text className="text-p01-text-secondary text-sm ml-2">
            {formatTime(timestamp)}
          </Text>
        </View>
      </View>

      <View className="items-end">
        <Text
          className={`
            font-semibold text-base
            ${isSend ? 'text-red-400' : 'text-p01-cyan'}
          `}
        >
          {isSend ? '-' : '+'}
          {amount.toFixed(4)} {symbol}
        </Text>
      </View>
    </TouchableOpacity>
  );
};

export default ActivityItem;

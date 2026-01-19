import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Card } from '../ui/Card';
import { Avatar } from '../ui/Avatar';
import { Button } from '../ui/Button';

type RequestType = 'payment' | 'contact' | 'stream';
type RequestStatus = 'pending' | 'accepted' | 'rejected' | 'expired';

interface RequestCardProps {
  id: string;
  type: RequestType;
  from: {
    name: string;
    address: string;
    avatar?: string;
  };
  amount?: number;
  symbol?: string;
  message?: string;
  createdAt: Date;
  expiresAt?: Date;
  status: RequestStatus;
  onAccept?: () => void;
  onReject?: () => void;
  onPress?: () => void;
}

const typeConfig: Record<RequestType, { icon: keyof typeof Ionicons.glyphMap; label: string; color: string }> = {
  payment: { icon: 'cash', label: 'Payment Request', color: '#39c5bb' },
  contact: { icon: 'person-add', label: 'Contact Request', color: '#3b82f6' },
  stream: { icon: 'water', label: 'Stream Request', color: '#ff77a8' },
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
  return `${days}d ago`;
};

const getTimeUntilExpiry = (expiresAt?: Date): string | null => {
  if (!expiresAt) return null;
  const now = new Date();
  const diff = expiresAt.getTime() - now.getTime();

  if (diff <= 0) return 'Expired';

  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);

  if (hours > 24) return `${Math.floor(hours / 24)}d left`;
  if (hours > 0) return `${hours}h ${minutes}m left`;
  return `${minutes}m left`;
};

export const RequestCard: React.FC<RequestCardProps> = ({
  id,
  type,
  from,
  amount,
  symbol,
  message,
  createdAt,
  expiresAt,
  status,
  onAccept,
  onReject,
  onPress,
}) => {
  const config = typeConfig[type];
  const isPending = status === 'pending';
  const expiryText = getTimeUntilExpiry(expiresAt);

  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.8}>
      <Card variant="glass" padding="md" className="mb-3">
        <View className="flex-row items-start mb-4">
          <View
            className="w-10 h-10 rounded-full items-center justify-center"
            style={{ backgroundColor: `${config.color}20` }}
          >
            <Ionicons name={config.icon} size={20} color={config.color} />
          </View>

          <View className="flex-1 ml-3">
            <Text className="text-white font-semibold">{config.label}</Text>
            <Text className="text-p01-text-secondary text-xs mt-0.5">
              {formatTime(createdAt)}
              {expiryText && isPending && (
                <Text className="text-yellow-500"> - {expiryText}</Text>
              )}
            </Text>
          </View>

          {status !== 'pending' && (
            <View
              className={`
                px-2 py-1 rounded-lg
                ${status === 'accepted' ? 'bg-p01-cyan/20' : ''}
                ${status === 'rejected' ? 'bg-red-500/20' : ''}
                ${status === 'expired' ? 'bg-yellow-500/20' : ''}
              `}
            >
              <Text
                className={`
                  text-xs font-medium capitalize
                  ${status === 'accepted' ? 'text-p01-cyan' : ''}
                  ${status === 'rejected' ? 'text-red-500' : ''}
                  ${status === 'expired' ? 'text-yellow-500' : ''}
                `}
              >
                {status}
              </Text>
            </View>
          )}
        </View>

        <View className="flex-row items-center mb-4">
          <Avatar source={from.avatar} name={from.name} size="sm" />
          <View className="ml-2">
            <Text className="text-white font-medium">{from.name}</Text>
            <Text className="text-p01-text-secondary text-xs">
              {from.address.slice(0, 6)}...{from.address.slice(-4)}
            </Text>
          </View>
        </View>

        {type === 'payment' && amount && symbol && (
          <View className="bg-p01-surface/50 rounded-xl p-4 mb-4">
            <Text className="text-p01-text-secondary text-xs mb-1">
              Requested Amount
            </Text>
            <Text className="text-white text-2xl font-bold">
              {amount.toFixed(4)} {symbol}
            </Text>
          </View>
        )}

        {message && (
          <View className="mb-4">
            <Text className="text-p01-text-secondary text-xs mb-1">
              Message
            </Text>
            <Text className="text-white text-sm">{message}</Text>
          </View>
        )}

        {isPending && (
          <View className="flex-row gap-3">
            {onReject && (
              <Button
                variant="ghost"
                size="md"
                className="flex-1 bg-red-500/10 border border-red-500/30"
                onPress={onReject}
              >
                <Text className="text-red-500 font-semibold">Decline</Text>
              </Button>
            )}
            {onAccept && (
              <Button
                variant="primary"
                size="md"
                className="flex-1"
                onPress={onAccept}
              >
                {type === 'payment' ? 'Pay' : 'Accept'}
              </Button>
            )}
          </View>
        )}
      </Card>
    </TouchableOpacity>
  );
};

export default RequestCard;

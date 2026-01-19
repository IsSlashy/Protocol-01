import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, Animated, Easing } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Card } from '../ui/Card';
import { Avatar } from '../ui/Avatar';
import { Badge } from '../ui/Badge';
import { StreamingIndicator } from './StreamingIndicator';

const ACCENT_PINK = '#ff77a8';

type StreamStatus = 'active' | 'paused' | 'completed' | 'cancelled';

export interface StreamData {
  id: string;
  name: string;
  recipient?: {
    name: string;
    address: string;
    avatar?: string;
  };
  sender?: {
    name: string;
    address: string;
    avatar?: string;
  };
  totalAmount: number;
  streamedAmount: number;
  token: string;
  symbol: string;
  startTime: Date;
  endTime: Date;
  startDate?: Date;
  endDate?: Date;
  status: StreamStatus;
  ratePerSecond?: number;
  rate?: number; // per day
  isPrivate: boolean;
  direction: 'outgoing' | 'incoming';
}

interface StreamCardProps {
  stream: StreamData;
  onPress?: () => void;
  onPause?: () => void;
  onCancel?: () => void;
}

const statusConfig: Record<StreamStatus, { color: string; label: string; bgColor: string }> = {
  active: { color: ACCENT_PINK, label: 'Active', bgColor: 'rgba(255, 119, 168, 0.2)' },
  paused: { color: '#eab308', label: 'Paused', bgColor: 'rgba(234, 179, 8, 0.2)' },
  completed: { color: '#22c55e', label: 'Completed', bgColor: 'rgba(34, 197, 94, 0.2)' },
  cancelled: { color: '#ef4444', label: 'Cancelled', bgColor: 'rgba(239, 68, 68, 0.2)' },
};

export const StreamCard: React.FC<StreamCardProps> = ({
  stream,
  onPress,
  onPause,
  onCancel,
}) => {
  const router = useRouter();
  const progressAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const tickAnim = useRef(new Animated.Value(1)).current;
  const [currentAmount, setCurrentAmount] = useState(stream.streamedAmount);

  const startDate = stream.startDate || stream.startTime;
  const endDate = stream.endDate || stream.endTime;
  const symbol = stream.symbol || stream.token;
  const ratePerSecond = stream.ratePerSecond || (stream.rate ? stream.rate / (24 * 60 * 60) : 0);

  const progress = Math.min((currentAmount / stream.totalAmount) * 100, 100);
  const remaining = stream.totalAmount - currentAmount;
  const statusInfo = statusConfig[stream.status];
  const isActive = stream.status === 'active';

  // Calculate time remaining
  const now = new Date();
  const msRemaining = new Date(endDate).getTime() - now.getTime();
  const daysRemaining = Math.max(0, Math.floor(msRemaining / (1000 * 60 * 60 * 24)));
  const hoursRemaining = Math.max(0, Math.floor((msRemaining % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)));

  const formatDuration = (start: Date, end: Date): string => {
    const diff = new Date(end).getTime() - new Date(start).getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    if (days > 0) return `${days}d ${hours}h`;
    return `${hours}h`;
  };

  const formatTimeRemaining = (end: Date): string => {
    const now = new Date();
    const diff = new Date(end).getTime() - now.getTime();
    if (diff <= 0) return 'Completed';
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    if (days > 0) return `${days}d ${hours}h left`;
    if (hours > 0) return `${hours}h ${minutes}m left`;
    return `${minutes}m left`;
  };

  const formatAddress = (address: string) => {
    return `${address.slice(0, 4)}...${address.slice(-4)}`;
  };

  // Real-time counter animation
  useEffect(() => {
    if (!isActive) return;

    const interval = setInterval(() => {
      setCurrentAmount((prev) => {
        const newAmount = prev + ratePerSecond;
        return Math.min(newAmount, stream.totalAmount);
      });

      // Tick animation
      Animated.sequence([
        Animated.timing(tickAnim, {
          toValue: 1.05,
          duration: 100,
          useNativeDriver: true,
        }),
        Animated.timing(tickAnim, {
          toValue: 1,
          duration: 100,
          useNativeDriver: true,
        }),
      ]).start();
    }, 1000);

    return () => clearInterval(interval);
  }, [isActive, ratePerSecond, stream.totalAmount]);

  useEffect(() => {
    Animated.timing(progressAnim, {
      toValue: progress,
      duration: 1000,
      easing: Easing.out(Easing.ease),
      useNativeDriver: false,
    }).start();

    if (isActive) {
      const pulseAnimation = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.2,
            duration: 1000,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 1000,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ])
      );
      pulseAnimation.start();
      return () => pulseAnimation.stop();
    }
  }, [progress, isActive]);

  const progressWidth = progressAnim.interpolate({
    inputRange: [0, 100],
    outputRange: ['0%', '100%'],
  });

  const handlePress = () => {
    if (onPress) {
      onPress();
    } else {
      router.push(`/(main)/(streams)/${stream.id}`);
    }
  };

  const recipient = stream.recipient;
  const sender = stream.sender;
  const displayPerson = stream.direction === 'outgoing' ? recipient : sender;

  return (
    <TouchableOpacity onPress={handlePress} activeOpacity={0.8}>
      <Card
        variant="glass"
        padding="md"
        className="mb-3"
        style={{
          borderWidth: 1,
          borderColor: isActive ? 'rgba(255, 119, 168, 0.3)' : 'rgba(42, 42, 48, 0.5)',
          shadowColor: isActive ? ACCENT_PINK : '#000',
          shadowOpacity: isActive ? 0.2 : 0.3,
          shadowRadius: isActive ? 12 : 8,
          shadowOffset: { width: 0, height: 4 },
          elevation: 6,
        }}
      >
        {/* Header */}
        <View className="flex-row items-center justify-between mb-4">
          <View className="flex-row items-center">
            <View
              className="w-10 h-10 rounded-full items-center justify-center"
              style={{ backgroundColor: 'rgba(255, 119, 168, 0.2)' }}
            >
              <Ionicons
                name={stream.direction === 'outgoing' ? 'arrow-up' : 'arrow-down'}
                size={18}
                color={ACCENT_PINK}
              />
            </View>
            <View className="ml-3">
              <Text className="text-white font-semibold">{stream.name}</Text>
              <Text className="text-p01-text-secondary text-xs">
                {stream.direction === 'outgoing'
                  ? `To: ${displayPerson?.address ? formatAddress(displayPerson.address) : 'Unknown'}`
                  : `From: ${displayPerson?.address ? formatAddress(displayPerson.address) : 'Unknown'}`}
              </Text>
            </View>
          </View>

          <View className="flex-row items-center gap-2">
            {stream.isPrivate && (
              <View
                className="flex-row items-center px-2 py-1 rounded-md"
                style={{ backgroundColor: 'rgba(255, 119, 168, 0.2)' }}
              >
                <Ionicons name="shield-checkmark" size={12} color={ACCENT_PINK} />
                <Text className="text-xs ml-1" style={{ color: ACCENT_PINK }}>
                  Private
                </Text>
              </View>
            )}
            {isActive && <StreamingIndicator size="sm" label="" />}
          </View>
        </View>

        {/* Progress Bar */}
        <View className="mb-4">
          <View className="flex-row items-center justify-between mb-2">
            <Text className="text-p01-text-secondary text-sm">Progress</Text>
            <Text className="text-white text-sm font-medium">{progress.toFixed(1)}%</Text>
          </View>

          <View
            className="h-2 rounded-full overflow-hidden"
            style={{ backgroundColor: 'rgba(255, 119, 168, 0.2)' }}
          >
            <Animated.View
              className="h-full rounded-full"
              style={{
                width: progressWidth,
                backgroundColor: ACCENT_PINK,
                shadowColor: ACCENT_PINK,
                shadowOpacity: isActive ? 0.8 : 0.3,
                shadowRadius: isActive ? 8 : 4,
                shadowOffset: { width: 0, height: 0 },
              }}
            />
          </View>
        </View>

        {/* Amount Stats */}
        <View className="flex-row items-center justify-between mb-4">
          <View>
            <Text className="text-p01-text-secondary text-xs">Streamed</Text>
            <Animated.Text
              style={{ color: ACCENT_PINK, transform: [{ scale: tickAnim }] }}
              className="font-semibold font-mono"
            >
              {currentAmount.toFixed(4)} {symbol}
            </Animated.Text>
          </View>
          <View className="items-center">
            {isActive && (
              <Animated.View
                style={{ transform: [{ scale: pulseAnim }], backgroundColor: ACCENT_PINK }}
                className="w-2 h-2 rounded-full mb-1"
              />
            )}
            <Text className="text-p01-text-secondary text-xs">
              {ratePerSecond.toFixed(6)}/s
            </Text>
          </View>
          <View className="items-end">
            <Text className="text-p01-text-secondary text-xs">Remaining</Text>
            <Text className="text-white font-semibold">
              {remaining.toFixed(4)} {symbol}
            </Text>
          </View>
        </View>

        {/* Footer */}
        <View className="flex-row items-center justify-between pt-3 border-t border-p01-border">
          <View className="flex-row items-center">
            <Ionicons name="time-outline" size={14} color="#888892" />
            <Text className="text-p01-text-secondary text-xs ml-1">
              {isActive || stream.status === 'paused'
                ? formatTimeRemaining(endDate)
                : formatDuration(startDate, endDate)}
            </Text>
          </View>

          <View className="flex-row items-center gap-2">
            {/* Status Badge */}
            <View
              className="px-2 py-1 rounded-md"
              style={{ backgroundColor: statusInfo.bgColor }}
            >
              <Text className="text-xs" style={{ color: statusInfo.color }}>
                {statusInfo.label}
              </Text>
            </View>

            {/* Action Buttons */}
            {(isActive || stream.status === 'paused') && (
              <View className="flex-row gap-2">
                {onPause && (
                  <TouchableOpacity
                    onPress={onPause}
                    className="px-3 py-1.5 rounded-lg"
                    style={{ backgroundColor: 'rgba(255, 119, 168, 0.2)' }}
                  >
                    <Ionicons
                      name={isActive ? 'pause' : 'play'}
                      size={16}
                      color={ACCENT_PINK}
                    />
                  </TouchableOpacity>
                )}
                {onCancel && (
                  <TouchableOpacity
                    onPress={onCancel}
                    className="px-3 py-1.5 bg-red-500/20 rounded-lg"
                  >
                    <Ionicons name="close" size={16} color="#ef4444" />
                  </TouchableOpacity>
                )}
              </View>
            )}
          </View>
        </View>
      </Card>
    </TouchableOpacity>
  );
};

export default StreamCard;

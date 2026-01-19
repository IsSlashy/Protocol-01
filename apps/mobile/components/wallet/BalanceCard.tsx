import React, { useState } from 'react';
import { View, Text, TouchableOpacity, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Card } from '../ui/Card';

interface BalanceCardProps {
  totalBalance: number;
  currency?: string;
  percentageChange?: number;
  onSend?: () => void;
  onReceive?: () => void;
}

export const BalanceCard: React.FC<BalanceCardProps> = ({
  totalBalance,
  currency = 'USD',
  percentageChange = 0,
  onSend,
  onReceive,
}) => {
  const [isHidden, setIsHidden] = useState(false);

  const formatBalance = (amount: number): string => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  };

  const isPositive = percentageChange >= 0;

  return (
    <Card variant="glass" padding="lg" className="mx-4">
      <View className="flex-row items-center justify-between mb-2">
        <Text className="text-p01-text-secondary text-sm">
          Total Balance
        </Text>
        <TouchableOpacity
          onPress={() => setIsHidden(!isHidden)}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons
            name={isHidden ? 'eye-off-outline' : 'eye-outline'}
            size={20}
            color="#888892"
          />
        </TouchableOpacity>
      </View>

      <View className="flex-row items-baseline mb-4">
        <Text className="text-white text-4xl font-bold">
          {isHidden ? '******' : formatBalance(totalBalance)}
        </Text>
      </View>

      <View className="flex-row items-center mb-6">
        <View
          className={`
            flex-row items-center
            px-2 py-1 rounded-lg
            ${isPositive ? 'bg-p01-cyan/20' : 'bg-red-500/20'}
          `}
        >
          <Ionicons
            name={isPositive ? 'trending-up' : 'trending-down'}
            size={14}
            color={isPositive ? '#39c5bb' : '#ef4444'}
          />
          <Text
            className={`
              text-sm font-medium ml-1
              ${isPositive ? 'text-p01-cyan' : 'text-red-500'}
            `}
          >
            {isHidden ? '***' : `${isPositive ? '+' : ''}${percentageChange.toFixed(2)}%`}
          </Text>
        </View>
        <Text className="text-p01-text-secondary text-sm ml-2">
          24h change
        </Text>
      </View>

      <View className="flex-row gap-3">
        <TouchableOpacity
          onPress={onSend}
          className="flex-1 bg-p01-cyan py-4 rounded-xl flex-row items-center justify-center"
          style={{
            shadowColor: '#39c5bb',
            shadowOpacity: 0.3,
            shadowRadius: 10,
            shadowOffset: { width: 0, height: 4 },
            elevation: 8,
          }}
        >
          <Ionicons name="arrow-up" size={20} color="#0a0a0c" />
          <Text className="text-p01-void font-semibold text-base ml-2">
            Send
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={onReceive}
          className="flex-1 bg-p01-surface border border-p01-border py-4 rounded-xl flex-row items-center justify-center"
        >
          <Ionicons name="arrow-down" size={20} color="#39c5bb" />
          <Text className="text-p01-cyan font-semibold text-base ml-2">
            Receive
          </Text>
        </TouchableOpacity>
      </View>
    </Card>
  );
};

export default BalanceCard;

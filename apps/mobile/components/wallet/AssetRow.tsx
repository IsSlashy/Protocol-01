import React from 'react';
import { View, Text, TouchableOpacity, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

interface AssetRowProps {
  name: string;
  symbol: string;
  balance: number;
  fiatValue: number;
  percentageChange?: number;
  icon?: string;
  isPrivate?: boolean;
  onPress?: () => void;
}

export const AssetRow: React.FC<AssetRowProps> = ({
  name,
  symbol,
  balance,
  fiatValue,
  percentageChange = 0,
  icon,
  isPrivate = false,
  onPress,
}) => {
  const isPositive = percentageChange >= 0;

  const formatFiat = (amount: number): string => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  };

  const formatBalance = (amount: number): string => {
    if (amount >= 1000000) {
      return `${(amount / 1000000).toFixed(2)}M`;
    }
    if (amount >= 1000) {
      return `${(amount / 1000).toFixed(2)}K`;
    }
    return amount.toFixed(amount < 1 ? 6 : 4);
  };

  return (
    <TouchableOpacity
      onPress={onPress}
      className="flex-row items-center py-4 px-4 bg-p01-surface rounded-xl mb-2"
      activeOpacity={0.7}
    >
      <View className="relative">
        {icon ? (
          <Image
            source={{ uri: icon }}
            className="w-12 h-12 rounded-full"
            style={{ backgroundColor: '#2a2a30' }}
          />
        ) : (
          <View className="w-12 h-12 rounded-full bg-p01-cyan/20 items-center justify-center">
            <Text className="text-p01-cyan text-lg font-bold">
              {symbol.slice(0, 2)}
            </Text>
          </View>
        )}
        {isPrivate && (
          <View className="absolute -bottom-1 -right-1 bg-p01-void rounded-full p-1">
            <Ionicons name="shield-checkmark" size={12} color="#39c5bb" />
          </View>
        )}
      </View>

      <View className="flex-1 ml-3">
        <View className="flex-row items-center">
          <Text className="text-white font-semibold text-base">{name}</Text>
          {isPrivate && (
            <View className="ml-2 px-2 py-0.5 bg-p01-cyan/10 rounded">
              <Text className="text-p01-cyan text-xs">Private</Text>
            </View>
          )}
        </View>
        <Text className="text-p01-text-secondary text-sm mt-0.5">
          {formatBalance(balance)} {symbol}
        </Text>
      </View>

      <View className="items-end">
        <Text className="text-white font-semibold text-base">
          {formatFiat(fiatValue)}
        </Text>
        <View className="flex-row items-center mt-0.5">
          <Ionicons
            name={isPositive ? 'caret-up' : 'caret-down'}
            size={12}
            color={isPositive ? '#39c5bb' : '#ef4444'}
          />
          <Text
            className={`
              text-sm ml-0.5
              ${isPositive ? 'text-p01-cyan' : 'text-red-500'}
            `}
          >
            {Math.abs(percentageChange).toFixed(2)}%
          </Text>
        </View>
      </View>

      <Ionicons
        name="chevron-forward"
        size={20}
        color="#555560"
        style={{ marginLeft: 8 }}
      />
    </TouchableOpacity>
  );
};

export default AssetRow;

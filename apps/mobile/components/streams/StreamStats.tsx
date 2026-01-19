import React from 'react';
import { View, Text, ViewProps } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

interface StatItem {
  label: string;
  value: string;
  icon?: keyof typeof Ionicons.glyphMap;
  highlight?: boolean;
}

interface StreamStatsProps extends ViewProps {
  stats: StatItem[];
  columns?: 1 | 2;
}

export const StreamStats: React.FC<StreamStatsProps> = ({
  stats,
  columns = 2,
  className,
  ...props
}) => {
  return (
    <View
      className={`${columns === 2 ? 'flex-row flex-wrap' : ''} ${className || ''}`}
      {...props}
    >
      {stats.map((stat, index) => (
        <View
          key={index}
          className={`
            ${columns === 2 ? 'w-1/2' : 'w-full'}
            ${index % 2 === 0 && columns === 2 ? 'pr-2' : columns === 2 ? 'pl-2' : ''}
            mb-4
          `}
        >
          <View
            className="bg-p01-surface rounded-xl p-3"
            style={{
              borderWidth: 1,
              borderColor: stat.highlight ? 'rgba(255, 119, 168, 0.3)' : 'rgba(42, 42, 48, 0.5)',
            }}
          >
            <View className="flex-row items-center gap-2 mb-1">
              {stat.icon && (
                <Ionicons
                  name={stat.icon}
                  size={14}
                  color={stat.highlight ? '#ff77a8' : '#888892'}
                />
              )}
              <Text className="text-p01-text-secondary text-xs">{stat.label}</Text>
            </View>
            <Text
              className={`font-semibold ${stat.highlight ? '' : 'text-white'}`}
              style={stat.highlight ? { color: '#ff77a8' } : {}}
            >
              {stat.value}
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
};

export default StreamStats;

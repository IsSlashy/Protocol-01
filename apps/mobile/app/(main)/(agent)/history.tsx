import React, { useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Animated, { FadeInDown, FadeIn } from 'react-native-reanimated';

import { Card } from '@/components/ui/Card';

type FilterType = 'all' | 'swaps' | 'sends' | 'buys';

interface ActionHistoryItem {
  id: string;
  type: 'swap' | 'send' | 'buy';
  command: string;
  result: string;
  timestamp: string;
  date: string;
  status: 'completed' | 'pending' | 'failed';
  details: {
    from?: string;
    to?: string;
    amount?: string;
    recipient?: string;
    route?: string;
    txHash?: string;
  };
}

// Real history will come from aiStore - empty by default
const getActionHistory = (): ActionHistoryItem[] => {
  // In production, this would fetch from aiStore or transaction history
  return [];
};

const filters: { label: string; value: FilterType }[] = [
  { label: 'All', value: 'all' },
  { label: 'Swaps', value: 'swaps' },
  { label: 'Sends', value: 'sends' },
  { label: 'Buys', value: 'buys' },
];

const actionTypeIcons: Record<string, keyof typeof Ionicons.glyphMap> = {
  swap: 'swap-horizontal',
  send: 'arrow-up',
  buy: 'card',
};

const actionTypeColors: Record<string, string> = {
  swap: '#8b5cf6',
  send: '#3b82f6',
  buy: '#22c55e',
};

const statusColors: Record<string, string> = {
  completed: '#22c55e',
  pending: '#f59e0b',
  failed: '#ef4444',
};

const statusLabels: Record<string, string> = {
  completed: 'Completed',
  pending: 'Pending',
  failed: 'Failed',
};

export default function ActionHistory() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [activeFilter, setActiveFilter] = useState<FilterType>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const actionHistory = getActionHistory();

  const filteredHistory = actionHistory.filter((item) => {
    if (activeFilter === 'all') return true;
    if (activeFilter === 'swaps') return item.type === 'swap';
    if (activeFilter === 'sends') return item.type === 'send';
    if (activeFilter === 'buys') return item.type === 'buy';
    return true;
  });

  // Group by date
  const groupedHistory = filteredHistory.reduce(
    (groups, item) => {
      const date = item.date;
      if (!groups[date]) {
        groups[date] = [];
      }
      groups[date].push(item);
      return groups;
    },
    {} as Record<string, ActionHistoryItem[]>
  );

  const toggleExpand = (id: string) => {
    setExpandedId(expandedId === id ? null : id);
  };

  return (
    <View className="flex-1 bg-p01-void" style={{ paddingTop: insets.top }}>
      {/* Header */}
      <Animated.View
        entering={FadeIn}
        className="flex-row items-center justify-between px-4 py-3 border-b border-p01-border"
      >
        <View className="flex-row items-center">
          <TouchableOpacity
            onPress={() => router.back()}
            className="w-10 h-10 rounded-full items-center justify-center mr-2"
          >
            <Ionicons name="chevron-back" size={24} color="#ffffff" />
          </TouchableOpacity>
          <Text className="text-white text-xl font-bold">Action History</Text>
        </View>
        <TouchableOpacity
          className="w-10 h-10 rounded-full items-center justify-center"
        >
          <Ionicons name="search-outline" size={22} color="#888888" />
        </TouchableOpacity>
      </Animated.View>

      {/* Filters */}
      <Animated.View
        entering={FadeInDown.delay(100)}
        className="px-4 py-3"
      >
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8 }}
        >
          {filters.map((filter) => (
            <TouchableOpacity
              key={filter.value}
              onPress={() => setActiveFilter(filter.value)}
              className={`
                px-4 py-2 rounded-full
                ${
                  activeFilter === filter.value
                    ? 'bg-orange-500'
                    : 'bg-p01-surface border border-p01-border'
                }
              `}
              activeOpacity={0.7}
            >
              <Text
                className={`
                  font-medium
                  ${activeFilter === filter.value ? 'text-white' : 'text-p01-text-muted'}
                `}
              >
                {filter.label}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </Animated.View>

      {/* History List */}
      <ScrollView
        className="flex-1 px-4"
        contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
        showsVerticalScrollIndicator={false}
      >
        {filteredHistory.length === 0 ? (
          <Animated.View
            entering={FadeInDown.delay(150)}
            className="items-center justify-center py-20"
          >
            <View
              className="w-16 h-16 rounded-full items-center justify-center mb-4"
              style={{ backgroundColor: 'rgba(139, 92, 246, 0.15)' }}
            >
              <Ionicons name="time-outline" size={32} color="#8b5cf6" />
            </View>
            <Text className="text-white font-semibold text-lg mb-2">No history yet</Text>
            <Text className="text-p01-text-muted text-center px-8">
              Your AI agent actions will appear here after you start using it.
            </Text>
          </Animated.View>
        ) : (
          Object.entries(groupedHistory).map(([date, items], groupIndex) => (
          <Animated.View
            key={date}
            entering={FadeInDown.delay(150 + groupIndex * 50)}
          >
            {/* Date Header */}
            <Text className="text-p01-text-muted text-sm font-medium uppercase tracking-wider mb-3 mt-4">
              {date}
            </Text>

            {/* Actions */}
            <Card variant="default" padding="none">
              {items.map((item, index) => {
                const isExpanded = expandedId === item.id;
                const isLast = index === items.length - 1;

                return (
                  <TouchableOpacity
                    key={item.id}
                    onPress={() => toggleExpand(item.id)}
                    activeOpacity={0.7}
                    className={`
                      ${!isLast ? 'border-b border-p01-border' : ''}
                    `}
                  >
                    {/* Main Row */}
                    <View className="flex-row items-center p-4">
                      {/* Icon */}
                      <View
                        className="w-10 h-10 rounded-xl items-center justify-center mr-3"
                        style={{
                          backgroundColor: `${actionTypeColors[item.type]}20`,
                        }}
                      >
                        <Ionicons
                          name={actionTypeIcons[item.type]}
                          size={20}
                          color={actionTypeColors[item.type]}
                        />
                      </View>

                      {/* Content */}
                      <View className="flex-1">
                        <Text className="text-white font-medium">
                          {item.command}
                        </Text>
                        <Text className="text-p01-text-muted text-sm mt-0.5">
                          {item.timestamp}
                        </Text>
                      </View>

                      {/* Status & Expand */}
                      <View className="flex-row items-center">
                        <View
                          className="px-2 py-1 rounded-md mr-2"
                          style={{
                            backgroundColor: `${statusColors[item.status]}20`,
                          }}
                        >
                          <Text
                            className="text-xs font-medium"
                            style={{ color: statusColors[item.status] }}
                          >
                            {statusLabels[item.status]}
                          </Text>
                        </View>
                        <Ionicons
                          name={isExpanded ? 'chevron-up' : 'chevron-down'}
                          size={18}
                          color="#666666"
                        />
                      </View>
                    </View>

                    {/* Expanded Details */}
                    {isExpanded && (
                      <Animated.View
                        entering={FadeIn}
                        className="px-4 pb-4 pt-0"
                      >
                        <View
                          className="bg-p01-void rounded-xl p-4"
                          style={{
                            borderLeftWidth: 3,
                            borderLeftColor: actionTypeColors[item.type],
                          }}
                        >
                          {/* Result */}
                          <View className="mb-3">
                            <Text className="text-p01-text-muted text-xs uppercase tracking-wide mb-1">
                              Result
                            </Text>
                            <Text className="text-white">{item.result}</Text>
                          </View>

                          {/* Details Grid */}
                          <View className="flex-row flex-wrap">
                            {item.details.from && (
                              <View className="w-1/2 mb-2">
                                <Text className="text-p01-text-muted text-xs uppercase tracking-wide mb-0.5">
                                  From
                                </Text>
                                <Text className="text-white text-sm">
                                  {item.details.from}
                                </Text>
                              </View>
                            )}
                            {item.details.to && (
                              <View className="w-1/2 mb-2">
                                <Text className="text-p01-text-muted text-xs uppercase tracking-wide mb-0.5">
                                  To
                                </Text>
                                <Text className="text-white text-sm">
                                  {item.details.to}
                                </Text>
                              </View>
                            )}
                            {item.details.amount && (
                              <View className="w-1/2 mb-2">
                                <Text className="text-p01-text-muted text-xs uppercase tracking-wide mb-0.5">
                                  Amount
                                </Text>
                                <Text className="text-white text-sm">
                                  {item.details.amount}
                                </Text>
                              </View>
                            )}
                            {item.details.recipient && (
                              <View className="w-1/2 mb-2">
                                <Text className="text-p01-text-muted text-xs uppercase tracking-wide mb-0.5">
                                  Recipient
                                </Text>
                                <Text className="text-white text-sm">
                                  {item.details.recipient}
                                </Text>
                              </View>
                            )}
                            {item.details.route && (
                              <View className="w-1/2 mb-2">
                                <Text className="text-p01-text-muted text-xs uppercase tracking-wide mb-0.5">
                                  Route
                                </Text>
                                <Text className="text-white text-sm">
                                  {item.details.route}
                                </Text>
                              </View>
                            )}
                            {item.details.txHash && (
                              <View className="w-1/2 mb-2">
                                <Text className="text-p01-text-muted text-xs uppercase tracking-wide mb-0.5">
                                  TX Hash
                                </Text>
                                <Text className="text-orange-500 text-sm">
                                  {item.details.txHash}
                                </Text>
                              </View>
                            )}
                          </View>
                        </View>
                      </Animated.View>
                    )}
                  </TouchableOpacity>
                );
              })}
            </Card>
          </Animated.View>
        ))
        )}
      </ScrollView>
    </View>
  );
}

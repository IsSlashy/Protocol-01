import React from 'react';
import { View, Text, TouchableOpacity, Dimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  useAnimatedStyle,
  withSpring,
  interpolate,
} from 'react-native-reanimated';

interface TabItem {
  key: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  activeIcon?: keyof typeof Ionicons.glyphMap;
  badge?: number;
}

interface TabBarProps {
  tabs: TabItem[];
  activeTab: string;
  onTabPress: (key: string) => void;
  showLabels?: boolean;
  className?: string;
}

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export const TabBar: React.FC<TabBarProps> = ({
  tabs,
  activeTab,
  onTabPress,
  showLabels = true,
  className,
}) => {
  const insets = useSafeAreaInsets();
  const tabWidth = SCREEN_WIDTH / tabs.length;

  const activeIndex = tabs.findIndex((tab) => tab.key === activeTab);

  const indicatorStyle = useAnimatedStyle(() => {
    return {
      transform: [
        {
          translateX: withSpring(activeIndex * tabWidth + tabWidth / 2 - 20, {
            damping: 20,
            stiffness: 200,
          }),
        },
      ],
    };
  });

  return (
    <View
      className={`bg-p01-surface border-t border-p01-border ${className || ''}`}
      style={{ paddingBottom: insets.bottom }}
    >
      <Animated.View
        className="absolute top-0 w-10 h-1 bg-p01-cyan rounded-full"
        style={indicatorStyle}
      />

      <View className="flex-row h-16">
        {tabs.map((tab) => {
          const isActive = tab.key === activeTab;
          const iconName = isActive && tab.activeIcon ? tab.activeIcon : tab.icon;

          return (
            <TouchableOpacity
              key={tab.key}
              onPress={() => onTabPress(tab.key)}
              className="flex-1 items-center justify-center"
              activeOpacity={0.7}
            >
              <View className="relative">
                <Ionicons
                  name={iconName}
                  size={24}
                  color={isActive ? '#39c5bb' : '#555560'}
                />
                {tab.badge !== undefined && tab.badge > 0 && (
                  <View className="absolute -top-1 -right-2 bg-p01-cyan min-w-[16px] h-4 rounded-full items-center justify-center px-1">
                    <Text className="text-p01-void text-[10px] font-bold">
                      {tab.badge > 99 ? '99+' : tab.badge}
                    </Text>
                  </View>
                )}
              </View>
              {showLabels && (
                <Text
                  className={`
                    text-xs mt-1
                    ${isActive ? 'text-p01-cyan font-medium' : 'text-p01-text-secondary'}
                  `}
                >
                  {tab.label}
                </Text>
              )}
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
};

export default TabBar;

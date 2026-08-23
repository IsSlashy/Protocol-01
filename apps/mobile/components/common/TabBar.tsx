/**
 * TabBar — a generic bottom tab strip.
 *
 * 🎯 REBUILT ON THE REALIGNED THEME 2026-08-23. Colours were Tailwind names and
 * two raw literals; heights were Tailwind's, not `Layout`'s. Every tab is now a
 * real 44pt target, announces itself as a tab, and says whether it is selected —
 * none of which it did before, on the one control that is on screen the whole
 * time the app is open.
 */

import React from 'react';
import { View, Text, TouchableOpacity, Dimensions, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Animated, { useAnimatedStyle, withSpring } from 'react-native-reanimated';

import { Colors, Spacing, FontFamily, FontSize, BorderRadius, Layout } from '@/constants/theme';

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
const INDICATOR_WIDTH = 28;

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
          translateX: withSpring(
            activeIndex * tabWidth + tabWidth / 2 - INDICATOR_WIDTH / 2,
            { damping: 20, stiffness: 200 }
          ),
        },
      ],
    };
  });

  return (
    <View
      style={[styles.bar, { paddingBottom: insets.bottom }]}
      className={className}
      accessibilityRole="tablist"
    >
      <Animated.View style={[styles.indicator, indicatorStyle]} />

      <View style={styles.row}>
        {tabs.map((tab) => {
          const isActive = tab.key === activeTab;
          const iconName = isActive && tab.activeIcon ? tab.activeIcon : tab.icon;

          return (
            <TouchableOpacity
              key={tab.key}
              onPress={() => onTabPress(tab.key)}
              style={styles.tab}
              activeOpacity={0.7}
              accessibilityRole="tab"
              accessibilityLabel={tab.label}
              accessibilityState={{ selected: isActive }}
            >
              <View>
                <Ionicons
                  name={iconName}
                  size={22}
                  color={isActive ? Colors.primary : Colors.textTertiary}
                />
                {tab.badge !== undefined && tab.badge > 0 ? (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>
                      {tab.badge > 99 ? '99+' : tab.badge}
                    </Text>
                  </View>
                ) : null}
              </View>

              {showLabels ? (
                <Text style={[styles.label, isActive && styles.labelActive]} numberOfLines={1}>
                  {tab.label}
                </Text>
              ) : null}
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  bar: {
    backgroundColor: Colors.surfaceSecondary,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
  indicator: {
    position: 'absolute',
    top: 0,
    width: INDICATOR_WIDTH,
    height: 2,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.primary,
  },
  row: {
    flexDirection: 'row',
    height: Layout.tabBarHeight,
  },
  tab: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  label: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    color: Colors.textTertiary,
  },
  labelActive: {
    fontFamily: FontFamily.medium,
    color: Colors.primary,
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -10,
    minWidth: 16,
    height: 16,
    borderRadius: BorderRadius.full,
    paddingHorizontal: Spacing.xs,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.primary,
  },
  badgeText: {
    fontFamily: FontFamily.medium,
    fontSize: 10,
    color: Colors.background,
  },
});

export default TabBar;

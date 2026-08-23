/**
 * StreamStats — a small grid of label/value facts.
 *
 * 🎯 REBUILT IN StyleSheet ON THE REALIGNED THEME 2026-08-23. It was written in
 * utility classes (`bg-p01-surface`, `text-white`) with three colour literals
 * inline: a pink border for the highlighted tile, an opaque grey border for the
 * rest, and pure white for the value. This app styles in `StyleSheet.create`
 * and its text is warm paper — both were true before this file was written.
 */

import React from 'react';
import { View, Text, StyleSheet, ViewProps } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Colors, FontFamily, FontSize, BorderRadius, Spacing } from '@/constants/theme';

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
  style,
  ...props
}) => {
  return (
    <View style={[styles.grid, style]} className={className} {...props}>
      {stats.map((stat, index) => (
        <View
          key={index}
          style={[styles.cell, columns === 2 ? styles.cellHalf : styles.cellFull]}
        >
          <View style={[styles.tile, stat.highlight && styles.tileHighlight]}>
            <View style={styles.tileHead}>
              {stat.icon && (
                <Ionicons
                  name={stat.icon}
                  size={14}
                  color={stat.highlight ? Colors.primary : Colors.textSecondary}
                />
              )}
              <Text style={styles.tileLabel}>{stat.label}</Text>
            </View>
            <Text style={[styles.tileValue, stat.highlight && styles.tileValueHighlight]}>
              {stat.value}
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { marginBottom: Spacing.md },
  cellHalf: { width: '50%', paddingHorizontal: Spacing.xs },
  cellFull: { width: '100%' },
  tile: {
    padding: Spacing.md,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  tileHighlight: {
    backgroundColor: Colors.primaryDim,
    borderColor: Colors.primaryMuted,
  },
  tileHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginBottom: Spacing.xs,
  },
  tileLabel: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
  },
  // Amounts are mono. A stat tile is nearly always a number.
  tileValue: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.md,
    color: Colors.text,
  },
  tileValueHighlight: { color: Colors.primary },
});

export default StreamStats;

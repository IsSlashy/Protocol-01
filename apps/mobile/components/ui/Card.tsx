/**
 * Card — a flat panel with one hairline rule.
 *
 * 🎯 REBUILT ON THE REALIGNED THEME 2026-08-23. What this used to be: a
 * `rounded-2xl` box with a black drop shadow at 30% over 8px, and a `glass`
 * variant that stacked a `BlurView` behind a translucent grey. Three panels on
 * one screen therefore rendered three different depths, and none of them
 * carried information — the shadow said "this is a card", which the border
 * already says, more quietly and for one pixel.
 *
 * The site draws a panel as a fill and a rule. So does the extension's
 * `Panel`. So does this now.
 *
 * ⚠️ THE VARIANT NAMES ARE UNCHANGED ON PURPOSE. `variant="glass"` is passed by
 * BalanceCard, ActionPreview, ExecutionProgress and others; renaming it would
 * have meant editing every call site and getting one wrong. The name is a
 * legacy label — all three variants are flat now, they differ only in fill.
 */

import React from 'react';
import { View, StyleSheet, ViewProps } from 'react-native';

import { Colors, Spacing, BorderRadius } from '@/constants/theme';

interface CardProps extends ViewProps {
  /** `glass` is a legacy name: it is a flat panel one step down, not a blur. */
  variant?: 'default' | 'glass' | 'outlined';
  padding?: 'none' | 'sm' | 'md' | 'lg';
  children: React.ReactNode;
}

export const Card: React.FC<CardProps> = ({
  variant = 'default',
  padding = 'md',
  children,
  className,
  style,
  ...props
}) => {
  return (
    <View
      style={[styles.base, variantStyles[variant], paddingStyles[padding], style]}
      className={className}
      {...props}
    >
      {children}
    </View>
  );
};

const styles = StyleSheet.create({
  base: {
    borderRadius: BorderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
});

const variantStyles = StyleSheet.create({
  default: { backgroundColor: Colors.surface },
  glass: { backgroundColor: Colors.surfaceSecondary },
  outlined: { backgroundColor: 'transparent' },
});

const paddingStyles = StyleSheet.create({
  none: { padding: 0 },
  sm: { padding: Spacing.md },
  md: { padding: Spacing.lg },
  lg: { padding: Spacing['2xl'] },
});

export default Card;

/**
 * Badge — a small state label.
 *
 * 🎯 RETONED 2026-08-23. The four tones the system actually has:
 *
 *   neutral  quiet. A fact, not a judgement.
 *   good     the accent. This system uses cyan for success — there is no green.
 *   warn     amber, and amber is CAUTION ONLY. Never decoration.
 *   bad      red. Something failed or is about to.
 *
 * 🚨 The old palette here was raw Tailwind: `bg-yellow-500`, `text-red-500`,
 * `bg-blue-500`. Those are the framework's colours, not the brand's — three of
 * them sat outside `constants/theme.ts` entirely, so the token sweep left them
 * exactly as they were. Every tone below reads `Colors.*`.
 *
 * ⚠️ The old variant names still work (`success`, `warning`, `error`, `info`,
 * `default`) and map onto the four tones. They are aliases so existing call
 * sites keep rendering; write the tone names in new code.
 *
 * ⛔ No all-caps, no brackets. If a badge needs shouting to be noticed, the
 * layout around it is wrong.
 */

import React from 'react';
import { View, Text, StyleSheet, ViewProps } from 'react-native';

import { Colors, Spacing, FontFamily, FontSize, BorderRadius } from '@/constants/theme';

type BadgeTone = 'neutral' | 'good' | 'warn' | 'bad';
/** Legacy names, kept so existing screens compile. Prefer the tones. */
type BadgeLegacyVariant = 'default' | 'success' | 'warning' | 'error' | 'info';
type BadgeVariant = BadgeTone | BadgeLegacyVariant;
type BadgeSize = 'sm' | 'md' | 'lg';

interface BadgeProps extends ViewProps {
  variant?: BadgeVariant;
  size?: BadgeSize;
  icon?: React.ReactNode;
  children: React.ReactNode;
}

const TONE_OF: Record<BadgeVariant, BadgeTone> = {
  neutral: 'neutral',
  good: 'good',
  warn: 'warn',
  bad: 'bad',
  // Aliases.
  default: 'neutral',
  success: 'good',
  warning: 'warn',
  error: 'bad',
  info: 'neutral',
};

export const Badge: React.FC<BadgeProps> = ({
  variant = 'neutral',
  size = 'md',
  icon,
  children,
  className,
  style,
  ...props
}) => {
  const tone = TONE_OF[variant] ?? 'neutral';

  return (
    <View
      style={[styles.base, toneContainer[tone], sizeContainer[size], style]}
      className={className}
      {...props}
    >
      {icon}
      <Text style={[styles.label, toneLabel[tone], sizeLabel[size]]}>{children}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    borderWidth: StyleSheet.hairlineWidth,
    alignSelf: 'flex-start',
  },
  label: {
    fontFamily: FontFamily.medium,
  },
});

const toneContainer = StyleSheet.create({
  neutral: { backgroundColor: Colors.surface, borderColor: Colors.border },
  good: { backgroundColor: Colors.primaryDim, borderColor: Colors.primaryMuted },
  warn: { backgroundColor: Colors.warningDim, borderColor: Colors.yellow },
  bad: { backgroundColor: Colors.errorDim, borderColor: Colors.error },
});

const toneLabel = StyleSheet.create({
  neutral: { color: Colors.textSecondary },
  good: { color: Colors.primary },
  warn: { color: Colors.yellow },
  bad: { color: Colors.error },
});

const sizeContainer = StyleSheet.create({
  sm: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
    borderRadius: BorderRadius.sm,
  },
  md: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderRadius: BorderRadius.sm,
  },
  lg: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: 6,
    borderRadius: BorderRadius.md,
  },
});

const sizeLabel = StyleSheet.create({
  sm: { fontSize: FontSize.xs },
  md: { fontSize: FontSize.xs },
  lg: { fontSize: FontSize.sm },
});

export default Badge;

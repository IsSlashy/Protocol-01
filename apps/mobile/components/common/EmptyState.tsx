/**
 * EmptyState — what a screen says when it has nothing to show.
 *
 * 🎯 REBUILT ON THE REALIGNED THEME 2026-08-23.
 *   - the title was `text-white text-xl font-bold`: pure white, in the body
 *     face one weight louder. Both are the exact habits the realignment
 *     removes. It is warm paper, in the display face.
 *   - the icon sat in a cyan-tinted disc with a cyan ring. An accent used on
 *     something that carries no decision spends the one loud colour the system
 *     has on nothing. It is a quiet panel now.
 *   - ONE primary action. The secondary is a ghost button and is optional; if a
 *     screen needs two equally weighted choices here, the screen is the problem.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Colors, Spacing, FontFamily, FontSize, BorderRadius } from '@/constants/theme';
import { Button } from '../ui/Button';

interface EmptyStateProps {
  icon?: keyof typeof Ionicons.glyphMap;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
  illustration?: React.ReactNode;
  className?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon = 'cube-outline',
  title,
  description,
  actionLabel,
  onAction,
  secondaryActionLabel,
  onSecondaryAction,
  illustration,
  className,
}) => {
  return (
    <View style={styles.root} className={className}>
      {illustration || (
        <View style={styles.iconWrap}>
          <Ionicons name={icon} size={28} color={Colors.textTertiary} />
        </View>
      )}

      <Text style={styles.title}>{title}</Text>

      {description ? <Text style={styles.description}>{description}</Text> : null}

      {actionLabel || secondaryActionLabel ? (
        <View style={styles.actions}>
          {actionLabel && onAction ? (
            <Button variant="primary" size="lg" fullWidth onPress={onAction}>
              {actionLabel}
            </Button>
          ) : null}
          {secondaryActionLabel && onSecondaryAction ? (
            <Button variant="ghost" size="md" fullWidth onPress={onSecondaryAction}>
              {secondaryActionLabel}
            </Button>
          ) : null}
        </View>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing['3xl'],
    paddingVertical: Spacing['5xl'],
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: BorderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    marginBottom: Spacing['2xl'],
  },
  title: {
    fontFamily: FontFamily.display,
    fontSize: FontSize['2xl'],
    color: Colors.text,
    textAlign: 'center',
  },
  description: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.md,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
    marginTop: Spacing.sm,
  },
  actions: {
    width: '100%',
    gap: Spacing.md,
    marginTop: Spacing['3xl'],
  },
});

export default EmptyState;

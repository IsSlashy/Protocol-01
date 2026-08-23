/**
 * Avatar — initials on a panel, or an image.
 *
 * 🚨 THE TINT PALETTE IS GONE. This hashed the name into a seven-colour list
 * that included `#f97316` orange, `#eab308` yellow and `#14b8a6` teal. None of
 * those are in the theme, and the amber one collided head-on with the rule that
 * amber means CAUTION: a merchant whose name happened to hash to index 5 was
 * rendered in the warning colour, permanently, for no reason. A per-user colour
 * that carries no meaning is decoration that can lie.
 *
 * An avatar is now a panel with a hairline rule, like every other surface, and
 * the initials are read in the text colour.
 */

import React from 'react';
import { View, Image, Text, StyleSheet } from 'react-native';

import { Colors, FontFamily, FontSize } from '@/constants/theme';

type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

interface AvatarProps {
  source?: string;
  name?: string;
  size?: AvatarSize;
  showStatus?: boolean;
  status?: 'online' | 'offline' | 'away';
  className?: string;
}

const DIMENSION: Record<AvatarSize, number> = {
  xs: 24,
  sm: 32,
  md: 40,
  lg: 56,
  xl: 80,
};

const LABEL_SIZE: Record<AvatarSize, number> = {
  xs: FontSize.xs,
  sm: FontSize.sm,
  md: FontSize.md,
  lg: FontSize.lg,
  xl: FontSize['2xl'],
};

const DOT: Record<AvatarSize, number> = {
  xs: 8,
  sm: 10,
  md: 12,
  lg: 14,
  xl: 16,
};

const STATUS_COLOR: Record<NonNullable<AvatarProps['status']>, string> = {
  online: Colors.primary,
  offline: Colors.textTertiary,
  away: Colors.yellow,
};

const getInitials = (name: string): string => {
  const parts = name.trim().split(' ');
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
};

export const Avatar: React.FC<AvatarProps> = ({
  source,
  name,
  size = 'md',
  showStatus = false,
  status = 'offline',
  className,
}) => {
  const dimension = DIMENSION[size];
  const round = { width: dimension, height: dimension, borderRadius: dimension / 2 };
  const dot = DOT[size];

  return (
    <View style={styles.wrap} className={className}>
      {source ? (
        <Image
          source={{ uri: source }}
          style={[round, styles.face]}
          accessibilityLabel={name}
        />
      ) : (
        <View style={[round, styles.face, styles.placeholder]}>
          <Text style={[styles.initials, { fontSize: LABEL_SIZE[size] }]} numberOfLines={1}>
            {name ? getInitials(name) : '?'}
          </Text>
        </View>
      )}

      {showStatus ? (
        <View
          style={[
            styles.status,
            {
              width: dot,
              height: dot,
              borderRadius: dot / 2,
              backgroundColor: STATUS_COLOR[status],
            },
          ]}
        />
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    position: 'relative',
  },
  face: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  placeholder: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surface,
  },
  initials: {
    fontFamily: FontFamily.medium,
    color: Colors.text,
  },
  status: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    borderWidth: 2,
    borderColor: Colors.background,
  },
});

export default Avatar;

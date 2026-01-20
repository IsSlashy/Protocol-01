/**
 * Specter Protocol Badge Component
 * Status badges with glow effects
 */

import React from 'react';
import { colors, ColorKey } from '../colors';
import { fontFamilies, fontSizes, fontWeights } from '../typography';
import { spacing, radii } from '../spacing';
import { glows } from '../shadows';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════
export type BadgeVariant = 'solid' | 'subtle' | 'outline' | 'glow';
export type BadgeSize = 'sm' | 'md' | 'lg';
export type BadgeColor = 'green' | 'purple' | 'blue' | 'amber' | 'red' | 'gray';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  size?: BadgeSize;
  color?: BadgeColor;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  children: React.ReactNode;
}

// ═══════════════════════════════════════════════════════════════
// STYLE MAPS
// ═══════════════════════════════════════════════════════════════
const sizeStyles: Record<BadgeSize, {
  height: number;
  paddingX: number;
  fontSize: number;
  iconSize: number;
  gap: number;
}> = {
  sm: {
    height: 20,
    paddingX: spacing[2],
    fontSize: fontSizes.xs,
    iconSize: 10,
    gap: spacing[1],
  },
  md: {
    height: 24,
    paddingX: spacing[2.5],
    fontSize: fontSizes.sm,
    iconSize: 12,
    gap: spacing[1.5],
  },
  lg: {
    height: 28,
    paddingX: spacing[3],
    fontSize: fontSizes.base,
    iconSize: 14,
    gap: spacing[2],
  },
};

const colorMap: Record<BadgeColor, {
  primary: string;
  dim: string;
  glow: string;
  subtle: string;
}> = {
  green: {
    primary: colors.green,
    dim: colors.greenDark,
    glow: glows.greenSm,
    subtle: colors.greenGlow,
  },
  purple: {
    primary: colors.streams,
    dim: '#6d28d9',
    glow: glows.purpleSm,
    subtle: colors.streamsGlow,
  },
  blue: {
    primary: colors.social,
    dim: '#1d4ed8',
    glow: glows.blueSm,
    subtle: colors.socialGlow,
  },
  amber: {
    primary: colors.agent,
    dim: '#b45309',
    glow: glows.amberSm,
    subtle: colors.agentGlow,
  },
  red: {
    primary: colors.error,
    dim: '#b91c1c',
    glow: glows.redSm,
    subtle: colors.errorGlow,
  },
  gray: {
    primary: colors.textSecondary,
    dim: colors.textMuted,
    glow: 'none',
    subtle: colors.surface3,
  },
};

const getVariantStyles = (color: BadgeColor, variant: BadgeVariant): React.CSSProperties => {
  const colorConfig = colorMap[color];

  switch (variant) {
    case 'solid':
      return {
        backgroundColor: colorConfig.primary,
        color: color === 'green' || color === 'amber' ? colors.black : colors.white,
        border: 'none',
      };
    case 'subtle':
      return {
        backgroundColor: colorConfig.subtle,
        color: colorConfig.primary,
        border: 'none',
      };
    case 'outline':
      return {
        backgroundColor: 'transparent',
        color: colorConfig.primary,
        border: `1px solid ${colorConfig.primary}`,
      };
    case 'glow':
      return {
        backgroundColor: colorConfig.subtle,
        color: colorConfig.primary,
        border: `1px solid ${colorConfig.primary}`,
        boxShadow: colorConfig.glow,
      };
    default:
      return {};
  }
};

// ═══════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════
export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  (
    {
      variant = 'subtle',
      size = 'md',
      color = 'green',
      leftIcon,
      rightIcon,
      children,
      style,
      ...props
    },
    ref
  ) => {
    const sizeStyle = sizeStyles[size];
    const variantStyle = getVariantStyles(color, variant);

    const badgeStyles: React.CSSProperties = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: sizeStyle.height,
      paddingLeft: sizeStyle.paddingX,
      paddingRight: sizeStyle.paddingX,
      gap: sizeStyle.gap,
      fontSize: sizeStyle.fontSize,
      fontFamily: fontFamilies.sans,
      fontWeight: fontWeights.medium,
      lineHeight: 1,
      borderRadius: radii.full,
      whiteSpace: 'nowrap',
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      ...variantStyle,
      ...style,
    };

    return (
      <span ref={ref} style={badgeStyles} {...props}>
        {leftIcon && (
          <span style={{ display: 'flex', width: sizeStyle.iconSize, height: sizeStyle.iconSize }}>
            {leftIcon}
          </span>
        )}
        {children}
        {rightIcon && (
          <span style={{ display: 'flex', width: sizeStyle.iconSize, height: sizeStyle.iconSize }}>
            {rightIcon}
          </span>
        )}
      </span>
    );
  }
);

Badge.displayName = 'Badge';

// ═══════════════════════════════════════════════════════════════
// STATUS BADGE - Predefined status badges
// ═══════════════════════════════════════════════════════════════
export type StatusType = 'success' | 'error' | 'warning' | 'info' | 'pending' | 'offline';

const statusConfig: Record<StatusType, { color: BadgeColor; label: string }> = {
  success: { color: 'green', label: 'Success' },
  error: { color: 'red', label: 'Error' },
  warning: { color: 'amber', label: 'Warning' },
  info: { color: 'blue', label: 'Info' },
  pending: { color: 'amber', label: 'Pending' },
  offline: { color: 'gray', label: 'Offline' },
};

export interface StatusBadgeProps extends Omit<BadgeProps, 'color' | 'children'> {
  status: StatusType;
  label?: string;
  showDot?: boolean;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({
  status,
  label,
  showDot = true,
  variant = 'subtle',
  size = 'md',
  ...props
}) => {
  const config = statusConfig[status];
  const sizeStyle = sizeStyles[size];

  const dot = showDot ? (
    <span
      style={{
        width: sizeStyle.iconSize - 2,
        height: sizeStyle.iconSize - 2,
        borderRadius: '50%',
        backgroundColor: colorMap[config.color].primary,
      }}
    />
  ) : undefined;

  return (
    <Badge
      variant={variant}
      size={size}
      color={config.color}
      leftIcon={dot}
      {...props}
    >
      {label || config.label}
    </Badge>
  );
};

StatusBadge.displayName = 'StatusBadge';

// ═══════════════════════════════════════════════════════════════
// MODULE BADGE - Badges for Specter modules
// ═══════════════════════════════════════════════════════════════
export type ModuleType = 'wallet' | 'streams' | 'social' | 'agent';

const moduleConfig: Record<ModuleType, { color: BadgeColor; label: string }> = {
  wallet: { color: 'green', label: 'Wallet' },
  streams: { color: 'purple', label: 'Streams' },
  social: { color: 'blue', label: 'Social' },
  agent: { color: 'amber', label: 'Agent' },
};

export interface ModuleBadgeProps extends Omit<BadgeProps, 'color' | 'children'> {
  module: ModuleType;
  label?: string;
}

export const ModuleBadge: React.FC<ModuleBadgeProps> = ({
  module,
  label,
  variant = 'glow',
  size = 'md',
  ...props
}) => {
  const config = moduleConfig[module];

  return (
    <Badge variant={variant} size={size} color={config.color} {...props}>
      {label || config.label}
    </Badge>
  );
};

ModuleBadge.displayName = 'ModuleBadge';

export default Badge;

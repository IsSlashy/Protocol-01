import React from 'react';
import { View, Text, ViewProps } from 'react-native';

type BadgeVariant = 'default' | 'success' | 'warning' | 'error' | 'info';
type BadgeSize = 'sm' | 'md' | 'lg';

interface BadgeProps extends ViewProps {
  variant?: BadgeVariant;
  size?: BadgeSize;
  icon?: React.ReactNode;
  children: React.ReactNode;
}

const variantStyles: Record<BadgeVariant, { bg: string; text: string; border: string }> = {
  default: {
    bg: 'bg-p01-surface',
    text: 'text-p01-text-secondary',
    border: 'border-p01-border',
  },
  success: {
    bg: 'bg-p01-cyan/20',
    text: 'text-p01-cyan',
    border: 'border-p01-cyan/30',
  },
  warning: {
    bg: 'bg-yellow-500/20',
    text: 'text-yellow-500',
    border: 'border-yellow-500/30',
  },
  error: {
    bg: 'bg-red-500/20',
    text: 'text-red-500',
    border: 'border-red-500/30',
  },
  info: {
    bg: 'bg-blue-500/20',
    text: 'text-blue-500',
    border: 'border-blue-500/30',
  },
};

const sizeStyles: Record<BadgeSize, { container: string; text: string }> = {
  sm: {
    container: 'px-2 py-0.5 rounded-md',
    text: 'text-xs',
  },
  md: {
    container: 'px-3 py-1 rounded-lg',
    text: 'text-sm',
  },
  lg: {
    container: 'px-4 py-1.5 rounded-xl',
    text: 'text-base',
  },
};

export const Badge: React.FC<BadgeProps> = ({
  variant = 'default',
  size = 'md',
  icon,
  children,
  className,
  ...props
}) => {
  const variantStyle = variantStyles[variant];
  const sizeStyle = sizeStyles[size];

  return (
    <View
      className={`
        flex-row items-center gap-1
        border
        ${variantStyle.bg}
        ${variantStyle.border}
        ${sizeStyle.container}
        ${className || ''}
      `}
      {...props}
    >
      {icon}
      <Text
        className={`
          font-medium
          ${variantStyle.text}
          ${sizeStyle.text}
        `}
      >
        {children}
      </Text>
    </View>
  );
};

export default Badge;

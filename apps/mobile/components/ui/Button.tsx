import React from 'react';
import {
  TouchableOpacity,
  Text,
  ActivityIndicator,
  View,
  TouchableOpacityProps,
} from 'react-native';

type ButtonVariant = 'primary' | 'secondary' | 'ghost';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends TouchableOpacityProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: React.ReactNode;
  iconPosition?: 'left' | 'right';
  fullWidth?: boolean;
  children: React.ReactNode;
}

const variantStyles: Record<ButtonVariant, { container: string; text: string }> = {
  primary: {
    container: 'bg-p01-cyan',
    text: 'text-p01-void',
  },
  secondary: {
    container: 'bg-p01-surface border border-p01-border',
    text: 'text-p01-cyan',
  },
  ghost: {
    container: 'bg-transparent',
    text: 'text-p01-cyan',
  },
};

const sizeStyles: Record<ButtonSize, { container: string; text: string }> = {
  sm: {
    container: 'px-4 py-2 rounded-lg',
    text: 'text-sm',
  },
  md: {
    container: 'px-6 py-3 rounded-xl',
    text: 'text-base',
  },
  lg: {
    container: 'px-8 py-4 rounded-xl',
    text: 'text-lg',
  },
};

const shadowStyles: Record<ButtonVariant, object> = {
  primary: {
    shadowColor: '#39c5bb',
    shadowOpacity: 0.3,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  secondary: {
    shadowColor: '#39c5bb',
    shadowOpacity: 0.1,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  ghost: {},
};

export const Button: React.FC<ButtonProps> = ({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  iconPosition = 'left',
  fullWidth = false,
  disabled,
  children,
  className,
  style,
  ...props
}) => {
  const variantStyle = variantStyles[variant];
  const sizeStyle = sizeStyles[size];
  const shadow = shadowStyles[variant];

  const isDisabled = disabled || loading;

  return (
    <TouchableOpacity
      className={`
        ${variantStyle.container}
        ${sizeStyle.container}
        ${fullWidth ? 'w-full' : ''}
        ${isDisabled ? 'opacity-50' : ''}
        flex-row items-center justify-center
        ${className || ''}
      `}
      style={[shadow, style]}
      disabled={isDisabled}
      activeOpacity={0.8}
      {...props}
    >
      {loading ? (
        <ActivityIndicator
          color={variant === 'primary' ? '#0a0a0c' : '#39c5bb'}
          size="small"
        />
      ) : (
        <View className="flex-row items-center gap-2">
          {icon && iconPosition === 'left' && icon}
          <Text
            className={`
              ${variantStyle.text}
              ${sizeStyle.text}
              font-semibold text-center
            `}
          >
            {children}
          </Text>
          {icon && iconPosition === 'right' && icon}
        </View>
      )}
    </TouchableOpacity>
  );
};

export default Button;

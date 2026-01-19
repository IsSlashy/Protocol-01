import React from 'react';
import { View, ViewProps } from 'react-native';
import { BlurView } from 'expo-blur';

interface CardProps extends ViewProps {
  variant?: 'default' | 'glass' | 'outlined';
  padding?: 'none' | 'sm' | 'md' | 'lg';
  children: React.ReactNode;
}

const paddingStyles = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-6',
};

export const Card: React.FC<CardProps> = ({
  variant = 'default',
  padding = 'md',
  children,
  className,
  style,
  ...props
}) => {
  const baseStyles = `rounded-2xl ${paddingStyles[padding]}`;

  if (variant === 'glass') {
    return (
      <View
        className={`${baseStyles} overflow-hidden ${className || ''}`}
        style={[
          {
            backgroundColor: 'rgba(21, 21, 24, 0.7)',
            borderWidth: 1,
            borderColor: 'rgba(42, 42, 48, 0.5)',
          },
          style,
        ]}
        {...props}
      >
        <BlurView
          intensity={20}
          tint="dark"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
          }}
        />
        <View className="relative z-10">{children}</View>
      </View>
    );
  }

  if (variant === 'outlined') {
    return (
      <View
        className={`
          ${baseStyles}
          bg-transparent
          border border-p01-border
          ${className || ''}
        `}
        style={style}
        {...props}
      >
        {children}
      </View>
    );
  }

  return (
    <View
      className={`
        ${baseStyles}
        bg-p01-surface
        ${className || ''}
      `}
      style={[
        {
          shadowColor: '#000',
          shadowOpacity: 0.3,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 4 },
          elevation: 6,
        },
        style,
      ]}
      {...props}
    >
      {children}
    </View>
  );
};

export default Card;

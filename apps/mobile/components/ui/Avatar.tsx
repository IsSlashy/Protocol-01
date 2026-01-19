import React from 'react';
import { View, Image, Text } from 'react-native';

type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

interface AvatarProps {
  source?: string;
  name?: string;
  size?: AvatarSize;
  showStatus?: boolean;
  status?: 'online' | 'offline' | 'away';
  className?: string;
}

const sizeStyles: Record<AvatarSize, { container: string; text: string; status: string; dimension: number }> = {
  xs: {
    container: 'w-6 h-6',
    text: 'text-xs',
    status: 'w-2 h-2',
    dimension: 24,
  },
  sm: {
    container: 'w-8 h-8',
    text: 'text-sm',
    status: 'w-2.5 h-2.5',
    dimension: 32,
  },
  md: {
    container: 'w-10 h-10',
    text: 'text-base',
    status: 'w-3 h-3',
    dimension: 40,
  },
  lg: {
    container: 'w-14 h-14',
    text: 'text-lg',
    status: 'w-3.5 h-3.5',
    dimension: 56,
  },
  xl: {
    container: 'w-20 h-20',
    text: 'text-2xl',
    status: 'w-4 h-4',
    dimension: 80,
  },
};

const statusColors = {
  online: 'bg-p01-cyan',
  offline: 'bg-gray-500',
  away: 'bg-yellow-500',
};

const getInitials = (name: string): string => {
  const parts = name.trim().split(' ');
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
};

const getColorFromName = (name: string): string => {
  const colors = [
    '#39c5bb',
    '#3b82f6',
    '#ff77a8',
    '#14b8a6',
    '#f97316',
    '#eab308',
    '#06b6d4',
  ];
  const hash = name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return colors[hash % colors.length];
};

export const Avatar: React.FC<AvatarProps> = ({
  source,
  name,
  size = 'md',
  showStatus = false,
  status = 'offline',
  className,
}) => {
  const sizeStyle = sizeStyles[size];
  const bgColor = name ? getColorFromName(name) : '#2a2a30';

  return (
    <View className={`relative ${className || ''}`}>
      {source ? (
        <Image
          source={{ uri: source }}
          className={`${sizeStyle.container} rounded-full`}
          style={{
            borderWidth: 2,
            borderColor: '#2a2a30',
          }}
        />
      ) : (
        <View
          className={`${sizeStyle.container} rounded-full items-center justify-center`}
          style={{
            backgroundColor: bgColor,
            borderWidth: 2,
            borderColor: 'rgba(255,255,255,0.1)',
          }}
        >
          <Text className={`${sizeStyle.text} font-bold text-p01-void`}>
            {name ? getInitials(name) : '?'}
          </Text>
        </View>
      )}

      {showStatus && (
        <View
          className={`
            absolute bottom-0 right-0
            ${sizeStyle.status}
            ${statusColors[status]}
            rounded-full
            border-2 border-p01-void
          `}
        />
      )}
    </View>
  );
};

export default Avatar;

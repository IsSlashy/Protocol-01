import React from 'react';
import { View, Image, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

interface ContactAvatarProps {
  source?: string;
  name?: string;
  size?: AvatarSize;
  showFavorite?: boolean;
  isFavorite?: boolean;
  showStatus?: boolean;
  status?: 'online' | 'offline' | 'away';
  className?: string;
}

const sizeStyles: Record<AvatarSize, { container: string; text: string; status: string; dimension: number; favoriteSize: number }> = {
  xs: {
    container: 'w-6 h-6',
    text: 'text-xs',
    status: 'w-2 h-2',
    dimension: 24,
    favoriteSize: 10,
  },
  sm: {
    container: 'w-8 h-8',
    text: 'text-sm',
    status: 'w-2.5 h-2.5',
    dimension: 32,
    favoriteSize: 12,
  },
  md: {
    container: 'w-12 h-12',
    text: 'text-base',
    status: 'w-3 h-3',
    dimension: 48,
    favoriteSize: 14,
  },
  lg: {
    container: 'w-16 h-16',
    text: 'text-xl',
    status: 'w-3.5 h-3.5',
    dimension: 64,
    favoriteSize: 16,
  },
  xl: {
    container: 'w-24 h-24',
    text: 'text-3xl',
    status: 'w-4 h-4',
    dimension: 96,
    favoriteSize: 20,
  },
};

const statusColors = {
  online: 'bg-green-500',
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
    '#39c5bb', // P-01 cyan
    '#3b82f6', // blue-500
    '#ff77a8', // P-01 pink
    '#14b8a6', // teal
    '#06b6d4', // cyan
    '#f97316', // orange
    '#eab308', // yellow
  ];
  const hash = name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return colors[hash % colors.length];
};

export const ContactAvatar: React.FC<ContactAvatarProps> = ({
  source,
  name,
  size = 'md',
  showFavorite = false,
  isFavorite = false,
  showStatus = false,
  status = 'offline',
  className,
}) => {
  const sizeStyle = sizeStyles[size];
  const bgColor = name ? getColorFromName(name) : '#3b82f6';

  return (
    <View className={`relative ${className || ''}`}>
      {source ? (
        <Image
          source={{ uri: source }}
          className={`${sizeStyle.container} rounded-full`}
          style={{
            borderWidth: 2,
            borderColor: '#3b82f6',
          }}
        />
      ) : (
        <View
          className={`${sizeStyle.container} rounded-full items-center justify-center`}
          style={{
            backgroundColor: bgColor,
            borderWidth: 2,
            borderColor: 'rgba(59, 130, 246, 0.3)',
          }}
        >
          <Text className={`${sizeStyle.text} font-bold text-white`}>
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

      {showFavorite && isFavorite && (
        <View
          className="absolute -top-1 -right-1 bg-p01-void rounded-full p-0.5"
        >
          <Ionicons name="star" size={sizeStyle.favoriteSize} color="#fbbf24" />
        </View>
      )}
    </View>
  );
};

export default ContactAvatar;

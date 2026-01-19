import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

interface HeaderProps {
  title?: string;
  subtitle?: string;
  showBack?: boolean;
  onBackPress?: () => void;
  leftComponent?: React.ReactNode;
  rightComponent?: React.ReactNode;
  transparent?: boolean;
  className?: string;
}

export const Header: React.FC<HeaderProps> = ({
  title,
  subtitle,
  showBack = false,
  onBackPress,
  leftComponent,
  rightComponent,
  transparent = false,
  className,
}) => {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const handleBack = () => {
    if (onBackPress) {
      onBackPress();
    } else {
      router.back();
    }
  };

  return (
    <View
      className={`
        ${transparent ? '' : 'bg-p01-void'}
        ${className || ''}
      `}
      style={{ paddingTop: insets.top }}
    >
      <View className="flex-row items-center justify-between h-14 px-4">
        <View className="flex-row items-center flex-1">
          {showBack && (
            <TouchableOpacity
              onPress={handleBack}
              className="w-10 h-10 rounded-full bg-p01-surface items-center justify-center mr-3"
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Ionicons name="chevron-back" size={24} color="#ffffff" />
            </TouchableOpacity>
          )}
          {leftComponent}
          {!leftComponent && title && (
            <View className="flex-1">
              <Text className="text-white font-bold text-xl">{title}</Text>
              {subtitle && (
                <Text className="text-p01-text-secondary text-sm mt-0.5">
                  {subtitle}
                </Text>
              )}
            </View>
          )}
        </View>

        {rightComponent && (
          <View className="flex-row items-center">{rightComponent}</View>
        )}
      </View>
    </View>
  );
};

export default Header;

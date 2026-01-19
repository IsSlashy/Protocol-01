import React from 'react';
import { TouchableOpacity, View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

interface SettingsRowProps {
  label: string;
  value?: string;
  onPress?: () => void;
  showChevron?: boolean;
  leftIcon?: keyof typeof Ionicons.glyphMap;
  disabled?: boolean;
}

export const SettingsRow: React.FC<SettingsRowProps> = ({
  label,
  value,
  onPress,
  showChevron = true,
  leftIcon,
  disabled = false,
}) => {
  return (
    <TouchableOpacity
      className={`
        flex-row items-center justify-between
        py-4 px-4
        ${disabled ? 'opacity-50' : ''}
      `}
      onPress={onPress}
      disabled={disabled || !onPress}
      activeOpacity={0.7}
    >
      <View className="flex-row items-center flex-1">
        {leftIcon && (
          <View className="w-8 h-8 rounded-lg bg-p01-elevated items-center justify-center mr-3">
            <Ionicons name={leftIcon} size={18} color="#39c5bb" />
          </View>
        )}
        <Text className="text-white text-base font-medium">{label}</Text>
      </View>

      <View className="flex-row items-center">
        {value && (
          <Text className="text-p01-gray text-sm mr-2">{value}</Text>
        )}
        {showChevron && onPress && (
          <Ionicons name="chevron-forward" size={20} color="#555560" />
        )}
      </View>
    </TouchableOpacity>
  );
};

export default SettingsRow;

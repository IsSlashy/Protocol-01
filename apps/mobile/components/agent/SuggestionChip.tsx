import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

interface SuggestionChipProps {
  label: string;
  onPress: () => void;
  icon?: keyof typeof Ionicons.glyphMap;
  className?: string;
}

export const SuggestionChip: React.FC<SuggestionChipProps> = ({
  label,
  onPress,
  icon,
  className,
}) => {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      className={`
        flex-row
        items-center
        rounded-full
        px-4
        py-2.5
        mr-2
        ${className || ''}
      `}
      style={{
        backgroundColor: 'rgba(57, 197, 187, 0.1)',
        borderWidth: 1,
        borderColor: 'rgba(57, 197, 187, 0.25)',
      }}
    >
      {icon && (
        <View className="mr-2">
          <Ionicons name={icon} size={14} color="#39c5bb" />
        </View>
      )}
      <Text style={{ color: '#39c5bb', fontSize: 13, fontWeight: '500' }}>
        {label}
      </Text>
    </TouchableOpacity>
  );
};

export default SuggestionChip;

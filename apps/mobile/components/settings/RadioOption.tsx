import React from 'react';
import { TouchableOpacity, View, Text } from 'react-native';

interface RadioOptionProps {
  label: string;
  description?: string;
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
}

export const RadioOption: React.FC<RadioOptionProps> = ({
  label,
  description,
  selected,
  onSelect,
  disabled = false,
}) => {
  return (
    <TouchableOpacity
      className={`
        flex-row items-center justify-between
        py-4 px-4
        ${disabled ? 'opacity-50' : ''}
      `}
      onPress={onSelect}
      disabled={disabled}
      activeOpacity={0.7}
    >
      <View className="flex-1 mr-3">
        <Text className="text-white text-base font-medium">{label}</Text>
        {description && (
          <Text className="text-p01-gray text-sm mt-1">{description}</Text>
        )}
      </View>

      <View
        className={`
          w-6 h-6 rounded-full border-2
          items-center justify-center
          ${selected ? 'border-p01-cyan' : 'border-p01-gray'}
        `}
      >
        {selected && (
          <View className="w-3 h-3 rounded-full bg-p01-cyan" />
        )}
      </View>
    </TouchableOpacity>
  );
};

export default RadioOption;

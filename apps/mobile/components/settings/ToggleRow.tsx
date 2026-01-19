import React from 'react';
import { View, Text, Switch, Platform } from 'react-native';

interface ToggleRowProps {
  label: string;
  description?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
}

export const ToggleRow: React.FC<ToggleRowProps> = ({
  label,
  description,
  value,
  onValueChange,
  disabled = false,
}) => {
  return (
    <View
      className={`
        flex-row items-center justify-between
        py-4 px-4
        ${disabled ? 'opacity-50' : ''}
      `}
    >
      <View className="flex-1 mr-3">
        <Text className="text-white text-base font-medium">{label}</Text>
        {description && (
          <Text className="text-p01-gray text-sm mt-1">{description}</Text>
        )}
      </View>

      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        trackColor={{
          false: '#2a2a30',
          true: 'rgba(57, 197, 187, 0.3)'
        }}
        thumbColor={value ? '#39c5bb' : '#555560'}
        ios_backgroundColor="#2a2a30"
        style={Platform.OS === 'android' ? { transform: [{ scaleX: 1.1 }, { scaleY: 1.1 }] } : undefined}
      />
    </View>
  );
};

export default ToggleRow;

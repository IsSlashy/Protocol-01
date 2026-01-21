import React from 'react';
import { TouchableOpacity, View, Text } from 'react-native';

const COLORS = {
  text: '#ffffff',
  textSecondary: '#9ca3af',
  textMuted: '#6b7280',
  cyan: '#06b6d4',
};

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
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 16,
        paddingHorizontal: 16,
        opacity: disabled ? 0.5 : 1,
      }}
      onPress={onSelect}
      disabled={disabled}
      activeOpacity={0.7}
    >
      <View style={{ flex: 1, marginRight: 12 }}>
        <Text style={{ color: COLORS.text, fontSize: 16, fontWeight: '500' }}>
          {label}
        </Text>
        {description && (
          <Text style={{ color: COLORS.textSecondary, fontSize: 14, marginTop: 4 }}>
            {description}
          </Text>
        )}
      </View>

      <View
        style={{
          width: 24,
          height: 24,
          borderRadius: 12,
          borderWidth: 2,
          borderColor: selected ? COLORS.cyan : COLORS.textMuted,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {selected && (
          <View
            style={{
              width: 12,
              height: 12,
              borderRadius: 6,
              backgroundColor: COLORS.cyan,
            }}
          />
        )}
      </View>
    </TouchableOpacity>
  );
};

export default RadioOption;

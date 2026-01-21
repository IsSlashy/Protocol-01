import React from 'react';
import { TouchableOpacity, View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

const COLORS = {
  text: '#ffffff',
  textSecondary: '#9ca3af',
  textMuted: '#6b7280',
  surface: '#27272a',
  cyan: '#06b6d4',
};

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
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 16,
        paddingHorizontal: 16,
        opacity: disabled ? 0.5 : 1,
      }}
      onPress={onPress}
      disabled={disabled || !onPress}
      activeOpacity={0.7}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
        {leftIcon && (
          <View
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              backgroundColor: COLORS.surface,
              alignItems: 'center',
              justifyContent: 'center',
              marginRight: 12,
            }}
          >
            <Ionicons name={leftIcon} size={18} color={COLORS.cyan} />
          </View>
        )}
        <Text style={{ color: COLORS.text, fontSize: 16, fontWeight: '500' }}>{label}</Text>
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        {value && (
          <Text style={{ color: COLORS.textSecondary, fontSize: 14, marginRight: 8 }}>{value}</Text>
        )}
        {showChevron && onPress && (
          <Ionicons name="chevron-forward" size={20} color={COLORS.textMuted} />
        )}
      </View>
    </TouchableOpacity>
  );
};

export default SettingsRow;

import React from 'react';
import { View, Text, Switch, Platform } from 'react-native';

import { Colors, P01Colors } from '@/constants/theme';

const COLORS = {
  text: Colors.text,
  textSecondary: Colors.textSecondary,
  cyan: P01Colors.cyan,
  switchTrackOff: Colors.border,
  switchTrackOn: P01Colors.cyanDim,
  switchThumbOff: Colors.textTertiary,
};

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
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 16,
        paddingHorizontal: 16,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <View style={{ flex: 1, marginRight: 12 }}>
        <Text style={{ color: COLORS.text, fontSize: 16, fontWeight: '500' }}>{label}</Text>
        {description && (
          <Text style={{ color: COLORS.textSecondary, fontSize: 14, marginTop: 4 }}>
            {description}
          </Text>
        )}
      </View>

      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        trackColor={{
          false: COLORS.switchTrackOff,
          true: COLORS.switchTrackOn,
        }}
        thumbColor={value ? COLORS.cyan : COLORS.switchThumbOff}
        ios_backgroundColor={COLORS.switchTrackOff}
        style={Platform.OS === 'android' ? { transform: [{ scaleX: 1.1 }, { scaleY: 1.1 }] } : undefined}
      />
    </View>
  );
};

export default ToggleRow;

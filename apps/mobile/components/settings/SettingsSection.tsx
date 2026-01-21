import React from 'react';
import { View, Text } from 'react-native';

const COLORS = {
  surface: '#18181b',
  textMuted: '#6b7280',
};

interface SettingsSectionProps {
  title: string;
  children: React.ReactNode;
}

export const SettingsSection: React.FC<SettingsSectionProps> = ({
  title,
  children,
}) => {
  return (
    <View style={{ marginBottom: 24 }}>
      <Text
        style={{
          color: COLORS.textMuted,
          fontSize: 12,
          fontWeight: '600',
          letterSpacing: 1,
          textTransform: 'uppercase',
          paddingHorizontal: 16,
          marginBottom: 8,
        }}
      >
        {title}
      </Text>
      <View
        style={{
          backgroundColor: COLORS.surface,
          borderRadius: 16,
          overflow: 'hidden',
          marginHorizontal: 16,
        }}
      >
        {children}
      </View>
    </View>
  );
};

export default SettingsSection;

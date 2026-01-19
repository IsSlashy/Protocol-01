import React from 'react';
import { View, Text } from 'react-native';

interface SettingsSectionProps {
  title: string;
  children: React.ReactNode;
}

export const SettingsSection: React.FC<SettingsSectionProps> = ({
  title,
  children,
}) => {
  return (
    <View className="mb-6">
      <Text className="text-p01-gray text-xs font-semibold tracking-wider uppercase px-4 mb-2">
        {title}
      </Text>
      <View className="bg-p01-surface rounded-2xl overflow-hidden mx-4">
        {children}
      </View>
    </View>
  );
};

export default SettingsSection;

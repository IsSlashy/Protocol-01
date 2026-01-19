import React from 'react';
import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Button } from '../ui/Button';

interface EmptyStateProps {
  icon?: keyof typeof Ionicons.glyphMap;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
  illustration?: React.ReactNode;
  className?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon = 'cube-outline',
  title,
  description,
  actionLabel,
  onAction,
  secondaryActionLabel,
  onSecondaryAction,
  illustration,
  className,
}) => {
  return (
    <View className={`flex-1 items-center justify-center px-8 py-12 ${className || ''}`}>
      {illustration || (
        <View
          className="w-20 h-20 rounded-full items-center justify-center mb-6"
          style={{
            backgroundColor: 'rgba(57, 197, 187, 0.1)',
            borderWidth: 1,
            borderColor: 'rgba(57, 197, 187, 0.2)',
          }}
        >
          <Ionicons name={icon} size={36} color="#39c5bb" />
        </View>
      )}

      <Text className="text-white text-xl font-bold text-center mb-2">
        {title}
      </Text>

      {description && (
        <Text className="text-p01-text-secondary text-center text-base mb-6 leading-6">
          {description}
        </Text>
      )}

      {(actionLabel || secondaryActionLabel) && (
        <View className="w-full gap-3">
          {actionLabel && onAction && (
            <Button
              variant="primary"
              size="lg"
              fullWidth
              onPress={onAction}
            >
              {actionLabel}
            </Button>
          )}
          {secondaryActionLabel && onSecondaryAction && (
            <Button
              variant="ghost"
              size="md"
              fullWidth
              onPress={onSecondaryAction}
            >
              {secondaryActionLabel}
            </Button>
          )}
        </View>
      )}
    </View>
  );
};

export default EmptyState;

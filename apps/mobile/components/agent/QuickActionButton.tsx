import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';

interface QuickActionButtonProps {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  description?: string;
  onPress: () => void;
  variant?: 'default' | 'highlighted' | 'compact';
  disabled?: boolean;
  color?: string;
  className?: string;
}

export const QuickActionButton: React.FC<QuickActionButtonProps> = ({
  icon,
  label,
  description,
  onPress,
  variant = 'default',
  disabled = false,
  color = '#f59e0b',
  className,
}) => {
  const isHighlighted = variant === 'highlighted';
  const isCompact = variant === 'compact';

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.7}
      className={`
        flex-1
        ${disabled ? 'opacity-50' : ''}
        ${className || ''}
      `}
      style={{
        minHeight: isCompact ? 56 : 90,
      }}
    >
      <LinearGradient
        colors={
          isHighlighted
            ? [`${color}15`, `${color}05`]
            : ['#151518', '#0f0f12']
        }
        style={{
          flex: 1,
          borderRadius: 16,
          padding: isCompact ? 12 : 16,
          borderWidth: 1,
          borderColor: isHighlighted ? `${color}40` : '#2a2a30',
          flexDirection: isCompact ? 'row' : 'column',
          alignItems: 'center',
          justifyContent: isCompact ? 'flex-start' : 'center',
        }}
      >
        {/* Icon Container */}
        <View
          style={{
            width: isCompact ? 40 : 48,
            height: isCompact ? 40 : 48,
            borderRadius: isCompact ? 12 : 14,
            backgroundColor: `${color}20`,
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: isCompact ? 0 : 12,
            marginRight: isCompact ? 12 : 0,
          }}
        >
          <Ionicons
            name={icon}
            size={isCompact ? 20 : 24}
            color={color}
          />
        </View>

        {/* Text Content */}
        <View style={{ alignItems: isCompact ? 'flex-start' : 'center' }}>
          <Text
            className="font-semibold"
            style={{
              color: '#ffffff',
              fontSize: isCompact ? 15 : 14,
            }}
          >
            {label}
          </Text>
          {description && (
            <Text
              className="mt-1"
              style={{
                color: '#888892',
                fontSize: 12,
              }}
              numberOfLines={1}
            >
              {description}
            </Text>
          )}
        </View>

        {isCompact && (
          <View style={{ marginLeft: 'auto' }}>
            <Ionicons name="chevron-forward" size={18} color="#555560" />
          </View>
        )}
      </LinearGradient>
    </TouchableOpacity>
  );
};

export default QuickActionButton;

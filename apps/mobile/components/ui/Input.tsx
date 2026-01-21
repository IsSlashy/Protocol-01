import React, { useState } from 'react';
import {
  View,
  TextInput,
  Text,
  TouchableOpacity,
  TextInputProps,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

const COLORS = {
  surface: '#18181b',
  border: '#3f3f46',
  borderFocus: '#06b6d4',
  text: '#ffffff',
  textSecondary: '#9ca3af',
  textMuted: '#6b7280',
  placeholder: '#555560',
  error: '#ef4444',
  cyan: '#06b6d4',
};

interface InputProps extends TextInputProps {
  label?: string;
  error?: string;
  hint?: string;
  leftIcon?: keyof typeof Ionicons.glyphMap;
  rightIcon?: keyof typeof Ionicons.glyphMap;
  onRightIconPress?: () => void;
  containerClassName?: string;
}

export const Input: React.FC<InputProps> = ({
  label,
  error,
  hint,
  leftIcon,
  rightIcon,
  onRightIconPress,
  containerClassName,
  secureTextEntry,
  className,
  style,
  ...props
}) => {
  const [isFocused, setIsFocused] = useState(false);
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);

  const isPassword = secureTextEntry !== undefined;
  const showPassword = isPassword && isPasswordVisible;

  return (
    <View style={{ width: '100%' }}>
      {label && (
        <Text style={{ color: COLORS.textSecondary, fontSize: 14, marginBottom: 8, fontWeight: '500' }}>
          {label}
        </Text>
      )}

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: COLORS.surface,
          borderWidth: 1,
          borderColor: isFocused ? COLORS.borderFocus : error ? COLORS.error : COLORS.border,
          borderRadius: 12,
          paddingHorizontal: 16,
          paddingVertical: 12,
          ...(isFocused ? {
            shadowColor: COLORS.cyan,
            shadowOpacity: 0.2,
            shadowRadius: 8,
            shadowOffset: { width: 0, height: 0 },
            elevation: 4,
          } : {}),
        }}
      >
        {leftIcon && (
          <Ionicons
            name={leftIcon}
            size={20}
            color={isFocused ? COLORS.cyan : COLORS.textMuted}
            style={{ marginRight: 12 }}
          />
        )}

        <TextInput
          style={[
            {
              flex: 1,
              color: COLORS.text,
              fontSize: 16,
            },
            style,
          ]}
          placeholderTextColor={COLORS.placeholder}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          secureTextEntry={isPassword && !showPassword}
          {...props}
        />

        {isPassword && (
          <TouchableOpacity
            onPress={() => setIsPasswordVisible(!isPasswordVisible)}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons
              name={showPassword ? 'eye-off-outline' : 'eye-outline'}
              size={20}
              color={COLORS.textMuted}
            />
          </TouchableOpacity>
        )}

        {rightIcon && !isPassword && (
          <TouchableOpacity
            onPress={onRightIconPress}
            disabled={!onRightIconPress}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons
              name={rightIcon}
              size={20}
              color={isFocused ? COLORS.cyan : COLORS.textMuted}
            />
          </TouchableOpacity>
        )}
      </View>

      {error && (
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8 }}>
          <Ionicons name="alert-circle" size={14} color={COLORS.error} />
          <Text style={{ color: COLORS.error, fontSize: 12, marginLeft: 4 }}>{error}</Text>
        </View>
      )}

      {hint && !error && (
        <Text style={{ color: COLORS.textSecondary, fontSize: 12, marginTop: 8 }}>{hint}</Text>
      )}
    </View>
  );
};

export default Input;

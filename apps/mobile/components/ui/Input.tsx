import React, { useState } from 'react';
import {
  View,
  TextInput,
  Text,
  TouchableOpacity,
  TextInputProps,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

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
  ...props
}) => {
  const [isFocused, setIsFocused] = useState(false);
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);

  const isPassword = secureTextEntry !== undefined;
  const showPassword = isPassword && isPasswordVisible;

  return (
    <View className={`w-full ${containerClassName || ''}`}>
      {label && (
        <Text className="text-p01-text-secondary text-sm mb-2 font-medium">
          {label}
        </Text>
      )}

      <View
        className={`
          flex-row items-center
          bg-p01-surface
          border rounded-xl
          px-4 py-3
          ${isFocused ? 'border-p01-cyan' : error ? 'border-red-500' : 'border-p01-border'}
        `}
        style={
          isFocused
            ? {
                shadowColor: '#39c5bb',
                shadowOpacity: 0.2,
                shadowRadius: 8,
                shadowOffset: { width: 0, height: 0 },
                elevation: 4,
              }
            : undefined
        }
      >
        {leftIcon && (
          <Ionicons
            name={leftIcon}
            size={20}
            color={isFocused ? '#39c5bb' : '#888892'}
            style={{ marginRight: 12 }}
          />
        )}

        <TextInput
          className={`
            flex-1
            text-white
            text-base
            ${className || ''}
          `}
          placeholderTextColor="#555560"
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
              color="#888892"
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
              color={isFocused ? '#39c5bb' : '#888892'}
            />
          </TouchableOpacity>
        )}
      </View>

      {error && (
        <View className="flex-row items-center mt-2">
          <Ionicons name="alert-circle" size={14} color="#ef4444" />
          <Text className="text-red-500 text-xs ml-1">{error}</Text>
        </View>
      )}

      {hint && !error && (
        <Text className="text-p01-text-secondary text-xs mt-2">{hint}</Text>
      )}
    </View>
  );
};

export default Input;

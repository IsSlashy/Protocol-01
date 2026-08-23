/**
 * Input — label above, field, message below.
 *
 * 🚨 THIS FILE HELD ITS OWN PALETTE. A local `COLORS` object declared a
 * `#18181b` surface, a `#3f3f46` border, a `#06b6d4` focus ring and a `#ef4444`
 * error — none of which are in `constants/theme.ts`, and three of which are not
 * in the brand at all. The theme sweep could not reach them, which is exactly
 * how one component ends up being the only cool-grey thing on a warm-paper
 * screen. The object is gone; every colour here is a token.
 *
 * 🎯 The error message sits UNDER THE FIELD THAT CAUSED IT and carries
 * `accessibilityRole="alert"`, so a screen reader announces it when it appears
 * instead of leaving it to be discovered by swiping.
 *
 * ⛔ The cyan focus glow is gone with the rest of the neon. Focus is the border
 * changing to the accent, which is what the site and the extension do.
 */

import React, { useState } from 'react';
import {
  View,
  TextInput,
  Text,
  TouchableOpacity,
  StyleSheet,
  TextInputProps,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Colors, Spacing, FontFamily, FontSize, BorderRadius } from '@/constants/theme';

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

  const iconColor = isFocused ? Colors.primary : Colors.textTertiary;

  return (
    <View style={styles.container} className={containerClassName}>
      {/* The label is visible, not a placeholder. A placeholder disappears the
          moment the user starts typing, taking the only description of the
          field with it. */}
      {label ? <Text style={styles.label}>{label}</Text> : null}

      <View
        style={[
          styles.field,
          isFocused && styles.fieldFocused,
          !!error && styles.fieldError,
        ]}
      >
        {leftIcon ? (
          <Ionicons name={leftIcon} size={18} color={iconColor} style={styles.leftIcon} />
        ) : null}

        <TextInput
          style={[styles.input, style]}
          className={className}
          placeholderTextColor={Colors.textTertiary}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          secureTextEntry={isPassword && !showPassword}
          accessibilityLabel={label}
          {...props}
        />

        {isPassword ? (
          <TouchableOpacity
            onPress={() => setIsPasswordVisible(!isPasswordVisible)}
            style={styles.iconButton}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityRole="button"
            accessibilityLabel={showPassword ? 'Hide the value' : 'Show the value'}
          >
            <Ionicons
              name={showPassword ? 'eye-off-outline' : 'eye-outline'}
              size={18}
              color={Colors.textTertiary}
            />
          </TouchableOpacity>
        ) : null}

        {rightIcon && !isPassword ? (
          <TouchableOpacity
            onPress={onRightIconPress}
            disabled={!onRightIconPress}
            style={styles.iconButton}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityRole="button"
            accessibilityLabel={rightIcon.replace(/-outline$/, '').replace(/-/g, ' ')}
          >
            <Ionicons name={rightIcon} size={18} color={iconColor} />
          </TouchableOpacity>
        ) : null}
      </View>

      {error ? (
        <View style={styles.messageRow} accessibilityRole="alert" accessibilityLiveRegion="polite">
          <Ionicons name="alert-circle" size={13} color={Colors.error} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {hint && !error ? <Text style={styles.hintText}>{hint}</Text> : null}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  label: {
    color: Colors.textSecondary,
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    marginBottom: Spacing.sm,
  },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.lg,
  },
  fieldFocused: {
    borderColor: Colors.primary,
  },
  fieldError: {
    borderColor: Colors.error,
  },
  input: {
    flex: 1,
    minHeight: 44,
    color: Colors.text,
    fontFamily: FontFamily.regular,
    fontSize: FontSize.md,
    paddingVertical: Spacing.md,
  },
  leftIcon: {
    marginRight: Spacing.md,
  },
  iconButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  messageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    marginTop: Spacing.sm,
  },
  errorText: {
    flex: 1,
    color: Colors.error,
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
  },
  hintText: {
    color: Colors.textTertiary,
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    marginTop: Spacing.sm,
  },
});

export default Input;

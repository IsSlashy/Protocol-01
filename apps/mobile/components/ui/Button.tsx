/**
 * Button — the one button.
 *
 * 🎯 REBUILT ON THE REALIGNED THEME 2026-08-23, and rebuilt in StyleSheet
 * rather than utility classes, because the old file carried the whole problem
 * in miniature: its colours were Tailwind names (`bg-p01-cyan`,
 * `text-p01-void`) that resolve in a config file nobody edits when the design
 * changes, so a token sweep over `constants/theme.ts` moved every screen EXCEPT
 * the buttons on them. Reading `Colors.*` means this component moves when the
 * theme moves.
 *
 * The rules baked in here, so no screen has to remember them — the same four
 * the Chrome extension's kit states:
 *   - every target is at least 44pt tall
 *   - disabled is the `disabled` prop AND reduced opacity AND no `onPress`,
 *     never a colour change that still fires
 *   - a button that is loading is disabled and says `busy` to a screen reader
 *   - one accent. `primary` is cyan; `danger` is the red, and it is the only
 *     other filled treatment.
 *
 * ⛔ The cyan drop-shadow is gone. A glow is the neon language the brand is
 * removing; a button does not need to emit light to look pressable.
 *
 * `className` is still accepted and still forwarded, because call sites use it
 * for LAYOUT (`className="mt-6"`) and that is not this component's business.
 */

import React from 'react';
import {
  TouchableOpacity,
  Text,
  ActivityIndicator,
  View,
  StyleSheet,
  TouchableOpacityProps,
  ViewStyle,
  TextStyle,
} from 'react-native';

import { Colors, Spacing, FontFamily, FontSize, BorderRadius } from '@/constants/theme';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends TouchableOpacityProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: React.ReactNode;
  iconPosition?: 'left' | 'right';
  fullWidth?: boolean;
  children: React.ReactNode;
}

export const Button: React.FC<ButtonProps> = ({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  iconPosition = 'left',
  fullWidth = false,
  disabled,
  children,
  className,
  style,
  onPress,
  accessibilityLabel,
  ...props
}) => {
  const isDisabled = disabled === true || loading;

  const containerStyle: (ViewStyle | undefined | false)[] = [
    styles.base,
    sizeContainer[size],
    variantContainer[variant],
    fullWidth && styles.fullWidth,
    isDisabled && styles.disabled,
  ];

  const labelStyle: (TextStyle | undefined)[] = [
    styles.label,
    sizeLabel[size],
    variantLabel[variant],
  ];

  return (
    <TouchableOpacity
      // ⚠️ `disabled` on the element, not only in the styling, and `onPress`
      // withheld outright. A control that looks dead but still fires is the
      // worst of both.
      disabled={isDisabled}
      onPress={isDisabled ? undefined : onPress}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      style={[containerStyle, style]}
      className={className}
      {...props}
    >
      {loading ? (
        <ActivityIndicator
          size="small"
          color={variant === 'primary' ? Colors.background : Colors.primary}
        />
      ) : (
        <View style={styles.row}>
          {icon && iconPosition === 'left' ? icon : null}
          <Text style={labelStyle} numberOfLines={1}>
            {children}
          </Text>
          {icon && iconPosition === 'right' ? icon : null}
        </View>
      )}
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: BorderRadius.md,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  fullWidth: {
    width: '100%',
  },
  // The whole disabled treatment: it reads as unavailable at a glance, and the
  // `disabled` prop above makes it actually unavailable.
  disabled: {
    opacity: 0.4,
  },
  label: {
    fontFamily: FontFamily.medium,
    textAlign: 'center',
  },
});

/** 44pt is the floor, not the target for `md`. */
const sizeContainer = StyleSheet.create({
  sm: { minHeight: 44, paddingHorizontal: Spacing.lg },
  md: { minHeight: 48, paddingHorizontal: Spacing.xl },
  lg: { minHeight: 52, paddingHorizontal: Spacing['2xl'] },
});

const sizeLabel = StyleSheet.create({
  sm: { fontSize: FontSize.sm },
  md: { fontSize: FontSize.md },
  lg: { fontSize: FontSize.lg },
});

const variantContainer = StyleSheet.create({
  primary: { backgroundColor: Colors.primary },
  secondary: { backgroundColor: 'transparent', borderColor: Colors.border },
  ghost: { backgroundColor: 'transparent' },
  // Danger is outlined rather than filled: a destructive action should be
  // findable, not the loudest thing on the screen.
  danger: { backgroundColor: Colors.errorDim, borderColor: Colors.error },
});

const variantLabel = StyleSheet.create({
  primary: { color: Colors.background },
  secondary: { color: Colors.text },
  ghost: { color: Colors.textSecondary },
  danger: { color: Colors.error },
});

export default Button;

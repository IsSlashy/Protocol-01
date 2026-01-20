/**
 * Specter Protocol Input Component
 * Dark themed input with glow focus effects
 */

import React from 'react';
import { colors } from '../colors';
import { fontFamilies, fontSizes, fontWeights } from '../typography';
import { spacing, radii, sizes, borderWidths } from '../spacing';
import { borderGlows } from '../shadows';
import { transitions } from '../animations';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════
export type InputSize = 'sm' | 'md' | 'lg';
export type InputVariant = 'default' | 'filled' | 'ghost';

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: InputSize;
  variant?: InputVariant;
  label?: string;
  hint?: string;
  error?: string;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  leftAddon?: React.ReactNode;
  rightAddon?: React.ReactNode;
  isFullWidth?: boolean;
}

// ═══════════════════════════════════════════════════════════════
// STYLE MAPS
// ═══════════════════════════════════════════════════════════════
const sizeStyles: Record<InputSize, { height: number; fontSize: number; padding: number; iconSize: number }> = {
  sm: {
    height: sizes.inputSm,
    fontSize: fontSizes.sm,
    padding: spacing[2.5],
    iconSize: 16,
  },
  md: {
    height: sizes.inputMd,
    fontSize: fontSizes.base,
    padding: spacing[3],
    iconSize: 18,
  },
  lg: {
    height: sizes.inputLg,
    fontSize: fontSizes.md,
    padding: spacing[4],
    iconSize: 20,
  },
};

const variantStyles: Record<InputVariant, {
  base: React.CSSProperties;
  hover: React.CSSProperties;
  focus: React.CSSProperties;
}> = {
  default: {
    base: {
      backgroundColor: colors.surface,
      border: `${borderWidths.thin}px solid ${colors.border}`,
    },
    hover: {
      borderColor: colors.borderLight,
    },
    focus: {
      borderColor: colors.green,
      boxShadow: borderGlows.greenFocus,
    },
  },
  filled: {
    base: {
      backgroundColor: colors.surface2,
      border: `${borderWidths.thin}px solid transparent`,
    },
    hover: {
      backgroundColor: colors.surface3,
    },
    focus: {
      backgroundColor: colors.surface,
      borderColor: colors.green,
      boxShadow: borderGlows.greenFocus,
    },
  },
  ghost: {
    base: {
      backgroundColor: 'transparent',
      border: `${borderWidths.thin}px solid transparent`,
      borderBottom: `${borderWidths.thin}px solid ${colors.border}`,
      borderRadius: 0,
    },
    hover: {
      borderBottomColor: colors.borderLight,
    },
    focus: {
      borderBottomColor: colors.green,
      boxShadow: `0 2px 0 0 ${colors.green}`,
    },
  },
};

// ═══════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════
export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    {
      size = 'md',
      variant = 'default',
      label,
      hint,
      error,
      leftIcon,
      rightIcon,
      leftAddon,
      rightAddon,
      isFullWidth = false,
      disabled,
      style,
      onFocus,
      onBlur,
      ...props
    },
    ref
  ) => {
    const [isFocused, setIsFocused] = React.useState(false);
    const [isHovered, setIsHovered] = React.useState(false);

    const sizeStyle = sizeStyles[size];
    const variantStyle = variantStyles[variant];
    const hasError = !!error;

    const containerStyles: React.CSSProperties = {
      display: 'inline-flex',
      flexDirection: 'column',
      width: isFullWidth ? '100%' : 'auto',
      ...style,
    };

    const inputWrapperStyles: React.CSSProperties = {
      display: 'flex',
      alignItems: 'center',
      position: 'relative',
      borderRadius: variant === 'ghost' ? 0 : radii.lg,
      transition: transitions.input,
      ...variantStyle.base,
      ...(isHovered && !isFocused && !disabled ? variantStyle.hover : {}),
      ...(isFocused && !disabled ? variantStyle.focus : {}),
      ...(hasError ? {
        borderColor: colors.error,
        boxShadow: isFocused ? borderGlows.redFocus : borderGlows.red,
      } : {}),
      ...(disabled ? {
        opacity: 0.5,
        cursor: 'not-allowed',
      } : {}),
    };

    const inputStyles: React.CSSProperties = {
      flex: 1,
      height: sizeStyle.height,
      padding: `0 ${sizeStyle.padding}px`,
      paddingLeft: leftIcon ? sizeStyle.height : leftAddon ? spacing[2] : sizeStyle.padding,
      paddingRight: rightIcon ? sizeStyle.height : rightAddon ? spacing[2] : sizeStyle.padding,
      fontSize: sizeStyle.fontSize,
      fontFamily: fontFamilies.sans,
      fontWeight: fontWeights.normal,
      color: colors.text,
      backgroundColor: 'transparent',
      border: 'none',
      outline: 'none',
      width: '100%',
      cursor: disabled ? 'not-allowed' : 'text',
    };

    const iconContainerStyles = (position: 'left' | 'right'): React.CSSProperties => ({
      position: 'absolute',
      [position]: 0,
      top: 0,
      bottom: 0,
      width: sizeStyle.height,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: hasError ? colors.error : isFocused ? colors.green : colors.textMuted,
      pointerEvents: 'none',
      transition: transitions.colors,
    });

    const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
      setIsFocused(true);
      onFocus?.(e);
    };

    const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
      setIsFocused(false);
      onBlur?.(e);
    };

    return (
      <div style={containerStyles}>
        {label && (
          <label
            style={{
              display: 'block',
              marginBottom: spacing[2],
              fontSize: fontSizes.sm,
              fontWeight: fontWeights.medium,
              color: hasError ? colors.error : colors.textSecondary,
            }}
          >
            {label}
          </label>
        )}

        <div
          style={inputWrapperStyles}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
        >
          {leftAddon && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                paddingLeft: sizeStyle.padding,
                color: colors.textMuted,
                fontSize: sizeStyle.fontSize,
              }}
            >
              {leftAddon}
            </div>
          )}

          {leftIcon && (
            <div style={iconContainerStyles('left')}>
              {leftIcon}
            </div>
          )}

          <input
            ref={ref}
            disabled={disabled}
            style={inputStyles}
            onFocus={handleFocus}
            onBlur={handleBlur}
            {...props}
          />

          {rightIcon && (
            <div style={iconContainerStyles('right')}>
              {rightIcon}
            </div>
          )}

          {rightAddon && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                paddingRight: sizeStyle.padding,
                color: colors.textMuted,
                fontSize: sizeStyle.fontSize,
              }}
            >
              {rightAddon}
            </div>
          )}
        </div>

        {(hint || error) && (
          <p
            style={{
              marginTop: spacing[1.5],
              fontSize: fontSizes.xs,
              color: hasError ? colors.error : colors.textMuted,
            }}
          >
            {error || hint}
          </p>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';

// ═══════════════════════════════════════════════════════════════
// TEXTAREA COMPONENT
// ═══════════════════════════════════════════════════════════════
export interface TextAreaProps extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'style'> {
  label?: string;
  hint?: string;
  error?: string;
  isFullWidth?: boolean;
  resize?: 'none' | 'vertical' | 'horizontal' | 'both';
}

export const TextArea = React.forwardRef<HTMLTextAreaElement, TextAreaProps>(
  (
    {
      label,
      hint,
      error,
      isFullWidth = false,
      resize = 'vertical',
      disabled,
      onFocus,
      onBlur,
      ...props
    },
    ref
  ) => {
    const [isFocused, setIsFocused] = React.useState(false);
    const hasError = !!error;

    const containerStyles: React.CSSProperties = {
      display: 'inline-flex',
      flexDirection: 'column',
      width: isFullWidth ? '100%' : 'auto',
    };

    const textareaStyles: React.CSSProperties = {
      minHeight: 100,
      padding: spacing[3],
      fontSize: fontSizes.base,
      fontFamily: fontFamilies.sans,
      fontWeight: fontWeights.normal,
      color: colors.text,
      backgroundColor: colors.surface,
      border: `${borderWidths.thin}px solid ${hasError ? colors.error : isFocused ? colors.green : colors.border}`,
      borderRadius: radii.lg,
      outline: 'none',
      resize,
      transition: transitions.input,
      boxShadow: hasError
        ? (isFocused ? borderGlows.redFocus : 'none')
        : (isFocused ? borderGlows.greenFocus : 'none'),
      opacity: disabled ? 0.5 : 1,
      cursor: disabled ? 'not-allowed' : 'text',
      width: isFullWidth ? '100%' : 'auto',
    };

    const handleFocus = (e: React.FocusEvent<HTMLTextAreaElement>) => {
      setIsFocused(true);
      onFocus?.(e);
    };

    const handleBlur = (e: React.FocusEvent<HTMLTextAreaElement>) => {
      setIsFocused(false);
      onBlur?.(e);
    };

    return (
      <div style={containerStyles}>
        {label && (
          <label
            style={{
              display: 'block',
              marginBottom: spacing[2],
              fontSize: fontSizes.sm,
              fontWeight: fontWeights.medium,
              color: hasError ? colors.error : colors.textSecondary,
            }}
          >
            {label}
          </label>
        )}

        <textarea
          ref={ref}
          disabled={disabled}
          style={textareaStyles}
          onFocus={handleFocus}
          onBlur={handleBlur}
          {...props}
        />

        {(hint || error) && (
          <p
            style={{
              marginTop: spacing[1.5],
              fontSize: fontSizes.xs,
              color: hasError ? colors.error : colors.textMuted,
            }}
          >
            {error || hint}
          </p>
        )}
      </div>
    );
  }
);

TextArea.displayName = 'TextArea';

export default Input;

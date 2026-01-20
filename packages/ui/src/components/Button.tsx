/**
 * Specter Protocol Button Component
 * Variants: primary, secondary, ghost, danger
 * With neon glow effects
 */

import React from 'react';
import { colors } from '../colors';
import { fontFamilies, fontSizes, fontWeights } from '../typography';
import { spacing, radii, sizes } from '../spacing';
import { glows, shadows } from '../shadows';
import { transitions, durations, easings } from '../animations';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'xl';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  isLoading?: boolean;
  isFullWidth?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  children: React.ReactNode;
}

// ═══════════════════════════════════════════════════════════════
// STYLE MAPS
// ═══════════════════════════════════════════════════════════════
const sizeStyles: Record<ButtonSize, React.CSSProperties> = {
  sm: {
    height: sizes.buttonSm,
    paddingLeft: spacing[3],
    paddingRight: spacing[3],
    fontSize: fontSizes.sm,
    gap: spacing[1.5],
  },
  md: {
    height: sizes.buttonMd,
    paddingLeft: spacing[4],
    paddingRight: spacing[4],
    fontSize: fontSizes.base,
    gap: spacing[2],
  },
  lg: {
    height: sizes.buttonLg,
    paddingLeft: spacing[6],
    paddingRight: spacing[6],
    fontSize: fontSizes.md,
    gap: spacing[2],
  },
  xl: {
    height: sizes.buttonXl,
    paddingLeft: spacing[8],
    paddingRight: spacing[8],
    fontSize: fontSizes.lg,
    gap: spacing[3],
  },
};

const variantStyles: Record<ButtonVariant, {
  base: React.CSSProperties;
  hover: React.CSSProperties;
  active: React.CSSProperties;
  disabled: React.CSSProperties;
}> = {
  primary: {
    base: {
      backgroundColor: colors.green,
      color: colors.black,
      border: 'none',
      boxShadow: glows.greenSm,
    },
    hover: {
      backgroundColor: colors.greenDim,
      boxShadow: glows.green,
    },
    active: {
      backgroundColor: colors.greenDark,
      boxShadow: glows.greenSm,
      transform: 'scale(0.98)',
    },
    disabled: {
      backgroundColor: colors.surface3,
      color: colors.textMuted,
      boxShadow: 'none',
    },
  },
  secondary: {
    base: {
      backgroundColor: 'transparent',
      color: colors.green,
      border: `1px solid ${colors.green}`,
      boxShadow: 'none',
    },
    hover: {
      backgroundColor: colors.greenGlow,
      boxShadow: glows.greenSm,
    },
    active: {
      backgroundColor: colors.greenGlow2,
      transform: 'scale(0.98)',
    },
    disabled: {
      backgroundColor: 'transparent',
      color: colors.textMuted,
      borderColor: colors.border,
      boxShadow: 'none',
    },
  },
  ghost: {
    base: {
      backgroundColor: 'transparent',
      color: colors.text,
      border: 'none',
      boxShadow: 'none',
    },
    hover: {
      backgroundColor: colors.surface2,
      color: colors.green,
    },
    active: {
      backgroundColor: colors.surface3,
      transform: 'scale(0.98)',
    },
    disabled: {
      backgroundColor: 'transparent',
      color: colors.textMuted,
    },
  },
  danger: {
    base: {
      backgroundColor: colors.error,
      color: colors.white,
      border: 'none',
      boxShadow: glows.redSm,
    },
    hover: {
      backgroundColor: colors.errorDim,
      boxShadow: glows.red,
    },
    active: {
      backgroundColor: '#b91c1c',
      boxShadow: glows.redSm,
      transform: 'scale(0.98)',
    },
    disabled: {
      backgroundColor: colors.surface3,
      color: colors.textMuted,
      boxShadow: 'none',
    },
  },
};

// ═══════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      isLoading = false,
      isFullWidth = false,
      leftIcon,
      rightIcon,
      children,
      disabled,
      style,
      onMouseEnter,
      onMouseLeave,
      onMouseDown,
      onMouseUp,
      ...props
    },
    ref
  ) => {
    const [isHovered, setIsHovered] = React.useState(false);
    const [isPressed, setIsPressed] = React.useState(false);

    const isDisabled = disabled || isLoading;
    const variantStyle = variantStyles[variant];
    const sizeStyle = sizeStyles[size];

    // Compute current styles based on state
    const currentStyles: React.CSSProperties = {
      // Base styles
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: fontFamilies.sans,
      fontWeight: fontWeights.semibold,
      borderRadius: radii.lg,
      cursor: isDisabled ? 'not-allowed' : 'pointer',
      transition: transitions.button,
      outline: 'none',
      textDecoration: 'none',
      whiteSpace: 'nowrap',
      userSelect: 'none',
      width: isFullWidth ? '100%' : 'auto',
      opacity: isLoading ? 0.7 : 1,
      // Size styles
      ...sizeStyle,
      // Variant styles (state-based)
      ...variantStyle.base,
      ...(isHovered && !isDisabled ? variantStyle.hover : {}),
      ...(isPressed && !isDisabled ? variantStyle.active : {}),
      ...(isDisabled ? variantStyle.disabled : {}),
      // Custom styles
      ...style,
    };

    const handleMouseEnter = (e: React.MouseEvent<HTMLButtonElement>) => {
      setIsHovered(true);
      onMouseEnter?.(e);
    };

    const handleMouseLeave = (e: React.MouseEvent<HTMLButtonElement>) => {
      setIsHovered(false);
      setIsPressed(false);
      onMouseLeave?.(e);
    };

    const handleMouseDown = (e: React.MouseEvent<HTMLButtonElement>) => {
      setIsPressed(true);
      onMouseDown?.(e);
    };

    const handleMouseUp = (e: React.MouseEvent<HTMLButtonElement>) => {
      setIsPressed(false);
      onMouseUp?.(e);
    };

    return (
      <button
        ref={ref}
        disabled={isDisabled}
        style={currentStyles}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        {...props}
      >
        {isLoading ? (
          <LoadingSpinner size={size} variant={variant} />
        ) : (
          <>
            {leftIcon && <span style={{ display: 'flex' }}>{leftIcon}</span>}
            {children}
            {rightIcon && <span style={{ display: 'flex' }}>{rightIcon}</span>}
          </>
        )}
      </button>
    );
  }
);

Button.displayName = 'Button';

// ═══════════════════════════════════════════════════════════════
// LOADING SPINNER
// ═══════════════════════════════════════════════════════════════
const spinnerSizes: Record<ButtonSize, number> = {
  sm: 14,
  md: 16,
  lg: 18,
  xl: 20,
};

const LoadingSpinner: React.FC<{ size: ButtonSize; variant: ButtonVariant }> = ({
  size,
  variant,
}) => {
  const spinnerSize = spinnerSizes[size];
  const color = variant === 'primary' || variant === 'danger' ? 'currentColor' : colors.green;

  return (
    <svg
      width={spinnerSize}
      height={spinnerSize}
      viewBox="0 0 24 24"
      style={{
        animation: `spin 1s linear infinite`,
      }}
    >
      <style>
        {`
          @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
        `}
      </style>
      <circle
        cx="12"
        cy="12"
        r="10"
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeDasharray="60 40"
        strokeLinecap="round"
      />
    </svg>
  );
};

export default Button;

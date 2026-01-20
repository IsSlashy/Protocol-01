/**
 * Specter Protocol Card Component
 * Glass morphism effect with optional glow
 */

import React from 'react';
import { colors } from '../colors';
import { spacing, radii } from '../spacing';
import { glass, shadows, glows } from '../shadows';
import { transitions } from '../animations';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════
export type CardVariant = 'default' | 'elevated' | 'subtle' | 'outlined' | 'ghost';
export type CardGlow = 'none' | 'green' | 'purple' | 'blue' | 'amber';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant;
  glow?: CardGlow;
  padding?: 'none' | 'sm' | 'md' | 'lg' | 'xl';
  isHoverable?: boolean;
  isPressable?: boolean;
  isDisabled?: boolean;
  children: React.ReactNode;
}

// ═══════════════════════════════════════════════════════════════
// STYLE MAPS
// ═══════════════════════════════════════════════════════════════
const paddingMap = {
  none: 0,
  sm: spacing[3],
  md: spacing[4],
  lg: spacing[6],
  xl: spacing[8],
};

const glowMap: Record<CardGlow, string> = {
  none: 'none',
  green: glows.greenSm,
  purple: glows.purpleSm,
  blue: glows.blueSm,
  amber: glows.amberSm,
};

const glowHoverMap: Record<CardGlow, string> = {
  none: 'none',
  green: glows.green,
  purple: glows.purple,
  blue: glows.blue,
  amber: glows.amber,
};

const variantStyles: Record<CardVariant, React.CSSProperties> = {
  default: {
    background: glass.card.background,
    backdropFilter: glass.card.backdropFilter,
    border: glass.card.border,
    boxShadow: shadows.md,
  },
  elevated: {
    background: glass.cardElevated.background,
    backdropFilter: glass.cardElevated.backdropFilter,
    border: glass.cardElevated.border,
    boxShadow: glass.cardElevated.boxShadow,
  },
  subtle: {
    background: glass.cardSubtle.background,
    backdropFilter: glass.cardSubtle.backdropFilter,
    border: glass.cardSubtle.border,
    boxShadow: 'none',
  },
  outlined: {
    background: 'transparent',
    backdropFilter: 'none',
    border: `1px solid ${colors.border}`,
    boxShadow: 'none',
  },
  ghost: {
    background: 'transparent',
    backdropFilter: 'none',
    border: 'none',
    boxShadow: 'none',
  },
};

// ═══════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════
export const Card = React.forwardRef<HTMLDivElement, CardProps>(
  (
    {
      variant = 'default',
      glow = 'none',
      padding = 'md',
      isHoverable = false,
      isPressable = false,
      isDisabled = false,
      children,
      style,
      onMouseEnter,
      onMouseLeave,
      onMouseDown,
      onMouseUp,
      onClick,
      ...props
    },
    ref
  ) => {
    const [isHovered, setIsHovered] = React.useState(false);
    const [isPressed, setIsPressed] = React.useState(false);

    const baseGlow = glowMap[glow];
    const hoverGlow = glowHoverMap[glow];

    // Compute box-shadow based on state
    const computedShadow = () => {
      if (isDisabled) return 'none';

      const baseShadow = variantStyles[variant].boxShadow || 'none';

      if (glow !== 'none') {
        if (isHovered && (isHoverable || isPressable)) {
          return `${baseShadow !== 'none' ? baseShadow + ', ' : ''}${hoverGlow}`;
        }
        return `${baseShadow !== 'none' ? baseShadow + ', ' : ''}${baseGlow}`;
      }

      if (isHovered && (isHoverable || isPressable)) {
        return shadows.lg;
      }

      return baseShadow;
    };

    const currentStyles: React.CSSProperties = {
      borderRadius: radii.xl,
      padding: paddingMap[padding],
      transition: transitions.card,
      cursor: isPressable && !isDisabled ? 'pointer' : 'default',
      opacity: isDisabled ? 0.5 : 1,
      pointerEvents: isDisabled ? 'none' : 'auto',
      transform: isPressed ? 'scale(0.98)' : isHovered && isHoverable ? 'translateY(-2px)' : 'none',
      ...variantStyles[variant],
      boxShadow: computedShadow(),
      ...style,
    };

    const handleMouseEnter = (e: React.MouseEvent<HTMLDivElement>) => {
      setIsHovered(true);
      onMouseEnter?.(e);
    };

    const handleMouseLeave = (e: React.MouseEvent<HTMLDivElement>) => {
      setIsHovered(false);
      setIsPressed(false);
      onMouseLeave?.(e);
    };

    const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
      if (isPressable) setIsPressed(true);
      onMouseDown?.(e);
    };

    const handleMouseUp = (e: React.MouseEvent<HTMLDivElement>) => {
      setIsPressed(false);
      onMouseUp?.(e);
    };

    const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
      if (!isDisabled) onClick?.(e);
    };

    return (
      <div
        ref={ref}
        style={currentStyles}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onClick={handleClick}
        {...props}
      >
        {children}
      </div>
    );
  }
);

Card.displayName = 'Card';

// ═══════════════════════════════════════════════════════════════
// CARD HEADER
// ═══════════════════════════════════════════════════════════════
export interface CardHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  title?: string;
  subtitle?: string;
  action?: React.ReactNode;
  children?: React.ReactNode;
}

export const CardHeader: React.FC<CardHeaderProps> = ({
  title,
  subtitle,
  action,
  children,
  style,
  ...props
}) => {
  if (children) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: spacing[4],
          ...style,
        }}
        {...props}
      >
        {children}
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        marginBottom: spacing[4],
        ...style,
      }}
      {...props}
    >
      <div>
        {title && (
          <h3
            style={{
              margin: 0,
              fontSize: 18,
              fontWeight: 600,
              color: colors.text,
              lineHeight: 1.4,
            }}
          >
            {title}
          </h3>
        )}
        {subtitle && (
          <p
            style={{
              margin: 0,
              marginTop: spacing[1],
              fontSize: 14,
              color: colors.textSecondary,
            }}
          >
            {subtitle}
          </p>
        )}
      </div>
      {action && <div>{action}</div>}
    </div>
  );
};

CardHeader.displayName = 'CardHeader';

// ═══════════════════════════════════════════════════════════════
// CARD BODY
// ═══════════════════════════════════════════════════════════════
export interface CardBodyProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export const CardBody: React.FC<CardBodyProps> = ({ children, style, ...props }) => {
  return (
    <div style={{ ...style }} {...props}>
      {children}
    </div>
  );
};

CardBody.displayName = 'CardBody';

// ═══════════════════════════════════════════════════════════════
// CARD FOOTER
// ═══════════════════════════════════════════════════════════════
export interface CardFooterProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export const CardFooter: React.FC<CardFooterProps> = ({ children, style, ...props }) => {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: spacing[3],
        marginTop: spacing[4],
        paddingTop: spacing[4],
        borderTop: `1px solid ${colors.border}`,
        ...style,
      }}
      {...props}
    >
      {children}
    </div>
  );
};

CardFooter.displayName = 'CardFooter';

export default Card;

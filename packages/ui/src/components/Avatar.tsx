/**
 * Specter Protocol Avatar Component
 * User avatars with glow effects and fallback initials
 */

import React from 'react';
import { colors } from '../colors';
import { fontFamilies, fontSizes, fontWeights } from '../typography';
import { sizes, radii } from '../spacing';
import { glows } from '../shadows';
import { transitions } from '../animations';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════
export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';
export type AvatarVariant = 'circle' | 'rounded' | 'square';
export type AvatarGlow = 'none' | 'green' | 'purple' | 'blue' | 'amber';

export interface AvatarProps extends React.HTMLAttributes<HTMLDivElement> {
  src?: string;
  alt?: string;
  name?: string;
  size?: AvatarSize;
  variant?: AvatarVariant;
  glow?: AvatarGlow;
  isOnline?: boolean;
  isBordered?: boolean;
  fallback?: React.ReactNode;
}

// ═══════════════════════════════════════════════════════════════
// STYLE MAPS
// ═══════════════════════════════════════════════════════════════
const sizeMap: Record<AvatarSize, {
  size: number;
  fontSize: number;
  statusSize: number;
  statusOffset: number;
}> = {
  xs: {
    size: sizes.avatarXs,
    fontSize: fontSizes.xs,
    statusSize: 8,
    statusOffset: 0,
  },
  sm: {
    size: sizes.avatarSm,
    fontSize: fontSizes.sm,
    statusSize: 10,
    statusOffset: 0,
  },
  md: {
    size: sizes.avatarMd,
    fontSize: fontSizes.base,
    statusSize: 12,
    statusOffset: 1,
  },
  lg: {
    size: sizes.avatarLg,
    fontSize: fontSizes.lg,
    statusSize: 14,
    statusOffset: 2,
  },
  xl: {
    size: sizes.avatarXl,
    fontSize: fontSizes.xl,
    statusSize: 16,
    statusOffset: 3,
  },
  '2xl': {
    size: sizes.avatar2xl,
    fontSize: fontSizes['2xl'],
    statusSize: 18,
    statusOffset: 4,
  },
};

const variantRadii: Record<AvatarVariant, number | string> = {
  circle: radii.full,
  rounded: radii.lg,
  square: radii.md,
};

const glowMap: Record<AvatarGlow, { border: string; shadow: string }> = {
  none: { border: colors.border, shadow: 'none' },
  green: { border: colors.green, shadow: glows.greenSm },
  purple: { border: colors.streams, shadow: glows.purpleSm },
  blue: { border: colors.social, shadow: glows.blueSm },
  amber: { border: colors.agent, shadow: glows.amberSm },
};

// ═══════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════
const getInitials = (name: string): string => {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) {
    return parts[0].charAt(0).toUpperCase();
  }
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
};

const stringToColor = (str: string): string => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = hash % 360;
  return `hsl(${hue}, 50%, 30%)`;
};

// ═══════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════
export const Avatar = React.forwardRef<HTMLDivElement, AvatarProps>(
  (
    {
      src,
      alt,
      name,
      size = 'md',
      variant = 'circle',
      glow = 'none',
      isOnline,
      isBordered = false,
      fallback,
      style,
      ...props
    },
    ref
  ) => {
    const [imageError, setImageError] = React.useState(false);
    const sizeStyle = sizeMap[size];
    const glowStyle = glowMap[glow];

    const showFallback = !src || imageError;
    const initials = name ? getInitials(name) : '';
    const fallbackColor = name ? stringToColor(name) : colors.surface2;

    const containerStyles: React.CSSProperties = {
      position: 'relative',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: sizeStyle.size,
      height: sizeStyle.size,
      borderRadius: variantRadii[variant],
      backgroundColor: showFallback ? fallbackColor : colors.surface2,
      border: isBordered || glow !== 'none' ? `2px solid ${glowStyle.border}` : 'none',
      boxShadow: glowStyle.shadow,
      overflow: 'hidden',
      flexShrink: 0,
      transition: transitions.all,
      ...style,
    };

    const imageStyles: React.CSSProperties = {
      width: '100%',
      height: '100%',
      objectFit: 'cover',
    };

    const initialsStyles: React.CSSProperties = {
      fontSize: sizeStyle.fontSize,
      fontFamily: fontFamilies.sans,
      fontWeight: fontWeights.semibold,
      color: colors.text,
      textTransform: 'uppercase',
      userSelect: 'none',
    };

    return (
      <div ref={ref} style={containerStyles} {...props}>
        {showFallback ? (
          fallback || <span style={initialsStyles}>{initials || '?'}</span>
        ) : (
          <img
            src={src}
            alt={alt || name || 'Avatar'}
            style={imageStyles}
            onError={() => setImageError(true)}
          />
        )}

        {isOnline !== undefined && (
          <span
            style={{
              position: 'absolute',
              bottom: sizeStyle.statusOffset,
              right: sizeStyle.statusOffset,
              width: sizeStyle.statusSize,
              height: sizeStyle.statusSize,
              borderRadius: '50%',
              backgroundColor: isOnline ? colors.success : colors.textMuted,
              border: `2px solid ${colors.dark}`,
              boxShadow: isOnline ? glows.greenSm : 'none',
            }}
          />
        )}
      </div>
    );
  }
);

Avatar.displayName = 'Avatar';

// ═══════════════════════════════════════════════════════════════
// AVATAR GROUP
// ═══════════════════════════════════════════════════════════════
export interface AvatarGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  max?: number;
  size?: AvatarSize;
  children: React.ReactNode;
}

export const AvatarGroup: React.FC<AvatarGroupProps> = ({
  max = 4,
  size = 'md',
  children,
  style,
  ...props
}) => {
  const avatars = React.Children.toArray(children);
  const visibleAvatars = avatars.slice(0, max);
  const remainingCount = avatars.length - max;
  const sizeStyle = sizeMap[size];

  const groupStyles: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    ...style,
  };

  const avatarWrapperStyles: React.CSSProperties = {
    marginLeft: -sizeStyle.size / 3,
    border: `2px solid ${colors.dark}`,
    borderRadius: radii.full,
  };

  return (
    <div style={groupStyles} {...props}>
      {visibleAvatars.map((avatar, index) => (
        <div
          key={index}
          style={{
            ...avatarWrapperStyles,
            marginLeft: index === 0 ? 0 : -sizeStyle.size / 3,
            zIndex: visibleAvatars.length - index,
          }}
        >
          {React.cloneElement(avatar as React.ReactElement, { size, isBordered: true })}
        </div>
      ))}

      {remainingCount > 0 && (
        <div
          style={{
            ...avatarWrapperStyles,
            zIndex: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: sizeStyle.size,
            height: sizeStyle.size,
            backgroundColor: colors.surface3,
            borderRadius: radii.full,
          }}
        >
          <span
            style={{
              fontSize: sizeStyle.fontSize * 0.75,
              fontFamily: fontFamilies.sans,
              fontWeight: fontWeights.semibold,
              color: colors.textSecondary,
            }}
          >
            +{remainingCount}
          </span>
        </div>
      )}
    </div>
  );
};

AvatarGroup.displayName = 'AvatarGroup';

export default Avatar;

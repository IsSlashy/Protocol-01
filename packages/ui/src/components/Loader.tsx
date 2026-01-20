/**
 * Specter Protocol Loader Component
 * Ghost-themed loading animations
 */

import React from 'react';
import { colors } from '../colors';
import { fontFamilies, fontSizes, fontWeights } from '../typography';
import { spacing } from '../spacing';
import { glows, textGlows } from '../shadows';
import { durations, easings, keyframes } from '../animations';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════
export type LoaderSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
export type LoaderVariant = 'spinner' | 'ghost' | 'dots' | 'pulse' | 'typing';
export type LoaderColor = 'green' | 'purple' | 'blue' | 'amber' | 'white';

export interface LoaderProps {
  size?: LoaderSize;
  variant?: LoaderVariant;
  color?: LoaderColor;
  label?: string;
}

// ═══════════════════════════════════════════════════════════════
// STYLE MAPS
// ═══════════════════════════════════════════════════════════════
const sizeMap: Record<LoaderSize, { size: number; fontSize: number }> = {
  xs: { size: 16, fontSize: fontSizes.xs },
  sm: { size: 24, fontSize: fontSizes.sm },
  md: { size: 32, fontSize: fontSizes.base },
  lg: { size: 48, fontSize: fontSizes.md },
  xl: { size: 64, fontSize: fontSizes.lg },
};

const colorMap: Record<LoaderColor, string> = {
  green: colors.green,
  purple: colors.streams,
  blue: colors.social,
  amber: colors.agent,
  white: colors.text,
};

// ═══════════════════════════════════════════════════════════════
// SPINNER LOADER
// ═══════════════════════════════════════════════════════════════
const SpinnerLoader: React.FC<{ size: number; color: string }> = ({ size, color }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    style={{ animation: `spin 1s linear infinite` }}
  >
    <circle
      cx="12"
      cy="12"
      r="10"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeDasharray="60 40"
      strokeLinecap="round"
      style={{ opacity: 0.3 }}
    />
    <circle
      cx="12"
      cy="12"
      r="10"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeDasharray="15 85"
      strokeLinecap="round"
    />
  </svg>
);

// ═══════════════════════════════════════════════════════════════
// GHOST LOADER - Specter signature loader
// ═══════════════════════════════════════════════════════════════
const GhostLoader: React.FC<{ size: number; color: string }> = ({ size, color }) => {
  const glowColor = color === colors.green ? 'rgba(0, 255, 136, 0.3)' :
                    color === colors.streams ? 'rgba(139, 92, 246, 0.3)' :
                    color === colors.social ? 'rgba(59, 130, 246, 0.3)' :
                    color === colors.agent ? 'rgba(245, 158, 11, 0.3)' :
                    'rgba(255, 255, 255, 0.3)';

  return (
    <div
      style={{
        position: 'relative',
        width: size,
        height: size,
        animation: `ghostFloat 2s ${easings.easeInOut} infinite`,
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 64 64"
        fill="none"
        style={{
          filter: `drop-shadow(0 0 10px ${glowColor})`,
        }}
      >
        {/* Ghost body */}
        <path
          d="M32 8C19.85 8 10 17.85 10 30v24l6-6 6 6 6-6 6 6 6-6 6 6 6-6 6 6V30C54 17.85 44.15 8 32 8z"
          fill={color}
          opacity="0.9"
        />
        {/* Eyes */}
        <circle cx="24" cy="28" r="4" fill={colors.black} />
        <circle cx="40" cy="28" r="4" fill={colors.black} />
        {/* Eye highlights */}
        <circle cx="25.5" cy="26.5" r="1.5" fill={colors.white} opacity="0.8" />
        <circle cx="41.5" cy="26.5" r="1.5" fill={colors.white} opacity="0.8" />
      </svg>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════
// DOTS LOADER
// ═══════════════════════════════════════════════════════════════
const DotsLoader: React.FC<{ size: number; color: string }> = ({ size, color }) => {
  const dotSize = size / 4;
  const gap = size / 8;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap,
      }}
    >
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          style={{
            width: dotSize,
            height: dotSize,
            borderRadius: '50%',
            backgroundColor: color,
            animation: `pulse 1.4s ${easings.easeInOut} ${i * 0.16}s infinite`,
          }}
        />
      ))}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════
// PULSE LOADER
// ═══════════════════════════════════════════════════════════════
const PulseLoader: React.FC<{ size: number; color: string }> = ({ size, color }) => {
  const glowColor = color === colors.green ? glows.green :
                    color === colors.streams ? glows.purple :
                    color === colors.social ? glows.blue :
                    color === colors.agent ? glows.amber :
                    glows.white;

  return (
    <div
      style={{
        position: 'relative',
        width: size,
        height: size,
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          width: size * 0.5,
          height: size * 0.5,
          borderRadius: '50%',
          backgroundColor: color,
          transform: 'translate(-50%, -50%)',
          boxShadow: glowColor,
        }}
      />
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: size,
          height: size,
          borderRadius: '50%',
          border: `2px solid ${color}`,
          animation: `ripple 1.5s ${easings.easeOut} infinite`,
          opacity: 0.5,
        }}
      />
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: size,
          height: size,
          borderRadius: '50%',
          border: `2px solid ${color}`,
          animation: `ripple 1.5s ${easings.easeOut} 0.5s infinite`,
          opacity: 0.5,
        }}
      />
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════
// TYPING LOADER
// ═══════════════════════════════════════════════════════════════
const TypingLoader: React.FC<{ size: number; color: string }> = ({ size, color }) => {
  const cursorHeight = size * 0.8;
  const cursorWidth = size * 0.15;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: spacing[1],
      }}
    >
      <span
        style={{
          fontFamily: fontFamilies.mono,
          fontSize: size * 0.5,
          color: color,
          textShadow: color === colors.green ? textGlows.green : 'none',
        }}
      >
        _
      </span>
      <div
        style={{
          width: cursorWidth,
          height: cursorHeight,
          backgroundColor: color,
          animation: `typing 1s ${easings.linear} infinite`,
          boxShadow: color === colors.green ? glows.greenSm : 'none',
        }}
      />
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════
// MAIN LOADER COMPONENT
// ═══════════════════════════════════════════════════════════════
export const Loader: React.FC<LoaderProps> = ({
  size = 'md',
  variant = 'ghost',
  color = 'green',
  label,
}) => {
  const sizeConfig = sizeMap[size];
  const colorValue = colorMap[color];

  const loaderComponents: Record<LoaderVariant, React.ReactNode> = {
    spinner: <SpinnerLoader size={sizeConfig.size} color={colorValue} />,
    ghost: <GhostLoader size={sizeConfig.size} color={colorValue} />,
    dots: <DotsLoader size={sizeConfig.size} color={colorValue} />,
    pulse: <PulseLoader size={sizeConfig.size} color={colorValue} />,
    typing: <TypingLoader size={sizeConfig.size} color={colorValue} />,
  };

  return (
    <div
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: spacing[3],
      }}
    >
      <style>
        {keyframes.spin}
        {keyframes.pulse}
        {keyframes.ghostFloat}
        {keyframes.typing}
        {keyframes.ripple}
      </style>

      {loaderComponents[variant]}

      {label && (
        <span
          style={{
            fontSize: sizeConfig.fontSize,
            fontFamily: fontFamilies.sans,
            fontWeight: fontWeights.medium,
            color: colors.textSecondary,
          }}
        >
          {label}
        </span>
      )}
    </div>
  );
};

Loader.displayName = 'Loader';

// ═══════════════════════════════════════════════════════════════
// FULL PAGE LOADER
// ═══════════════════════════════════════════════════════════════
export interface FullPageLoaderProps {
  isVisible: boolean;
  label?: string;
}

export const FullPageLoader: React.FC<FullPageLoaderProps> = ({
  isVisible,
  label = 'Loading...',
}) => {
  const [shouldRender, setShouldRender] = React.useState(false);
  const [opacity, setOpacity] = React.useState(0);

  React.useEffect(() => {
    if (isVisible) {
      setShouldRender(true);
      requestAnimationFrame(() => setOpacity(1));
    } else {
      setOpacity(0);
      const timer = setTimeout(() => setShouldRender(false), durations.normal);
      return () => clearTimeout(timer);
    }
  }, [isVisible]);

  if (!shouldRender) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.black,
        zIndex: 9999,
        opacity,
        transition: `opacity ${durations.normal}ms ${easings.specter}`,
      }}
    >
      <Loader variant="ghost" size="xl" color="green" />
      {label && (
        <p
          style={{
            marginTop: spacing[6],
            fontSize: fontSizes.lg,
            fontFamily: fontFamilies.sans,
            fontWeight: fontWeights.medium,
            color: colors.green,
            textShadow: textGlows.green,
          }}
        >
          {label}
        </p>
      )}
    </div>
  );
};

FullPageLoader.displayName = 'FullPageLoader';

// ═══════════════════════════════════════════════════════════════
// SKELETON LOADER
// ═══════════════════════════════════════════════════════════════
export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  borderRadius?: number | string;
  isCircle?: boolean;
}

export const Skeleton: React.FC<SkeletonProps> = ({
  width = '100%',
  height = 20,
  borderRadius = 8,
  isCircle = false,
}) => {
  const size = isCircle ? (typeof height === 'number' ? height : 40) : undefined;

  return (
    <div
      style={{
        width: isCircle ? size : width,
        height: isCircle ? size : height,
        borderRadius: isCircle ? '50%' : borderRadius,
        background: `linear-gradient(90deg, ${colors.surface2} 25%, ${colors.surface3} 50%, ${colors.surface2} 75%)`,
        backgroundSize: '200% 100%',
        animation: `shimmer 1.5s ${easings.linear} infinite`,
      }}
    >
      <style>{keyframes.shimmer}</style>
    </div>
  );
};

Skeleton.displayName = 'Skeleton';

export default Loader;

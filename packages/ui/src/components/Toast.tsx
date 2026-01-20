/**
 * Specter Protocol Toast Component
 * Notification toasts with glow effects
 */

import React, { useEffect, useCallback } from 'react';
import { colors } from '../colors';
import { fontFamilies, fontSizes, fontWeights } from '../typography';
import { spacing, radii, zIndices } from '../spacing';
import { glows, shadows, glass } from '../shadows';
import { durations, easings, keyframes } from '../animations';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════
export type ToastVariant = 'success' | 'error' | 'warning' | 'info' | 'default';
export type ToastPosition = 'top-right' | 'top-left' | 'top-center' | 'bottom-right' | 'bottom-left' | 'bottom-center';

export interface ToastProps {
  id: string;
  title?: string;
  message: string;
  variant?: ToastVariant;
  duration?: number;
  isClosable?: boolean;
  onClose: (id: string) => void;
  action?: {
    label: string;
    onClick: () => void;
  };
}

export interface ToastContainerProps {
  position?: ToastPosition;
  children: React.ReactNode;
}

// ═══════════════════════════════════════════════════════════════
// STYLE MAPS
// ═══════════════════════════════════════════════════════════════
const variantConfig: Record<ToastVariant, {
  icon: string;
  iconColor: string;
  glow: string;
  accentColor: string;
}> = {
  success: {
    icon: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
    iconColor: colors.success,
    glow: glows.greenSm,
    accentColor: colors.green,
  },
  error: {
    icon: 'M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z',
    iconColor: colors.error,
    glow: glows.redSm,
    accentColor: colors.error,
  },
  warning: {
    icon: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z',
    iconColor: colors.warning,
    glow: glows.amberSm,
    accentColor: colors.warning,
  },
  info: {
    icon: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
    iconColor: colors.info,
    glow: glows.blueSm,
    accentColor: colors.info,
  },
  default: {
    icon: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
    iconColor: colors.textSecondary,
    glow: 'none',
    accentColor: colors.textSecondary,
  },
};

const positionStyles: Record<ToastPosition, React.CSSProperties> = {
  'top-right': { top: spacing[4], right: spacing[4] },
  'top-left': { top: spacing[4], left: spacing[4] },
  'top-center': { top: spacing[4], left: '50%', transform: 'translateX(-50%)' },
  'bottom-right': { bottom: spacing[4], right: spacing[4] },
  'bottom-left': { bottom: spacing[4], left: spacing[4] },
  'bottom-center': { bottom: spacing[4], left: '50%', transform: 'translateX(-50%)' },
};

// ═══════════════════════════════════════════════════════════════
// TOAST CONTAINER
// ═══════════════════════════════════════════════════════════════
export const ToastContainer: React.FC<ToastContainerProps> = ({
  position = 'top-right',
  children,
}) => {
  const containerStyles: React.CSSProperties = {
    position: 'fixed',
    display: 'flex',
    flexDirection: position.startsWith('bottom') ? 'column-reverse' : 'column',
    gap: spacing[3],
    zIndex: zIndices.toast,
    pointerEvents: 'none',
    ...positionStyles[position],
  };

  return <div style={containerStyles}>{children}</div>;
};

ToastContainer.displayName = 'ToastContainer';

// ═══════════════════════════════════════════════════════════════
// TOAST COMPONENT
// ═══════════════════════════════════════════════════════════════
export const Toast: React.FC<ToastProps> = ({
  id,
  title,
  message,
  variant = 'default',
  duration = 5000,
  isClosable = true,
  onClose,
  action,
}) => {
  const [isVisible, setIsVisible] = React.useState(false);
  const [isLeaving, setIsLeaving] = React.useState(false);

  const config = variantConfig[variant];

  // Animate in
  useEffect(() => {
    requestAnimationFrame(() => setIsVisible(true));
  }, []);

  // Auto-dismiss
  useEffect(() => {
    if (duration > 0) {
      const timer = setTimeout(() => handleClose(), duration);
      return () => clearTimeout(timer);
    }
  }, [duration]);

  const handleClose = useCallback(() => {
    setIsLeaving(true);
    setTimeout(() => onClose(id), durations.normal);
  }, [id, onClose]);

  const toastStyles: React.CSSProperties = {
    display: 'flex',
    alignItems: 'flex-start',
    gap: spacing[3],
    width: 360,
    maxWidth: '100%',
    padding: spacing[4],
    borderRadius: radii.xl,
    ...glass.cardElevated,
    borderLeft: `3px solid ${config.accentColor}`,
    boxShadow: `${shadows.lg}, ${config.glow}`,
    pointerEvents: 'auto',
    opacity: isVisible && !isLeaving ? 1 : 0,
    transform: isVisible && !isLeaving ? 'translateX(0)' : 'translateX(20px)',
    transition: `all ${durations.normal}ms ${easings.spring}`,
  };

  const iconContainerStyles: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 24,
    height: 24,
    flexShrink: 0,
    color: config.iconColor,
  };

  const contentStyles: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
  };

  const closeButtonStyles: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 24,
    height: 24,
    padding: 0,
    border: 'none',
    borderRadius: radii.md,
    backgroundColor: 'transparent',
    color: colors.textMuted,
    cursor: 'pointer',
    flexShrink: 0,
    transition: `all ${durations.fast}ms ${easings.specter}`,
  };

  return (
    <div style={toastStyles} role="alert">
      {/* Icon */}
      <div style={iconContainerStyles}>
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d={config.icon} />
        </svg>
      </div>

      {/* Content */}
      <div style={contentStyles}>
        {title && (
          <div
            style={{
              fontSize: fontSizes.base,
              fontWeight: fontWeights.semibold,
              fontFamily: fontFamilies.sans,
              color: colors.text,
              marginBottom: title ? spacing[1] : 0,
            }}
          >
            {title}
          </div>
        )}
        <div
          style={{
            fontSize: fontSizes.sm,
            fontFamily: fontFamilies.sans,
            color: colors.textSecondary,
            lineHeight: 1.5,
          }}
        >
          {message}
        </div>

        {/* Action Button */}
        {action && (
          <button
            onClick={action.onClick}
            style={{
              marginTop: spacing[2],
              padding: 0,
              border: 'none',
              backgroundColor: 'transparent',
              fontSize: fontSizes.sm,
              fontWeight: fontWeights.medium,
              fontFamily: fontFamilies.sans,
              color: config.accentColor,
              cursor: 'pointer',
              transition: `opacity ${durations.fast}ms ${easings.specter}`,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.opacity = '0.8';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.opacity = '1';
            }}
          >
            {action.label}
          </button>
        )}
      </div>

      {/* Close Button */}
      {isClosable && (
        <button
          onClick={handleClose}
          style={closeButtonStyles}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = colors.surface2;
            e.currentTarget.style.color = colors.text;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'transparent';
            e.currentTarget.style.color = colors.textMuted;
          }}
          aria-label="Close notification"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
};

Toast.displayName = 'Toast';

// ═══════════════════════════════════════════════════════════════
// TOAST HOOK - For managing toast state
// ═══════════════════════════════════════════════════════════════
export interface ToastState {
  id: string;
  title?: string;
  message: string;
  variant?: ToastVariant;
  duration?: number;
  isClosable?: boolean;
  action?: {
    label: string;
    onClick: () => void;
  };
}

export const useToast = () => {
  const [toasts, setToasts] = React.useState<ToastState[]>([]);

  const addToast = useCallback((toast: Omit<ToastState, 'id'>) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    setToasts((prev) => [...prev, { ...toast, id }]);
    return id;
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const success = useCallback(
    (message: string, title?: string) => addToast({ message, title, variant: 'success' }),
    [addToast]
  );

  const error = useCallback(
    (message: string, title?: string) => addToast({ message, title, variant: 'error' }),
    [addToast]
  );

  const warning = useCallback(
    (message: string, title?: string) => addToast({ message, title, variant: 'warning' }),
    [addToast]
  );

  const info = useCallback(
    (message: string, title?: string) => addToast({ message, title, variant: 'info' }),
    [addToast]
  );

  return {
    toasts,
    addToast,
    removeToast,
    success,
    error,
    warning,
    info,
  };
};

export default Toast;

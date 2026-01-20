/**
 * Specter Protocol Modal Component
 * Dark glass modal with animations
 */

import React, { useEffect, useCallback } from 'react';
import { colors } from '../colors';
import { fontFamilies, fontSizes, fontWeights } from '../typography';
import { spacing, radii, zIndices, sizes } from '../spacing';
import { glass, shadows } from '../shadows';
import { durations, easings, keyframes } from '../animations';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════
export type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'full';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  size?: ModalSize;
  closeOnOverlayClick?: boolean;
  closeOnEscape?: boolean;
  showCloseButton?: boolean;
  header?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
}

// ═══════════════════════════════════════════════════════════════
// STYLE MAPS
// ═══════════════════════════════════════════════════════════════
const sizeWidths: Record<ModalSize, string | number> = {
  sm: 400,
  md: 500,
  lg: 600,
  xl: 800,
  full: '90vw',
};

const sizeMaxHeights: Record<ModalSize, string> = {
  sm: '85vh',
  md: '85vh',
  lg: '85vh',
  xl: '90vh',
  full: '95vh',
};

// ═══════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════
export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  subtitle,
  size = 'md',
  closeOnOverlayClick = true,
  closeOnEscape = true,
  showCloseButton = true,
  header,
  footer,
  children,
}) => {
  const [isAnimating, setIsAnimating] = React.useState(false);
  const [shouldRender, setShouldRender] = React.useState(false);

  // Handle mount/unmount animations
  useEffect(() => {
    if (isOpen) {
      setShouldRender(true);
      requestAnimationFrame(() => setIsAnimating(true));
    } else {
      setIsAnimating(false);
      const timer = setTimeout(() => setShouldRender(false), durations.normal);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // Handle escape key
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (closeOnEscape && e.key === 'Escape') {
        onClose();
      }
    },
    [closeOnEscape, onClose]
  );

  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [isOpen, handleKeyDown]);

  if (!shouldRender) return null;

  const overlayStyles: React.CSSProperties = {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.overlay,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing[4],
    zIndex: zIndices.modal,
    opacity: isAnimating ? 1 : 0,
    transition: `opacity ${durations.normal}ms ${easings.specter}`,
  };

  const modalStyles: React.CSSProperties = {
    position: 'relative',
    width: '100%',
    maxWidth: sizeWidths[size],
    maxHeight: sizeMaxHeights[size],
    display: 'flex',
    flexDirection: 'column',
    borderRadius: radii['2xl'],
    ...glass.modal,
    transform: isAnimating ? 'scale(1) translateY(0)' : 'scale(0.95) translateY(20px)',
    opacity: isAnimating ? 1 : 0,
    transition: `transform ${durations.normal}ms ${easings.spring}, opacity ${durations.normal}ms ${easings.specter}`,
  };

  const headerStyles: React.CSSProperties = {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    padding: spacing[6],
    paddingBottom: spacing[4],
    borderBottom: `1px solid ${colors.border}`,
  };

  const contentStyles: React.CSSProperties = {
    flex: 1,
    padding: spacing[6],
    overflowY: 'auto',
  };

  const footerStyles: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing[3],
    padding: spacing[6],
    paddingTop: spacing[4],
    borderTop: `1px solid ${colors.border}`,
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (closeOnOverlayClick && e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div style={overlayStyles} onClick={handleOverlayClick}>
      <style>
        {keyframes.fadeIn}
        {keyframes.scaleIn}
      </style>

      <div style={modalStyles} role="dialog" aria-modal="true" aria-labelledby="modal-title">
        {/* Header */}
        {(title || header || showCloseButton) && (
          <div style={headerStyles}>
            {header || (
              <div>
                {title && (
                  <h2
                    id="modal-title"
                    style={{
                      margin: 0,
                      fontSize: fontSizes.xl,
                      fontWeight: fontWeights.semibold,
                      fontFamily: fontFamilies.display,
                      color: colors.text,
                    }}
                  >
                    {title}
                  </h2>
                )}
                {subtitle && (
                  <p
                    style={{
                      margin: 0,
                      marginTop: spacing[1],
                      fontSize: fontSizes.sm,
                      color: colors.textSecondary,
                    }}
                  >
                    {subtitle}
                  </p>
                )}
              </div>
            )}

            {showCloseButton && (
              <button
                onClick={onClose}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 32,
                  height: 32,
                  marginLeft: spacing[4],
                  padding: 0,
                  border: 'none',
                  borderRadius: radii.md,
                  backgroundColor: 'transparent',
                  color: colors.textMuted,
                  cursor: 'pointer',
                  transition: `all ${durations.fast}ms ${easings.specter}`,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = colors.surface2;
                  e.currentTarget.style.color = colors.text;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                  e.currentTarget.style.color = colors.textMuted;
                }}
                aria-label="Close modal"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        )}

        {/* Content */}
        <div style={contentStyles}>{children}</div>

        {/* Footer */}
        {footer && <div style={footerStyles}>{footer}</div>}
      </div>
    </div>
  );
};

Modal.displayName = 'Modal';

// ═══════════════════════════════════════════════════════════════
// CONFIRM MODAL
// ═══════════════════════════════════════════════════════════════
export interface ConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'default' | 'danger';
  isLoading?: boolean;
}

export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'default',
  isLoading = false,
}) => {
  const confirmButtonStyles: React.CSSProperties = {
    padding: `${spacing[2]}px ${spacing[4]}px`,
    fontSize: fontSizes.base,
    fontWeight: fontWeights.semibold,
    fontFamily: fontFamilies.sans,
    borderRadius: radii.lg,
    border: 'none',
    cursor: isLoading ? 'not-allowed' : 'pointer',
    transition: `all ${durations.fast}ms ${easings.specter}`,
    backgroundColor: variant === 'danger' ? colors.error : colors.green,
    color: variant === 'danger' ? colors.white : colors.black,
    opacity: isLoading ? 0.7 : 1,
  };

  const cancelButtonStyles: React.CSSProperties = {
    padding: `${spacing[2]}px ${spacing[4]}px`,
    fontSize: fontSizes.base,
    fontWeight: fontWeights.medium,
    fontFamily: fontFamilies.sans,
    borderRadius: radii.lg,
    border: `1px solid ${colors.border}`,
    backgroundColor: 'transparent',
    color: colors.text,
    cursor: 'pointer',
    transition: `all ${durations.fast}ms ${easings.specter}`,
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <button
            onClick={onClose}
            style={cancelButtonStyles}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = colors.surface2;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent';
            }}
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            disabled={isLoading}
            style={confirmButtonStyles}
          >
            {isLoading ? 'Loading...' : confirmText}
          </button>
        </>
      }
    >
      <p style={{ margin: 0, color: colors.textSecondary, lineHeight: 1.6 }}>{message}</p>
    </Modal>
  );
};

ConfirmModal.displayName = 'ConfirmModal';

export default Modal;

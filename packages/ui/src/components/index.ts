/**
 * Protocol 01 UI Components
 *
 * All components are web-only (React DOM) using inline styles.
 * Design tokens (colors, spacing, etc.) work on both web and React Native.
 */

// Button
export { Button } from './Button';
export type { ButtonProps, ButtonVariant, ButtonSize } from './Button';

// Card
export { Card, CardHeader, CardBody, CardFooter } from './Card';
export type { CardProps, CardHeaderProps, CardBodyProps, CardFooterProps, CardVariant, CardGlow } from './Card';

// Input
export { Input, TextArea } from './Input';
export type { InputProps, TextAreaProps, InputSize, InputVariant } from './Input';

// Badge
export { Badge, StatusBadge, ModuleBadge } from './Badge';
export type {
  BadgeProps,
  BadgeVariant,
  BadgeSize,
  BadgeColor,
  StatusBadgeProps,
  StatusType,
  ModuleBadgeProps,
  ModuleType
} from './Badge';

// Avatar
export { Avatar, AvatarGroup } from './Avatar';
export type { AvatarProps, AvatarGroupProps, AvatarSize, AvatarVariant, AvatarGlow } from './Avatar';

// Modal
export { Modal, ConfirmModal } from './Modal';
export type { ModalProps, ConfirmModalProps, ModalSize } from './Modal';

// Toast
export { Toast, ToastContainer, useToast } from './Toast';
export type { ToastProps, ToastContainerProps, ToastVariant, ToastPosition, ToastState } from './Toast';

// Loader
export { Loader, FullPageLoader, Skeleton } from './Loader';
export type { LoaderProps, FullPageLoaderProps, SkeletonProps, LoaderSize, LoaderVariant, LoaderColor } from './Loader';

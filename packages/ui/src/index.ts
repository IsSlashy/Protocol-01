/**
 * @protocol-01/ui - Protocol 01 Design System
 *
 * Ultra dark theme with neon accents
 * Supports both Web (React) and Mobile (React Native)
 *
 * @example
 * ```tsx
 * import { Button, Card, colors, spacing } from '@protocol-01/ui';
 *
 * function MyComponent() {
 *   return (
 *     <Card glow="green">
 *       <Button variant="primary">Connect Wallet</Button>
 *     </Card>
 *   );
 * }
 * ```
 */

// ═══════════════════════════════════════════════════════════════
// DESIGN TOKENS
// ═══════════════════════════════════════════════════════════════

// Colors
export {
  colors,
  getModuleColor,
  getStatusColor
} from './colors';
export type { ColorKey, ColorValue } from './colors';

// Typography
export {
  fontFamilies,
  fontSizes,
  fontWeights,
  lineHeights,
  letterSpacings,
  textStyles,
} from './typography';
export type {
  FontFamily,
  FontSize,
  FontWeight,
  LineHeight,
  LetterSpacing,
  TextStyle,
} from './typography';

// Spacing
export {
  spacing,
  semanticSpacing,
  radii,
  borderWidths,
  zIndices,
  breakpoints,
  mediaQueries,
  sizes,
} from './spacing';
export type {
  SpacingKey,
  SpacingValue,
  RadiiKey,
  ZIndexKey,
  BreakpointKey,
  SizeKey,
} from './spacing';

// Shadows & Glows
export {
  shadows,
  glows,
  textGlows,
  borderGlows,
  glass,
  getModuleGlow,
  getStatusGlow,
} from './shadows';
export type {
  ShadowKey,
  GlowKey,
  TextGlowKey,
  GlassKey,
} from './shadows';

// Animations
export {
  durations,
  easings,
  keyframes,
  animations,
  transitions,
  rnAnimationConfig,
} from './animations';
export type {
  DurationKey,
  EasingKey,
  KeyframeKey,
  AnimationKey,
  TransitionKey,
} from './animations';

// ═══════════════════════════════════════════════════════════════
// COMPONENTS
// ═══════════════════════════════════════════════════════════════

export {
  // Button
  Button,

  // Card
  Card,
  CardHeader,
  CardBody,
  CardFooter,

  // Input
  Input,
  TextArea,

  // Badge
  Badge,
  StatusBadge,
  ModuleBadge,

  // Avatar
  Avatar,
  AvatarGroup,

  // Modal
  Modal,
  ConfirmModal,

  // Toast
  Toast,
  ToastContainer,
  useToast,

  // Loader
  Loader,
  FullPageLoader,
  Skeleton,
} from './components';

export type {
  // Button
  ButtonProps,
  ButtonVariant,
  ButtonSize,

  // Card
  CardProps,
  CardHeaderProps,
  CardBodyProps,
  CardFooterProps,
  CardVariant,
  CardGlow,

  // Input
  InputProps,
  TextAreaProps,
  InputSize,
  InputVariant,

  // Badge
  BadgeProps,
  BadgeVariant,
  BadgeSize,
  BadgeColor,
  StatusBadgeProps,
  StatusType,
  ModuleBadgeProps,
  ModuleType,

  // Avatar
  AvatarProps,
  AvatarGroupProps,
  AvatarSize,
  AvatarVariant,
  AvatarGlow,

  // Modal
  ModalProps,
  ConfirmModalProps,
  ModalSize,

  // Toast
  ToastProps,
  ToastContainerProps,
  ToastVariant,
  ToastPosition,
  ToastState,

  // Loader
  LoaderProps,
  FullPageLoaderProps,
  SkeletonProps,
  LoaderSize,
  LoaderVariant,
  LoaderColor,
} from './components';

// ═══════════════════════════════════════════════════════════════
// THEME OBJECT - For theme providers
// ═══════════════════════════════════════════════════════════════

import { colors } from './colors';
import { fontFamilies, fontSizes, fontWeights, lineHeights, letterSpacings } from './typography';
import { spacing, radii, borderWidths, zIndices, breakpoints, sizes } from './spacing';
import { shadows, glows, glass } from './shadows';
import { durations, easings, transitions } from './animations';

export const theme = {
  colors,
  fonts: fontFamilies,
  fontSizes,
  fontWeights,
  lineHeights,
  letterSpacings,
  spacing,
  radii,
  borderWidths,
  zIndices,
  breakpoints,
  sizes,
  shadows,
  glows,
  glass,
  durations,
  easings,
  transitions,
} as const;

export type Theme = typeof theme;

/**
 * Create a custom theme by deep-merging overrides with the default theme.
 * Useful for white-labeling or adjusting colors/spacing without replacing
 * the entire theme object.
 *
 * @param overrides - Partial theme object with values to override
 * @returns A new theme object with defaults + overrides merged
 *
 * @example
 * ```tsx
 * import { createTheme } from '@protocol-01/ui';
 *
 * const customTheme = createTheme({
 *   colors: { cyan: '#00ffcc', pink: '#ff00aa' },
 *   spacing: { 4: 20 },
 * });
 *
 * // Use with any theme provider
 * <ThemeProvider theme={customTheme}>
 *   <App />
 * </ThemeProvider>
 * ```
 */
export function createTheme(overrides: Partial<{ [K in keyof Theme]: Partial<Theme[K]> }>): Theme {
  const merged = { ...theme } as Record<string, any>;
  for (const key of Object.keys(overrides) as Array<keyof typeof overrides>) {
    const overrideValue = overrides[key];
    if (overrideValue && typeof overrideValue === 'object' && !Array.isArray(overrideValue)) {
      merged[key] = { ...(theme as any)[key], ...overrideValue };
    } else if (overrideValue !== undefined) {
      merged[key] = overrideValue;
    }
  }
  return merged as Theme;
}

export default theme;

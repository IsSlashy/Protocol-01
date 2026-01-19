/**
 * Design tokens and color constants for Protocol 01 (P-01)
 *
 * P-01 Design System Rules:
 * - Primary: Cyan #39c5bb (NOT green, NOT purple)
 * - Accent: Pink #ff77a8 (NOT purple)
 * - NO purple colors anywhere
 * - NO black text
 */

/**
 * Core brand colors
 */
export const BRAND = {
  primary: '#39c5bb', // P-01 Cyan (NOT green, NOT purple)
  primaryLight: '#00ffe5', // Bright Cyan
  primaryDark: '#2a9d95',
  secondary: '#ff77a8', // P-01 Pink (NOT purple)
  secondaryLight: '#ff9dc4',
  secondaryDark: '#ff2d7a',
  accent: '#ffcc00', // P-01 Yellow
  accentLight: '#ffe066',
  accentDark: '#cc9900',
} as const;

/**
 * Semantic colors (P-01 uses cyan for success, NOT green)
 */
export const SEMANTIC = {
  success: '#39c5bb', // P-01 Cyan (NOT green #22C55E)
  successLight: '#00ffe5', // Bright Cyan
  successDark: '#2a9d95',
  warning: '#ffcc00', // P-01 Yellow
  warningLight: '#ffe066',
  warningDark: '#cc9900',
  error: '#ff3366', // P-01 Red
  errorLight: '#ff6699',
  errorDark: '#cc2952',
  info: '#39c5bb', // P-01 Cyan
  infoLight: '#00ffe5',
  infoDark: '#2a9d95',
} as const;

/**
 * Dark theme colors (P-01 Cyberpunk)
 * NO black text - use white/muted/dim
 */
export const DARK = {
  // Backgrounds
  background: '#0a0a0c',      // p01-void
  backgroundSecondary: '#0f0f12', // p01-dark
  backgroundTertiary: '#151518',  // p01-surface
  backgroundElevated: '#1a1a1f',  // p01-elevated

  // Surfaces
  surface: '#151518',
  surfaceHover: '#1a1a1f',
  surfaceActive: '#22222c',
  surfaceBorder: '#2a2a30',

  // Cards
  card: '#151518',
  cardHover: '#1a1a1f',
  cardBorder: '#2a2a30',

  // Text (NO black text)
  textPrimary: '#ffffff',     // white
  textSecondary: '#888892',   // muted (NOT black)
  textTertiary: '#555560',    // dim (NOT black)
  textMuted: '#555560',       // dim
  textDisabled: '#3a3a40',

  // Input
  inputBackground: '#151518',
  inputBorder: '#2a2a30',
  inputBorderFocus: '#39c5bb', // p01-cyan
  inputPlaceholder: '#555560', // dim

  // Overlay
  overlay: 'rgba(10, 10, 12, 0.9)',
  overlayLight: 'rgba(10, 10, 12, 0.7)',
} as const;

/**
 * Light theme colors (for future use)
 * NOTE: P-01 is primarily dark theme, light mode uses P-01 accent colors
 */
export const LIGHT = {
  // Backgrounds
  background: '#FFFFFF',
  backgroundSecondary: '#F4F4F5',
  backgroundTertiary: '#E4E4E7',
  backgroundElevated: '#FAFAFA',

  // Surfaces
  surface: '#FFFFFF',
  surfaceHover: '#F4F4F5',
  surfaceActive: '#E4E4E7',
  surfaceBorder: '#E4E4E7',

  // Cards
  card: '#FFFFFF',
  cardHover: '#FAFAFA',
  cardBorder: '#E4E4E7',

  // Text (dark text for light mode, not pure black)
  textPrimary: '#1a1a1f',     // near-black (not pure black)
  textSecondary: '#52525B',
  textTertiary: '#71717A',
  textMuted: '#A1A1AA',
  textDisabled: '#D4D4D8',

  // Input
  inputBackground: '#FFFFFF',
  inputBorder: '#D4D4D8',
  inputBorderFocus: '#39c5bb', // p01-cyan (NOT purple #6366F1)
  inputPlaceholder: '#A1A1AA',

  // Overlay
  overlay: 'rgba(0, 0, 0, 0.5)',
  overlayLight: 'rgba(0, 0, 0, 0.3)',
} as const;

/**
 * Gradient definitions (P-01 Cyberpunk)
 * NO purple gradients - use cyan/pink
 */
export const GRADIENTS = {
  primary: ['#39c5bb', '#00ffe5'] as const,   // cyan
  secondary: ['#ff77a8', '#ff2d7a'] as const,  // pink (NOT purple)
  accent: ['#ffcc00', '#ff9900'] as const,     // yellow/agent
  success: ['#39c5bb', '#2a9d95'] as const,   // cyan (NOT green)
  warning: ['#ffcc00', '#cc9900'] as const,
  error: ['#ff3366', '#cc2952'] as const,      // red
  dark: ['#0f0f12', '#0a0a0c'] as const,
  p01: ['#39c5bb', '#ff77a8'] as const,        // cyan to pink
  card: ['rgba(57, 197, 187, 0.1)', 'rgba(255, 119, 168, 0.1)'] as const,
} as const;

/**
 * Shadow definitions (for elevation)
 */
export const SHADOWS = {
  sm: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 2,
    elevation: 2,
  },
  md: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 4,
  },
  lg: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  xl: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35,
    shadowRadius: 16,
    elevation: 16,
  },
  glow: {
    shadowColor: BRAND.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 8,
  },
  glowPink: {
    shadowColor: BRAND.secondary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 8,
  },
} as const;

/**
 * Border radius
 */
export const RADIUS = {
  none: 0,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  '2xl': 32,
  full: 9999,
} as const;

/**
 * Spacing scale
 */
export const SPACING = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
  20: 80,
  24: 96,
} as const;

/**
 * Font sizes
 */
export const FONT_SIZES = {
  xs: 10,
  sm: 12,
  base: 14,
  md: 16,
  lg: 18,
  xl: 20,
  '2xl': 24,
  '3xl': 30,
  '4xl': 36,
  '5xl': 48,
} as const;

/**
 * Font weights
 */
export const FONT_WEIGHTS = {
  normal: '400' as const,
  medium: '500' as const,
  semibold: '600' as const,
  bold: '700' as const,
  extrabold: '800' as const,
} as const;

/**
 * Z-index scale
 */
export const Z_INDEX = {
  base: 0,
  dropdown: 10,
  sticky: 20,
  fixed: 30,
  modalBackdrop: 40,
  modal: 50,
  popover: 60,
  tooltip: 70,
  toast: 80,
} as const;

/**
 * Animation durations
 */
export const ANIMATION = {
  fast: 150,
  normal: 300,
  slow: 500,
} as const;

/**
 * Get theme colors based on mode
 */
export function getTheme(mode: 'dark' | 'light' = 'dark') {
  const colors = mode === 'dark' ? DARK : LIGHT;

  return {
    ...colors,
    brand: BRAND,
    semantic: SEMANTIC,
    gradients: GRADIENTS,
    shadows: SHADOWS,
    radius: RADIUS,
    spacing: SPACING,
    fontSizes: FONT_SIZES,
    fontWeights: FONT_WEIGHTS,
    zIndex: Z_INDEX,
    animation: ANIMATION,
  };
}

/**
 * Default theme export
 */
export const theme = getTheme('dark');

/**
 * Color types
 */
export type BrandColor = keyof typeof BRAND;
export type SemanticColor = keyof typeof SEMANTIC;
export type DarkColor = keyof typeof DARK;
export type LightColor = keyof typeof LIGHT;

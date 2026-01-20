/**
 * Specter Protocol Typography System
 * Clean, modern type scale for dark interfaces
 */

// ═══════════════════════════════════════════════════════════════
// FONT FAMILIES
// ═══════════════════════════════════════════════════════════════
export const fontFamilies = {
  // Primary sans-serif for UI
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',

  // Monospace for code, addresses, numbers
  mono: '"SF Mono", "Fira Code", "Fira Mono", "Roboto Mono", Menlo, Monaco, Consolas, monospace',

  // Display font for headings (optional custom font)
  display: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
} as const;

// ═══════════════════════════════════════════════════════════════
// FONT SIZES - Modular scale (1.25 ratio)
// ═══════════════════════════════════════════════════════════════
export const fontSizes = {
  // Tiny text (labels, captions)
  xs: 10,
  sm: 12,

  // Body text
  base: 14,
  md: 16,

  // Subheadings
  lg: 18,
  xl: 20,

  // Headings
  '2xl': 24,
  '3xl': 30,
  '4xl': 36,
  '5xl': 48,

  // Display
  '6xl': 60,
  '7xl': 72,
  '8xl': 96,
} as const;

// ═══════════════════════════════════════════════════════════════
// FONT WEIGHTS
// ═══════════════════════════════════════════════════════════════
export const fontWeights = {
  thin: '100',
  light: '300',
  normal: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
  extrabold: '800',
  black: '900',
} as const;

// ═══════════════════════════════════════════════════════════════
// LINE HEIGHTS
// ═══════════════════════════════════════════════════════════════
export const lineHeights = {
  none: 1,
  tight: 1.25,
  snug: 1.375,
  normal: 1.5,
  relaxed: 1.625,
  loose: 2,
} as const;

// ═══════════════════════════════════════════════════════════════
// LETTER SPACING
// ═══════════════════════════════════════════════════════════════
export const letterSpacings = {
  tighter: -0.8,
  tight: -0.4,
  normal: 0,
  wide: 0.4,
  wider: 0.8,
  widest: 1.6,
} as const;

// ═══════════════════════════════════════════════════════════════
// TEXT STYLES - Pre-composed typography variants
// ═══════════════════════════════════════════════════════════════
export const textStyles = {
  // Display styles (hero text)
  displayLarge: {
    fontFamily: fontFamilies.display,
    fontSize: fontSizes['6xl'],
    fontWeight: fontWeights.bold,
    lineHeight: lineHeights.tight,
    letterSpacing: letterSpacings.tight,
  },
  displayMedium: {
    fontFamily: fontFamilies.display,
    fontSize: fontSizes['5xl'],
    fontWeight: fontWeights.bold,
    lineHeight: lineHeights.tight,
    letterSpacing: letterSpacings.tight,
  },
  displaySmall: {
    fontFamily: fontFamilies.display,
    fontSize: fontSizes['4xl'],
    fontWeight: fontWeights.semibold,
    lineHeight: lineHeights.tight,
    letterSpacing: letterSpacings.normal,
  },

  // Heading styles
  h1: {
    fontFamily: fontFamilies.display,
    fontSize: fontSizes['3xl'],
    fontWeight: fontWeights.bold,
    lineHeight: lineHeights.tight,
    letterSpacing: letterSpacings.normal,
  },
  h2: {
    fontFamily: fontFamilies.display,
    fontSize: fontSizes['2xl'],
    fontWeight: fontWeights.semibold,
    lineHeight: lineHeights.tight,
    letterSpacing: letterSpacings.normal,
  },
  h3: {
    fontFamily: fontFamilies.display,
    fontSize: fontSizes.xl,
    fontWeight: fontWeights.semibold,
    lineHeight: lineHeights.snug,
    letterSpacing: letterSpacings.normal,
  },
  h4: {
    fontFamily: fontFamilies.sans,
    fontSize: fontSizes.lg,
    fontWeight: fontWeights.medium,
    lineHeight: lineHeights.snug,
    letterSpacing: letterSpacings.normal,
  },

  // Body styles
  bodyLarge: {
    fontFamily: fontFamilies.sans,
    fontSize: fontSizes.md,
    fontWeight: fontWeights.normal,
    lineHeight: lineHeights.relaxed,
    letterSpacing: letterSpacings.normal,
  },
  body: {
    fontFamily: fontFamilies.sans,
    fontSize: fontSizes.base,
    fontWeight: fontWeights.normal,
    lineHeight: lineHeights.normal,
    letterSpacing: letterSpacings.normal,
  },
  bodySmall: {
    fontFamily: fontFamilies.sans,
    fontSize: fontSizes.sm,
    fontWeight: fontWeights.normal,
    lineHeight: lineHeights.normal,
    letterSpacing: letterSpacings.normal,
  },

  // UI styles
  label: {
    fontFamily: fontFamilies.sans,
    fontSize: fontSizes.sm,
    fontWeight: fontWeights.medium,
    lineHeight: lineHeights.normal,
    letterSpacing: letterSpacings.wide,
  },
  caption: {
    fontFamily: fontFamilies.sans,
    fontSize: fontSizes.xs,
    fontWeight: fontWeights.normal,
    lineHeight: lineHeights.normal,
    letterSpacing: letterSpacings.normal,
  },
  button: {
    fontFamily: fontFamilies.sans,
    fontSize: fontSizes.base,
    fontWeight: fontWeights.semibold,
    lineHeight: lineHeights.none,
    letterSpacing: letterSpacings.wide,
  },
  buttonSmall: {
    fontFamily: fontFamilies.sans,
    fontSize: fontSizes.sm,
    fontWeight: fontWeights.semibold,
    lineHeight: lineHeights.none,
    letterSpacing: letterSpacings.wide,
  },

  // Code styles
  code: {
    fontFamily: fontFamilies.mono,
    fontSize: fontSizes.sm,
    fontWeight: fontWeights.normal,
    lineHeight: lineHeights.relaxed,
    letterSpacing: letterSpacings.normal,
  },
  codeSmall: {
    fontFamily: fontFamilies.mono,
    fontSize: fontSizes.xs,
    fontWeight: fontWeights.normal,
    lineHeight: lineHeights.normal,
    letterSpacing: letterSpacings.normal,
  },

  // Special styles
  address: {
    fontFamily: fontFamilies.mono,
    fontSize: fontSizes.sm,
    fontWeight: fontWeights.medium,
    lineHeight: lineHeights.normal,
    letterSpacing: letterSpacings.wider,
  },
  number: {
    fontFamily: fontFamilies.mono,
    fontSize: fontSizes.base,
    fontWeight: fontWeights.medium,
    lineHeight: lineHeights.none,
    letterSpacing: letterSpacings.normal,
  },
  numberLarge: {
    fontFamily: fontFamilies.mono,
    fontSize: fontSizes['2xl'],
    fontWeight: fontWeights.bold,
    lineHeight: lineHeights.none,
    letterSpacing: letterSpacings.tight,
  },
} as const;

// Type exports
export type FontFamily = keyof typeof fontFamilies;
export type FontSize = keyof typeof fontSizes;
export type FontWeight = keyof typeof fontWeights;
export type LineHeight = keyof typeof lineHeights;
export type LetterSpacing = keyof typeof letterSpacings;
export type TextStyle = keyof typeof textStyles;

export default {
  fontFamilies,
  fontSizes,
  fontWeights,
  lineHeights,
  letterSpacings,
  textStyles,
};

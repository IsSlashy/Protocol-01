/**
 * Specter Protocol Spacing System
 * Consistent spacing scale for layouts and components
 * Base unit: 4px
 */

// ═══════════════════════════════════════════════════════════════
// SPACING SCALE - Based on 4px grid
// ═══════════════════════════════════════════════════════════════
export const spacing = {
  // Micro spacing (0-8px)
  0: 0,
  px: 1,
  0.5: 2,
  1: 4,
  1.5: 6,
  2: 8,

  // Small spacing (12-24px)
  2.5: 10,
  3: 12,
  3.5: 14,
  4: 16,
  5: 20,
  6: 24,

  // Medium spacing (28-48px)
  7: 28,
  8: 32,
  9: 36,
  10: 40,
  11: 44,
  12: 48,

  // Large spacing (56-96px)
  14: 56,
  16: 64,
  20: 80,
  24: 96,

  // Extra large spacing (112-384px)
  28: 112,
  32: 128,
  36: 144,
  40: 160,
  44: 176,
  48: 192,
  52: 208,
  56: 224,
  60: 240,
  64: 256,
  72: 288,
  80: 320,
  96: 384,
} as const;

// ═══════════════════════════════════════════════════════════════
// SEMANTIC SPACING - Named spacing for common use cases
// ═══════════════════════════════════════════════════════════════
export const semanticSpacing = {
  // Component internal spacing
  componentPaddingXs: spacing[2],   // 8px - Small buttons, badges
  componentPaddingSm: spacing[3],   // 12px - Inputs, small cards
  componentPaddingMd: spacing[4],   // 16px - Cards, modals
  componentPaddingLg: spacing[6],   // 24px - Large containers
  componentPaddingXl: spacing[8],   // 32px - Page sections

  // Gap between elements
  gapXs: spacing[1],    // 4px - Icon to text
  gapSm: spacing[2],    // 8px - Related items
  gapMd: spacing[3],    // 12px - List items
  gapLg: spacing[4],    // 16px - Card groups
  gapXl: spacing[6],    // 24px - Sections
  gap2xl: spacing[8],   // 32px - Major sections

  // Screen margins
  screenPaddingMobile: spacing[4],   // 16px
  screenPaddingTablet: spacing[6],   // 24px
  screenPaddingDesktop: spacing[8],  // 32px

  // Section spacing
  sectionSpacingSm: spacing[8],   // 32px
  sectionSpacingMd: spacing[12],  // 48px
  sectionSpacingLg: spacing[16],  // 64px
  sectionSpacingXl: spacing[24],  // 96px
} as const;

// ═══════════════════════════════════════════════════════════════
// BORDER RADIUS - Rounded corners scale
// ═══════════════════════════════════════════════════════════════
export const radii = {
  none: 0,
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  '2xl': 20,
  '3xl': 24,
  full: 9999,
} as const;

// ═══════════════════════════════════════════════════════════════
// BORDER WIDTHS
// ═══════════════════════════════════════════════════════════════
export const borderWidths = {
  none: 0,
  thin: 1,
  medium: 2,
  thick: 4,
} as const;

// ═══════════════════════════════════════════════════════════════
// Z-INDEX SCALE - Layering system
// ═══════════════════════════════════════════════════════════════
export const zIndices = {
  base: 0,
  dropdown: 100,
  sticky: 200,
  fixed: 300,
  overlay: 400,
  modal: 500,
  popover: 600,
  tooltip: 700,
  toast: 800,
  max: 9999,
} as const;

// ═══════════════════════════════════════════════════════════════
// BREAKPOINTS - Responsive design
// ═══════════════════════════════════════════════════════════════
export const breakpoints = {
  xs: 0,
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  '2xl': 1536,
} as const;

// Media query helpers (for web)
export const mediaQueries = {
  sm: `@media (min-width: ${breakpoints.sm}px)`,
  md: `@media (min-width: ${breakpoints.md}px)`,
  lg: `@media (min-width: ${breakpoints.lg}px)`,
  xl: `@media (min-width: ${breakpoints.xl}px)`,
  '2xl': `@media (min-width: ${breakpoints['2xl']}px)`,
} as const;

// ═══════════════════════════════════════════════════════════════
// SIZES - Common component sizes
// ═══════════════════════════════════════════════════════════════
export const sizes = {
  // Icon sizes
  iconXs: 12,
  iconSm: 16,
  iconMd: 20,
  iconLg: 24,
  iconXl: 32,
  icon2xl: 40,

  // Avatar sizes
  avatarXs: 24,
  avatarSm: 32,
  avatarMd: 40,
  avatarLg: 48,
  avatarXl: 64,
  avatar2xl: 80,

  // Button heights
  buttonSm: 32,
  buttonMd: 40,
  buttonLg: 48,
  buttonXl: 56,

  // Input heights
  inputSm: 32,
  inputMd: 40,
  inputLg: 48,

  // Container widths
  containerSm: 640,
  containerMd: 768,
  containerLg: 1024,
  containerXl: 1280,
  container2xl: 1536,
} as const;

// Type exports
export type SpacingKey = keyof typeof spacing;
export type SpacingValue = (typeof spacing)[SpacingKey];
export type RadiiKey = keyof typeof radii;
export type ZIndexKey = keyof typeof zIndices;
export type BreakpointKey = keyof typeof breakpoints;
export type SizeKey = keyof typeof sizes;

export default {
  spacing,
  semanticSpacing,
  radii,
  borderWidths,
  zIndices,
  breakpoints,
  mediaQueries,
  sizes,
};

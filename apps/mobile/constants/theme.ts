// Protocol 01 (P-01) - Design System
// Cyberpunk-inspired theme with cyan/pink accent colors
// NO purple colors anywhere | NO black text | NO green #00ff88

export const Colors = {
  // Core palette (P-01) - Backgrounds
  background: '#0a0a0c',      // p01-void
  surface: '#151518',          // p01-surface
  surfaceSecondary: '#0f0f12', // p01-dark
  surfaceTertiary: '#1a1a1f',  // p01-elevated

  // Borders
  border: '#2a2a30',           // p01-border
  borderLight: '#3a3a40',

  // Primary accent: Cyan (NOT green, NOT purple)
  primary: '#39c5bb',          // p01-cyan
  primaryDim: 'rgba(57, 197, 187, 0.15)',
  primaryMuted: 'rgba(57, 197, 187, 0.4)',
  primaryBright: '#00ffe5',    // p01-cyan-bright

  // Secondary accent: Pink (NOT purple)
  pink: '#ff77a8',             // p01-pink (accent)
  pinkHot: '#ff2d7a',          // p01-pink-hot
  pinkDim: 'rgba(255, 119, 168, 0.15)',

  // Tertiary accents
  yellow: '#ffcc00',           // p01-yellow (agent)
  red: '#ff3366',              // p01-red (error)
  blue: '#3b82f6',             // p01-blue (swap)
  blueDim: 'rgba(59, 130, 246, 0.15)',
  chrome: '#c0c0c8',           // p01-chrome

  // Module colors
  wallet: '#39c5bb',           // cyan
  streams: '#ff77a8',          // pink
  social: '#00ffe5',           // cyan-bright
  agent: '#ffcc00',            // yellow

  // Status colors (P-01 uses cyan for success, NOT green)
  success: '#39c5bb',          // cyan
  successDim: 'rgba(57, 197, 187, 0.15)',
  warning: '#ffcc00',          // yellow
  warningDim: 'rgba(255, 204, 0, 0.15)',
  error: '#ff3366',            // red
  errorDim: 'rgba(255, 51, 102, 0.15)',

  // Text (NO black text)
  text: '#ffffff',             // white
  textPrimary: '#ffffff',      // white (alias for text)
  textSecondary: '#888892',    // muted
  textTertiary: '#555560',     // dim
  textMuted: '#555560',        // dim

  // Gradients (as arrays for LinearGradient)
  gradientPrimary: ['#39c5bb', '#00ffe5'],
  gradientPink: ['#ff77a8', '#ff2d7a'],
  gradientCyan: ['#00ffe5', '#39c5bb'],
  gradientDark: ['#0f0f12', '#0a0a0c'],
  gradientCard: ['#151518', '#0f0f12'],
} as const;

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  '2xl': 24,
  '3xl': 32,
  '4xl': 40,
  '5xl': 48,
  '6xl': 64,
} as const;

export const BorderRadius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  '2xl': 24,
  '3xl': 32,
  full: 9999,
} as const;

export const FontSize = {
  xs: 11,
  sm: 13,
  md: 15,
  lg: 17,
  xl: 20,
  '2xl': 24,
  '3xl': 32,
  '4xl': 40,
  '5xl': 48,
  '6xl': 64,
} as const;

export const FontFamily = {
  regular: 'Inter-Regular',
  medium: 'Inter-Medium',
  semibold: 'Inter-SemiBold',
  bold: 'Inter-Bold',
  mono: 'JetBrainsMono-Regular',
  monoMedium: 'JetBrainsMono-Medium',
} as const;

export const Shadows = {
  sm: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 2,
  },
  md: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  lg: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 16,
    elevation: 8,
  },
  glow: {
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    elevation: 10,
  },
} as const;

// Animation configs for react-native-reanimated
export const AnimationConfig = {
  fast: { duration: 150 },
  normal: { duration: 250 },
  slow: { duration: 400 },
  spring: {
    damping: 15,
    stiffness: 150,
    mass: 1,
  },
  springBouncy: {
    damping: 10,
    stiffness: 180,
    mass: 0.8,
  },
} as const;

// Layout constants
export const Layout = {
  screenPadding: 20,
  cardPadding: 16,
  tabBarHeight: 85,
  headerHeight: 56,
  bottomSafeArea: 34,
} as const;

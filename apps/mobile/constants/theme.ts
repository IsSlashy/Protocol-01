/**
 * Styx / P-01 design system, mobile.
 *
 * 🎯 REALIGNED ON THE WEB SYSTEM 2026-08-23, the same way and for the same
 * reason as the Chrome extension. The token NAMES are unchanged on purpose:
 * ~42,500 lines of TSX read `Colors.background`, `Colors.text`,
 * `Colors.primary`. Retuning the VALUES moves the whole app onto the site's
 * palette in one file. A rename would have meant touching every screen and
 * getting some of them wrong.
 *
 * Source of truth: apps/web/app/_styx/styx.css.
 *
 * 🚨 THE CHANGE THAT SHOWS MOST IS THE TEXT COLOUR. This was pure #ffffff on a
 * cool grey. The site uses a warm paper #eae7df on near-black ink, and side by
 * side the pure white is what made three surfaces look like three products: it
 * is colder, it glares, and it belongs to a greyscale the brand does not use.
 *
 * ⛔ PINK IS RETIRED (founder ruling 2026-08-23). The keys stay and resolve to
 * cyan, because pink was the Streams module's colour and deleting the keys
 * would have meant dozens of edits with one missed. Do not use these names in
 * new code: they exist to retire the old ones, not to be a second accent.
 *
 * NO purple, NO black text, NO green, and no neon: #00ffe5 never appears on
 * the site either.
 */

export const Colors = {
  // Core palette (P-01) - Backgrounds
  background: '#070709',      // --styx-ink
  surface: '#101014',          // --styx-panel-2
  surfaceSecondary: '#0d0d10', // --styx-panel
  surfaceTertiary: '#16161b',  // one step above panel-2

  // Borders
  border: 'rgba(234, 231, 223, 0.14)',  // --styx-rule, alpha over paper
  borderLight: 'rgba(234, 231, 223, 0.24)',
  borderSoft: 'rgba(234, 231, 223, 0.07)',  // --styx-rule-soft

  // Primary accent: Cyan (NOT green, NOT purple)
  primary: '#39c5bb',          // p01-cyan
  primaryDim: 'rgba(57, 197, 187, 0.15)',
  primaryMuted: 'rgba(57, 197, 187, 0.4)',
  primaryBright: '#5fd8cf',    // was #00ffe5; that neon is not on the site

  // Secondary accent: Pink (NOT purple)
  pink: '#39c5bb',             // RETIRED, aliased to cyan
  pinkHot: '#2a9d95',          // RETIRED, aliased to cyan-dim
  pinkDim: 'rgba(57, 197, 187, 0.15)',   // RETIRED, aliased

  // Tertiary accents
  yellow: '#d9a24a',           // --styx-warn. Caution, never decoration.
  red: '#e0574f',              // desaturated so it stops vibrating on ink
  blue: '#3b82f6',             // p01-blue (swap)
  blueDim: 'rgba(59, 130, 246, 0.15)',
  chrome: '#c0c0c8',           // p01-chrome

  // Module colors
  wallet: '#39c5bb',           // cyan
  streams: '#39c5bb',          // was pink. One accent, like the site.
  social: '#39c5bb',
  agent: '#d9a24a',

  // Status colors (P-01 uses cyan for success, NOT green)
  success: '#39c5bb',          // cyan
  successDim: 'rgba(57, 197, 187, 0.15)',
  warning: '#d9a24a',          // amber
  warningDim: 'rgba(217, 162, 74, 0.15)',
  error: '#e0574f',
  errorDim: 'rgba(224, 87, 79, 0.15)',

  // Text (NO black text)
  text: '#eae7df',             // --styx-paper. NOT white.
  textPrimary: '#eae7df',      // --styx-paper
  textSecondary: 'rgba(234, 231, 223, 0.62)',  // --styx-muted
  textTertiary: 'rgba(234, 231, 223, 0.40)',   // --styx-faint
  textMuted: 'rgba(234, 231, 223, 0.40)',      // --styx-faint

  // Gradients (as arrays for LinearGradient)
  // The neon gradients are retired. The site uses flat panels and one
  // hairline rule; these stay as on-palette pairs so any surviving usage
  // degrades to something that belongs.
  gradientPrimary: ['#39c5bb', '#2a9d95'],
  gradientPink: ['#39c5bb', '#2a9d95'],
  gradientCyan: ['#39c5bb', '#2a9d95'],
  gradientDark: ['#0d0d10', '#070709'],
  gradientCard: ['#101014', '#0d0d10'],
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
  /**
   * 🎯 A DISPLAY FACE, WHICH THIS APP DID NOT HAVE. Every heading was
   * Inter-Bold, i.e. the body face one weight louder, so nothing on screen
   * carried the brand's voice. Newsreader at 300 is what the site and the
   * extension set headings in.
   * ⚠️ Loaded in hooks/useLoadFonts.ts. A fontFamily that is not loaded falls
   * back silently on both platforms, which is how a typeface nobody chose ends
   * up being the one everybody sees.
   */
  display: 'Newsreader-Light',
  displayMedium: 'Newsreader-Regular',
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

/**
 * Convenience colours, kept in step with `Colors` above.
 *
 * 🚨 THIS BLOCK IS WHY A SECOND SWEEP WAS NEEDED. It is a SECOND copy of the
 * palette, exported under a different name, and it still carried every retired
 * value after `Colors` had been realigned: hot pink, the #00ffe5 neon, the old
 * yellow, and a GREEN that the design system's own header forbids in the very
 * first line ("NO green"). A convenience export that drifts from the thing it
 * is convenient for is not convenience, it is a second source of truth.
 *
 * ⚠️ Do not add a colour here that is not in `Colors`. Better still, read
 * `Colors`.
 */
export const P01Colors = {
  cyan: Colors.primary,
  cyanDim: Colors.primaryDim,
  cyanBright: Colors.primaryBright,
  // Retired, aliased. See the note on Colors.pink.
  pink: Colors.primary,
  pinkDim: Colors.primaryDim,
  pinkHot: Colors.primaryDim,
  blue: Colors.blue,
  blueDim: Colors.blueDim,
  yellow: Colors.yellow,
  yellowDim: Colors.warningDim,
  // ⛔ Was #10b981, a green, in a file whose first rule is NO green. Aliased to
  // the accent, which is what this system uses for success.
  green: Colors.primary,
  greenDim: Colors.primaryDim,
} as const;

// Layout constants
export const Layout = {
  screenPadding: 20,
  cardPadding: 16,
  tabBarHeight: 64,
  tabBarBottomMargin: 16,
  tabBarTotalHeight: 80, // tabBarHeight + tabBarBottomMargin — add insets.bottom per screen
  headerHeight: 56,
  bottomSafeArea: 34,
} as const;
